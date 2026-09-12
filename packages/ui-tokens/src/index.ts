// The Relay design tokens, in one place, so the widget and the console are visibly
// one product rather than two things that happen to share a palette.
//
// The widget renders into a shadow root and needs its variables on `:host`; the
// console is an ordinary document and needs them on `:root`. Both come from the
// tables below, so a colour can only be changed in one place.
//
// Rules the palette encodes:
//   · the ground is COOL — a blue-grey archival paper in light, a blue-black in
//     dark. Deliberately not the warm cream of apps/demo-site: that is a third-party
//     publication and this is Relay's own product, and they should not be mistaken
//     for one another at a glance.
//   · one accent per side — UP green, DOWN red — and one brand accent, cobalt,
//     which is never used for a direction. Three colours, three jobs, no overlap.
//   · neutrals carry every disabled and inert state. A disabled UP button is grey,
//     not pale green: colour means "this will act, and in this direction".
//   · light and dark are the same names with different values, never different names.

export type ThemeName = "light" | "dark";

/** Colour tokens. Every value is a literal; nothing here references anything else. */
export const COLORS: Record<ThemeName, Record<string, string>> = {
  light: {
    bg: "#f7f8fa",
    "bg-sunken": "#edeff3",
    "bg-raised": "#ffffff",
    line: "#dfe3ea",
    "line-strong": "#c3cad6",
    ink: "#0b0f16",
    "ink-2": "#47505f",
    "ink-3": "#6b7480",
    up: "#0a7c5a",
    "up-bg": "#e2f3ec",
    "up-ink": "#05543c",
    down: "#c62a22",
    "down-bg": "#fceae8",
    "down-ink": "#8c1c16",
    "neutral-300": "#cfd5de",
    "neutral-700": "#39414e",
    "btn-off": "#cfd5de",
    amber: "#a4680a",
    accent: "#1b4dff",
    "accent-bg": "#e8edff",
    "accent-ink": "#ffffff",
    focus: "#1b4dff",
    shadow: "0 1px 2px rgba(11,15,22,.05), 0 12px 32px rgba(11,15,22,.07)",
  },
  dark: {
    bg: "#0a0d13",
    "bg-sunken": "#0e1219",
    "bg-raised": "#141922",
    line: "#222935",
    "line-strong": "#323b4a",
    ink: "#e9edf4",
    "ink-2": "#a9b3c2",
    "ink-3": "#7a8695",
    up: "#2fd39b",
    "up-bg": "#0b2a20",
    "up-ink": "#7df0c3",
    down: "#ff6e62",
    "down-bg": "#2c1513",
    "down-ink": "#ffb2aa",
    "neutral-300": "#cfd5de",
    "neutral-700": "#39414e",
    "btn-off": "#39414e",
    amber: "#e0a33a",
    accent: "#7c9bff",
    "accent-bg": "#141f3d",
    "accent-ink": "#0a0d13",
    focus: "#7c9bff",
    shadow: "0 1px 2px rgba(0,0,0,.5), 0 12px 32px rgba(0,0,0,.55)",
  },
};

/** 4-pt spacing scale. s1 … s6 = 4 … 24. */
export const SPACE = { s1: "4px", s2: "8px", s3: "12px", s4: "16px", s5: "20px", s6: "24px" } as const;

/** Three radii, nothing between them. Tight on purpose: this is an instrument, not a card game. */
export const RADII = { "r-sm": "4px", "r-md": "6px", "r-lg": "10px" } as const;

/**
 * A typeface PAIRING, not a font: a rounded display face for the big numbers, a
 * neutral sans for text, a mono for hashes and addresses. All system-resident, each
 * overridable from the host page through the `--relay-font-override-*` variables.
 */
export const FONTS = {
  "relay-font-ui": `var(--relay-font-override-ui, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif)`,
  "relay-font-display": `var(--relay-font-override-display, ui-rounded, "SF Pro Rounded", "Segoe UI Variable Display", "Nunito", var(--relay-font-ui))`,
  "relay-font-mono": `var(--relay-font-override-mono, ui-monospace, SFMono-Regular, "SF Mono", "Cascadia Mono", Consolas, monospace)`,
} as const;

const declare = (vars: Record<string, string>, indent = "  "): string =>
  Object.entries(vars)
    .map(([k, v]) => `${indent}--${k}: ${v};`)
    .join("\n");

/** Colour variables for one theme, as CSS declarations (no selector). */
export const colorVars = (theme: ThemeName, indent = "  "): string => declare(COLORS[theme], indent);

/** Fonts, spacing and radii — the parts that do not change between themes. */
export const staticVars = (indent = "  "): string => declare({ ...FONTS, ...SPACE, ...RADII }, indent);

/**
 * The full token sheet for an ordinary document (the console).
 *
 * Three theme states, and all three must be written or the toggle only works one
 * way: an explicit choice stamps `data-theme` on the root, and the default "system"
 * setting stamps nothing, leaving `prefers-color-scheme` to decide.
 */
export const TOKENS_CSS = `:root {
  color-scheme: light;
${staticVars()}
${colorVars("light")}
}

:root[data-theme="dark"] {
  color-scheme: dark;
${colorVars("dark")}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
${colorVars("dark", "    ")}
  }
}
`;
