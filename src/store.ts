// Acesso ao D1 (estado do cofre) e ao R2 (documentos e diário de transmissões).

import { decryptJson, encryptJson } from "./crypto";
import type { Holder, ParsedCertificate } from "./pfx";
import { type CertificateInfo, sha256Hex } from "./protocol";

/** Material sensível do certificado; só existe decifrado em memória. */
export interface CertificateSecrets {
	privateKeyPem: string;
	certificatePem: string;
	chainPem: string[];
}

export interface StoredCertificate {
	info: CertificateInfo;
	holder: Holder;
	secrets: CertificateSecrets;
}

interface CertificateRow {
	ciphertext: string;
	iv: string;
	holder_kind: "cnpj" | "cpf";
	holder_id: string;
	common_name: string;
	issuer: string;
	serial_number: string;
	not_before: number;
	not_after: number;
	installed_at: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

function rowToInfo(row: CertificateRow): CertificateInfo {
	return {
		holder: { kind: row.holder_kind, id: row.holder_id },
		commonName: row.common_name,
		issuer: row.issuer,
		serialNumber: row.serial_number,
		notBefore: iso(row.not_before),
		notAfter: iso(row.not_after),
		installedAt: iso(row.installed_at),
	};
}

export async function saveCertificate(
	db: D1Database,
	secret: string,
	cert: ParsedCertificate,
): Promise<CertificateInfo> {
	const secrets: CertificateSecrets = {
		privateKeyPem: cert.privateKeyPem,
		certificatePem: cert.certificatePem,
		chainPem: cert.chainPem,
	};
	const { iv, ciphertext } = await encryptJson(secret, secrets);
	const now = Date.now();
	await db
		.prepare(
			`INSERT OR REPLACE INTO certificate
			 (id, ciphertext, iv, holder_kind, holder_id, common_name, issuer, serial_number, not_before, not_after, installed_at)
			 VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			ciphertext,
			iv,
			cert.holder.kind,
			cert.holder.id,
			cert.commonName,
			cert.issuer,
			cert.serialNumber,
			cert.notBefore.getTime(),
			cert.notAfter.getTime(),
			now,
		)
		.run();
	const info = await getCertificateInfo(db);
	if (!info) throw new Error("Falha ao gravar o certificado.");
	return info;
}

export async function getCertificateInfo(db: D1Database): Promise<CertificateInfo | null> {
	const row = await db.prepare("SELECT * FROM certificate WHERE id = 1").first<CertificateRow>();
	return row ? rowToInfo(row) : null;
}

export async function loadCertificate(
	db: D1Database,
	secret: string,
): Promise<StoredCertificate | null> {
	const row = await db.prepare("SELECT * FROM certificate WHERE id = 1").first<CertificateRow>();
	if (!row) return null;
	const info = rowToInfo(row);
	const secrets = await decryptJson<CertificateSecrets>(secret, row.iv, row.ciphertext);
	return { info, holder: info.holder, secrets };
}

export async function deleteCertificate(db: D1Database): Promise<void> {
	await db.prepare("DELETE FROM certificate WHERE id = 1").run();
}

// ---------- Pareamentos ----------

export interface Pairing {
	id: string;
	label: string;
	createdAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
}

interface PairingRow {
	id: string;
	label: string;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
}

const rowToPairing = (r: PairingRow): Pairing => ({
	id: r.id,
	label: r.label,
	createdAt: iso(r.created_at),
	lastUsedAt: r.last_used_at ? iso(r.last_used_at) : null,
	revokedAt: r.revoked_at ? iso(r.revoked_at) : null,
});

export async function createPairing(db: D1Database, label: string): Promise<Pairing> {
	const id = crypto.randomUUID().replace(/-/g, "");
	const now = Date.now();
	await db
		.prepare("INSERT INTO pairing (id, label, created_at) VALUES (?, ?, ?)")
		.bind(id, label, now)
		.run();
	return { id, label, createdAt: iso(now), lastUsedAt: null, revokedAt: null };
}

export async function listPairings(db: D1Database): Promise<Pairing[]> {
	const { results } = await db
		.prepare("SELECT * FROM pairing ORDER BY created_at DESC")
		.all<PairingRow>();
	return results.map(rowToPairing);
}

export async function isPairingActive(db: D1Database, id: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT id FROM pairing WHERE id = ? AND revoked_at IS NULL")
		.bind(id)
		.first();
	return row !== null;
}

export async function touchPairing(db: D1Database, id: string): Promise<void> {
	await db.prepare("UPDATE pairing SET last_used_at = ? WHERE id = ?").bind(Date.now(), id).run();
}

export async function revokePairing(db: D1Database, id: string): Promise<boolean> {
	const res = await db
		.prepare("UPDATE pairing SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
		.bind(Date.now(), id)
		.run();
	return res.meta.changes > 0;
}

// ---------- Proteção contra repetição ----------

/** Registra o nonce; devolve false se ele já foi usado. */
export async function consumeNonce(db: D1Database, nonce: string, ttlSeconds: number): Promise<boolean> {
	const now = Math.floor(Date.now() / 1000);
	const res = await db
		.prepare("INSERT OR IGNORE INTO nonces (nonce, expires_at) VALUES (?, ?)")
		.bind(nonce, now + ttlSeconds)
		.run();
	return res.meta.changes > 0;
}

export async function purgeNonces(db: D1Database): Promise<void> {
	await db
		.prepare("DELETE FROM nonces WHERE expires_at < ?")
		.bind(Math.floor(Date.now() / 1000))
		.run();
}

// ---------- Configurações ----------

export async function getAllowProduction(db: D1Database): Promise<boolean> {
	const row = await db
		.prepare("SELECT value FROM settings WHERE key = 'allow_production'")
		.first<{ value: string }>();
	return row?.value === "true";
}

export async function setAllowProduction(db: D1Database, allow: boolean): Promise<void> {
	await db
		.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('allow_production', ?)")
		.bind(String(allow))
		.run();
}

// ---------- Auditoria ----------

export interface AuditEntry {
	at: string;
	action: string;
	actor: string;
	outcome: string;
	detail: Record<string, unknown>;
}

export async function audit(
	db: D1Database,
	entry: { action: string; actor: string; outcome: string; detail?: Record<string, unknown> },
): Promise<void> {
	await db
		.prepare("INSERT INTO audit (at, action, actor, outcome, detail) VALUES (?, ?, ?, ?, ?)")
		.bind(Date.now(), entry.action, entry.actor, entry.outcome, JSON.stringify(entry.detail ?? {}))
		.run();
}

export async function listAudit(db: D1Database, limit: number): Promise<AuditEntry[]> {
	const { results } = await db
		.prepare("SELECT at, action, actor, outcome, detail FROM audit ORDER BY id DESC LIMIT ?")
		.bind(Math.min(Math.max(limit, 1), 200))
		.all<{ at: number; action: string; actor: string; outcome: string; detail: string }>();
	return results.map((r) => ({
		at: iso(r.at),
		action: r.action,
		actor: r.actor,
		outcome: r.outcome,
		detail: JSON.parse(r.detail) as Record<string, unknown>,
	}));
}

// ---------- Documentos (R2 + índice no D1) ----------

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,480}$/;

export function isValidDocumentKey(key: string): boolean {
	return KEY_RE.test(key) && !key.includes("..") && !key.includes("//") && !key.startsWith("journal/");
}

export interface DocumentEntry {
	key: string;
	contentType: string;
	size: number;
	sha256: string;
	meta: Record<string, unknown>;
	createdAt: string;
}

export async function putDocument(
	db: D1Database,
	bucket: R2Bucket,
	input: { key: string; body: ArrayBuffer; contentType: string; meta: Record<string, unknown> },
): Promise<DocumentEntry> {
	const sha256 = await sha256Hex(input.body);
	const now = Date.now();
	await bucket.put(`docs/${input.key}`, input.body, {
		httpMetadata: { contentType: input.contentType },
		sha256,
	});
	await db
		.prepare(
			"INSERT OR REPLACE INTO documents (key, content_type, size, sha256, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind(input.key, input.contentType, input.body.byteLength, sha256, JSON.stringify(input.meta), now)
		.run();
	return {
		key: input.key,
		contentType: input.contentType,
		size: input.body.byteLength,
		sha256,
		meta: input.meta,
		createdAt: iso(now),
	};
}

export function getDocument(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
	return bucket.get(`docs/${key}`);
}

export async function listDocuments(
	db: D1Database,
	opts: { prefix?: string; limit?: number; before?: number },
): Promise<DocumentEntry[]> {
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
	const { results } = await db
		.prepare(
			`SELECT key, content_type, size, sha256, meta, created_at FROM documents
			 WHERE key LIKE ? ESCAPE '\\' AND created_at < ?
			 ORDER BY created_at DESC LIMIT ?`,
		)
		.bind(`${(opts.prefix ?? "").replace(/[\\%_]/g, "\\$&")}%`, opts.before ?? Number.MAX_SAFE_INTEGER, limit)
		.all<{
			key: string;
			content_type: string;
			size: number;
			sha256: string;
			meta: string;
			created_at: number;
		}>();
	return results.map((r) => ({
		key: r.key,
		contentType: r.content_type,
		size: r.size,
		sha256: r.sha256,
		meta: JSON.parse(r.meta) as Record<string, unknown>,
		createdAt: iso(r.created_at),
	}));
}

/** Grava a troca completa com o governo. Chamado antes de responder à central. */
export async function writeJournal(
	bucket: R2Bucket,
	entry: Record<string, unknown>,
): Promise<string> {
	const now = new Date();
	const day = now.toISOString().slice(0, 10).replace(/-/g, "/");
	const key = `journal/${day}/${now.getTime()}-${crypto.randomUUID().slice(0, 8)}.json`;
	await bucket.put(key, JSON.stringify(entry), {
		httpMetadata: { contentType: "application/json" },
	});
	return key;
}
