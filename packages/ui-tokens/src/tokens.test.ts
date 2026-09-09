// Two things can go wrong with a shared token table, and both are silent.
//
// A colour defined in light but not dark leaves the dark theme inheriting a light
// value — usually black text on a near-black panel, which nobody notices until a
// screenshot. And src/tokens.css is generated, so an edit to the table that is never
// re-emitted leaves the console on stale colours while the widget moves.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COLORS, FONTS, RADII, SPACE, TOKENS_CSS, colorVars, staticVars } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("the token table", () => {
  it("defines every colour in both themes", () => {
    const light = Object.keys(COLORS.light).sort();
    const dark = Object.keys(COLORS.dark).sort();
    expect(dark).toEqual(light);
  });

  it("has no empty or accidentally-inherited values", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const [name, value] of Object.entries(COLORS[theme])) {
        expect(value.trim(), `${theme}.${name}`).not.toBe("");
        // A token whose value is just `var(--something)` chains indirection into the
        // consumer, where an override lands in the wrong place. Keep the table literal.
        expect(value.startsWith("var("), `${theme}.${name} should be a literal`).toBe(false);
      }
    }
  });

  it("gives light and dark genuinely different grounds", () => {
    expect(COLORS.light.bg).not.toBe(COLORS.dark.bg);
    expect(COLORS.light.ink).not.toBe(COLORS.dark.ink);
    // The disabled-button neutral must differ too, or one theme gets a button that
    // is invisible against its own panel.
    expect(COLORS.light["btn-off"]).not.toBe(COLORS.dark["btn-off"]);
  });

  it("keeps the 4-pt scale and three radii intact", () => {
    expect(Object.values(SPACE)).toEqual(["4px", "8px", "12px", "16px", "20px", "24px"]);
    expect(Object.keys(RADII)).toEqual(["r-sm", "r-md", "r-lg"]);
  });

  it("lets the host page override every typeface", () => {
    for (const v of Object.values(FONTS)) expect(v).toContain("--relay-font-override-");
  });
});

describe("the emitted stylesheet", () => {
  const css = readFileSync(resolve(here, "tokens.css"), "utf8");

  it("is in sync with the table it is generated from", () => {
    // If this fails, run `pnpm --filter @relay/ui-tokens build:css`.
    expect(css).toContain(TOKENS_CSS);
  });

  it("writes all three theme states, so a toggle works in both directions", () => {
    expect(css).toContain(":root {");
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(':root:not([data-theme="light"])');
  });

  it("declares every token the widget's shadow root also declares", () => {
    const shadow = `${staticVars()}\n${colorVars("light")}`;
    for (const line of shadow.split("\n")) {
      const name = line.trim().split(":")[0];
      if (!name?.startsWith("--")) continue;
      expect(css.includes(`${name}:`), `${name} missing from tokens.css`).toBe(true);
    }
  });
});
