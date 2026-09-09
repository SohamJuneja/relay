// @relay/core — browser-safe shared layer for Relay.
//
// No Node built-ins, no env access, no signing. Reads only. The widget, the
// indexer and the console all import from here so every consumer decodes the
// same pinned ABIs and keys markets the same way (by marketId, never by pool).

export * from "./chain.js";
export * from "./addresses.js";
export * from "./abi/index.js";
export * from "./status.js";
export * from "./encoding.js";
export * from "./logs.js";
export * from "./reads.js";
export * from "./discovery.js";
export * from "./book.js";
export * from "./pool.js";
export * from "./fills.js";
export * from "./order.js";
export * from "./attribution.js";
export * from "./errors.js";
export * from "./trade.js";
export * from "./settle.js";
