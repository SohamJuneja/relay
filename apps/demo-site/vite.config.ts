import { defineConfig } from "vite";
import { resolve } from "node:path";

// A plain multi-page static site. No framework: a publisher's article is HTML, and
// building it as HTML is the honest demonstration.
export default defineConfig({
  server: { port: 5180, host: "127.0.0.1" },
  preview: { port: 4181, host: "127.0.0.1" },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        article: resolve(__dirname, "btc-window/index.html"),
      },
    },
  },
});
