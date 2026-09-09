// Phase 1 · Step 1 — wallet readiness. Prints address + balances, tops up tUSDC
// from the public faucet when low, and STOPS if there is not enough gas.
//
//   pnpm wallet

import { formatUnits } from "viem";
import { ADDRESSES, binaryErrorsAbi, erc20Abi, estimateGasWithFloor, explainRevert, outcomeToken6909Abi, readPoolSnapshot, sendContractWrite, testUsdcAbi, discoverMarketsFromLogs, MarketStatus, readMarketStatuses } from "@relay/core";
import { loadPhase1Env, txUrl } from "./_env.js";

const MIN_STT = 0.5;
const MIN_TUSDC = 50;
const FAUCET_AMOUNT = 1_000n; // whole tUSDC; the faucet caps somewhere between 10,000 and 100,000

async function main(): Promise<void> {
  const env = loadPhase1Env();
  const { publicClient: pc, walletClient: wc, account, addresses, one, decimals } = env;
  console.log(`address   ${account.address}`);
  console.log(`network   ${env.network} (chain ${env.chainId}) · venue ${env.venueId}`);

  const stt = await pc.getBalance({ address: account.address });
  let usdc = await pc.readContract({ address: addresses.collateral, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  console.log(`STT       ${formatUnits(stt, 18)}`);
  console.log(`tUSDC     ${formatUnits(usdc, decimals)}`);

  if (Number(formatUnits(stt, 18)) < MIN_STT) {
    console.log(`\nSTOP: STT ${formatUnits(stt, 18)} < ${MIN_STT}. Get gas from the Somnia Telegram faucet (https://t.me/+XHq0F0JXMyhmMzM0, faucet topic) for ${account.address} and re-run.`);
    process.exit(2);
  }

  if (Number(formatUnits(usdc, decimals)) < MIN_TUSDC) {
    const amount = FAUCET_AMOUNT * one;
    console.log(`\ntUSDC below ${MIN_TUSDC} → calling faucet(${amount}) on ${ADDRESSES[env.network].collateral} …`);
    try {
      const faucetAbi = [...testUsdcAbi, ...binaryErrorsAbi];
      const call = { address: addresses.collateral, abi: faucetAbi, functionName: "faucet" as const, args: [amount] as const, account };
      await pc.simulateContract(call);
      const gas = await estimateGasWithFloor(pc, call, 1_000_000n);
      console.log(`  gas limit ${gas} (2 × estimate, floor 1M — a 300k limit ran out of gas on Somnia)`);
      const hash = await sendContractWrite(wc, { ...call, gas });
      console.log(`  faucet tx ${hash}\n  ${txUrl(env.explorer, hash)}`);
      const rcpt = await pc.waitForTransactionReceipt({ hash });
      console.log(`  status ${rcpt.status} · gasUsed ${rcpt.gasUsed}`);
      if (rcpt.status !== "success") throw new Error("faucet reverted on chain");
      usdc = await pc.readContract({ address: addresses.collateral, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
      console.log(`  tUSDC now ${formatUnits(usdc, decimals)}`);
    } catch (e) {
      const r = explainRevert(e);
      console.log(`  faucet FAILED: ${r.name ?? r.selector ?? r.message}`);
      process.exit(1);
    }
  }

  // Allowance / operator status for the pools currently Trading on our venue.
  const head = await pc.getBlockNumber();
  const markets = await discoverMarketsFromLogs({ client: pc, binaryModule: addresses.binaryModule, fromBlock: head - 36_000n, toBlock: head, concurrency: 8 });
  const mine = markets.filter((m) => m.venueId.toLowerCase() === env.venueId && m.expiry > Math.floor(Date.now() / 1000));
  const st = await readMarketStatuses(pc, mine.map((m) => m.market));
  const trading = mine.filter((_, i) => st[i] === MarketStatus.Trading);
  console.log(`\nvenue pools currently Trading (last ~1h of MarketCreated): ${trading.length}`);
  for (const m of trading) {
    const [allowance, snap] = await Promise.all([
      pc.readContract({ address: addresses.collateral, abi: erc20Abi, functionName: "allowance", args: [account.address, m.pool] }),
      readPoolSnapshot(pc, m.pool),
    ]);
    const isOp = await pc.readContract({ address: snap.params.outcomeToken, abi: outcomeToken6909Abi, functionName: "isOperator", args: [account.address, m.pool] });
    console.log(`  ${m.asset.padEnd(4)} ${String(m.intervalSec).padStart(6)}s  pool ${m.pool}  allowance(pool)=${formatUnits(allowance, decimals)}  6909.isOperator(pool)=${isOp}`);
  }
  const moduleOp = trading[0]
    ? await pc.readContract({ address: (await readPoolSnapshot(pc, trading[0].pool)).params.outcomeToken, abi: outcomeToken6909Abi, functionName: "isOperator", args: [account.address, addresses.binaryModule] })
    : null;
  console.log(`  6909.isOperator(binaryModule) = ${moduleOp}  (needed for redeem; set lazily by settle.ts)`);
  console.log(`\nNo allowance is granted here: the trade path approves the exact pool it trades on, when it trades (buys need ERC-20 allowance to the POOL; sells need 6909 operator on the POOL; redeem needs 6909 operator on the MODULE).`);
  console.log("wallet ready.");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
