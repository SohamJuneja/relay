import { z } from "zod";
import { inArray, sql } from "drizzle-orm";
import type { Address } from "viem";
import { batchRead, outcomeToken6909Abi, unwrap } from "@relay/core";
import { markets } from "@relay/indexer";
import type { App } from "../app.js";
import type { ApiDeps } from "../deps.js";
import { effectiveStatus, rowsOf } from "../format.js";
import { AddressZ, Hex32 } from "../schemas.js";

export interface WalletPosition {
  marketId: string;
  asset: string;
  intervalSec: number;
  expiry: number;
  status: number;
  winner: "UP" | "DOWN" | null;
  voided: boolean;
  yes: number;
  no: number;
  yesRaw: string;
  noRaw: string;
  redeemable: boolean;
  redeemableOutcome: number[];
  operatorId: number;
  venueId: string;
}

/**
 * Outcome balances for every market this wallet traded, read from the ERC-6909
 * singleton. `redeemableOutcome` lists the outcome indices `redeem()` will pay:
 * the winning side on a resolved market, or both held sides on a voided one.
 */
export async function walletPositions(deps: ApiDeps, addr: Address, limit: number): Promise<{ outcomeToken: Address; positions: WalletPosition[] }> {
  const idsQ = rowsOf(
    await deps.db.execute(sql`
      select market_id from (
        select market_id, max(placed_block) as b from orders where owner = ${addr} and market_id is not null group by market_id
        union all
        select market_id, max(block) from fills where (taker_owner = ${addr} or maker_owner = ${addr}) and market_id is not null group by market_id
      ) x group by market_id order by max(b) desc limit ${limit}`),
  );
  const ids = idsQ.map((r) => String(r.market_id));
  const token = await deps.outcomeToken();
  if (ids.length === 0) return { outcomeToken: token, positions: [] };
  const rows = await deps.db.select().from(markets).where(inArray(markets.marketId, ids));
  const calls = rows.flatMap((m) => [
    { address: token, abi: outcomeToken6909Abi, functionName: "balanceOf", args: [addr, BigInt(m.yesId)] },
    { address: token, abi: outcomeToken6909Abi, functionName: "balanceOf", args: [addr, BigInt(m.noId)] },
  ]);
  const res = await batchRead(deps.client, calls);
  const now = Math.floor(Date.now() / 1000);
  const one = Number(10n ** BigInt(deps.cfg.decimals));
  const positions = rows
    .map((m, i) => {
      const yes = unwrap<bigint>(res[2 * i]) ?? 0n;
      const no = unwrap<bigint>(res[2 * i + 1]) ?? 0n;
      const status = effectiveStatus(m, now);
      const redeemableOutcome: number[] = [];
      if (m.voided) {
        if (yes > 0n) redeemableOutcome.push(0);
        if (no > 0n) redeemableOutcome.push(1);
      } else if (status === 4 && m.winner !== null) {
        if (m.winner === 0 && yes > 0n) redeemableOutcome.push(0);
        if (m.winner === 1 && no > 0n) redeemableOutcome.push(1);
      }
      return {
        marketId: m.marketId,
        asset: m.asset,
        intervalSec: m.intervalSec,
        expiry: Number(m.expiry),
        status,
        winner: m.winner === 0 ? ("UP" as const) : m.winner === 1 ? ("DOWN" as const) : null,
        voided: m.voided,
        yes: Number(yes) / one,
        no: Number(no) / one,
        yesRaw: yes.toString(),
        noRaw: no.toString(),
        redeemable: redeemableOutcome.length > 0,
        redeemableOutcome,
        operatorId: m.operatorId,
        venueId: m.venueId,
      };
    })
    .filter((p) => p.yes > 0 || p.no > 0)
    .sort((a, b) => b.expiry - a.expiry);
  return { outcomeToken: token, positions };
}

const PositionZ = z.object({
  marketId: Hex32,
  asset: z.string(),
  intervalSec: z.number(),
  expiry: z.number(),
  status: z.number(),
  winner: z.enum(["UP", "DOWN"]).nullable(),
  voided: z.boolean(),
  yes: z.number(),
  no: z.number(),
  yesRaw: z.string(),
  noRaw: z.string(),
  redeemable: z.boolean(),
  redeemableOutcome: z.array(z.number()),
  operatorId: z.number(),
  venueId: Hex32,
});

export function registerWallets(app: App, deps: ApiDeps): void {
  app.get(
    "/v1/wallets/:address/positions",
    {
      schema: {
        tags: ["wallets"],
        summary: "Open outcome balances (ERC-6909 reads) on markets the wallet traded, with a redeemable flag",
        params: z.object({ address: AddressZ }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }),
        response: { 200: z.object({ address: AddressZ, outcomeToken: AddressZ, positions: z.array(PositionZ) }) },
      },
    },
    async (req) => {
      const addr = req.params.address.toLowerCase() as Address;
      const { outcomeToken, positions } = await walletPositions(deps, addr, req.query.limit);
      return { address: addr, outcomeToken, positions };
    },
  );

  app.get(
    "/v1/wallets/:address/claimable",
    {
      schema: {
        tags: ["wallets"],
        summary: "Resolved markets where this wallet holds the winning side — everything redeem() needs, plus the total",
        description:
          "A subset of /positions: only markets that are Resolved (or Voided) and where the wallet holds a payable outcome. " +
          "Each row carries operatorId, venueId, marketId, outcomeIdx and the raw amount, i.e. the exact arguments for " +
          "BinaryMarketsModule.redeem(operatorId, venueId, marketId, outcomeIdx, amount). Winning shares pay 1 collateral " +
          "each minus the venue settlement fee (0 on Shannon today).",
        params: z.object({ address: AddressZ }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }),
        response: {
          200: z.object({
            address: AddressZ,
            outcomeToken: AddressZ,
            binaryModule: AddressZ,
            total: z.number(),
            totalRaw: z.string(),
            count: z.number(),
            claims: z.array(
              z.object({
                marketId: Hex32,
                operatorId: z.number(),
                venueId: Hex32,
                outcomeIdx: z.number(),
                outcome: z.enum(["UP", "DOWN"]),
                amount: z.number(),
                amountRaw: z.string(),
                asset: z.string(),
                intervalSec: z.number(),
                expiry: z.number(),
                voided: z.boolean(),
                reason: z.enum(["won", "voided"]),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const addr = req.params.address.toLowerCase() as Address;
      const { outcomeToken, positions } = await walletPositions(deps, addr, req.query.limit);
      const one = 10n ** BigInt(deps.cfg.decimals);
      const claims = positions
        .filter((p) => p.redeemable)
        .flatMap((p) =>
          p.redeemableOutcome.map((idx) => {
            const amountRaw = idx === 0 ? BigInt(p.yesRaw) : BigInt(p.noRaw);
            return {
              marketId: p.marketId,
              operatorId: p.operatorId,
              venueId: p.venueId,
              outcomeIdx: idx,
              outcome: idx === 0 ? ("UP" as const) : ("DOWN" as const),
              amount: Number(amountRaw) / Number(one),
              amountRaw: amountRaw.toString(),
              asset: p.asset,
              intervalSec: p.intervalSec,
              expiry: p.expiry,
              voided: p.voided,
              reason: p.voided ? ("voided" as const) : ("won" as const),
            };
          }),
        );
      // A voided market refunds half per side; a win pays the full share.
      const totalRaw = claims.reduce((s, c) => s + (c.voided ? BigInt(c.amountRaw) / 2n : BigInt(c.amountRaw)), 0n);
      return {
        address: addr,
        outcomeToken,
        binaryModule: deps.cfg.addresses.binaryModule,
        total: Number(totalRaw) / Number(one),
        totalRaw: totalRaw.toString(),
        count: claims.length,
        claims,
      };
    },
  );
}
