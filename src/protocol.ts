// Protocolo entre a API central do NFapi e o cofre.
//
// Este arquivo é a fonte única de verdade do contrato: a central importa daqui.
// Usa somente WebCrypto, sem dependências, para rodar em qualquer Worker.

export const PROTOCOL_VERSION = 1;
export const VAULT_VERSION = "0.1.0";

export const HEADERS = {
	pairing: "x-nfapi-pairing",
	timestamp: "x-nfapi-timestamp",
	nonce: "x-nfapi-nonce",
	signature: "x-nfapi-signature",
} as const;

/** Diferença máxima aceita entre o relógio da central e o do cofre. */
export const MAX_CLOCK_SKEW_SECONDS = 300;

// ---------- Tipos das operações ----------

export type SignableTag = "infNFe" | "infEvento" | "infInut" | "infDPS" | "infPedReg";
export type SignatureProfile = "rsa-sha1" | "rsa-sha256";
export type Environment = "producao" | "homologacao";

export interface SignRequest {
	xml: string;
	tag: SignableTag;
	profile: SignatureProfile;
}
export interface SignResponse {
	xml: string;
	id: string;
	emitter: string;
	environment: Environment;
}

export interface TransmitRequest {
	url: string;
	method?: "GET" | "HEAD" | "POST" | "PUT" | "DELETE";
	headers?: Record<string, string>;
	/** Corpo em base64 (o conteúdo pode ser XML, JSON ou binário). */
	bodyB64?: string;
	/** A maioria dos webservices fiscais exige TLS 1.2 (renegociação). */
	maxTls?: "1.2" | "1.3";
	timeoutMs?: number;
	/** Referência livre da central (ex.: id da emissão), gravada no diário. */
	ref?: string;
}
export interface TransmitResponse {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	bodyB64: string;
	tls: { protocol: string | null; cipher: string | null; peerIssuer: string | null };
	ms: number;
	/** Onde a troca completa ficou gravada no R2 do emitente. */
	journalKey: string;
}

export interface CertificateInfo {
	holder: { kind: "cnpj" | "cpf"; id: string };
	commonName: string;
	issuer: string;
	serialNumber: string;
	notBefore: string;
	notAfter: string;
	installedAt: string;
}

export interface HealthResponse {
	ok: true;
	version: string;
	protocol: number;
	certificate: CertificateInfo | null;
	allowProduction: boolean;
}

export interface ErrorBody {
	error: { code: string; message: string };
}

// ---------- Assinatura das requisições (HMAC-SHA256) ----------

export interface CanonicalParts {
	method: string;
	/** Caminho + query string, exatamente como enviado. */
	path: string;
	timestamp: string;
	nonce: string;
	bodySha256: string;
}

export function canonicalRequest(p: CanonicalParts): string {
	return ["v1", p.method.toUpperCase(), p.path, p.timestamp, p.nonce, p.bodySha256].join("\n");
}

const encoder = new TextEncoder();

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let out = "";
	for (const b of view) out += b.toString(16).padStart(2, "0");
	return out;
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
	if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("hex inválido");
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

function hmacKey(key: Uint8Array, usage: "sign" | "verify"): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** Monta os cabeçalhos de autenticação que a central envia ao cofre. */
export async function signRequest(input: {
	key: Uint8Array;
	pairingId: string;
	method: string;
	path: string;
	body: Uint8Array;
	now?: number;
	nonce?: string;
}): Promise<Record<string, string>> {
	const timestamp = String(Math.floor((input.now ?? Date.now()) / 1000));
	const nonce = input.nonce ?? toHex(crypto.getRandomValues(new Uint8Array(16)));
	const message = canonicalRequest({
		method: input.method,
		path: input.path,
		timestamp,
		nonce,
		bodySha256: await sha256Hex(input.body),
	});
	const mac = await crypto.subtle.sign("HMAC", await hmacKey(input.key, "sign"), encoder.encode(message));
	return {
		[HEADERS.pairing]: input.pairingId,
		[HEADERS.timestamp]: timestamp,
		[HEADERS.nonce]: nonce,
		[HEADERS.signature]: toHex(mac),
	};
}

/** Verificação em tempo constante (crypto.subtle.verify). */
export async function verifySignature(
	key: Uint8Array,
	parts: CanonicalParts,
	signatureHex: string,
): Promise<boolean> {
	let signature: Uint8Array<ArrayBuffer>;
	try {
		signature = fromHex(signatureHex);
	} catch {
		return false;
	}
	return crypto.subtle.verify(
		"HMAC",
		await hmacKey(key, "verify"),
		signature,
		encoder.encode(canonicalRequest(parts)),
	);
}

// ---------- Código de pareamento ----------

/** O que o emitente copia da tela /setup do cofre e envia à API (POST /v1/emitentes). */
export interface PairingCode {
	v: 1;
	url: string;
	id: string;
	/** Chave HMAC em hexadecimal. */
	key: string;
}

const PAIRING_PREFIX = "nfapi-cofre-v1.";

export function encodePairingCode(code: PairingCode): string {
	const json = JSON.stringify(code);
	return PAIRING_PREFIX + btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodePairingCode(text: string): PairingCode {
	const trimmed = text.trim();
	if (!trimmed.startsWith(PAIRING_PREFIX)) throw new Error("Código de pareamento inválido.");
	const b64 = trimmed.slice(PAIRING_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
	const code = JSON.parse(atob(b64)) as PairingCode;
	if (code.v !== 1 || !code.url || !code.id || !code.key) {
		throw new Error("Código de pareamento inválido.");
	}
	return code;
}
