// The console builds the registration message in the browser and the API rebuilds it
// on the server to verify. They are two copies of one string, and a stray space in
// either produces a signature that verifies against nothing — with no error anywhere,
// just a partner who stays unverified and cannot find out why.
//
// This pins the console's half against the literal. packages/api/src/proof.test.ts
// pins the server's half against the same literal.

import { describe, expect, it } from "vitest";
import { isoMinute, proofMessage, randomNonce } from "./proof";

const ADDRESS = "0xb5eCf004491aa8589a82af91633D18867fcFF038";

describe("the registration message the console signs", () => {
  it("is exactly the four lines the API rebuilds", () => {
    const m = proofMessage({ builderAddress: ADDRESS, nonce: "7f3a1c9b", issued: "2026-09-09T16:45Z" });
    expect(m).toBe(`Relay partner registration\nbuilder: ${ADDRESS}\nnonce: 7f3a1c9b\nissued: 2026-09-09T16:45Z`);
  });

  it("checksums the address, whatever case the form held", () => {
    expect(proofMessage({ builderAddress: ADDRESS.toLowerCase(), nonce: "n", issued: "2026-09-09T16:45Z" })).toContain(ADDRESS);
  });

  it("truncates the timestamp to the minute, so both sides can agree on it", () => {
    expect(isoMinute(new Date("2026-09-09T16:45:37.123Z"))).toBe("2026-09-09T16:45Z");
  });

  it("mints a nonce with enough entropy to not repeat", () => {
    const a = randomNonce();
    const b = randomNonce();
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(a).not.toBe(b);
  });
});
