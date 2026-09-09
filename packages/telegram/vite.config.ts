import { defineConfig } from "vite";
import { resolve } from "node:path";

// The mini-app is one page. It is deliberately tiny: Telegram opens it inside a
// webview on a phone, often on a bad connection, and every kilobyte is felt.
export default defineConfig({
  root: resolve(__dirname, "miniapp"),
  // Env lives at the package root, where scripts/setup-partner.ts writes it, not
  // inside miniapp/ — the vite root is the document tree, not the config tree.
  envDir: resolve(__dirname),
  publicDir: resolve(__dirname, "miniapp/public"),
  server: { port: 5181, host: "127.0.0.1" },
  preview: { port: 4182, host: "127.0.0.1" },
  build: { outDir: resolve(__dirname, "dist-miniapp"), emptyOutDir: true, target: "es2022" },
});
