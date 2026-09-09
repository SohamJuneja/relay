// DreamDEX Event Contract deployment addresses.
//
// Primary source: @somnia-chain/markets-sdk 0.29.0 dist/addresses.js
// (SOMNIA_TESTNET_ADDRESSES / SOMNIA_MAINNET_ADDRESSES). The protocol core is
// CREATE3-deterministic, so module / settlement / router / hub are identical on
// both networks; only the collateral token and the rolling-series
// `marketCreator` differ.
//
// The dreamdex-bot-kit (packages/ec-core/src/addresses.ts, verified 2026-07-24)
// carries OLDER values for three entries — kept below as comments so a reader
// can see the drift:
//   clobFactory     kit 0xb2BE8EE02F96379DB75f01802384593EBa9bfF04  sdk 0x1a478019…
//   binaryPoolImpl  kit 0x82A1FcdaA2daC2fC7D5f9909D43E68021eE966FD  sdk 0x48e523c9…
//                   (pools are BEACON proxies; the impl moves under you — kit gotcha #22)
//   marketCreator   kit 0x5Ce69567dB39C8fBAd7e048bEfdbcCdfE67B44e6  sdk 0x138CfA6b…
//
// None of those three are needed for discovery: the BinaryMarketsModule emits a
// `MarketCreated` for EVERY market (module-created or creator-created), and it
// is the only creation event carrying (operatorId, venueId). Discover from the
// module.

import type { Address } from "viem";
import type { Network } from "./chain.js";

export interface EcAddresses {
  /** BinaryMarketsModule — market registry, MarketCreated emitter, redeem entry. */
  binaryModule: Address;
  /** UpgradeableBeacon every BinaryPool proxy delegates to. */
  binaryPoolBeacon: Address;
  /** Current beacon implementation (informational; resolve `implementation()` live). */
  binaryPoolImpl: Address;
  /** BinarySettlement singleton — permanent redemption home after finalize. */
  binarySettlement: Address;
  clobFactory: Address;
  /** Collateral ERC-20: tUSDC (6 dp, public faucet) on testnet; USDso (18 dp) on mainnet. */
  collateral: Address;
  collateralRouter: Address;
  /** Rolling-series MarketCreator (13-field MarketCreated; no venueId). */
  marketCreator: Address;
  marketCreatorFactory: Address;
  marketsCore: Address;
  oracleHub: Address;
}

export const ADDRESSES: Record<Network, EcAddresses> = {
  testnet: {
    binaryModule: "0x3ecC694Cef705358864a646142ac17A90E29e388",
    binaryPoolBeacon: "0x85C01B5ef4F4ed59caC69749565e309f01b14Dbc",
    binaryPoolImpl: "0x48e523c9f22f98548d263f0aD444D732e5202C0E",
    binarySettlement: "0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23",
    clobFactory: "0x1a478019Ae4d24249a962934af0f129CE98B5e6f",
    collateral: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
    collateralRouter: "0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C",
    marketCreator: "0x138CfA6b80475b8c03d7E468b2442278E51e645a",
    marketCreatorFactory: "0xE6bEE93cE87c9E6e62aCb621caa7832EE47b4F6B",
    marketsCore: "0x2802504314685D89bF6C992CA5a8e7cC78bc0294",
    oracleHub: "0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b",
  },
  mainnet: {
    binaryModule: "0x3ecC694Cef705358864a646142ac17A90E29e388",
    binaryPoolBeacon: "0x85C01B5ef4F4ed59caC69749565e309f01b14Dbc",
    binaryPoolImpl: "0x48e523c9f22f98548d263f0aD444D732e5202C0E",
    binarySettlement: "0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23",
    clobFactory: "0x1a478019Ae4d24249a962934af0f129CE98B5e6f",
    collateral: "0x00000022dA000002656c64D9eA6011ea952D008A",
    collateralRouter: "0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C",
    marketCreator: "0xfe81C4e8EfFb7df27Eb21881f80AF2BF8DCF0c39",
    marketCreatorFactory: "0xE6bEE93cE87c9E6e62aCb621caa7832EE47b4F6B",
    marketsCore: "0x2802504314685D89bF6C992CA5a8e7cC78bc0294",
    oracleHub: "0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b",
  },
};

/** Collateral decimals per network. Always confirm with `decimals()` on chain. */
export const COLLATERAL_DECIMALS: Record<Network, number> = { testnet: 6, mainnet: 18 };

/**
 * Venue ids the kit shipped as STARTING POINTS (dreamdex-bot-kit .env.example,
 * docs/event-contracts.md). They moved three times in one week; the probe
 * infers the live value from MarketCreated logs and prints it. Never trust these
 * blindly.
 */
export const KIT_VENUE_HINTS: Record<Network, `0x${string}`> = {
  testnet: "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c",
  mainnet: "0x458b30c2d72bfd2c6317304a4594ecbafe5f729d3111b65fdc3a33bd48e5432d",
};

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
