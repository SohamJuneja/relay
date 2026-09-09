// IBinaryMarket — the per-window market clone that carries status + outcome.
//
// Sources: IEventContracts.sol (IBinaryMarket) + markets-sdk readsAbi.js
// (binaryMarketReadAbi). `status()` is the AUTHORITATIVE trading gate — the
// indexer's status lags by seconds (kit event-contracts.md sharp edge #1/#9).

import { parseAbi } from "viem";

export const binaryMarketReadAbi = parseAbi([
  "function outcomeToken() view returns (address)",
  "function yesId() view returns (uint256)",
  "function noId() view returns (uint256)",
  "function pool() view returns (address)",
  "function collateral() view returns (address)",
  // MarketStatus enum: 0 Listed · 1 Trading · 2 Locked · 3 Settling · 4 Resolved · 5 Voided
  "function status() view returns (uint8)",
  "function backing() view returns (uint256)",
  "function expiry() view returns (uint64)",
  // Seconds after expiry the oracle may still answer; voidExpired() opens after.
  "function settlementWindow() view returns (uint64)",
  // Payout VECTOR (index 0 = YES/Up). One-hot on resolve, equal halves on void.
  "function payoutNumerators() view returns (uint256[])",
  "function isResolved() view returns (bool)",
  "function isVoided() view returns (bool)",
  // 0 UNIFORM · 2 CLOB_SNAPSHOT. Older clones lack the selector.
  "function voidPolicy() view returns (uint8)",
]);

export const binaryMarketWriteAbi = parseAbi([
  // Permissionless dead-oracle escape hatch; reverts SettlementWindowOpen() early.
  "function voidExpired()",
]);
