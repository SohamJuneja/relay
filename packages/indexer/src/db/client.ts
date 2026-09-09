// Database handle. Two backends behind one Drizzle interface:
//   postgres://…   → postgres.js against a real Postgres 16 (docker-compose.yml)
//   pglite://<dir> → embedded Postgres (PGlite/WASM) — same SQL, same migrations;
//                    used when Docker is unavailable (dev laptops, CI).

import { drizzle as drizzlePg, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema> | PgliteDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  kind: "postgres" | "pglite";
  url: string;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Where the checked-in SQL migrations live.
 *
 * Resolved relative to this file in development. A bundled build moves this module
 * into one file somewhere else entirely, so the deployment copies `drizzle/` next to
 * the bundle and points MIGRATIONS_DIR at it.
 */
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR
  ? path.resolve(process.env.MIGRATIONS_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

export async function openDb(url: string): Promise<DbHandle> {
  if (url.startsWith("pglite://")) {
    const dir = url.slice("pglite://".length);
    const client = new PGlite(dir || undefined);
    const db = drizzlePglite(client, { schema });
    return {
      db,
      kind: "pglite",
      url,
      migrate: () => migratePglite(db, { migrationsFolder: MIGRATIONS_DIR }),
      close: () => client.close(),
    };
  }
  // One process runs the API and the indexer against this pool, so it is sized for
  // the smallest box we deploy to rather than for a workstation. Neon's free tier
  // also caps connections, and a pool that opens more than it is allowed fails at the
  // worst possible moment — under load.
  const max = Number(process.env.PG_POOL_MAX || 8);
  const client = postgres(url, { max, prepare: false, onnotice: () => undefined });
  const db = drizzlePg(client, { schema });
  return {
    db,
    kind: "postgres",
    url,
    migrate: () => migratePg(db, { migrationsFolder: MIGRATIONS_DIR }),
    close: () => client.end({ timeout: 5 }),
  };
}
