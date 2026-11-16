// API de NFS-e do cofre: é por aqui que os sistemas do emitente (ERP, loja,
// Wabotia etc.) emitem, consultam e cancelam notas, com uma chave de API criada
// na tela /setup. Tudo roda dentro do cofre; não há serviço intermediário.
//
//   POST /v1/nfse                  emite
//   GET  /v1/nfse                  lista
//   GET  /v1/nfse/:id              consulta
//   GET  /v1/nfse/:id/xml          XML da NFS-e
//   POST /v1/nfse/:id/cancelar     cancela
//
// As respostas e os erros desta API usam nomes em português.

import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Ctx } from "./app";
import * as banco from "./emissao/banco";
import { cancelarNfse, emitirNfse } from "./emissao/nfse";
import { CancelamentoInput, NfseInput } from "./nfse";
import { OperacaoError, abrirOperacoes } from "./operacoes";
import * as store from "./store";
import type { Transport } from "./transport";

type C = Context<Ctx>;
type Status = 400 | 401 | 403 | 404 | 409 | 422 | 502;

const erro = (c: C, status: Status, codigo: string, mensagem: string, extra: Record<string, unknown> = {}) =>
	c.json({ erro: { codigo, mensagem }, ...extra }, status);

const iso = (ms: number) => new Date(ms).toISOString();

export const nfseJson = (e: banco.Emission) => ({
	id: e.id,
	ambiente: e.environment,
	referencia: e.reference,
	serie: e.serie,
	numero: e.number,
	idDps: e.documentId,
	situacao: e.status,
	chaveAcesso: e.accessKey,
	numeroNfse: e.fiscalNumber,
	mensagens: e.messages,
	xmlDisponivel: e.documentKey !== null,
	criadaEm: iso(e.createdAt),
	atualizadaEm: iso(e.updatedAt),
});

const chaveJson = (k: banco.ApiKey) => ({
	id: k.id,
	nome: k.name,
	prefixo: k.prefix,
	escopo: k.scope,
	criadaEm: iso(k.createdAt),
	ultimoUso: k.lastUsedAt ? iso(k.lastUsedAt) : null,
	revogadaEm: k.revokedAt ? iso(k.revokedAt) : null,
});

const EmitirNfse = NfseInput.extend({
	ambiente: z.enum(["homologacao", "producao"]).default("homologacao"),
	/** Identificador do pedido no sistema cliente: reenviar a mesma referência nunca gera duas notas. */
	referencia: z
		.string()
		.regex(/^[A-Za-z0-9._:-]{1,80}$/, "referencia: letras, números e . _ : - (até 80)")
		.optional(),
});

function problema(error: z.ZodError): string {
	const issue = error.issues[0];
	const campo = issue?.path.join(".");
	return campo ? `Campo "${campo}": ${issue?.message}` : (issue?.message ?? "Requisição inválida.");
}

async function autenticar(c: C): Promise<banco.ApiKey | Response> {
	const header = c.req.header("authorization") ?? "";
	const valor = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
	const chave = await banco.findApiKey(c.env.DB, valor);
	if (!chave) return erro(c, 401, "nao_autenticado", "Envie uma chave de API válida em Authorization: Bearer.");
	await banco.touchApiKey(c.env.DB, chave.id).catch(() => undefined);
	return chave;
}

/** Abre as operações do cofre ou responde por que não é possível. */
async function operacoes(c: C, transport: Transport, ator: string) {
	try {
		return await abrirOperacoes(c.env, transport, ator);
	} catch (err) {
		if (!(err instanceof OperacaoError)) throw err;
		return erro(c, 409, err.code, err.message);
	}
}

export function registrarApiNfse(app: Hono<Ctx>, makeTransport: (env: AppEnv) => Transport) {
	app.post("/v1/nfse", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const input = EmitirNfse.safeParse(await c.req.json().catch(() => null));
		if (!input.success) return erro(c, 400, "requisicao_invalida", problema(input.error));
		const { ambiente, referencia, ...pedido } = input.data;

		// Chave de teste: serve para homologação e para a IA validar atualizações.
		if (chave.scope === "homologacao" && ambiente !== "homologacao") {
			return erro(c, 403, "chave_somente_homologacao", "Esta chave de API só emite em homologação.");
		}

		const ops = await operacoes(c, makeTransport(c.env), `chave:${chave.id}`);
		if (ops instanceof Response) return ops;
		const r = await emitirNfse(c.env.DB, ops, { ambiente, referencia, pedido });
		switch (r.tipo) {
			case "autorizada":
				return c.json(nfseJson(r.emission), r.nova ? 201 : 200);
			case "conflito":
				return erro(c, 409, r.codigo, r.mensagem);
			case "nao_autorizada":
				return erro(c, r.status, r.codigo, r.mensagem, { nfse: nfseJson(r.emission) });
		}
	});

	app.get("/v1/nfse", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const limite = Number(c.req.query("limite") ?? 50);
		const lista = await banco.listEmissions(c.env.DB, Number.isFinite(limite) ? limite : 50);
		return c.json({ nfse: lista.map(nfseJson) });
	});

	app.get("/v1/nfse/:id", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const emission = await banco.getEmission(c.env.DB, c.req.param("id"));
		if (!emission) return erro(c, 404, "nao_encontrado", "Emissão inexistente.");
		return c.json(nfseJson(emission));
	});

	app.get("/v1/nfse/:id/xml", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const emission = await banco.getEmission(c.env.DB, c.req.param("id"));
		if (!emission?.documentKey) return erro(c, 404, "nao_encontrado", "XML indisponível para esta emissão.");
		const object = await store.getDocument(c.env.DOCS, emission.documentKey);
		if (!object) return erro(c, 404, "nao_encontrado", "O XML não está mais no cofre.");
		return c.body(object.body, 200, { "content-type": "application/xml; charset=utf-8" });
	});

	app.post("/v1/nfse/:id/cancelar", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const input = CancelamentoInput.safeParse(await c.req.json().catch(() => null));
		if (!input.success) return erro(c, 400, "requisicao_invalida", problema(input.error));
		const emission = await banco.getEmission(c.env.DB, c.req.param("id"));
		if (!emission) return erro(c, 404, "nao_encontrado", "Emissão inexistente.");
		if (chave.scope === "homologacao" && emission.environment !== "homologacao") {
			return erro(c, 403, "chave_somente_homologacao", "Esta chave de API só opera em homologação.");
		}

		const ops = await operacoes(c, makeTransport(c.env), `chave:${chave.id}`);
		if (ops instanceof Response) return ops;
		const r = await cancelarNfse(c.env.DB, ops, emission, input.data);
		if (!r.ok) return erro(c, r.status, r.codigo, r.mensagem, { mensagens: r.mensagens });
		return c.json(nfseJson(r.emission));
	});

	// ---------- Chaves de API (tela /setup) ----------

	app.get("/admin/chaves", async (c) => c.json({ chaves: (await banco.listApiKeys(c.env.DB)).map(chaveJson) }));

	app.post("/admin/chaves", async (c) => {
		const input = z
			.object({
				nome: z.string().trim().min(1).max(80).default("Chave de API"),
				escopo: z.enum(["completo", "homologacao"]).default("completo"),
			})
			.safeParse((await c.req.json().catch(() => null)) ?? {});
		if (!input.success) return erro(c, 400, "requisicao_invalida", problema(input.error));
		const { key, value } = await banco.createApiKey(c.env.DB, input.data.nome, input.data.escopo);
		await store.audit(c.env.DB, {
			action: "chave.criar",
			actor: "admin",
			outcome: "ok",
			detail: { chave: key.id, nome: key.name, escopo: key.scope },
		});
		// O valor completo só existe nesta resposta.
		return c.json({ chave: { ...chaveJson(key), valor: value } }, 201);
	});

	app.delete("/admin/chaves/:id", async (c) => {
		const id = c.req.param("id");
		if (!(await banco.revokeApiKey(c.env.DB, id))) {
			return erro(c, 404, "nao_encontrado", "Chave inexistente ou já revogada.");
		}
		await store.audit(c.env.DB, { action: "chave.revogar", actor: "admin", outcome: "ok", detail: { chave: id } });
		return c.json({ ok: true });
	});
}

/**
 * Cancelamento pedido pelo painel do emitente. Devolve null quando a nota não
 * foi emitida por este cofre.
 */
export async function cancelarPeloPainel(
	c: C,
	transport: Transport,
	chaveAcesso: string,
	dados: unknown,
): Promise<Response | null> {
	const emission = await banco.findByAccessKey(c.env.DB, chaveAcesso);
	if (!emission) return null;
	const input = CancelamentoInput.safeParse(dados);
	// O painel usa o formato de erro das rotas /admin.
	const recusar = (status: Status, code: string, message: string) => c.json({ error: { code, message } }, status);
	if (!input.success) return recusar(400, "requisicao_invalida", problema(input.error));

	let ops: Awaited<ReturnType<typeof abrirOperacoes>>;
	try {
		ops = await abrirOperacoes(c.env, transport, "admin");
	} catch (err) {
		if (!(err instanceof OperacaoError)) throw err;
		return recusar(409, err.code, err.message);
	}
	const r = await cancelarNfse(c.env.DB, ops, emission, input.data);
	await store.audit(c.env.DB, {
		action: "nota.cancelar",
		actor: "admin",
		outcome: r.ok ? "ok" : r.codigo,
		detail: { chaveAcesso, motivo: input.data.motivo },
	});
	if (!r.ok) {
		const detalhes = r.mensagens.map((m) => `[${m.codigo}] ${m.descricao}`).join(" ");
		return recusar(r.status, r.codigo, detalhes || r.mensagem);
	}
	return c.json({ nfse: nfseJson(r.emission), jaCancelada: r.jaCancelada });
}
