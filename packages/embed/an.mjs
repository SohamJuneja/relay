import { build } from "esbuild";
import { gzipSync } from "node:zlib";
const r = await build({
  entryPoints: ["src/index.ts"], bundle: true, format: "iife", globalName: "Relay",
  platform: "browser", target: "es2020", minify: true, write: false, metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
  jsx: "automatic", jsxImportSource: "preact",
  loader: { ".ts": "ts", ".tsx": "tsx" },
});
const out = r.outputFiles[0];
console.log("TOTAL raw", (out.contents.length/1024).toFixed(1), "KB  gz", (gzipSync(out.contents,{level:9}).length/1024).toFixed(1), "KB");
const meta = r.metafile.outputs[Object.keys(r.metafile.outputs)[0]];
const groups = {};
for (const [file, info] of Object.entries(meta.inputs)) {
  let key = file;
  const m = file.match(/node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.*)/);
  if (m) key = m[2] + (m[2]==="viem" ? "/" + m[3].split("/").slice(0,2).join("/") : "");
  else if (file.startsWith("../core/")) key = "@relay/core";
  else key = "widget:" + file.replace("src/","");
  groups[key] = (groups[key]||0) + info.bytesInOutput;
}
const sorted = Object.entries(groups).sort((a,b)=>b[1]-a[1]);
let shown=0;
for (const [k,v] of sorted.slice(0,28)) { console.log(String((v/1024).toFixed(1)).padStart(8), "KB ", k); shown+=v; }
console.log("(top 28 =", (shown/1024).toFixed(1), "KB of", (Object.values(groups).reduce((a,b)=>a+b,0)/1024).toFixed(1), "KB)");
