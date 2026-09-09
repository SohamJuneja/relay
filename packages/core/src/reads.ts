// Batched reads: multicall3 when the chain has it, else bounded-concurrency
// individual eth_calls. Every result is `{ ok, value | error }` so a single
// reverting pool (e.g. an old implementation lacking a selector) never takes
// the batch down.

import type { Abi, Address, ContractFunctionName, PublicClient } from "viem";

export interface ReadCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export type ReadResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

const errMsg = (e: unknown): string => {
  const m = (e as { shortMessage?: string; message?: string }) ?? {};
  return (m.shortMessage ?? m.message ?? String(e)).split("\n")[0] ?? "error";
};

export interface BatchReadOptions {
  /** Force the fallback path (skip multicall). */
  noMulticall?: boolean;
  /** Fallback concurrency. */
  concurrency?: number;
  /** Multicall batch size (number of calls per aggregate3). */
  batchSize?: number;
}

export async function batchRead(
  client: PublicClient,
  calls: readonly ReadCall[],
  opts: BatchReadOptions = {},
): Promise<ReadResult[]> {
  if (calls.length === 0) return [];
  const hasMulticall = Boolean(client.chain?.contracts?.multicall3?.address) && !opts.noMulticall;
  if (hasMulticall) {
    try {
      const batchSize = opts.batchSize ?? 150;
      const out: ReadResult[] = [];
      for (let i = 0; i < calls.length; i += batchSize) {
        const slice = calls.slice(i, i + batchSize);
        const res = await client.multicall({
          allowFailure: true,
          contracts: slice.map((c) => ({
            address: c.address,
            abi: c.abi,
            functionName: c.functionName as ContractFunctionName<Abi>,
            args: (c.args ?? []) as readonly unknown[],
          })),
        });
        for (const r of res) {
          if (r.status === "success") out.push({ ok: true, value: r.result });
          else out.push({ ok: false, error: errMsg(r.error) });
        }
      }
      return out;
    } catch {
      // multicall3 missing/broken on this RPC — fall through to single calls.
    }
  }
  return fallbackRead(client, calls, opts.concurrency ?? 8);
}

async function fallbackRead(client: PublicClient, calls: readonly ReadCall[], concurrency: number): Promise<ReadResult[]> {
  const out: ReadResult[] = new Array(calls.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      const c = calls[i];
      if (!c) return;
      try {
        const value = await client.readContract({
          address: c.address,
          abi: c.abi,
          functionName: c.functionName as ContractFunctionName<Abi>,
          args: (c.args ?? []) as readonly unknown[],
        });
        out[i] = { ok: true, value };
      } catch (e) {
        out[i] = { ok: false, error: errMsg(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, calls.length) }, worker));
  return out;
}

export function unwrap<T>(r: ReadResult | undefined): T | null {
  return r && r.ok ? (r.value as T) : null;
}
