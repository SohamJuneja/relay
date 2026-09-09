// The injected-wallet path, against a stub EIP-1193 provider.
//
// Playwright cannot drive MetaMask, and this is the one flow where a mistake is
// expensive and invisible: a widget that submits an order while the wallet is still
// pointed at another chain gets a signature for a transaction that will never land,
// or lands somewhere it should not. So the chain switch is tested here instead.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { chainInfo, connectInjected, ensureChain, type Eip1193Provider } from "./wallet.js";

const chain = chainInfo("testnet");
const ADDRESS = "0xb5eCf004491aa8589a82af91633D18867fcFF038";

/** A provider that records what it was asked, and can be told how to fail. */
function stub(opts: { accounts?: string[]; switchError?: { code?: number; data?: unknown } | null; addFails?: boolean } = {}) {
  const calls: { method: string; params?: unknown[] }[] = [];
  const provider: Eip1193Provider = {
    async request(args) {
      calls.push(args);
      switch (args.method) {
        case "eth_requestAccounts":
          return opts.accounts ?? [ADDRESS];
        case "wallet_switchEthereumChain":
          if (opts.switchError) throw opts.switchError;
          return null;
        case "wallet_addEthereumChain":
          if (opts.addFails) throw new Error("user rejected");
          return null;
        case "eth_sendTransaction":
          return "0xdeadbeef";
        default:
          throw new Error(`unexpected ${args.method}`);
      }
    },
  };
  return { provider, calls };
}

beforeEach(() => {
  (globalThis as { ethereum?: unknown }).ethereum = undefined;
});

describe("ensureChain", () => {
  it("switches to Somnia Shannon by its hex chain id", async () => {
    const { provider, calls } = stub();
    await ensureChain(provider, chain);
    expect(chain.id).toBe(50312);
    expect(calls).toEqual([{ method: "wallet_switchEthereumChain", params: [{ chainId: "0xc488" }] }]);
  });

  it("adds the chain when the wallet does not know it, then switches", async () => {
    // 4902 is "unrecognised chain". A wallet that has never seen Somnia answers this,
    // and the only useful response is to describe the network and try again.
    const { provider, calls } = stub({ switchError: { code: 4902 } });
    // The second switch succeeds because the stub throws on every switch; assert the
    // sequence instead of the outcome.
    await ensureChain(provider, chain).catch(() => undefined);
    const methods = calls.map((c) => c.method);
    expect(methods).toEqual(["wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_switchEthereumChain"]);

    const added = calls[1]!.params?.[0] as { chainId: string; chainName: string; rpcUrls: string[]; nativeCurrency: { symbol: string; decimals: number } };
    expect(added.chainId).toBe("0xc488");
    expect(added.chainName).toContain("Somnia");
    expect(added.rpcUrls[0]).toMatch(/^https?:\/\//);
    expect(added.nativeCurrency).toMatchObject({ symbol: "STT", decimals: 18 });
  });

  it("treats a wrapped -32603 as unrecognised too", async () => {
    // Several wallets bury the 4902 inside an internal error rather than surfacing it.
    const { provider, calls } = stub({ switchError: { code: -32603 } });
    await ensureChain(provider, chain).catch(() => undefined);
    expect(calls.map((c) => c.method)).toContain("wallet_addEthereumChain");
  });

  it("gives up on an error that is not about an unknown chain", async () => {
    // 4001 is "user rejected". Retrying by adding the chain would prompt them again
    // for something they just declined.
    const { provider, calls } = stub({ switchError: { code: 4001 } });
    await expect(ensureChain(provider, chain)).rejects.toMatchObject({ code: 4001 });
    expect(calls.map((c) => c.method)).toEqual(["wallet_switchEthereumChain"]);
  });
});

describe("connectInjected", () => {
  it("refuses when there is no wallet at all", async () => {
    await expect(connectInjected(chain)).rejects.toThrow(/no injected wallet/i);
  });

  it("asks for accounts and puts the wallet on Somnia before returning", async () => {
    const { provider, calls } = stub();
    (globalThis as { ethereum?: unknown }).ethereum = provider;
    const w = await connectInjected(chain);
    expect(w.kind).toBe("injected");
    expect(w.address).toBe(ADDRESS);
    // The order matters: accounts first, then the chain, and only then is the wallet
    // handed back to a caller that will immediately try to sign with it.
    expect(calls.map((c) => c.method)).toEqual(["eth_requestAccounts", "wallet_switchEthereumChain"]);
  });

  it("refuses when the wallet returns no account", async () => {
    const { provider } = stub({ accounts: [] });
    (globalThis as { ethereum?: unknown }).ethereum = provider;
    await expect(connectInjected(chain)).rejects.toThrow(/no account/i);
  });

  it("never exposes a key — an injected wallet has no export", async () => {
    const { provider } = stub();
    (globalThis as { ethereum?: unknown }).ethereum = provider;
    const w = await connectInjected(chain);
    expect(w.exportKey).toBeUndefined();
  });

  it("delegates signing rather than doing it, and states gas and value in hex", async () => {
    const { provider, calls } = stub();
    (globalThis as { ethereum?: unknown }).ethereum = provider;
    const w = await connectInjected(chain);
    const hash = await w.send({ to: ADDRESS, data: "0x1234", gas: 500_000n, value: 0n });
    expect(hash).toBe("0xdeadbeef");
    const sent = calls.find((c) => c.method === "eth_sendTransaction")!.params?.[0] as Record<string, string>;
    // No nonce, no gas price, no signature: the wallet owns all of that.
    expect(sent).toEqual({ from: ADDRESS, to: ADDRESS, data: "0x1234", gas: "0x7a120" });
    expect(sent.value).toBeUndefined();
  });
});

describe("the wallet the widget offers first", () => {
  it("reports no injected provider when the page has none", async () => {
    const { injectedProvider } = await import("./wallet.js");
    expect(injectedProvider()).toBeNull();
  });

  it("finds one when the page has it", async () => {
    const { provider } = stub();
    (globalThis as { ethereum?: unknown }).ethereum = provider;
    const { injectedProvider } = await import("./wallet.js");
    expect(injectedProvider()).toBe(provider);
  });
});

describe("chainInfo", () => {
  it("describes Shannon well enough for a wallet to add it", () => {
    expect(chain).toMatchObject({ id: 50312, nativeCurrency: { symbol: "STT", decimals: 18 } });
    expect(chain.rpcUrl).toMatch(/^https?:\/\//);
    expect(chain.explorer).toMatch(/^https?:\/\//);
  });

  it("uses SOMI on mainnet, not the testnet token", () => {
    expect(chainInfo("mainnet").nativeCurrency.symbol).toBe("SOMI");
  });
});
