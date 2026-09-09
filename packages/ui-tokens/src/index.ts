// The Relay design tokens, in one place, so the widget and the console are visibly
// one product rather than two things that happen to share a palette.
//
// The widget renders into a shadow root and needs its variables on `:host`; the
// console is an ordinary document and needs them on `:root`. Both come from the
// tables below, so a colour can only be changed in one place.
//
// Rules the palette encodes:
//   · one accent per side — UP teal-green, DOWN warm red — on a neutral ground.
//     Nothing else in either product is coloured, so those two are the only things
//     competing for attention.
//   · neutrals carry every disabled and inert state. A disabled UP button is grey,
//     not pale green: colour means "this will act, and in this direction".
//   · light and dark are the same names with different values, never different names.

export type ThemeName = "light" | "dark";

/** Colour tokens. Every value is a literal; nothing here references anything else. */
export const COLORS: Record<ThemeName, Record<string, string>> = {
  light: {
    bg: "#ffffff",
    "bg-sunken": "#f4f5f7",
    "bg-raised": "#ffffff",
    line: "#e3e6ea",
    "line-strong": "#cdd3da",
    ink: "#0b0d10",
    "ink-2": "#4a5158",
    "ink-3": "#767f88",
    up: "#067a55",
    "up-bg": "#e6f5ef",
    "up-ink": "#05563c",
    down: "#c8291f",
    "down-bg": "#fdeceb",
    "down-ink": "#8f1d16",
    "neutral-300": "#d5dae0",
    "neutral-700": "#3a424b",
    "btn-off": "#d5dae0",
    amber: "#b26a00",
    focus: "#1c64f2",
    shadow: "0 1px 2px rgba(11,13,16,.06), 0 8px 24px rgba(11,13,16,.08)",
  },
  dark: {
    bg: "#101317",
    "bg-sunken": "#171b21",
    "bg-raised": "#1b2027",
    line: "#262c35",
    "line-strong": "#333b46",
    ink: "#f2f5f8",
    "ink-2": "#b3bdc7",
    "ink-3": "#7d8894",
    up: "#35d69a",
    "up-bg": "#10281f",
    "up-ink": "#7ff0c2",
    down: "#ff6b60",
    "down-bg": "#2b1512",
    "down-ink": "#ffb0a8",
    "neutral-300": "#d5dae0",
    "neutral-700": "#3a424b",
    "btn-off": "#3a424b",
    amber: "#e0a33a",
    focus: "#6ea8fe",
    shadow: "0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.45)",
  },
};

/** 4-pt spacing scale. s1 … s6 = 4 … 24. */
export const SPACE = { s1: "4px", s2: "8px", s3: "12px", s4: "16px", s5: "20px", s6: "24px" } as const;

/** Three radii, nothing between them. */
export const RADII = { "r-sm": "8px", "r-md": "12px", "r-lg": "16px" } as const;

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
