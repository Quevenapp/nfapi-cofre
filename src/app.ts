// Rotas do cofre.
//
//   /setup, /admin/*  -> o emitente, autenticado pelo VAULT_SECRET
//   /v1/*             -> a API central, autenticada por HMAC (pareamento)
//
// O cofre só oferece operações tipadas: assinar um elemento fiscal do próprio
// emitente, transmitir para o governo e guardar documentos.

import { type Context, Hono, type MiddlewareHandler } from "hono";
import { isAdminSecret, pairingKey, secretIsStrong } from "./crypto";
import { PfxError, parsePfx } from "./pfx";
import {
	type ErrorBody,
	HEADERS,
	type HealthResponse,
	MAX_CLOCK_SKEW_SECONDS,
	PROTOCOL_VERSION,
	type SignRequest,
	type SignResponse,
	type TransmitRequest,
	type TransmitResponse,
	VAULT_VERSION,
	encodePairingCode,
	sha256Hex,
	toHex,
	verifySignature,
} from "./protocol";
import { runSelfTest } from "./selftest";
import { SETUP_CSS, SETUP_HTML, SETUP_JS } from "./setup/page";
import { SIGNABLE_TAGS, SignError, signXml } from "./signer";
import * as store from "./store";
import { type Transport, TransportError, assertTransmittable } from "./transport";

export interface AppEnv {
	DB: D1Database;
	DOCS: R2Bucket;
	VAULT_SECRET: string;
}

type Ctx = { Bindings: AppEnv; Variables: { body: ArrayBuffer; actor: string } };
type C = Context<Ctx>;
type Status = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 502 | 503 | 504;

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_PFX_BYTES = 64 * 1024;
const STATUSES: readonly number[] = [400, 401, 403, 404, 409, 413, 422, 500, 502, 503, 504];

function fail(c: C, status: Status, code: string, message: string) {
	return c.json<ErrorBody>({ error: { code, message } }, status);
}

/** Tarefas que não precisam segurar a resposta (fora do Workers, espera normalmente). */
async function background(c: C, task: Promise<unknown>) {
	try {
		c.executionCtx.waitUntil(task.catch(() => undefined));
	} catch {
		await task.catch(() => undefined);
	}
}

function parseJson<T>(body: ArrayBuffer): T | undefined {
	try {
		const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
		return value && typeof value === "object" ? (value as T) : undefined;
	} catch {
		return undefined;
	}
}

export function createApp(makeTransport: (env: AppEnv) => Transport) {
	const app = new Hono<Ctx>();

	app.onError((err, c) => {
		console.error("erro não tratado:", err instanceof Error ? err.message : err);
		return fail(c, 500, "erro_interno", "Erro interno do cofre.");
	});
	app.notFound((c) => fail(c, 404, "nao_encontrado", "Rota inexistente."));

	app.use("*", async (c, next) => {
		await next();
		c.header("x-content-type-options", "nosniff");
		c.header("referrer-policy", "no-referrer");
		c.header("x-frame-options", "DENY");
		if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
	});

	// ---------- Público ----------

	app.get("/", (c) => c.redirect("/setup"));
	app.get("/health", (c) => c.json({ ok: true, version: VAULT_VERSION, protocol: PROTOCOL_VERSION }));

	const CSP =
		"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";
	app.get("/setup", (c) => {
		c.header("content-security-policy", CSP);
		return c.html(SETUP_HTML);
	});
	app.get("/setup/app.js", (c) => c.body(SETUP_JS, 200, { "content-type": "text/javascript; charset=utf-8" }));
	app.get("/setup/app.css", (c) => c.body(SETUP_CSS, 200, { "content-type": "text/css; charset=utf-8" }));

	// ---------- Segredo configurado? ----------

	const requireSecret: MiddlewareHandler<Ctx> = async (c, next) => {
		if (!secretIsStrong(c.env.VAULT_SECRET)) {
			return fail(
				c,
				503,
				"cofre_nao_configurado",
				"VAULT_SECRET ausente ou curto demais (mínimo de 32 caracteres).",
			);
		}
		await next();
	};
	app.use("/admin/*", requireSecret);
	app.use("/v1/*", requireSecret);

	// ---------- Administração (emitente) ----------

	app.use("/admin/*", async (c, next) => {
		const header = c.req.header("authorization") ?? "";
		const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
		if (!provided || !(await isAdminSecret(provided, c.env.VAULT_SECRET))) {
			return fail(c, 401, "nao_autenticado", "Segredo do cofre incorreto.");
		}
		c.set("actor", "admin");
		await next();
	});

	app.get("/admin/status", async (c) => {
		const [certificate, allowProduction, pairings] = await Promise.all([
			store.getCertificateInfo(c.env.DB),
			store.getAllowProduction(c.env.DB),
			store.listPairings(c.env.DB),
		]);
		return c.json({
			version: VAULT_VERSION,
			protocol: PROTOCOL_VERSION,
			certificate,
			allowProduction,
			pairings,
		});
	});

	app.post("/admin/certificate", async (c) => {
		const form = await c.req.formData().catch(() => null);
		const file = form?.get("pfx");
		const password = form?.get("password");
		if (!(file instanceof File) || typeof password !== "string") {
			return fail(c, 400, "requisicao_invalida", "Envie o arquivo .pfx e a senha.");
		}
		if (file.size === 0 || file.size > MAX_PFX_BYTES) {
			return fail(c, 413, "arquivo_invalido", "O arquivo .pfx está vazio ou é grande demais.");
		}
		try {
			const parsed = parsePfx(new Uint8Array(await file.arrayBuffer()), password);
			if (parsed.notAfter.getTime() < Date.now()) {
				return fail(c, 422, "certificado_vencido", "Este certificado já venceu.");
			}
			const info = await store.saveCertificate(c.env.DB, c.env.VAULT_SECRET, parsed);
			await store.audit(c.env.DB, {
				action: "certificado.instalar",
				actor: "admin",
				outcome: "ok",
				detail: { holder: info.holder.id, notAfter: info.notAfter },
			});
			return c.json({ certificate: info });
		} catch (err) {
			if (err instanceof PfxError) return fail(c, 422, err.code, err.message);
			throw err;
		}
	});

	app.delete("/admin/certificate", async (c) => {
		await store.deleteCertificate(c.env.DB);
		await store.audit(c.env.DB, { action: "certificado.remover", actor: "admin", outcome: "ok" });
		return c.json({ ok: true });
	});

	app.post("/admin/pairings", async (c) => {
		const input = parseJson<{ label?: unknown }>(await c.req.arrayBuffer());
		const label = typeof input?.label === "string" ? input.label.trim().slice(0, 80) : "";
		const pairing = await store.createPairing(c.env.DB, label || "API NFapi");
		const key = await pairingKey(c.env.VAULT_SECRET, pairing.id);
		const code = encodePairingCode({
			v: 1,
			url: new URL(c.req.url).origin,
			id: pairing.id,
			key: toHex(key),
		});
		await store.audit(c.env.DB, {
			action: "pareamento.criar",
			actor: "admin",
			outcome: "ok",
			detail: { pairing: pairing.id, label: pairing.label },
		});
		// O código só é exibido agora; depois não há como recuperá-lo.
		return c.json({ pairing, code });
	});

	app.delete("/admin/pairings/:id", async (c) => {
		const id = c.req.param("id");
		const revoked = await store.revokePairing(c.env.DB, id);
		if (!revoked) return fail(c, 404, "nao_encontrado", "Pareamento inexistente ou já revogado.");
		await store.audit(c.env.DB, {
			action: "pareamento.revogar",
			actor: "admin",
			outcome: "ok",
			detail: { pairing: id },
		});
		return c.json({ ok: true });
	});

	app.put("/admin/settings", async (c) => {
		const input = parseJson<{ allowProduction?: unknown }>(await c.req.arrayBuffer());
		if (typeof input?.allowProduction !== "boolean") {
			return fail(c, 400, "requisicao_invalida", "Informe allowProduction (true ou false).");
		}
		await store.setAllowProduction(c.env.DB, input.allowProduction);
		await store.audit(c.env.DB, {
			action: "producao.alterar",
			actor: "admin",
			outcome: "ok",
			detail: { allowProduction: input.allowProduction },
		});
		return c.json({ allowProduction: input.allowProduction });
	});

	app.post("/admin/selftest", async (c) => {
		const cert = await store.loadCertificate(c.env.DB, c.env.VAULT_SECRET);
		if (!cert) return fail(c, 409, "certificado_ausente", "Instale o certificado antes de testar.");
		const results = await runSelfTest(makeTransport(c.env), cert.secrets);
		await store.audit(c.env.DB, {
			action: "autoteste",
			actor: "admin",
			outcome: results.every((r) => r.ok) ? "ok" : "falha",
			detail: { results: results.map((r) => ({ host: r.host, ok: r.ok })) },
		});
		return c.json({ results });
	});

	app.get("/admin/audit", async (c) => {
		const limit = Number(c.req.query("limit") ?? 50);
		return c.json({ entries: await store.listAudit(c.env.DB, Number.isFinite(limit) ? limit : 50) });
	});

	// ---------- API central (HMAC) ----------

	app.use("/v1/*", async (c, next) => {
		const pairingId = c.req.header(HEADERS.pairing) ?? "";
		const timestamp = c.req.header(HEADERS.timestamp) ?? "";
		const nonce = c.req.header(HEADERS.nonce) ?? "";
		const signature = c.req.header(HEADERS.signature) ?? "";
		const denied = () => fail(c, 401, "nao_autenticado", "Assinatura da requisição ausente ou inválida.");

		if (!/^[a-f0-9]{32}$/.test(pairingId) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return denied();
		const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
		if (!/^\d{9,11}$/.test(timestamp) || skew > MAX_CLOCK_SKEW_SECONDS) {
			return fail(c, 401, "relogio_fora_de_sincronia", "Carimbo de tempo fora da janela aceita.");
		}
		if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) {
			return fail(c, 413, "requisicao_grande_demais", "Corpo excede o limite do cofre.");
		}
		const body = await c.req.arrayBuffer();
		if (body.byteLength > MAX_BODY_BYTES) {
			return fail(c, 413, "requisicao_grande_demais", "Corpo excede o limite do cofre.");
		}
		if (!(await store.isPairingActive(c.env.DB, pairingId))) return denied();

		const url = new URL(c.req.url);
		const valid = await verifySignature(
			await pairingKey(c.env.VAULT_SECRET, pairingId),
			{
				method: c.req.method,
				path: url.pathname + url.search,
				timestamp,
				nonce,
				bodySha256: await sha256Hex(body),
			},
			signature,
		);
		if (!valid) return denied();

		// Só depois de autenticar: evita que terceiros encham a tabela de nonces.
		const fresh = await store.consumeNonce(c.env.DB, `${pairingId}:${nonce}`, MAX_CLOCK_SKEW_SECONDS * 2);
		if (!fresh) return fail(c, 401, "requisicao_repetida", "Esta requisição já foi processada.");

		c.set("body", body);
		c.set("actor", `pareamento:${pairingId}`);
		await background(c, store.touchPairing(c.env.DB, pairingId));
		if (Math.random() < 0.05) await background(c, store.purgeNonces(c.env.DB));
		await next();
	});

	app.get("/v1/health", async (c) => {
		const [certificate, allowProduction] = await Promise.all([
			store.getCertificateInfo(c.env.DB),
			store.getAllowProduction(c.env.DB),
		]);
		return c.json<HealthResponse>({
			ok: true,
			version: VAULT_VERSION,
			protocol: PROTOCOL_VERSION,
			certificate,
			allowProduction,
		});
	});

	/** Carrega o certificado ou responde por que não dá para usá-lo. */
	async function usableCertificate(c: C) {
		const cert = await store.loadCertificate(c.env.DB, c.env.VAULT_SECRET);
		if (!cert) {
			return { error: fail(c, 409, "certificado_ausente", "Nenhum certificado instalado no cofre.") };
		}
		if (Date.parse(cert.info.notAfter) < Date.now()) {
			return { error: fail(c, 409, "certificado_vencido", "O certificado instalado venceu.") };
		}
		return { cert };
	}

	app.post("/v1/sign", async (c) => {
		const input = parseJson<Partial<SignRequest>>(c.get("body"));
		if (
			!input ||
			typeof input.xml !== "string" ||
			typeof input.tag !== "string" ||
			!SIGNABLE_TAGS.includes(input.tag) ||
			(input.profile !== "rsa-sha1" && input.profile !== "rsa-sha256")
		) {
			return fail(c, 400, "requisicao_invalida", "Informe xml, tag e profile válidos.");
		}
		const { cert, error } = await usableCertificate(c);
		if (!cert) return error;

		try {
			const out = signXml({
				xml: input.xml,
				tag: input.tag,
				profile: input.profile,
				privateKeyPem: cert.secrets.privateKeyPem,
				certificatePem: cert.secrets.certificatePem,
				holder: cert.holder,
				allowProduction: await store.getAllowProduction(c.env.DB),
			});
			await store.audit(c.env.DB, {
				action: "assinar",
				actor: c.get("actor"),
				outcome: "ok",
				detail: { tag: input.tag, id: out.id, environment: out.environment },
			});
			return c.json<SignResponse>(out);
		} catch (err) {
			if (!(err instanceof SignError)) throw err;
			await store.audit(c.env.DB, {
				action: "assinar",
				actor: c.get("actor"),
				outcome: err.code,
				detail: { tag: input.tag },
			});
			return fail(c, 422, err.code, err.message);
		}
	});

	app.post("/v1/transmit", async (c) => {
		const input = parseJson<Partial<TransmitRequest>>(c.get("body"));
		if (!input || typeof input.url !== "string") {
			return fail(c, 400, "requisicao_invalida", "Informe a url de destino.");
		}
		const request = input as TransmitRequest;
		const actor = c.get("actor");
		let host = "?";
		try {
			host = assertTransmittable(request).hostname;
			const { cert, error } = await usableCertificate(c);
			if (!cert) return error;

			const result = await makeTransport(c.env).transmit(request, cert.secrets);
			// O diário é gravado ANTES de responder: se a central cair agora, a
			// resposta do governo (inclusive uma autorização) já está no R2 do emitente.
			const journalKey = await store.writeJournal(c.env.DOCS, {
				at: new Date().toISOString(),
				actor,
				ref: request.ref ?? null,
				request: {
					url: request.url,
					method: request.method ?? "POST",
					headers: request.headers ?? {},
					bodyB64: request.bodyB64 ?? null,
				},
				response: result,
			});
			await store.audit(c.env.DB, {
				action: "transmitir",
				actor,
				outcome: "ok",
				detail: { host, status: result.status, ms: result.ms, journalKey, ref: request.ref ?? null },
			});
			return c.json<TransmitResponse>({ ...result, journalKey });
		} catch (err) {
			if (!(err instanceof TransportError)) throw err;
			await store.audit(c.env.DB, {
				action: "transmitir",
				actor,
				outcome: err.code,
				detail: { host, ref: request.ref ?? null },
			});
			const status = (STATUSES.includes(err.status) ? err.status : 502) as Status;
			return fail(c, status, err.code, err.message);
		}
	});

	app.get("/v1/documents", async (c) => {
		const before = Number(c.req.query("before"));
		const limit = Number(c.req.query("limit"));
		const documents = await store.listDocuments(c.env.DB, {
			prefix: c.req.query("prefix"),
			limit: Number.isFinite(limit) ? limit : undefined,
			before: Number.isFinite(before) && before > 0 ? before : undefined,
		});
		return c.json({ documents });
	});

	const documentKey = (c: C) => {
		try {
			return decodeURIComponent(new URL(c.req.url).pathname.slice("/v1/documents/".length));
		} catch {
			return "";
		}
	};

	app.put("/v1/documents/*", async (c) => {
		const key = documentKey(c);
		if (!store.isValidDocumentKey(key)) {
			return fail(c, 400, "chave_invalida", "Chave de documento inválida.");
		}
		const body = c.get("body");
		if (body.byteLength === 0) return fail(c, 400, "requisicao_invalida", "Documento vazio.");
		let meta: Record<string, unknown> = {};
		const rawMeta = c.req.header("x-nfapi-meta");
		if (rawMeta) {
			const parsed = rawMeta.length <= 4096 ? parseJson<Record<string, unknown>>(new TextEncoder().encode(rawMeta).buffer as ArrayBuffer) : undefined;
			if (!parsed) return fail(c, 400, "requisicao_invalida", "x-nfapi-meta precisa ser JSON de até 4 KB.");
			meta = parsed;
		}
		const entry = await store.putDocument(c.env.DB, c.env.DOCS, {
			key,
			body,
			contentType: c.req.header("content-type") ?? "application/octet-stream",
			meta,
		});
		await store.audit(c.env.DB, {
			action: "documento.gravar",
			actor: c.get("actor"),
			outcome: "ok",
			detail: { key, size: entry.size },
		});
		return c.json({ document: entry });
	});

	app.get("/v1/documents/*", async (c) => {
		const key = documentKey(c);
		if (!store.isValidDocumentKey(key)) {
			return fail(c, 400, "chave_invalida", "Chave de documento inválida.");
		}
		const object = await store.getDocument(c.env.DOCS, key);
		if (!object) return fail(c, 404, "nao_encontrado", "Documento inexistente.");
		return c.body(object.body, 200, {
			"content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
			"content-length": String(object.size),
		});
	});

	return app;
}
