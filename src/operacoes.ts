// Operações locais do cofre: assinar, transmitir e arquivar, usadas pelo fluxo
// de emissão que roda dentro do próprio cofre. As mesmas travas de sempre valem
// aqui: só documentos do titular do certificado, só endereços do governo, e
// produção apenas quando liberada na tela /setup.

import type { Holder } from "./pfx";
import type { SignRequest, SignResponse, TransmitRequest, TransmitResponse } from "./protocol";
import { SignError, signXml } from "./signer";
import * as store from "./store";
import { type Transport, TransportError, assertTransmittable } from "./transport";

/** Falha de uma operação do cofre, com código estável para quem chama. */
export class OperacaoError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "OperacaoError";
		this.status = status;
		this.code = code;
	}
}

export interface Operacoes {
	/** Titular do certificado instalado. */
	holder: Holder;
	sign(request: SignRequest): Promise<SignResponse>;
	transmit(request: TransmitRequest): Promise<TransmitResponse>;
	putDocument(key: string, body: string, options: { contentType: string; meta?: Record<string, unknown> }): Promise<void>;
}

interface Bindings {
	DB: D1Database;
	DOCS: R2Bucket;
	VAULT_SECRET: string;
}

/** Abre o certificado uma vez e devolve as operações que o usam. */
export async function abrirOperacoes(env: Bindings, transport: Transport, actor: string): Promise<Operacoes> {
	const cert = await store.loadCertificate(env.DB, env.VAULT_SECRET);
	if (!cert) throw new OperacaoError(409, "certificado_ausente", "Nenhum certificado instalado no cofre.");
	if (Date.parse(cert.info.notAfter) < Date.now()) {
		throw new OperacaoError(409, "certificado_vencido", "O certificado instalado venceu.");
	}

	return {
		holder: cert.holder,

		async sign(request) {
			try {
				const out = signXml({
					xml: request.xml,
					tag: request.tag,
					profile: request.profile,
					privateKeyPem: cert.secrets.privateKeyPem,
					certificatePem: cert.secrets.certificatePem,
					holder: cert.holder,
					allowProduction: await store.getAllowProduction(env.DB),
				});
				await store.audit(env.DB, {
					action: "assinar",
					actor,
					outcome: "ok",
					detail: { tag: request.tag, id: out.id, environment: out.environment },
				});
				return out;
			} catch (err) {
				if (!(err instanceof SignError)) throw err;
				await store.audit(env.DB, { action: "assinar", actor, outcome: err.code, detail: { tag: request.tag } });
				throw new OperacaoError(422, err.code, err.message);
			}
		},

		async transmit(request) {
			let host = "?";
			try {
				host = assertTransmittable(request).hostname;
				const result = await transport.transmit(request, cert.secrets);
				// O diário é gravado antes de seguir: a resposta do governo nunca se perde.
				const journalKey = await store.writeJournal(env.DOCS, {
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
				await store.audit(env.DB, {
					action: "transmitir",
					actor,
					outcome: "ok",
					detail: { host, status: result.status, ms: result.ms, journalKey, ref: request.ref ?? null },
				});
				return { ...result, journalKey };
			} catch (err) {
				if (!(err instanceof TransportError)) throw err;
				await store.audit(env.DB, { action: "transmitir", actor, outcome: err.code, detail: { host, ref: request.ref ?? null } });
				throw new OperacaoError(err.status, err.code, err.message);
			}
		},

		async putDocument(key, body, options) {
			await store.putDocument(env.DB, env.DOCS, {
				key,
				body: new TextEncoder().encode(body).buffer as ArrayBuffer,
				contentType: options.contentType,
				meta: options.meta ?? {},
			});
		},
	};
}
