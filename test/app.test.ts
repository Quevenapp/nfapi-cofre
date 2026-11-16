import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
	type PairingCode,
	type TransmitRequest,
	decodePairingCode,
	fromHex,
	signRequest,
} from "../src/protocol";
import type { CertificateSecrets } from "../src/store";
import type { Transport, TransportResult } from "../src/transport";
import { CNPJ_TESTE, SENHA_TESTE, pfxModerno } from "./helpers";

const ORIGIN = "https://cofre.exemplo.workers.dev";
const encoder = new TextEncoder();

/** Transporte simulado: registra o que recebeu e devolve uma resposta fixa. */
class FakeTransport implements Transport {
	calls: { request: TransmitRequest; cert: CertificateSecrets }[] = [];
	async transmit(request: TransmitRequest, cert: CertificateSecrets): Promise<TransportResult> {
		this.calls.push({ request, cert });
		return {
			status: 200,
			headers: { "content-type": "application/soap+xml" },
			bodyB64: btoa("<retorno><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo></retorno>"),
			tls: { protocol: "TLSv1.2", cipher: "TESTE", peerIssuer: "AC TESTE" },
			ms: 12,
		};
	}
}

let transport: FakeTransport;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
	transport = new FakeTransport();
	app = createApp(() => transport);
	// O D1 local persiste entre os testes do arquivo: cada caso começa do zero.
	await env.DB.batch(
		["certificate", "pairing", "nonces", "settings", "audit", "documents"].map((t) =>
			env.DB.prepare(`DELETE FROM ${t}`),
		),
	);
});

const admin = (path: string, init: RequestInit = {}) =>
	app.request(
		ORIGIN + path,
		{ ...init, headers: { ...init.headers, authorization: `Bearer ${env.VAULT_SECRET}` } },
		env,
	);

async function instalarCertificado(senha = SENHA_TESTE) {
	const form = new FormData();
	form.append("pfx", new File([pfxModerno()], "a1.pfx"));
	form.append("password", senha);
	return admin("/admin/certificate", { method: "POST", body: form });
}

async function parear(): Promise<PairingCode> {
	const res = await admin("/admin/pairings", {
		method: "POST",
		body: JSON.stringify({ label: "teste" }),
	});
	const { code } = (await res.json()) as { code: string };
	return decodePairingCode(code);
}

async function central(
	pairing: PairingCode,
	method: string,
	path: string,
	body: string | Uint8Array<ArrayBuffer> = "",
	extra: { headers?: Record<string, string>; now?: number; tamper?: boolean } = {},
) {
	const bytes = typeof body === "string" ? encoder.encode(body) : body;
	const auth = await signRequest({
		key: fromHex(pairing.key),
		pairingId: pairing.id,
		method,
		path,
		body: bytes,
		now: extra.now,
	});
	const sent = extra.tamper ? encoder.encode(`${new TextDecoder().decode(bytes)} `) : bytes;
	const init: RequestInit = { method, headers: { ...auth, ...extra.headers } };
	if (method !== "GET" && method !== "HEAD") init.body = sent;
	return { res: await app.request(ORIGIN + path, init, env), auth };
}

const erro = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

const NFE = (tpAmb: 1 | 2, cnpj = CNPJ_TESTE) =>
	`<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe35261111222333000181550010000000011000000015" versao="4.00">` +
	`<ide><cUF>35</cUF><tpAmb>${tpAmb}</tpAmb></ide><emit><CNPJ>${cnpj}</CNPJ></emit></infNFe></NFe>`;

describe("acesso", () => {
	it("expõe só o mínimo sem autenticação", async () => {
		const health = await app.request(`${ORIGIN}/health`, {}, env);
		expect(await health.json()).toEqual({ ok: true, version: "0.1.0", protocol: 1 });

		const setup = await app.request(`${ORIGIN}/setup`, {}, env);
		expect(setup.status).toBe(200);
		expect(setup.headers.get("content-security-policy")).toContain("script-src 'self'");
		expect(await setup.text()).toContain("Cofre NFapi");
	});

	it("exige o segredo do cofre nas rotas de administração", async () => {
		expect((await app.request(`${ORIGIN}/admin/status`, {}, env)).status).toBe(401);
		const errado = await app.request(
			`${ORIGIN}/admin/status`,
			{ headers: { authorization: "Bearer segredo-errado" } },
			env,
		);
		expect(errado.status).toBe(401);
		expect((await admin("/admin/status")).status).toBe(200);
	});

	it("recusa operar com VAULT_SECRET fraco", async () => {
		const res = await app.request(
			`${ORIGIN}/admin/status`,
			{ headers: { authorization: "Bearer curto" } },
			{ ...env, VAULT_SECRET: "curto" },
		);
		expect(res.status).toBe(503);
		expect(await erro(res)).toBe("cofre_nao_configurado");
	});
});

describe("certificado", () => {
	it("instala o PFX, mostra o titular e guarda a chave cifrada", async () => {
		const res = await instalarCertificado();
		expect(res.status).toBe(200);

		const status = (await (await admin("/admin/status")).json()) as {
			certificate: { holder: { id: string }; commonName: string };
		};
		expect(status.certificate.holder.id).toBe(CNPJ_TESTE);

		const row = await env.DB.prepare("SELECT * FROM certificate").first<Record<string, unknown>>();
		const dump = JSON.stringify(row);
		expect(dump).not.toContain("PRIVATE KEY");
		expect(dump).not.toContain(SENHA_TESTE);
	});

	it("informa senha incorreta sem instalar nada", async () => {
		const res = await instalarCertificado("senha-errada");
		expect(res.status).toBe(422);
		expect(await erro(res)).toBe("senha_incorreta");
		expect(await env.DB.prepare("SELECT id FROM certificate").first()).toBeNull();
	});
});

describe("autenticação da API central", () => {
	it("aceita requisição assinada e recusa repetição, adulteração, relógio e revogação", async () => {
		const pairing = await parear();
		expect(pairing.url).toBe(ORIGIN);

		const ok = await central(pairing, "GET", "/v1/health");
		expect(ok.res.status).toBe(200);

		// Mesmos cabeçalhos de novo: repetição.
		const replay = await app.request(`${ORIGIN}/v1/health`, { headers: ok.auth }, env);
		expect(await erro(replay)).toBe("requisicao_repetida");

		const adulterada = await central(pairing, "POST", "/v1/sign", "{}", { tamper: true });
		expect(adulterada.res.status).toBe(401);

		const antiga = await central(pairing, "GET", "/v1/health", "", { now: Date.now() - 3_600_000 });
		expect(await erro(antiga.res)).toBe("relogio_fora_de_sincronia");

		const chaveErrada = await central({ ...pairing, key: "00".repeat(32) }, "GET", "/v1/health");
		expect(chaveErrada.res.status).toBe(401);

		expect((await app.request(`${ORIGIN}/v1/health`, {}, env)).status).toBe(401);

		await admin(`/admin/pairings/${pairing.id}`, { method: "DELETE" });
		expect((await central(pairing, "GET", "/v1/health")).res.status).toBe(401);
	});
});

describe("assinar", () => {
	const assinar = (pairing: PairingCode, xml: string) =>
		central(pairing, "POST", "/v1/sign", JSON.stringify({ xml, tag: "infNFe", profile: "rsa-sha1" }));

	it("assina homologação e mantém produção bloqueada até o emitente liberar", async () => {
		await instalarCertificado();
		const pairing = await parear();

		const hom = await assinar(pairing, NFE(2));
		expect(hom.res.status).toBe(200);
		const out = (await hom.res.json()) as { xml: string; environment: string };
		expect(out.environment).toBe("homologacao");
		expect(out.xml).toContain("<SignatureValue>");

		const prod = await assinar(pairing, NFE(1));
		expect(prod.res.status).toBe(422);
		expect(await erro(prod.res)).toBe("producao_bloqueada");

		await admin("/admin/settings", { method: "PUT", body: JSON.stringify({ allowProduction: true }) });
		expect((await assinar(pairing, NFE(1))).res.status).toBe(200);
	});

	it("recusa documento de outro emitente e pedido sem certificado", async () => {
		const pairing = await parear();
		const semCert = await assinar(pairing, NFE(2));
		expect(await erro(semCert.res)).toBe("certificado_ausente");

		await instalarCertificado();
		const outro = await assinar(pairing, NFE(2, "99888777000166"));
		expect(await erro(outro.res)).toBe("emitente_divergente");
	});
});

describe("transmitir", () => {
	const transmitir = (pairing: PairingCode, url: string) =>
		central(pairing, "POST", "/v1/transmit", JSON.stringify({ url, bodyB64: btoa("<envelope/>"), ref: "emissao-1" }));

	it("só transmite para o governo e grava o diário antes de responder", async () => {
		await instalarCertificado();
		const pairing = await parear();

		for (const url of ["https://evil.example.com/x", "https://gov.br.evil.com/x", "http://nfe.svrs.rs.gov.br/x"]) {
			const fora = await transmitir(pairing, url);
			expect(fora.res.status).toBeGreaterThanOrEqual(400);
		}
		expect(transport.calls).toHaveLength(0);

		const { res } = await transmitir(pairing, "https://nfe-homologacao.svrs.rs.gov.br/ws/NFeAutorizacao4");
		expect(res.status).toBe(200);
		const out = (await res.json()) as { status: number; journalKey: string };
		expect(out.status).toBe(200);

		// O Container recebeu o certificado decifrado...
		expect(transport.calls).toHaveLength(1);
		expect(transport.calls[0]?.cert.privateKeyPem).toContain("BEGIN PRIVATE KEY");
		// ...e a troca completa ficou no R2 do emitente, sem material de chave.
		const journal = await env.DOCS.get(out.journalKey);
		const text = (await journal?.text()) ?? "";
		expect(text).toContain("emissao-1");
		expect(text).toContain("nfe-homologacao.svrs.rs.gov.br");
		expect(text).not.toContain("PRIVATE KEY");
	});
});

describe("documentos", () => {
	it("grava, lê e lista; recusa chaves que escapam da área de documentos", async () => {
		const pairing = await parear();
		const xml = "<nfeProc>autorizada</nfeProc>";
		const key = "nfe/2026/11/35261111222333000181550010000000011000000015-procNFe.xml";

		const put = await central(pairing, "PUT", `/v1/documents/${key}`, xml, {
			headers: { "content-type": "application/xml", "x-nfapi-meta": JSON.stringify({ modelo: 55 }) },
		});
		expect(put.res.status).toBe(200);

		const get = await central(pairing, "GET", `/v1/documents/${key}`);
		expect(get.res.headers.get("content-type")).toBe("application/xml");
		expect(await get.res.text()).toBe(xml);

		const list = await central(pairing, "GET", "/v1/documents?prefix=nfe/2026/");
		const { documents } = (await list.res.json()) as { documents: { key: string; meta: unknown }[] };
		expect(documents).toHaveLength(1);
		expect(documents[0]?.meta).toEqual({ modelo: 55 });

		for (const ruim of ["journal/2026/x.json", "nfe/..%2F..%2Fsegredo", "%2Fabsoluto"]) {
			const res = await central(pairing, "PUT", `/v1/documents/${ruim}`, "x");
			expect(await erro(res.res)).toBe("chave_invalida");
		}
		expect((await central(pairing, "GET", "/v1/documents/nao/existe.xml")).res.status).toBe(404);
	});
});

describe("cadastro na API (Criar minha conta)", () => {
	type Chamada = { url: string; body: { codigoPareamento: string; email: string } };

	/** Cofre ligado a uma API simulada que responde o que o teste mandar. */
	function comApi(resposta: () => Response) {
		const chamadas: Chamada[] = [];
		const cofre = createApp(() => transport, {
			fetch: async (input, init) => {
				chamadas.push({ url: String(input), body: JSON.parse(String(init?.body)) as Chamada["body"] });
				return resposta();
			},
		});
		const registrar = (body: unknown) =>
			cofre.request(
				`${ORIGIN}/admin/register`,
				{ method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${env.VAULT_SECRET}` } },
				env,
			);
		return { chamadas, registrar };
	}
	const ativos = async () =>
		(await env.DB.prepare("SELECT COUNT(*) AS n FROM pairing WHERE revoked_at IS NULL").first<{ n: number }>())?.n;

	it("entrega o código de pareamento à API e devolve a chave ao emitente", async () => {
		await instalarCertificado();
		const { chamadas, registrar } = comApi(() =>
			Response.json({ conta: { id: "cta_1", nome: "Empresa" }, chave: { chave: "nfapi_chave-de-teste" }, emitente: { id: "emi_1" } }, { status: 201 }),
		);
		const res = await registrar({ email: "dono@exemplo.test" });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ api: "https://api.nfapi.queven.app", chave: "nfapi_chave-de-teste" });

		// Sem endereço informado, usa a API padrão; o código aponta para este cofre.
		expect(chamadas).toHaveLength(1);
		expect(chamadas[0]?.url).toBe("https://api.nfapi.queven.app/v1/cadastro");
		expect(chamadas[0]?.body.email).toBe("dono@exemplo.test");
		expect(decodePairingCode(chamadas[0]?.body.codigoPareamento ?? "").url).toBe(ORIGIN);
		expect(await ativos()).toBe(1);

		const auditoria = await env.DB.prepare("SELECT detail FROM audit WHERE action = 'cadastro'").first<{ detail: string }>();
		expect(auditoria?.detail).not.toContain("nfapi_chave-de-teste");
	});

	it("se a API recusar, repassa o motivo e revoga o pareamento criado", async () => {
		await instalarCertificado();
		const { registrar } = comApi(() =>
			Response.json({ erro: { codigo: "email_ja_cadastrado", mensagem: "Já existe uma conta com este e-mail." } }, { status: 409 }),
		);
		const res = await registrar({ email: "dono@exemplo.test" });
		expect(res.status).toBe(409);
		expect(await erro(res)).toBe("email_ja_cadastrado");
		expect(await ativos()).toBe(0);
	});

	it("não chama a API sem certificado, com e-mail inválido ou com endereço inseguro", async () => {
		const { chamadas, registrar } = comApi(() => Response.json({}, { status: 500 }));
		expect(await erro(await registrar({ email: "dono@exemplo.test" }))).toBe("certificado_ausente");

		await instalarCertificado();
		expect((await registrar({ email: "sem-arroba" })).status).toBe(400);
		expect((await registrar({ email: "dono@exemplo.test", apiUrl: "http://api.exemplo.test" })).status).toBe(400);
		expect((await registrar({ email: "dono@exemplo.test", apiUrl: "nao é url" })).status).toBe(400);
		expect(chamadas).toHaveLength(0);
		expect(await ativos()).toBe(0);
	});
});

describe("auditoria", () => {
	it("registra as operações sem guardar conteúdo de documento", async () => {
		await instalarCertificado();
		const pairing = await parear();
		await central(pairing, "POST", "/v1/sign", JSON.stringify({ xml: NFE(2), tag: "infNFe", profile: "rsa-sha1" }));

		const res = await admin("/admin/audit");
		const { entries } = (await res.json()) as { entries: { action: string; outcome: string }[] };
		expect(entries.map((e) => e.action)).toEqual(["assinar", "pareamento.criar", "certificado.instalar"]);
		expect(JSON.stringify(entries)).not.toContain("<infNFe");
	});
});
