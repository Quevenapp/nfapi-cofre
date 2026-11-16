// Ponto de entrada do cofre no Cloudflare Workers.

import { Container } from "@cloudflare/containers";
import { type AppEnv, createApp } from "./app";
import { ContainerTransport } from "./transport";

/**
 * Durable Object que controla o Container do proxy mTLS (container/server.mjs).
 * O Container só é alcançável por este Worker; ele acorda sob demanda e dorme
 * depois de 10 minutos sem uso.
 */
export class MtlsProxy extends Container {
	override defaultPort = 8080;
	override sleepAfter = "10m";
}

interface Env extends AppEnv {
	MTLS: ConstructorParameters<typeof ContainerTransport>[0];
}

const app = createApp((env) => new ContainerTransport((env as Env).MTLS));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
