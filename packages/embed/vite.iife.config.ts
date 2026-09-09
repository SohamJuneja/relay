import { resolve } from "node:path";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

/** The script-tag build: everything inlined, one global. */
export default defineConfig({
  plugins: [preact({ prefreshEnabled: false })],
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    target: "es2020",
    minify: "esbuild",
    sourcemap: true,
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["iife"],
      name: "Relay",
      fileName: () => "relay.iife.js",
    },
  },
});
