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

export const DEFAULT_SCRIPT_URL = "https://cdn.relay.example/relay.iife.js";

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
