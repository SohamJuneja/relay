import { resolve } from "node:path";
import preact from "@preact/preset-vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Playground server. Root is the package so the page can load the real built
// artifacts from /dist (the script-tag path) alongside a Vite-compiled React
// demo, which is exactly the three integrations a partner can choose from.
export default defineConfig({
  root: __dirname,
  // Serve the BUILT artifacts verbatim. Without this Vite treats /dist/relay.iife.js
  // as source, rewrites it through its module graph and hands the browser a stale
  // 1.2 MB transform instead of the 176 KB bundle a partner would actually ship —
  // so the playground silently tests code that is not the build.
  publicDir: resolve(__dirname, "dist"),
  server: { port: 5178, open: "/dev/index.html", host: "127.0.0.1" },
  esbuild: { jsx: "automatic" },
  plugins: [
    // The React demo file gets React's JSX; everything else gets Preact's.
    { ...react({ include: /dev\/react-demo\.tsx$/ }), enforce: "pre" },
    preact({ include: /src\/.*\.[jt]sx?$/, prefreshEnabled: false }),
  ],
});
