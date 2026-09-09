// BinarySettlement singleton (settlement-extraction v2) — where finalized
// markets' backing lives and where redemption is served after finalize.
// Source: markets-sdk readsAbi.js binarySettlementAbi.

import { parseAbi } from "viem";

export const binarySettlementAbi = parseAbi([
  "function redeem(uint256 outcomeId, uint256 amount, address to) returns (uint256 collateralOut)",
  "function finalizeAndRedeem(address pool, uint256 outcomeId, uint256 amount, address to) returns (uint256 collateralOut)",
  "function finalize(address pool) returns (uint256 marketKey)",
  "function claimOwed(address token) returns (uint256 amount)",
  "function getSettlement(uint256 marketKey) view returns ((address collateralToken, uint128 backing, bool finalized, bool voided, uint256 settlementFeeBpsTimes1k, address feeRecipient, address pool, uint64 nonce, uint256[] payoutNumerators))",
  "function isFinalized(uint256 outcomeId) view returns (bool)",
  "function owed(address user, address token) view returns (uint256)",
  "function isPoolApproved(address pool) view returns (bool)",
  "function poolRegistrar() view returns (address)",
  "function outcomeToken() view returns (address)",
]);
