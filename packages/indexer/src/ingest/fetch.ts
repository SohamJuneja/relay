// Chunked, streaming eth_getLogs with bounded concurrency and ordered delivery.
//
// Shannon: 1000-block range cap, ~10 MB response cap in viem's HTTP transport.
// Either error splits the range; an address-list rejection splits the address
// list. Results are delivered to `onChunk` strictly in block order while up to
// `concurrency` fetches run ahead.

import type { Address, Hex, PublicClient } from "viem";
import { normaliseRpcLog, type RawLog } from "./decode.js";

export interface LogFilter {
  addresses: Address[];
  /** topic0 alternatives; undefined = every event on those addresses. */
  topics?: Hex[] | undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msgOf = (e: unknown) => String((e as { message?: string })?.message ?? e).toLowerCase();
const isRangeOrSizeError = (e: unknown) => /block range|range exceeds|too many|exceeds.*limit|size limit|response body|too large|query returned more/.test(msgOf(e));
const isAddressListError = (e: unknown) => /address/.test(msgOf(e)) && /too many|limit|exceed/.test(msgOf(e));

export async function fetchLogs(client: PublicClient, from: bigint, to: bigint, f: LogFilter, depth = 0): Promise<RawLog[]> {
  if (f.addresses.length === 0 || to < from) return [];
  let attempt = 0;
  for (;;) {
    try {
      const rows = (await client.request({
        method: "eth_getLogs",
        params: [
          {
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
            address: f.addresses.length === 1 ? f.addresses[0] : f.addresses,
            ...(f.topics ? { topics: [f.topics] } : {}),
          },
        ],
      } as never)) as Parameters<typeof normaliseRpcLog>[0][];
      const out = rows.map(normaliseRpcLog);
      out.sort((a, b) => (a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.logIndex - b.logIndex));
      return out;
    } catch (e) {
      if (isAddressListError(e) && f.addresses.length > 1) {
        const mid = Math.ceil(f.addresses.length / 2);
        const [a, b] = await Promise.all([
          fetchLogs(client, from, to, { ...f, addresses: f.addresses.slice(0, mid) }, depth),
          fetchLogs(client, from, to, { ...f, addresses: f.addresses.slice(mid) }, depth),
        ]);
        return [...a, ...b].sort((x, y) => (x.blockNumber !== y.blockNumber ? (x.blockNumber < y.blockNumber ? -1 : 1) : x.logIndex - y.logIndex));
      }
      if (isRangeOrSizeError(e) && to > from && depth < 12) {
        const mid = from + (to - from) / 2n;
        const [a, b] = await Promise.all([fetchLogs(client, from, mid, f, depth + 1), fetchLogs(client, mid + 1n, to, f, depth + 1)]);
        return [...a, ...b];
      }
      attempt++;
      if (attempt > 5) throw e;
      await sleep(300 * 2 ** (attempt - 1));
    }
  }
}

export interface Chunk {
  from: bigint;
  to: bigint;
  logs: RawLog[];
}

/**
 * Walk [from, to] in `chunkSize` steps. Up to `concurrency` chunks are fetched
 * ahead; `onChunk` is awaited in order. `filterFor(chunk)` lets the caller widen
 * the address list as new pools are discovered.
 */
export async function streamChunks(
  client: PublicClient,
  from: bigint,
  to: bigint,
  chunkSize: bigint,
  concurrency: number,
  filterFor: (from: bigint, to: bigint) => LogFilter,
  onChunk: (c: Chunk) => Promise<void>,
): Promise<void> {
  if (to < from) return;
  const ranges: Array<[bigint, bigint]> = [];
  for (let f = from; f <= to; f += chunkSize) ranges.push([f, f + chunkSize - 1n < to ? f + chunkSize - 1n : to]);
  const inflight: Promise<Chunk>[] = [];
  let next = 0;
  const launch = () => {
    while (inflight.length < concurrency && next < ranges.length) {
      const [f, t] = ranges[next++]!;
      inflight.push(fetchLogs(client, f, t, filterFor(f, t)).then((logs) => ({ from: f, to: t, logs })));
    }
  };
  launch();
  while (inflight.length > 0) {
    const c = await inflight.shift()!;
    await onChunk(c);
    launch();
  }
}
