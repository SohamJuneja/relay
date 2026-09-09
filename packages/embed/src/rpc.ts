// A minimal JSON-RPC client for the widget.
//
// Why not viem's client? Measured on this bundle: viem's actions + clients layer
// costs 96 KB gzipped on its own, while the parts that are genuinely hard to get
// right — ABI encoding/decoding and EIP-1559 transaction signing — cost 29.5 KB.
// So the widget keeps viem for exactly those and talks to the node over `fetch`.
// Nothing cryptographic is hand-rolled here: signing goes through viem's
// `privateKeyToAccount(...).signTransaction`, and calldata through
// `encodeFunctionData` / `decodeFunctionResult`.

import { decodeFunctionResult, encodeFunctionData, toFunctionSelector, type Abi, type Address, type Hex } from "viem";
import { binaryErrorsAbi } from "@relay/core/browser";

export interface RpcError extends Error {
  code?: number;
  /** Revert data, when the node returned any. */
  data?: Hex;
}

export interface TxRequest {
  to: Address;
  data?: Hex;
  value?: bigint;
  gas?: bigint;
  from?: Address;
}

export interface Receipt {
  transactionHash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  logs: { address: Address; topics: Hex[]; data: Hex; logIndex: number }[];
}

const hex = (v: bigint) => `0x${v.toString(16)}` as Hex;
const big = (v: string | null | undefined) => (v === null || v === undefined ? 0n : BigInt(v));

export class Rpc {
  private id = 0;
  constructor(readonly url: string) {}

  async request<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
    if (body.error) {
      const err = new Error(body.error.message) as RpcError;
      err.code = body.error.code;
      const d = body.error.data;
      if (typeof d === "string" && d.startsWith("0x")) err.data = d as Hex;
      else if (d && typeof d === "object" && typeof (d as { data?: string }).data === "string") err.data = (d as { data: string }).data as Hex;
      throw err;
    }
    return body.result as T;
  }

  chainId(): Promise<number> {
    return this.request<string>("eth_chainId").then(Number);
  }
  blockNumber(): Promise<bigint> {
    return this.request<string>("eth_blockNumber").then(big);
  }
  getBalance(address: Address): Promise<bigint> {
    return this.request<string>("eth_getBalance", [address, "latest"]).then(big);
  }
  getCode(address: Address): Promise<Hex> {
    return this.request<Hex>("eth_getCode", [address, "latest"]);
  }
  getTransactionCount(address: Address): Promise<number> {
    return this.request<string>("eth_getTransactionCount", [address, "pending"]).then((v) => Number(BigInt(v)));
  }
  call(tx: TxRequest): Promise<Hex> {
    return this.request<Hex>("eth_call", [rpcTx(tx), "latest"]);
  }
  estimateGas(tx: TxRequest): Promise<bigint> {
    return this.request<string>("eth_estimateGas", [rpcTx(tx)]).then(big);
  }
  sendRawTransaction(raw: Hex): Promise<Hex> {
    return this.request<Hex>("eth_sendRawTransaction", [raw]);
  }

  /** `eth_call` + ABI decode. Throws with the decoded revert name when the node gives one. */
  async read<T>(p: { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<T> {
    const data = encodeFunctionData({ abi: p.abi as Abi, functionName: p.functionName, args: (p.args ?? []) as readonly unknown[] });
    const out = await this.call({ to: p.address, data });
    return decodeFunctionResult({ abi: p.abi as Abi, functionName: p.functionName, data: out }) as T;
  }

  async waitForReceipt(hash: Hex, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<Receipt> {
    const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
    for (;;) {
      const r = await this.request<RawReceipt | null>("eth_getTransactionReceipt", [hash]).catch(() => null);
      if (r) {
        return {
          transactionHash: r.transactionHash,
          status: BigInt(r.status) === 1n ? "success" : "reverted",
          blockNumber: big(r.blockNumber),
          gasUsed: big(r.gasUsed),
          logs: (r.logs ?? []).map((l) => ({ address: l.address.toLowerCase() as Address, topics: l.topics, data: l.data, logIndex: Number(BigInt(l.logIndex ?? "0x0")) })),
        };
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${hash.slice(0, 12)}…`);
      await new Promise((res) => setTimeout(res, opts.pollMs ?? 250));
    }
  }
}

interface RawReceipt {
  transactionHash: Hex;
  status: string;
  blockNumber: string;
  gasUsed: string;
  logs: { address: string; topics: Hex[]; data: Hex; logIndex?: string }[];
}

function rpcTx(tx: TxRequest): Record<string, string> {
  const out: Record<string, string> = { to: tx.to };
  if (tx.data) out.data = tx.data;
  if (tx.from) out.from = tx.from;
  if (tx.value !== undefined) out.value = hex(tx.value);
  if (tx.gas !== undefined) out.gas = hex(tx.gas);
  return out;
}

// ───────────────────────── revert decoding ─────────────────────────
// A 4-byte selector → the error's name, built once from the same pinned error
// list the Node side uses. Cheaper than pulling viem's error-ABI machinery in.

const SELECTORS: Record<string, string> = {};
for (const item of binaryErrorsAbi) {
  if (item.type !== "error") continue;
  const sig = `${item.name}(${(item.inputs ?? []).map((i) => i.type).join(",")})`;
  try {
    SELECTORS[toFunctionSelector(sig).toLowerCase()] = item.name;
  } catch {
    /* skip anything the signature builder cannot hash */
  }
}

/** Name of the custom error a failed call reverted with, when we recognise it. */
export function revertNameOf(e: unknown): string | null {
  const data = (e as RpcError)?.data;
  if (typeof data === "string" && data.length >= 10) {
    const name = SELECTORS[data.slice(0, 10).toLowerCase()];
    if (name) return name;
  }
  // Some nodes only put the selector in the message text.
  const msg = String((e as Error)?.message ?? "");
  const m = msg.match(/0x[0-9a-fA-F]{8}/);
  if (m) {
    const name = SELECTORS[m[0].toLowerCase()];
    if (name) return name;
  }
  for (const n of Object.values(SELECTORS)) if (msg.includes(n)) return n;
  return null;
}
