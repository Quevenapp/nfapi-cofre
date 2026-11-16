// Dados fiscais: tudo aqui muda por publicação do governo, não por decisão de
// código. É a área que o monitor de IA pode atualizar sozinho quando os testes
// passam (ver plano: "atualização por risco").

import nfeStatus from "./nfe-status-homologacao.json";
import nfse from "./nfse-nacional.json";

export type Ambiente = "producao" | "homologacao";

/** Leiautes da DPS que a API sabe gerar. */
export type LeiauteDps = "1.01" | "1.01-nt009";

export type PerfilAssinatura = "rsa-sha1" | "rsa-sha256";

export interface NfseAmbiente {
	/** Base da API SEFIN Nacional (emissão, consulta e eventos). */
	sefin: string;
	/** Host do Ambiente de Dados Nacional (parametrização municipal, distribuição). */
	adn: string;
	leiaute: LeiauteDps;
	/** Pasta dos XSD oficiais em schemas/nfse/. */
	schemas: string;
}

export const NFSE_NACIONAL = nfse as {
	assinatura: PerfilAssinatura;
	ambientes: Record<Ambiente, NfseAmbiente>;
};

export function nfseAmbiente(ambiente: Ambiente): NfseAmbiente {
	return NFSE_NACIONAL.ambientes[ambiente];
}

// ---------- NF-e / NFC-e: serviço de status em homologação (tabela parcial) ----------

export interface AutorizadorStatus {
	autorizador: string;
	/** Códigos IBGE das UFs atendidas. */
	ufs: string[];
	status: string;
	/** O endereço já respondeu em teste real com certificado A1? */
	verificado: boolean;
}

const STATUS_HOMOLOGACAO = nfeStatus as unknown as Record<"nfe" | "nfce", AutorizadorStatus[]>;

/** Quem atende a UF (código IBGE de 2 dígitos) no serviço de status de homologação. */
export function statusHomologacao(modelo: "nfe" | "nfce", cUF: string): AutorizadorStatus | null {
	return STATUS_HOMOLOGACAO[modelo].find((a) => a.ufs.includes(cUF)) ?? null;
}
