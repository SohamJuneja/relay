// IBinaryPool — the per-market CLOB. Trading happens here.
//
// Copied from ec-dreamdex-hackathon-template/solidity/src/IEventContracts.sol
// (IBinaryPool, BinaryPoolParams, OrderBookParams, OrderBookLevel) and
// cross-checked against @somnia-chain/markets-sdk 0.29.0:
//   - dist/readsAbi.js  binaryPoolReadAbi  (getBookLevels, getOrderBookParameters,
//     getBinaryPoolParams, builder views, marketNonce/settlement/finalized/
//     booksEmpty/marketExpiryNs/setBacking, closingPrice/closingTop, order views)
//   - dist/tradeAbi.js  binaryPoolWriteAbi (placeBinaryOrder, placeBinaryOrderFor,
//     cancelOrder, reduceOrder, approveBuilder, mintSet, burnSet, …)
//
// The hackathon template flags `OrderBookLevel` as "confirm against the live
// ABI" — the SDK confirms it: `(uint256 price, uint256 quantity)`.
//
// NOTE the SDK's return name for placeBinaryOrder is `id`, the template's is
// `orderId`. Names do not affect the selector; both decode identically.

import { parseAbi } from "viem";

export const binaryPoolReadAbi = parseAbi([
  // Book. Returns [] on an empty side — it does NOT revert (kit gotcha #12).
  "function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])",
  // Tick / lot grid the pool validates orders against.
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
  // The whole pool state in one call (BinaryPoolInfo). Fees are bps × 1000.
  "function getBinaryPoolParams() view returns ((address collateralToken, address market, address outcomeToken, uint256 yesId, uint256 noId, uint256 oneCollateral, uint256 setBacking, address feeRecipient, uint256 makerFeeBpsTimes1k, uint256 takerFeeBpsTimes1k, uint256 maxBuilderFeeBpsTimes1k, uint256 settlementFeeBpsTimes1k, address settlement, uint64 marketNonce, bool finalized))",
  // Builder-code views (pool bps × 1000). Read-only, no signer.
  "function getMaxBuilderFeeBpsTimes1k() view returns (uint256)",
  "function getBuilderApproval(address user, address builder) view returns (uint256)",
  "function getEffectiveBuilderApproval(address user, address builder) view returns (uint256)",
  // Settlement-extraction v2 pool state.
  "function marketNonce() view returns (uint64)",
  "function settlement() view returns (address)",
  "function finalized() view returns (bool)",
  "function booksEmpty() view returns (bool)",
  "function marketExpiryNs() view returns (uint64)",
  "function setBacking() view returns (uint256)",
  "function outcomeToken() view returns (address)",
  "function collateralToken() view returns (address)",
  // Closing-price capture (newer pools only; older ones lack the selector).
  "function closingPrice() view returns (uint256 closingMid, uint256 oneCollateral, uint8 state)",
  "function closingTop(uint256 maxSteps) view returns (uint256 bestBid, uint256 bestAsk, bool bidFound, bool askFound)",
  // Order views (IOrderBook base).
  "function getOrder(uint128 orderId) view returns ((uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs))",
  "function getAllOpenOrdersOffChain(bool isBid, uint256 maxCount, uint64 startCursor) view returns ((uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs)[] orders, bool hasMoreOrders, uint64 nextCursor)",
  // Vault (every pool is an ERC20Vault; BinaryPool accepts only its collateral).
  "function getWithdrawableBalance(address user, address token) view returns (uint256)",
  "error IncorrectOrder()",
]);

/**
 * Write surface. Phase 0 never calls any of these — they are here so the
 * widget/SDK phases encode against the same pinned signatures the SDK uses.
 *
 * placeBinaryOrder args, in order:
 *   kind                 0 BUY_YES · 1 SELL_YES · 2 BUY_NO · 3 SELL_NO
 *   price                YES-side probability scaled by collateral decimals
 *                        (727000 = 0.727 on 6-dp tUSDC; 727e15 on 18-dp USDso)
 *   quantity             outcome tokens, collateral-decimal scaled
 *   expireTimestampNs    NANOseconds; 0 < x <= marketExpiryNs() (else reverts)
 *   orderType            0 LIMIT · 1 FILL_OR_KILL · 2 IOC (SDK: MARKET) · 3 POST_ONLY
 *   selfMatchingOption   0 CANCEL_TAKER · 1 CANCEL_MAKER
 *   builder              partner builder address (address(0) = untagged)
 *   builderFeeBpsTimes1k bps × 1000; must be <= getMaxBuilderFeeBpsTimes1k()
 *                        and <= the user's approveBuilder() cap
 *   userData             opaque uint64 forwarded into OrderPlaced.placedOrder.userData
 */
export const binaryPoolWriteAbi = parseAbi([
  "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 orderId)",
  "function placeBinaryOrderFor(address owner, uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 orderId)",
  "function cancelOrder(uint128 orderId)",
  "function cancelOrders(uint128[] orderIds) returns (bool[] cancelled)",
  "function reduceOrder(uint128 orderId, uint256 newQuantityRemaining)",
  "function cancelExpiredOrders(uint128[] orderIds)",
  "function sweepExpiredAtLevel(bool isBid, uint256 price, uint256 maxCount) returns (uint256 cleaned)",
  // Builder opt-in: a USER approves a BUILDER up to a fee cap, per POOL.
  "function approveBuilder(address builder, uint256 maxFeeBpsTimes1k)",
  // Complete sets (1 collateral → 1 YES + 1 NO, and back).
  "function mintSet(address yesTo, address noTo, uint256 amount)",
  "function burnSet(uint256 amount)",
  // Vault.
  "function deposit(address token, uint256 amount)",
  "function withdraw(address token, uint256 amount)",
]);

export const binaryPoolAbi = [...binaryPoolReadAbi, ...binaryPoolWriteAbi] as const;
