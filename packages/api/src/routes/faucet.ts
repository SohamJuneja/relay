// POST /v1/gas-drip — the TESTNET stand-in for a mainnet paymaster.
//
// A browser burner wallet starts with nothing and cannot pay for its own first
// transaction. On mainnet that is solved by a paymaster / ERC-4337 sponsor or by
// the partner funding the user; on Shannon we simply send a little STT from the
// API's own key so the burner can then call the public tUSDC `faucet(uint256)`
// itself. The API never touches the user's collateral and never signs an order:
// only this one native transfer.
//
// Guards: testnet only, one drip per address per day, 3 per hour per IP, and a
// refusal if the address already has enough gas.

import { z } from "zod";
import { createWalletClient, formatEther, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { relayChain } from "@relay/core";
import type { App } from "../app.js";
import type { ApiDeps } from "../deps.js";
import { AddressZ } from "../schemas.js";

/**
 * How much a burner needs to onboard and trade a few times.
 *
 * Not "the fee of one transaction": a node reserves `gas × maxFeePerGas` up front,
 * so with a 15 gwei cap a 3 M-gas order needs 0.045 STT *available*
 * even though it will only spend ~0.012 at the 6 gwei base fee. 0.03 STT was
 * enough to mine the drip and nothing after it — the tUSDC faucet failed with
 * "insufficient balance". 0.2 STT covers the largest single reserve with room for
 * several trades and a claim.
 */
const DRIP_AMOUNT = parseEther("0.2");
/**
 * Gas for the transfer. NOT 21 000: Somnia prices state creation aggressively and
 * paying a never-funded address measured **421 000 gas** on Shannon. Worse,
 * `eth_estimateGas` answers 21 000 for it, so estimating is actively misleading —
 * a 30 000-limit transfer mined with status 0 and burned the whole limit while the
 * recipient stayed at zero. Pin a high limit and check the receipt.
 */
const DRIP_GAS = 600_000n;
/** Above this the address does not need help. */
const ENOUGH = parseEther("0.05");
const PER_ADDRESS_MS = Number(process.env.GAS_DRIP_PER_ADDRESS_HOURS ?? 24) * 60 * 60 * 1000;
/** Requests per hour per IP. 3 in production; raise it for an automated test run. */
const PER_IP_PER_HOUR = Number(process.env.GAS_DRIP_PER_HOUR ?? 3);

export function registerFaucet(app: App, deps: ApiDeps): void {
  const lastDrip = new Map<string, number>();
  const key = (process.env.PRIVATE_KEY ?? "").trim();
  const account = /^(0x)?[0-9a-fA-F]{64}$/.test(key) ? privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex) : null;
  const chain = relayChain({ network: deps.cfg.network, rpcUrl: deps.cfg.rpcUrl, wsRpcUrl: deps.cfg.wsRpcUrl });
  const wallet = account ? createWalletClient({ account, chain, transport: http(deps.cfg.rpcUrl) }) : null;

  app.post(
    "/v1/gas-drip",
    {
      config: { rateLimit: { max: PER_IP_PER_HOUR, timeWindow: "1 hour" } },
      schema: {
        tags: ["faucet"],
        summary: "Testnet gas drip: send 0.2 STT to a fresh burner so it can call the tUSDC faucet itself",
        description:
          "TESTNET ONLY — the stand-in for a mainnet paymaster. Refuses when the address already holds ≥ 0.05 STT, " +
          "when it was dripped recently, or on mainnet. Rate limited per IP (3/hour by default). " +
          "The API does not fund collateral: after this the client calls tUSDC `faucet(uint256)` from the burner itself.",
        body: z.object({ address: AddressZ }),
        response: {
          200: z.object({ txHash: z.string(), amount: z.string(), amountWei: z.string(), balanceBefore: z.string(), from: AddressZ, note: z.string() }),
          400: z.object({ error: z.string(), message: z.string().optional(), balance: z.string().optional(), retryAfterSec: z.number().optional() }),
          503: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (req, reply) => {
      if (deps.cfg.network !== "testnet") {
        return reply.status(400).send({ error: "mainnet_not_supported", message: "the gas drip is a testnet development aid; use a paymaster on mainnet" });
      }
      if (!wallet || !account) {
        return reply.status(503).send({ error: "drip_unavailable", message: "the API has no PRIVATE_KEY configured" });
      }
      const to = req.body.address.toLowerCase() as Address;
      const prev = lastDrip.get(to);
      if (prev !== undefined && Date.now() - prev < PER_ADDRESS_MS) {
        return reply.status(400).send({ error: "already_dripped", message: "one drip per address per day", retryAfterSec: Math.ceil((PER_ADDRESS_MS - (Date.now() - prev)) / 1000) });
      }
      const balance = await deps.client.getBalance({ address: to });
      if (balance >= ENOUGH) {
        return reply.status(400).send({ error: "already_funded", message: `address already holds ${formatEther(balance)} STT`, balance: formatEther(balance) });
      }
      const treasury = await deps.client.getBalance({ address: account.address });
      if (treasury < DRIP_AMOUNT * 2n) {
        return reply.status(503).send({ error: "drip_exhausted", message: `the drip wallet holds ${formatEther(treasury)} STT` });
      }
      lastDrip.set(to, Date.now());
      try {
        const txHash = await wallet.sendTransaction({ to, value: DRIP_AMOUNT, chain, maxFeePerGas: 60_000_000_000n, maxPriorityFeePerGas: 0n, gas: DRIP_GAS });
        // A mined transaction can still be a failed one — never report a drip as
        // sent until the receipt says so, or the client waits forever for funds.
        const receipt = await deps.client.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
        if (receipt.status !== "success") {
          lastDrip.delete(to);
          return reply.status(503).send({ error: "drip_failed", message: `the drip transaction reverted (${txHash})` });
        }
        return {
          txHash,
          amount: formatEther(DRIP_AMOUNT),
          amountWei: DRIP_AMOUNT.toString(),
          balanceBefore: formatEther(balance),
          from: account.address,
          note: "testnet gas only — now call tUSDC faucet(uint256) from this address for collateral",
        };
      } catch (e) {
        lastDrip.delete(to);
        throw e;
      }
    },
  );
}
