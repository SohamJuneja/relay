import { resolve } from "node:path";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// Three artifacts from one source:
//   relay.iife.js       script-tag drop-in, global `Relay`, auto-mounts [data-relay-market]
//   relay.es.js         ESM for bundlers
//   relay-react.es.js   the <RelayMarket/> wrapper (React stays external)
//
// viem is bundled (the widget must work from a bare script tag), so the build
// leans on tree-shaking: only `viem`, `viem/accounts` and `viem/chains` symbols
// that are actually imported end up in the output. `pnpm size` prints the gzip.
export default defineConfig({
  plugins: [preact({ prefreshEnabled: false })],
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    target: "es2020",
    minify: "esbuild",
    sourcemap: true,
    emptyOutDir: true,
    lib: {
      entry: {
        relay: resolve(__dirname, "src/index.ts"),
        "relay-react": resolve(__dirname, "src/react.tsx"),
      },
      formats: ["es"],
      fileName: (_f, name) => `${name}.es.js`,
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime"],
      output: { globals: { react: "React" } },
    },
  },
});
