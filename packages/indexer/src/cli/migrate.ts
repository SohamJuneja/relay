import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";

const cfg = loadConfig();
const h = await openDb(cfg.databaseUrl);
console.log(`migrating ${h.kind} (${h.url.replace(/:\/\/[^@]*@/, "://***@")}) …`);
await h.migrate();
console.log("migrated.");
await h.close();
process.exit(0);
