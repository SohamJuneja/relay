// Copy the built widget into public/ so the page loads it through a plain <script
// src>, exactly the way a publisher would after dropping the file on their CDN.
// Importing it as a module would prove something easier than what we are claiming.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../../packages/embed/dist/relay.iife.js");
const dest = path.resolve(here, "../public/relay.iife.js");

if (!existsSync(src)) {
  console.error(`[demo-site] ${src} is missing — run: pnpm --filter @relay/embed build`);
  process.exit(1);
}
mkdirSync(path.dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`[demo-site] widget copied to public/relay.iife.js`);
