import { buildApp } from "./app.js";
import { createDeps } from "./deps.js";

const deps = await createDeps();
const app = await buildApp(deps, { logger: true });
const port = Number(process.env.API_PORT || 8787);
const host = process.env.API_HOST || "0.0.0.0";
await app.listen({ port, host });
console.log(`Relay API on http://${host === "0.0.0.0" ? "localhost" : host}:${port}  docs at /docs  ws at /v1/stream`);
const stop = async () => {
  await app.close();
  await deps.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
