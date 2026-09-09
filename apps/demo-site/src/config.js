// The three values a publisher would edit, in one place.
//
// The API base comes from an env var at build time so the same source can point at a
// local API or a deployed one; the partner id and builder address are the ones
// "Demo News" was issued when it registered on the Relay console.

export const RELAY_API = import.meta.env.VITE_RELAY_API ?? "http://localhost:8787";
export const RELAY_CONSOLE = import.meta.env.VITE_RELAY_CONSOLE ?? "http://127.0.0.1:5179";
export const RELAY_PARTNER = import.meta.env.VITE_RELAY_PARTNER ?? "3";
export const RELAY_BUILDER = import.meta.env.VITE_RELAY_BUILDER ?? "0xFb2341494D602B7988D368b3A361a4B7110563f6";

/**
 * Fill the widget's data-* attributes in from the config above.
 *
 * The markup carries the attributes literally so the page's HTML reads the way the
 * README says it should; this only substitutes the environment-specific parts, which
 * a real publisher would hard-code once.
 */
export function configureWidgetMount(el) {
  if (!el) return;
  el.setAttribute("data-partner", RELAY_PARTNER);
  el.setAttribute("data-builder", RELAY_BUILDER);
  el.setAttribute("data-api", RELAY_API);
}

/** The public partner card, which is what "attribution on-chain" links to. */
export const partnerCardUrl = () => `${RELAY_API}/v1/partners/${RELAY_PARTNER}/public`;
export const consoleEcosystemUrl = () => `${RELAY_CONSOLE}/ecosystem`;

/** Today, written the way a newspaper writes it. */
export function todayLong(d = new Date()) {
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
export function todayShort(d = new Date()) {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
