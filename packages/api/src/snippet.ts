// The two lines a partner pastes into their page.
//
// This lives in its own module because three things must agree on it: the register
// response, the console's copy button, and the widget's own README. A snippet that
// differs between them is a support ticket, and one missing `data-partner` silently
// costs the partner every fill it brings in.

export interface SnippetInput {
  partnerId: number;
  builderAddress: string;
  /** Where relay.iife.js is served from. */
  scriptUrl?: string;
  /** The partner's Relay API base, when it is not the default. */
  api?: string | undefined;
  asset?: string | undefined;
  intervalSec?: number | undefined;
  surface?: string | undefined;
}

/**
 * The placeholder. It resolves to nothing — deliberately, so that a snippet built
 * without configuration is obviously broken rather than subtly wrong.
 *
 * It was not obvious enough. The register response carried this URL, the console's
 * copy button copied the response rather than the corrected snippet it was showing on
 * screen, and partners pasted a script tag that fails with ERR_NAME_NOT_RESOLVED. The
 * guard below now refuses to start a production server that would emit it.
 */
export const DEFAULT_SCRIPT_URL = "https://cdn.relay.example/relay.iife.js";

/**
 * Where this deployment serves relay.iife.js.
 *
 * CDN_URL is the base (the same value the console gets as VITE_CDN_URL, so the two
 * cannot disagree); EMBED_SCRIPT_URL overrides it with a full URL when the file is not
 * at the conventional path.
 */
export function embedScriptUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.EMBED_SCRIPT_URL ?? "").trim();
  if (explicit) return explicit;
  const base = (env.CDN_URL ?? "").trim().replace(/\/$/, "");
  return base ? `${base}/relay.iife.js` : DEFAULT_SCRIPT_URL;
}

/**
 * Refuse to start a production server that would hand partners a dead URL.
 *
 * A snippet is the one artefact a partner copies once and pastes somewhere we never
 * see again. Getting it wrong is not a page that looks off — it is a script tag that
 * never loads, on someone else's site, discovered by them.
 */
export function assertEmbedScriptUrlConfigured(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const url = embedScriptUrl(env);
  if (url === DEFAULT_SCRIPT_URL || /(^|\.)example(\.|$)|example\.com/i.test(new URL(url).hostname)) {
    throw new Error(
      `CDN_URL is not configured (embed script URL resolves to ${url}). ` +
        "Every snippet this server hands out would carry a hostname that does not resolve. " +
        "Set CDN_URL to the origin serving relay.iife.js, or EMBED_SCRIPT_URL to its full URL.",
    );
  }
}

/**
 * Build the embed snippet. Attributes are emitted in the order a reader scans them:
 * what it is, who gets paid, then the optional shape of the card. Anything left at
 * its default is omitted rather than written out, so the snippet stays two lines and
 * the parts that matter are not buried among defaults.
 */
export function embedSnippet(input: SnippetInput): string {
  const attrs: string[] = ["data-relay-market", `data-partner="${input.partnerId}"`, `data-builder="${input.builderAddress}"`];
  if (input.asset) attrs.push(`data-asset="${input.asset}"`);
  if (input.intervalSec) attrs.push(`data-interval="${input.intervalSec}"`);
  if (input.surface) attrs.push(`data-surface="${input.surface}"`);
  if (input.api) attrs.push(`data-api="${input.api}"`);
  return `<script src="${input.scriptUrl ?? DEFAULT_SCRIPT_URL}"></script>\n<div ${attrs.join(" ")}></div>`;
}
