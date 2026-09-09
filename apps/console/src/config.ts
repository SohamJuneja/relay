// Every URL this build talks to, read from the environment and validated once.
//
// A missing base is not a runtime surprise to discover on a deployed page: the build
// fails, or — in dev, where a sensible default is a kindness — it falls back and says
// so in the console. Hard-coding any of these means a static bundle that only works
// on one deployment.

const required = (name: keyof ImportMetaEnv, fallback?: string): string => {
  const v = import.meta.env[name];
  if (v) return String(v).replace(/\/$/, "");
  if (import.meta.env.PROD) {
    // Thrown at module load, so a misconfigured deploy fails loudly on first paint
    // rather than rendering a console whose every link points at localhost.
    throw new Error(`[relay/console] ${name} is required in a production build`);
  }
  if (fallback === undefined) throw new Error(`[relay/console] ${name} has no default`);
  console.warn(`[relay/console] ${name} is not set — falling back to ${fallback}`);
  return fallback.replace(/\/$/, "");
};

/** The Relay API. */
export const API_URL = required("VITE_API_URL", "http://localhost:8787");

/** Where relay.iife.js is served from. Every snippet on the site points here. */
export const CDN_URL = required("VITE_CDN_URL", "http://127.0.0.1:5178");

/** This console's own public origin, for links a partner is meant to share. */
export const CONSOLE_URL = required("VITE_CONSOLE_URL", "http://127.0.0.1:5179");

/** Block explorer base, for transaction and address links. */
export const EXPLORER = required("VITE_EXPLORER_URL", "https://shannon-explorer.somnia.network");

/** The exact snippet a partner pastes, with the CDN this build was configured for. */
export const embedSnippet = (partnerId: number | string, builderAddress: string): string =>
  `<script src="${CDN_URL}/relay.iife.js"></script>\n<div data-relay-market data-partner="${partnerId}" data-builder="${builderAddress}"></div>`;
