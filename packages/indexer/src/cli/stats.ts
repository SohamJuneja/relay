import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { computePartnerStats, computeVenueStats } from "../stats/compute.js";

const cfg = loadConfig();
const h = await openDb(cfg.databaseUrl);
const days = Number(process.argv[2] ?? 3);
console.log(`venue rows: ${await computeVenueStats(h.db, days)}`);
console.log(`partner rows: ${await computePartnerStats(h.db, cfg.builderFeeBps)}`);
await h.close();
process.exit(0);
