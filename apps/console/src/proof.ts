// The registration proof, from the browser's side.
//
// The string must match packages/api/src/proof.ts byte for byte — a stray space is a
// signature that verifies against nothing. It is duplicated rather than imported
// because the console is a static bundle that must not depend on the API's server
// code, and the shape is four lines that a test pins on both sides.

import { getAddress } from "viem";

export const isoMinute = (d: Date = new Date()): string => `${d.toISOString().slice(0, 16)}Z`;

export const randomNonce = (): string => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

export function proofMessage(input: { builderAddress: string; nonce: string; issued: string }): string {
  return ["Relay partner registration", `builder: ${getAddress(input.builderAddress)}`, `nonce: ${input.nonce}`, `issued: ${input.issued}`].join("\n");
}
