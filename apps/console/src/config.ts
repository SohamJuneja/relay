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

/**
 * The partner the landing page's own widget mounts with, and its builder address.
 *
 * These two are one fact and were two: the landing widget was hard-coded to partner 1
 * while the builder beside it belonged to partner 8, so a receipt printed "via Phase 6
 * Live Check" and the leaderboard credited "Relay Demo" for the same trade. The tag
 * and the builder go out together in one order, so they are configured together and
 * checked against the API at startup.
 */
export const DEMO_PARTNER_ID = Number(required("VITE_DEMO_PARTNER_ID", "1"));
export const DEMO_BUILDER = required("VITE_DEMO_BUILDER", "0x0000000000000000000000000000000000000000");

/**
 * Ask the API whether those two actually belong together, and say so loudly if not.
 *
 * A mismatch is invisible on the page — the widget renders perfectly either way — and
 * only shows up later as an attribution that credits the wrong name. Cheap to check
 * once, at startup, against the source of truth.
 */
export async function assertDemoPartnerMatchesBuilder(): Promise<void> {
  try {
    const r = await fetch(`${API_URL}/v1/partners/${DEMO_PARTNER_ID}/public`);
    if (!r.ok) {
      console.error(`[relay/console] VITE_DEMO_PARTNER_ID=${DEMO_PARTNER_ID} is not a partner on ${API_URL} (${r.status}). The landing widget will tag orders with an id nothing can name.`);
      return;
    }
    const p = (await r.json()) as { partnerId: number; name: string; builderAddress?: string };
    const onFile = (p.builderAddress ?? "").toLowerCase();
    if (onFile !== DEMO_BUILDER.toLowerCase()) {
      console.error(
        `[relay/console] demo partner/builder mismatch. VITE_DEMO_PARTNER_ID=${DEMO_PARTNER_ID} ("${p.name}") is registered with builder ${onFile || "(none)"}, ` +
          `but VITE_DEMO_BUILDER is ${DEMO_BUILDER}. Receipts will credit "${p.name}" while the leaderboard credits whoever owns the builder address.`,
      );
      return;
    }
    console.info(`[relay/console] demo partner ${DEMO_PARTNER_ID} ("${p.name}") matches its builder ${DEMO_BUILDER}`);
  } catch (e) {
    console.error(`[relay/console] could not verify the demo partner against ${API_URL}: ${(e as Error).message}`);
  }
}

/**
 * The rest of Relay, so the console is a way in rather than a dead end.
 *
 * Somebody handed one link lands on the overview and can currently reach the console's
 * own pages and nothing else — not the demo publication, not the bot, not the source.
 * These are optional: a build without them simply omits the link rather than rendering
 * one that goes nowhere.
 */
const optional = (name: keyof ImportMetaEnv): string | null => {
  const v = import.meta.env[name];
  return v ? String(v).replace(/\/$/, "") : null;
};
export const DEMO_SITE_URL = optional("VITE_DEMO_SITE_URL");
export const TELEGRAM_URL = optional("VITE_TELEGRAM_URL");
export const REPO_URL = optional("VITE_REPO_URL");

/** The exact snippet a partner pastes, with the CDN this build was configured for. */
// data-api is not optional decoration. The widget's built-in default is
// http://localhost:8787 — right for someone developing against a local API, and
// dead on a publisher's actual page. A pasted snippet without it renders a card
// that loads forever, which reads as a broken widget rather than a missing setting.
export const embedSnippet = (partnerId: number | string, builderAddress: string): string =>
  `<script src="${CDN_URL}/relay.iife.js"></script>
<div data-relay-market data-partner="${partnerId}" data-builder="${builderAddress}" data-api="${API_URL}"></div>`;
