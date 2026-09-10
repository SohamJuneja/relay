// Database handle. Two backends behind one Drizzle interface:
//   postgres://…   → postgres.js against a real Postgres 16 (docker-compose.yml, Neon)
//   pglite://<dir> → embedded Postgres (PGlite/WASM) — same SQL, same migrations;
//                    used by tests and when Docker is unavailable.
//
// PGlite is imported LAZILY, inside the branch that uses it. It is a ~100 MB WASM
// package that only tests and local development need, and a static import made it a
// hard runtime requirement of every consumer — including the deployed server, which
// crashed on start with ERR_MODULE_NOT_FOUND because pnpm's non-hoisted node_modules
// correctly refused to resolve a dependency the server never declared.

import { drizzle as drizzlePg, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
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
 * A FUNCTION, not a constant, and that distinction was a production failure. As a
 * module-level const it was evaluated when this module loaded, which in the bundled
 * server happens before `main()` gets a chance to set MIGRATIONS_DIR — so the
 * override never applied, the fallback resolved to a directory that does not exist
 * next to the bundle, and the migrator died on `Can't find meta/_journal.json`.
 *
 * Reading the environment at call time also means nothing here depends on the
 * process's working directory. Render starts the server from the repo root, so any
 * cwd-relative path would resolve somewhere else entirely.
 */
export function migrationsDir(): string {
  const override = process.env.MIGRATIONS_DIR;
  if (override) return path.resolve(override);
  // Development: this file is packages/indexer/src/db/client.ts, so the migrations
  // are two levels up. In a bundle every module shares the bundle's own URL, which
  // is why the deployment sets the override instead of relying on this.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
}

/**
 * Query parameters that belong to the connection string but not to the server.
 *
 * postgres.js forwards anything it does not recognise as a Postgres *startup
 * parameter*, so a stray one makes the server reject the connection with
 * `unrecognized configuration parameter`. Neon's pooled URL carries two of these:
 * `sslmode`, which we translate into a real TLS setting, and `channel_binding`, which
 * is a libpq client concern with no server-side meaning at all.
 */
const CLIENT_ONLY_PARAMS = new Set(["sslmode", "channel_binding", "sslcert", "sslkey", "sslrootcert", "pgbouncer", "application_name", "options"]);
const ALLOWED_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

export interface ParsedDbUrl {
  /** The URL with client-only parameters removed, safe to hand to postgres.js. */
  url: string;
  /** `host:port/database` — never the password. Safe to log. */
  describe: string;
  /** What `sslmode` asked for, translated for postgres.js. */
  ssl: "require" | "prefer" | false;
}

/**
 * Split a connection string into the parts postgres.js wants and a description safe
 * to put in a log line. Anything unparseable is passed through untouched rather than
 * rejected — a connection string we do not understand is still more likely to work
 * than one we mangled.
 */
export function parseDbUrl(raw: string): ParsedDbUrl {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { url: raw, describe: "(unparseable connection string)", ssl: "prefer" };
  }

  // Fail on the scheme rather than on DNS. A typo in the scheme still parses as a
  // URL, and postgres.js then resolves something that was never a hostname — the
  // error you get back is `ENOTFOUND neopostgresql`, which reads like a network
  // problem and is not one. The value is never echoed: it carries a password.
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    throw new Error(
      `DATABASE_URL has scheme "${u.protocol}//" — it must be "postgresql://" or "postgres://". ` +
        `Check for a stray prefix before the scheme. The value is not shown here because it contains a password.`,
    );
  }

  const sslmode = u.searchParams.get("sslmode");
  // Neon, Supabase and every other hosted Postgres require TLS. `disable` is the only
  // value that should turn it off, and a local docker instance simply has no param.
  const ssl: ParsedDbUrl["ssl"] = sslmode === "disable" ? false : sslmode ? "require" : u.hostname === "localhost" || u.hostname === "127.0.0.1" ? false : "require";

  for (const key of [...u.searchParams.keys()]) {
    if (CLIENT_ONLY_PARAMS.has(key)) u.searchParams.delete(key);
  }

  // Strip every leading slash, not one. `postgresql://host//user:pw@real-host/db`
  // parses as host "host" with the REST OF THE CONNECTION STRING as the path, and
  // stripping a single slash left the password sitting in `describe` — which is the
  // one field documented as safe to log. A database name is a bare identifier; if
  // what is left does not look like one, the string is malformed and nothing from it
  // is printed.
  const db = u.pathname.replace(/^\/+/, "") || "postgres";
  const safeDb = /^[A-Za-z0-9_$-]+$/.test(db) ? db : "(unexpected database name)";
  return {
    url: u.toString(),
    describe: `${u.hostname}${u.port ? `:${u.port}` : ""}/${safeDb}`,
    ssl,
  };
}

export async function openDb(url: string): Promise<DbHandle> {
  if (url.startsWith("pglite://")) {
    // Lazy: only tests and local development take this branch, and the deployed
    // server must not need the package on disk at all.
    const [{ PGlite }, { drizzle: drizzlePglite }, { migrate: migratePglite }] = await Promise.all([
      import("@electric-sql/pglite"),
      import("drizzle-orm/pglite"),
      import("drizzle-orm/pglite/migrator"),
    ]);
    const dir = url.slice("pglite://".length);
    const client = new PGlite(dir || undefined);
    const db = drizzlePglite(client, { schema });
    return {
      db,
      kind: "pglite",
      url,
      migrate: () => migratePglite(db, { migrationsFolder: migrationsDir() }),
      close: () => client.close(),
    };
  }

  const parsed = parseDbUrl(url);
  // The host, never the credentials. A deploy that cannot reach its database is the
  // most common failure there is, and "which database was it even trying?" should not
  // require adding a log line and redeploying.
  console.log(`[db] connecting to ${parsed.describe} (ssl: ${parsed.ssl === false ? "off" : parsed.ssl})`);

  // One process runs the API and the indexer against this pool, so it is sized for
  // the smallest box we deploy to rather than for a workstation. Neon's free tier
  // also caps connections, and a pool that opens more than it is allowed fails at the
  // worst possible moment — under load.
  const max = Number(process.env.PG_POOL_MAX || 8);
  const client = postgres(parsed.url, {
    max,
    prepare: false,
    onnotice: () => undefined,
    ...(parsed.ssl === false ? {} : { ssl: parsed.ssl }),
  });
  const db = drizzlePg(client, { schema });
  return {
    db,
    kind: "postgres",
    url,
    migrate: () => migratePg(db, { migrationsFolder: migrationsDir() }),
    close: () => client.end({ timeout: 5 }),
  };
}
