// The mini-app loads the widget the same way a partner does: one static file.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../embed/dist/relay.iife.js");
const dest = path.resolve(here, "../miniapp/public/relay.iife.js");
if (!existsSync(src)) {
  console.error(`[telegram] ${src} is missing — run: pnpm --filter @relay/embed build`);
  process.exit(1);
}
mkdirSync(path.dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log("[telegram] widget copied to miniapp/public/relay.iife.js");
