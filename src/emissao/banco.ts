// Emissões e chaves de API no D1 do cofre.

import type { Ambiente } from "../fiscal/dados";
import type { Mensagem } from "../nfse";

export type EmissionStatus =
	| "processando"
	| "autorizada"
	| "rejeitada"
	| "erro"
	| "indefinida"
	| "cancelada";

export interface Emission {
	id: string;
	docId: string;
	kind: "nfse";
	environment: Ambiente;
	reference: string | null;
	serie: string;
	number: number;
	documentId: string;
	status: EmissionStatus;
	accessKey: string | null;
	fiscalNumber: string | null;
	messages: Mensagem[];
	documentKey: string | null;
	journalKey: string | null;
	createdAt: number;
	updatedAt: number;
}

type Row = Record<string, unknown>;
const hex = (bytes: ArrayBuffer | Uint8Array) =>
	[...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function newId(prefix: "nfs" | "chv"): string {
	return `${prefix}_${hex(crypto.getRandomValues(new Uint8Array(10)))}`;
}

const toEmission = (r: Row): Emission => ({
	id: r.id as string,
	docId: r.doc_id as string,
	kind: r.kind as "nfse",
	environment: r.environment as Ambiente,
	reference: (r.reference as string | null) ?? null,
	serie: r.serie as string,
	number: r.number as number,
	documentId: r.document_id as string,
	status: r.status as EmissionStatus,
	accessKey: (r.access_key as string | null) ?? null,
	fiscalNumber: (r.fiscal_number as string | null) ?? null,
	messages: JSON.parse(r.messages as string) as Mensagem[],
	documentKey: (r.document_key as string | null) ?? null,
	journalKey: (r.journal_key as string | null) ?? null,
	createdAt: r.created_at as number,
	updatedAt: r.updated_at as number,
});

export interface SerieKey {
	docId: string;
	kind: "nfse";
	environment: Ambiente;
	serie: string;
}

/** Reserva o próximo número da série, de forma atômica. */
export async function nextNumber(db: D1Database, k: SerieKey): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO series (doc_id, kind, environment, serie, last_number) VALUES (?, ?, ?, ?, 1)
			 ON CONFLICT (doc_id, kind, environment, serie) DO UPDATE SET last_number = last_number + 1
			 RETURNING last_number`,
		)
		.bind(k.docId, k.kind, k.environment, k.serie)
		.first<{ last_number: number }>();
	if (!row) throw new Error("Falha ao reservar o número da série.");
	return row.last_number;
}

/** Quando o cliente informa o número, a série avança para não reutilizá-lo depois. */
export async function noteNumber(db: D1Database, k: SerieKey, number: number): Promise<void> {
	await db
		.prepare(
			`INSERT INTO series (doc_id, kind, environment, serie, last_number) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (doc_id, kind, environment, serie)
			 DO UPDATE SET last_number = MAX(last_number, excluded.last_number)`,
		)
		.bind(k.docId, k.kind, k.environment, k.serie, number)
		.run();
}

/** Grava a emissão. Devolve false se o número (ou a referência) já estiver em uso. */
export async function insertEmission(db: D1Database, e: Emission): Promise<boolean> {
	try {
		await db
			.prepare(
				`INSERT INTO emissions (id, doc_id, kind, environment, reference, serie, number, document_id,
				 status, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
			)
			.bind(e.id, e.docId, e.kind, e.environment, e.reference, e.serie, e.number, e.documentId, e.status, e.createdAt, e.updatedAt)
			.run();
		return true;
	} catch (err) {
		if (/UNIQUE constraint/i.test(String(err instanceof Error ? err.message : err))) return false;
		throw err;
	}
}

export async function updateEmission(
	db: D1Database,
	id: string,
	patch: Partial<Pick<Emission, "status" | "accessKey" | "fiscalNumber" | "messages" | "documentKey" | "journalKey" | "documentId">>,
): Promise<Emission> {
	const current = await db.prepare("SELECT * FROM emissions WHERE id = ?").bind(id).first<Row>();
	if (!current) throw new Error(`Emissão ${id} inexistente.`);
	const next = { ...toEmission(current), ...patch, updatedAt: Date.now() };
	await db
		.prepare(
			`UPDATE emissions SET status = ?, access_key = ?, fiscal_number = ?, messages = ?,
			 document_key = ?, journal_key = ?, document_id = ?, updated_at = ? WHERE id = ?`,
		)
		.bind(next.status, next.accessKey, next.fiscalNumber, JSON.stringify(next.messages), next.documentKey, next.journalKey, next.documentId, next.updatedAt, id)
		.run();
	return next;
}

export async function getEmission(db: D1Database, id: string): Promise<Emission | null> {
	const row = await db.prepare("SELECT * FROM emissions WHERE id = ?").bind(id).first<Row>();
	return row ? toEmission(row) : null;
}

export async function findByReference(db: D1Database, k: Omit<SerieKey, "serie">, reference: string): Promise<Emission | null> {
	const row = await db
		.prepare("SELECT * FROM emissions WHERE doc_id = ? AND kind = ? AND environment = ? AND reference = ?")
		.bind(k.docId, k.kind, k.environment, reference)
		.first<Row>();
	return row ? toEmission(row) : null;
}

export async function findByAccessKey(db: D1Database, accessKey: string): Promise<Emission | null> {
	const row = await db.prepare("SELECT * FROM emissions WHERE access_key = ?").bind(accessKey).first<Row>();
	return row ? toEmission(row) : null;
}

export async function listEmissions(db: D1Database, limit: number): Promise<Emission[]> {
	const { results } = await db
		.prepare("SELECT * FROM emissions ORDER BY created_at DESC, rowid DESC LIMIT ?")
		.bind(Math.min(Math.max(limit, 1), 200))
		.all<Row>();
	return results.map(toEmission);
}

// ---------- Chaves de API ----------

export type Escopo = "completo" | "homologacao";

export interface ApiKey {
	id: string;
	name: string;
	prefix: string;
	scope: Escopo;
	createdAt: number;
	lastUsedAt: number | null;
	revokedAt: number | null;
}

const toApiKey = (r: Row): ApiKey => ({
	id: r.id as string,
	name: r.name as string,
	prefix: r.prefix as string,
	scope: r.scope as Escopo,
	createdAt: r.created_at as number,
	lastUsedAt: (r.last_used_at as number | null) ?? null,
	revokedAt: (r.revoked_at as number | null) ?? null,
});

export function looksLikeApiKey(value: string): boolean {
	return /^nfapi_[A-Za-z0-9_-]{40,60}$/.test(value);
}

async function hashKey(key: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
}

/** Cria uma chave. O valor completo só existe no retorno desta função. */
export async function createApiKey(db: D1Database, name: string, scope: Escopo): Promise<{ key: ApiKey; value: string }> {
	const random = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const value = `nfapi_${random}`;
	const key: ApiKey = { id: newId("chv"), name, prefix: value.slice(0, 12), scope, createdAt: Date.now(), lastUsedAt: null, revokedAt: null };
	await db
		.prepare("INSERT INTO api_keys (id, name, prefix, key_hash, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(key.id, key.name, key.prefix, await hashKey(value), key.scope, key.createdAt)
		.run();
	return { key, value };
}

export async function findApiKey(db: D1Database, value: string): Promise<ApiKey | null> {
	if (!looksLikeApiKey(value)) return null;
	const row = await db
		.prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
		.bind(await hashKey(value))
		.first<Row>();
	return row ? toApiKey(row) : null;
}

export async function touchApiKey(db: D1Database, id: string): Promise<void> {
	await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(Date.now(), id).run();
}

export async function listApiKeys(db: D1Database): Promise<ApiKey[]> {
	const { results } = await db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all<Row>();
	return results.map(toApiKey);
}

export async function revokeApiKey(db: D1Database, id: string): Promise<boolean> {
	const res = await db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(Date.now(), id).run();
	return res.meta.changes > 0;
}
