import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// A plain static SPA: one bundle, no server, VITE_API_URL at build or run time.
// The widget is imported from source rather than dist so the console always shows
// the code in this repo, not whatever was last built into packages/embed/dist.
export default defineConfig({
  plugins: [react()],
  server: { port: 5179, host: "127.0.0.1" },
  preview: { port: 4180, host: "127.0.0.1" },
  build: { outDir: "dist", sourcemap: true, target: "es2022" },
});
