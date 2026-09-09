import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// vite.config.ts points its root at miniapp/, which is where the mini-app's documents
// live — not where the bot's tests do. Without this, vitest inherits that root and
// reports "no test files found" for a package that has them.
export default defineConfig({
  root: resolve(__dirname),
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
