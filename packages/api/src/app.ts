// Fastify app: REST + WS + OpenAPI 3.1. Every route is zod-typed; the same
// schemas drive validation, serialization and the /docs page.

import Fastify, { type FastifyBaseLogger, type FastifyInstance, type RawReplyDefaultExpression, type RawRequestDefaultExpression, type RawServerDefault } from "fastify";
import cors from "@fastify/cors";
import etag from "@fastify/etag";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { ApiDeps } from "./deps.js";
import { registerFaucet } from "./routes/faucet.js";
import { registerHealth } from "./routes/health.js";
import { registerInsights } from "./routes/insights.js";
import { registerMarkets } from "./routes/markets.js";
import { registerPartners } from "./routes/partners.js";
import { registerStats } from "./routes/stats.js";
import { registerWallets } from "./routes/wallets.js";
import { registerStream } from "./ws.js";
import { assertEmbedScriptUrlConfigured } from "./snippet.js";

/** Fastify instance with the zod type provider, so route handlers infer params/query/body. */
export type App = FastifyInstance<RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression, FastifyBaseLogger, ZodTypeProvider>;

export async function buildApp(deps: ApiDeps, opts: { logger?: boolean } = {}): Promise<App> {
  // Before anything is served. A snippet is the one artefact a partner copies once and
  // pastes on a site we never see again; handing out a dead URL is not recoverable by
  // fixing the server later.
  assertEmbedScriptUrlConfigured();

  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: true });
  await app.register(etag);
  await app.register(rateLimit, { max: Number(process.env.API_RATE_LIMIT_PER_MIN || 60), timeWindow: "1 minute" });
  await app.register(websocket);
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Relay API",
        version: "0.1.0",
        description:
          "Public REST + WebSocket API for DreamDEX Event Contracts on Somnia, served from Relay's chain-only indexer. " +
          "Markets, live books, fills with partner attribution, venue liquidity stats, and the live underlying price. " +
          "Prices are YES-side probabilities in [0,1]; raw fields are collateral-decimal scaled integers as strings.",
      },
      servers: [{ url: "/" }],
      tags: [
        { name: "health" },
        { name: "markets" },
        { name: "venues" },
        { name: "price" },
        { name: "stats" },
        { name: "partners" },
        { name: "orders" },
        { name: "wallets" },
        { name: "faucet", description: "Testnet-only onboarding aids (the stand-in for a mainnet paymaster)." },
        { name: "stream", description: "WebSocket at /v1/stream — send {\"subscribe\":{\"all\":true}} or {\"subscribe\":{\"markets\":[\"0x…\"]}}; receives market_created, book, fill, market_locked, market_resolved, price." },
      ],
      components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-api-key" } } },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs", uiConfig: { docExpansion: "list", deepLinking: true } });

  app.setErrorHandler((err, _req, reply) => {
    const e = err as { statusCode?: number; message?: string; validation?: unknown };
    const status = e.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.status(status).send({ error: status >= 500 ? "internal_error" : (e.validation ? "validation_error" : "error"), message: e.message ?? String(err) });
  });

  registerHealth(app, deps);
  registerMarkets(app, deps);
  registerStats(app, deps);
  registerInsights(app, deps);
  registerPartners(app, deps);
  registerWallets(app, deps);
  registerFaucet(app, deps);
  registerStream(app, deps);

  return app;
}
