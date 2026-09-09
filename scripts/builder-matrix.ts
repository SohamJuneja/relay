// Phase 1 · Step 3 — builder-code experiments. eth_call simulations from OUR
// funded address first; the only real sends here are (a) an ERC-20 approve to
// the pool if the allowance is short and (b) approveBuilder(PARTNER, 0) in
// variant C if its simulation succeeds. Writes docs/BUILDER_FINDINGS.md.
//
//   pnpm builder-matrix

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeErrorResult, formatUnits, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { contractErrorsAbi } from "@somnia-chain/markets-sdk";
import {
  ORDER_KIND,
  ORDER_TYPE,
  SELF_MATCHING_OPTION,
  SURFACE,
  ZERO_ADDRESS,
  binaryErrorsAbi,
  binaryPoolReadAbi,
  binaryPoolWriteAbi,
  encodeUserData,
  erc20Abi,
  estimateGasWithFloor,
  explainRevert,
  expiryNsFromSec,
  formatBpsTimes1k,
  sendContractWrite,
  snapDown,
} from "@relay/core";
import { iso, loadPhase1Env, nowSec, txUrl } from "./_env.js";
import { loadState, pickTradingMarket, saveState, stateFromPick } from "./_pick.js";

const RELAY_PARTNER_ID = 1; // Relay's own demo partner id
const EXTRA: Abi = [...binaryPoolWriteAbi, ...binaryErrorsAbi, ...contractErrorsAbi];

interface Row {
  variant: string;
  builder: Address;
  fee: bigint;
  userData: bigint;
  result: string;
  selector: string;
  note: string;
}

function describeRevert(e: unknown): { result: string; selector: string } {
  const r = explainRevert(e);
  let name = r.name;
  if (!name && r.raw) {
    try {
      name = decodeErrorResult({ abi: contractErrorsAbi, data: r.raw }).errorName;
    } catch {
      /* not in the SDK table either */
    }
  }
  return { result: `REVERT ${name ?? "(unknown selector)"}`, selector: r.selector ?? "-" };
}

async function main(): Promise<void> {
  const env = loadPhase1Env();
  const { publicClient: pc, walletClient: wc, account, addresses, one, decimals } = env;
  console.log(`address ${account.address} · venue ${env.venueId}`);

  // Market with a two-sided book, ≥60s left, prefer 5m/15m.
  const pick = await pickTradingMarket(env, { minLeftSec: 60, preferIntervals: [300, 900] });
  const m = pick.m;
  const left = m.expiry - nowSec();
  console.log(`\nmarket ${m.marketId}\n  ${m.asset} ${m.intervalSec}s · pool ${m.pool} · expires ${iso(m.expiry)} (${left}s left)`);
  console.log(`  YES best bid ${pick.summary.bestBid?.toFixed(3)} · best ask ${pick.summary.bestAsk?.toFixed(3)} · spread ${((pick.summary.spread ?? 0) * 100).toFixed(1)} pts`);

  const [bookParams, marketExpiryNs, cap, asks] = await Promise.all([
    pc.readContract({ address: m.pool, abi: binaryPoolReadAbi, functionName: "getOrderBookParameters" }),
    pc.readContract({ address: m.pool, abi: binaryPoolReadAbi, functionName: "marketExpiryNs" }),
    pc.readContract({ address: m.pool, abi: binaryPoolReadAbi, functionName: "getMaxBuilderFeeBpsTimes1k" }),
    pc.readContract({ address: m.pool, abi: binaryPoolReadAbi, functionName: "getBookLevels", args: [false, 1n] }),
  ]);
  const bestAsk = asks[0]!;
  const price = bestAsk.price;
  const qty = snapDown(1n * one, bookParams.lotSize); // 1 contract on the lot grid
  const need = (price * qty + one - 1n) / one;
  console.log(`  pool cap getMaxBuilderFeeBpsTimes1k = ${formatBpsTimes1k(cap)} · tick ${bookParams.tickSize} lot ${bookParams.lotSize} min ${bookParams.minQuantity}`);
  console.log(`  order: BUY_YES IOC at best ask ${formatUnits(price, decimals)} × ${formatUnits(qty, decimals)} contract → escrow ${formatUnits(need, decimals)} tUSDC`);

  // Allowance to the pool so the simulations do not fail on ERC20InsufficientAllowance.
  const allowance = await pc.readContract({ address: addresses.collateral, abi: erc20Abi, functionName: "allowance", args: [account.address, m.pool] });
  let approveTx: Hex | null = null;
  if (allowance < need) {
    const amount = 1_000n * one;
    const approveAbi: Abi = [...erc20Abi, ...binaryErrorsAbi];
    const call = { address: addresses.collateral, abi: approveAbi, functionName: "approve", args: [m.pool, amount] as const, account };
    await pc.simulateContract(call);
    approveTx = await sendContractWrite(wc, { ...call, gas: await estimateGasWithFloor(pc, call, 1_000_000n) });
    const r = await pc.waitForTransactionReceipt({ hash: approveTx });
    console.log(`  approve(pool, ${formatUnits(amount, decimals)}) → ${approveTx} status ${r.status}`);
    if (r.status !== "success") throw new Error("approve reverted");
  } else {
    console.log(`  allowance(pool) = ${formatUnits(allowance, decimals)} ✓`);
  }

  // Throwaway partner builder address — key generated in memory, never printed.
  const partner = privateKeyToAccount(generatePrivateKey()).address;
  console.log(`\nPARTNER builder (throwaway) ${partner}`);
  const userData = encodeUserData({ partnerId: RELAY_PARTNER_ID, surfaceId: SURFACE.WEB });

  const expireNs = (() => {
    const want = expiryNsFromSec(nowSec() + 45);
    return want < marketExpiryNs ? want : marketExpiryNs;
  })();

  const rows: Row[] = [];
  const simulate = async (variant: string, builder: Address, fee: bigint, note: string): Promise<Row> => {
    const args = [ORDER_KIND.BUY_YES, price, qty, expireNs, ORDER_TYPE.IOC, SELF_MATCHING_OPTION.CANCEL_TAKER, builder, fee, userData] as const;
    let row: Row;
    try {
      const sim = await pc.simulateContract({ address: m.pool, abi: EXTRA, functionName: "placeBinaryOrder", args, account });
      const [success, orderId] = sim.result as unknown as readonly [boolean, bigint];
      row = { variant, builder, fee, userData, result: `OK success=${success} orderId=${orderId}`, selector: "-", note };
    } catch (e) {
      const d = describeRevert(e);
      row = { variant, builder, fee, userData, result: d.result, selector: d.selector, note };
    }
    console.log(`  ${variant}  builder=${builder === ZERO_ADDRESS ? "0x0" : "PARTNER"} fee=${fee}  → ${row.result}${row.selector !== "-" ? ` [${row.selector}]` : ""}`);
    rows.push(row);
    return row;
  };

  console.log("\nsimulations (eth_call from our address):");
  await simulate("A", ZERO_ADDRESS, 0n, "baseline: untagged builder, Relay userData");
  const b = await simulate("B", partner, 0n, "builder set, fee 0, NO approveBuilder");

  // C: approveBuilder(PARTNER, 0) — simulate, send if ok, then repeat B.
  let approveBuilderTx: Hex | null = null;
  let cNote = "";
  try {
    const call = { address: m.pool, abi: EXTRA, functionName: "approveBuilder", args: [partner, 0n] as const, account };
    await pc.simulateContract(call);
    approveBuilderTx = await sendContractWrite(wc, { ...call, gas: await estimateGasWithFloor(pc, call, 1_000_000n) });
    const r = await pc.waitForTransactionReceipt({ hash: approveBuilderTx });
    const approval = await pc.readContract({ address: m.pool, abi: binaryPoolReadAbi, functionName: "getBuilderApproval", args: [account.address, partner] });
    const effective = await pc.readContract({ address: m.pool, abi: binaryPoolReadAbi, functionName: "getEffectiveBuilderApproval", args: [account.address, partner] });
    cNote = `approveBuilder(PARTNER, 0) SENT ${approveBuilderTx} status=${r.status} gasUsed=${r.gasUsed}; getBuilderApproval=${approval} getEffectiveBuilderApproval=${effective}`;
    console.log(`  C  ${cNote}\n     ${txUrl(env.explorer, approveBuilderTx)}`);
  } catch (e) {
    const d = describeRevert(e);
    cNote = `approveBuilder(PARTNER, 0) simulation ${d.result} [${d.selector}] — not sent`;
    console.log(`  C  ${cNote}`);
  }
  await simulate("C", partner, 0n, `after ${approveBuilderTx ? "approveBuilder sent" : "approveBuilder NOT sent"}`);
  await simulate("D", partner, 1n, "builder set, fee 1 (bps×1000) vs cap " + cap);
  // Extra: does the pool distinguish approval from cap? fee=1 after approving 1.
  let extraNote = "";
  if (cap === 0n) {
    try {
      await pc.simulateContract({ address: m.pool, abi: EXTRA, functionName: "approveBuilder", args: [partner, 1n], account });
      extraNote = "approveBuilder(PARTNER, 1) simulates OK (approval can exceed cap; cap is enforced at placement)";
    } catch (e) {
      const d = describeRevert(e);
      extraNote = `approveBuilder(PARTNER, 1) simulation: ${d.result} [${d.selector}]`;
    }
    console.log(`  E  ${extraNote}`);
  }

  // Persist for the trade + settle steps.
  const st = loadState();
  st.pickedAt = new Date().toISOString();
  st.market = stateFromPick(pick);
  st.partner = { builder: partner };
  if (approveBuilderTx) st.approveBuilderTx = approveBuilderTx;
  st.matrix = Object.fromEntries(rows.map((r) => [r.variant, r.result]));
  saveState(st);

  // docs/BUILDER_FINDINGS.md
  const bAccepted = b.result.startsWith("OK success=true");
  const cRow = rows.find((r) => r.variant === "C")!;
  const dRow = rows.find((r) => r.variant === "D")!;
  const md = `# Builder-code findings (Shannon testnet)

Generated by \`pnpm builder-matrix\` on ${new Date().toISOString()}.
All results are \`eth_call\` simulations of \`placeBinaryOrder\` from the funded address
\`${account.address}\`, IOC BUY_YES at the best ask, 1 contract, on a live Trading market of the
DreamDEX venue. Real sends: ${approveTx ? `ERC-20 approve to the pool (${approveTx})` : "none for allowance"}${approveBuilderTx ? `; approveBuilder(PARTNER, 0) (${approveBuilderTx})` : ""}.

| | value |
| --- | --- |
| market | \`${m.marketId}\` — ${m.asset} ${m.intervalSec}s, expiry ${iso(m.expiry)} |
| pool | \`${m.pool}\` |
| pool \`getMaxBuilderFeeBpsTimes1k()\` | **${cap}** |
| PARTNER (throwaway builder address) | \`${partner}\` |
| userData (Relay v1 tag, partner ${RELAY_PARTNER_ID}, surface WEB) | \`${userData}\` (0x${userData.toString(16)}) |
| order | kind BUY_YES, price ${price} (${formatUnits(price, decimals)}), qty ${qty}, IOC, expire ${expireNs} ns |

## Matrix

| variant | builder | builderFeeBpsTimes1k | approveBuilder | result | selector |
| --- | --- | --- | --- | --- | --- |
${rows
  .map(
    (r) =>
      `| ${r.variant} | ${r.builder === ZERO_ADDRESS ? "address(0)" : "PARTNER"} | ${r.fee} | ${r.variant === "C" ? (approveBuilderTx ? "sent (cap 0)" : "simulation reverted, not sent") : "no"} | ${r.result} | ${r.selector} |`,
  )
  .join("\n")}

C detail: ${cNote}
${extraNote ? `\nE detail: ${extraNote}\n` : ""}
## Reading

- **A (baseline)** is the path Relay always has: untagged builder, Relay \`userData\`. ${rows[0]!.result.startsWith("OK") ? "Accepted." : "Rejected — see selector."}
- **B**: builder ≠ 0 with fee 0 and NO approval is **${bAccepted ? "ACCEPTED" : "REJECTED (" + b.result + ")"}** on a cap-0 testnet pool. ${bAccepted ? "So the builder address can be attached on testnet at no cost; `approveBuilder` only gates a non-zero fee." : "So on testnet Relay must send builder = address(0) and rely on userData alone; the fee channel is mainnet-only."}
- **C**: ${approveBuilderTx ? "approveBuilder(PARTNER, 0) is a valid pool call even at cap 0" : "approveBuilder(PARTNER, 0) reverts at cap 0"}; the tagged fee-0 order afterwards: ${cRow.result}.
- **D**: fee = 1 on a cap-0 pool → ${dRow.result}. This is the error the widget must map to "builder fees are not enabled on this network".
- Open: whether an approval on this pool survives the pool's recycle onto its next market (nonce+1), and the exact \`BuilderFeeCharged\` shape — a real fee needs mainnet (cap 1 %).
`;
  const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs/BUILDER_FINDINGS.md");
  writeFileSync(out, md);
  console.log(`\nwrote docs/BUILDER_FINDINGS.md and artifacts/phase1.json`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
