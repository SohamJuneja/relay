// IBinaryMarketsModule — the market registry. Discovery + claiming happen here.
//
// Sources: IEventContracts.sol (IBinaryMarketsModule.redeem) + markets-sdk
// moduleAbi.js (binaryModuleReadAbi / binaryModuleWriteAbi).
//
// `markets(bytes32 marketId)` is the raw-chain answer to "what pool/market/
// venue does this id map to right now" — the SDK's getMarketOnchain is built on
// it. It carries originOperatorId + originVenueId, so venue scoping never needs
// the indexer.

import { parseAbi } from "viem";

export const binaryModuleReadAbi = parseAbi([
  "function settlement() view returns (address)",
  "function poolCreator(address pool) view returns (address creator)",
  "function getFreePools(address creator, address collateral) view returns (address[] pools)",
  "function freePoolCount(address creator, address collateral) view returns (uint256 count)",
  "function marketNonce(bytes32 marketId) view returns (uint64 nonce)",
  "function markets(bytes32 marketId) view returns (uint256 oracleQuestionId, uint8 outcomeSlotCount, uint8 voidPolicy, address collateral, uint32 originOperatorId, bytes32 originVenueId, address oracleAdapter, address creator, address market, address pool, uint256 yesId, uint256 noId, uint64 tradingStart, uint64 expiry)",
]);

export const binaryModuleWriteAbi = parseAbi([
  // (operatorId, venueId) are attribution-only here and may be 0.
  "function redeem(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount)",
  "function redeemMany(uint32 operatorId, bytes32 venueId, bytes32[] marketIds, uint8[] outcomeIdxs, uint256[] amounts)",
  "function mintCompleteSet(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint256 amount)",
  "function mergeCompleteSet(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint256 amount)",
  // Permissionless keeper entries.
  "function finalizeMarket(bytes32 marketId)",
  "function releasePool(bytes32 marketId)",
  "function syncSettlement(bytes32 marketId)",
  "function pokeOracle(uint256 oracleQuestionId)",
]);
