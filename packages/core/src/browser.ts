// @relay/core/browser — the browser-safe surface.
//
// Nothing here touches `process`, `fs`, `dotenv` or any `node:` module, so it
// bundles with esbuild `platform=browser` and ships inside the widget. That is
// enforced by `browser.build.test.ts`, which bundles this entry and fails on any
// Node reference.
//
// What lives here: the pinned ABIs, per-network addresses, the attribution tag,
// price/quantity encoding, the pure order builder + contract-call builders, and
// the book helpers. Anything that needs a signer, a database, a log scan or an
// env file stays in the Node entry (`@relay/core`).

export {
  ADDRESSES,
  COLLATERAL_DECIMALS,
  KIT_VENUE_HINTS,
  ZERO_ADDRESS,
  type EcAddresses,
} from "./addresses.js";

export {
  APPROX_BLOCK_TIME_SEC,
  CHAIN_IDS,
  ENDPOINTS,
  GET_LOGS_MAX_RANGE,
  MULTICALL3,
  networkForChainId,
  relayChain,
  type Network,
  type NetworkEndpoints,
  type RelayChainOptions,
} from "./chain.js";

export * from "./abi/index.js";

export {
  MAX_PARTNER_ID,
  MAX_SURFACE_ID,
  SURFACE,
  UINT64_MAX,
  USERDATA_VERSION_UNTAGGED,
  USERDATA_VERSION_V1,
  decodeUserData,
  encodeUserData,
  formatUserData,
  isRelayTagged,
  projectBuilderFee,
  type DecodedUserData,
  type EncodeUserDataInput,
  type RelayTag,
  type SurfaceName,
} from "./attribution.js";

export {
  ORDER_KIND,
  ORDER_KIND_NAMES,
  ORDER_TYPE,
  SELF_MATCHING_OPTION,
  bpsTimes1kFromPercent,
  decodeOutcomeId,
  expiryNsFromSec,
  formatBpsTimes1k,
  formatProbability,
  formatRaw,
  marketKey,
  noPriceFromYes,
  nsToSec,
  oneCollateral,
  outcomeId,
  percentFromBpsTimes1k,
  priceToProbability,
  probabilityToPrice,
  snapDown,
  type OrderKind,
} from "./encoding.js";

export {
  MarketStatus,
  isTradingStatus,
  marketStatusLabel,
  marketStatusName,
  type IndexerMarketStatus,
  type MarketStatusCode,
} from "./status.js";

export { binaryErrorsAbi, explainRevert, withErrors, type RevertInfo } from "./errors.js";

export { summarizeYes, toFourSided, type BookLevel, type BookSummary, type FourSidedBook, type YesBook } from "./book.js";

export * from "./order.js";
