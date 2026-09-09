// Chunked, concurrent eth_getLogs for RPCs that cap the block range.
//
// Shannon returns `{"code":-1,"message":"block range exceeds 1000"}` for any
// range > 1000 blocks (measured 2026-09-09; also stated in the hackathon
// template's discover.mjs and the kit's docs/24-7-operations.md). At ~100 ms
// blocks that is ~100 s of chain time per call, so a 6-hour window is ~216
// calls per address-set. We run them in a small worker pool and halve a chunk
// on a range error so a tighter cap on another RPC degrades gracefully.

import type { AbiEvent, Address, Log, PublicClient } from "viem";
import { GET_LOGS_MAX_RANGE } from "./chain.js";

export interface ScanProgress {
  done: number;
  total: number;
  logs: number;
}

export interface ScanLogsOptions<TEvents extends readonly AbiEvent[]> {
  client: PublicClient;
  fromBlock: bigint;
  toBlock: bigint;
  /** One address, several, or none (topic-only scan — heavier on the node). */
  address?: Address | Address[];
  events: TEvents;
  /** Max blocks per request. Defaults to the Shannon cap (1000). */
  chunkSize?: bigint;
  /** Parallel in-flight requests. */
  concurrency?: number;
  /** Per-request retries on transient errors. */
  retries?: number;
  onProgress?: (p: ScanProgress) => void;
}

export type DecodedLog<TEvents extends readonly AbiEvent[]> = Log<bigint, number, false, undefined, false, TEvents>;

function isRangeError(e: unknown): boolean {
  const msg = String((e as { message?: string })?.message ?? e).toLowerCase();
  return /block range|range exceeds|too many blocks|exceeds.*limit|query returned more than|response size/.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Scan `[fromBlock, toBlock]` inclusive for `events`, chunked and concurrent.
 * Results are sorted by (blockNumber, logIndex).
 */
export async function scanLogs<const TEvents extends readonly AbiEvent[]>(
  opts: ScanLogsOptions<TEvents>,
): Promise<DecodedLog<TEvents>[]> {
  const chunk = opts.chunkSize ?? GET_LOGS_MAX_RANGE;
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const retries = opts.retries ?? 4;
  if (opts.toBlock < opts.fromBlock) return [];

  // Build the chunk list. Ranges are inclusive on both ends, so a 1000-block
  // cap means at most 1000 blocks: [a, a+999].
  const ranges: Array<[bigint, bigint]> = [];
  for (let from = opts.fromBlock; from <= opts.toBlock; from += chunk) {
    const to = from + chunk - 1n < opts.toBlock ? from + chunk - 1n : opts.toBlock;
    ranges.push([from, to]);
  }

  const out: DecodedLog<TEvents>[] = [];
  let done = 0;
  let next = 0;

  const fetchRange = async (from: bigint, to: bigint, depth = 0): Promise<DecodedLog<TEvents>[]> => {
    let attempt = 0;
    for (;;) {
      try {
        const logs = await opts.client.getLogs({
          ...(opts.address !== undefined ? { address: opts.address } : {}),
          events: opts.events,
          fromBlock: from,
          toBlock: to,
          strict: false,
        });
        return logs as unknown as DecodedLog<TEvents>[];
      } catch (e) {
        if (isRangeError(e) && to > from && depth < 12) {
          const mid = from + (to - from) / 2n;
          const [a, b] = await Promise.all([fetchRange(from, mid, depth + 1), fetchRange(mid + 1n, to, depth + 1)]);
          return [...a, ...b];
        }
        attempt++;
        if (attempt > retries) throw e;
        await sleep(250 * 2 ** (attempt - 1));
      }
    }
  };

  const worker = async () => {
    for (;;) {
      const i = next++;
      const r = ranges[i];
      if (!r) return;
      const logs = await fetchRange(r[0], r[1]);
      out.push(...logs);
      done++;
      opts.onProgress?.({ done, total: ranges.length, logs: out.length });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, ranges.length) }, worker));

  out.sort((a, b) => {
    const ba = a.blockNumber ?? 0n;
    const bb = b.blockNumber ?? 0n;
    if (ba !== bb) return ba < bb ? -1 : 1;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });
  return out;
}

/**
 * Measure the average block time over the last `sample` blocks. Prefer this to
 * a constant when converting hours → blocks.
 */
export async function estimateBlockTime(
  client: PublicClient,
  sample = 10_000n,
): Promise<{ head: bigint; headTimestamp: bigint; secondsPerBlock: number }> {
  const head = await client.getBlock({ blockTag: "latest" });
  const back = head.number - sample > 0n ? head.number - sample : 0n;
  const old = await client.getBlock({ blockNumber: back });
  const span = Number(head.timestamp - old.timestamp);
  const blocks = Number(head.number - old.number);
  return {
    head: head.number,
    headTimestamp: head.timestamp,
    secondsPerBlock: blocks > 0 ? span / blocks : 0.1,
  };
}

export function blocksForDuration(seconds: number, secondsPerBlock: number): bigint {
  return BigInt(Math.max(1, Math.round(seconds / Math.max(secondsPerBlock, 1e-6))));
}
