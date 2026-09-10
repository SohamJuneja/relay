// `describe` is documented as safe to log, and one malformed connection string made
// that false. A DATABASE_URL of the shape
//
//   postgresql://neopostgresql//neondb_owner:<password>@ep-….neon.tech/neondb
//
// parses as host "neopostgresql" with the whole real connection string as the path.
// Stripping a single leading slash left the password in `describe`, and it went
// straight into the deploy log.
//
// The password is the thing under test here, so every case checks for it by name.

import { describe, expect, it } from "vitest";
import { parseDbUrl } from "./client.js";

const PW = "npg_ThisIsThePasswordAndMustNeverAppear";
const HOST = "ep-rough-heart-aek59kxj-pooler.c-2.us-east-2.aws.neon.tech";

describe("parseDbUrl", () => {
  it("describes a normal Neon URL by host and database only", () => {
    const p = parseDbUrl(`postgresql://neondb_owner:${PW}@${HOST}/neondb`);
    expect(p.describe).toBe(`${HOST}/neondb`);
    expect(p.describe).not.toContain(PW);
    expect(p.ssl).toBe("require");
  });

  // The boundary of what a parser can know: a path holding a single bare identifier
  // IS a database name, and `postgres://host/npg_whatever` is indistinguishable from
  // a database that happens to be called that. What is detectable — and what actually
  // happened — is a path carrying an authority: ":", "@" and "/" together.
  it("never puts the password in describe, however mangled the string is", () => {
    const mangled = [
      // The one that actually happened: a stray prefix before the real string.
      `postgresql://neopostgresql//neondb_owner:${PW}@${HOST}/neondb`,
      `postgresql://x//neondb_owner:${PW}@${HOST}/neondb`,
      `postgresql://neondb_owner:${PW}@${HOST}//weird//path`,
      `postgresql://${HOST}/neondb_owner:${PW}@x`,
    ];
    for (const raw of mangled) {
      const p = parseDbUrl(raw);
      expect(p.describe, `leaked for ${raw.slice(0, 24)}…`).not.toContain(PW);
    }
  });

  it("says nothing at all about an unparseable string", () => {
    const p = parseDbUrl(`not a url ${PW}`);
    expect(p.describe).toBe("(unparseable connection string)");
    expect(p.describe).not.toContain(PW);
  });

  it("rejects a wrong scheme by name, without echoing the value", () => {
    let err: Error | null = null;
    try {
      parseDbUrl(`neopostgresql://neondb_owner:${PW}@${HOST}/neondb`);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("neopostgresql:");
    expect(err?.message).toContain("postgresql://");
    // The whole point: the diagnostic names the problem and not the credential.
    expect(err?.message).not.toContain(PW);
    expect(err?.message).not.toContain(HOST);
  });

  it("strips client-only parameters postgres.js cannot take", () => {
    const p = parseDbUrl(`postgresql://u:${PW}@${HOST}/neondb?sslmode=require&channel_binding=require`);
    expect(p.url).not.toContain("sslmode");
    expect(p.url).not.toContain("channel_binding");
    expect(p.ssl).toBe("require");
  });

  it("leaves TLS off for a local database and on for a hosted one", () => {
    expect(parseDbUrl("postgresql://postgres:postgres@localhost:5432/relay").ssl).toBe(false);
    expect(parseDbUrl("postgresql://postgres:postgres@127.0.0.1:5432/relay").ssl).toBe(false);
    expect(parseDbUrl(`postgresql://u:${PW}@${HOST}/neondb`).ssl).toBe("require");
    expect(parseDbUrl("postgresql://u:p@somewhere.example/db?sslmode=disable").ssl).toBe(false);
  });
});
