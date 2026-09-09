import { build } from "esbuild";
import { gzipSync } from "node:zlib";
const cases = {
  "utils only (encode/decode/format)": `import {encodeFunctionData,decodeFunctionResult,decodeAbiParameters,formatUnits,parseUnits} from "viem";
     globalThis.x=[encodeFunctionData,decodeFunctionResult,decodeAbiParameters,formatUnits,parseUnits];`,
  "utils + serializeTransaction + keccak": `import {encodeFunctionData,decodeFunctionResult,decodeAbiParameters,serializeTransaction,keccak256} from "viem";
     globalThis.x=[encodeFunctionData,decodeFunctionResult,decodeAbiParameters,serializeTransaction,keccak256];`,
  "above + privateKeyToAccount": `import {encodeFunctionData,decodeFunctionResult,decodeAbiParameters,serializeTransaction,keccak256} from "viem";
     import {privateKeyToAccount,generatePrivateKey} from "viem/accounts";
     globalThis.x=[encodeFunctionData,decodeFunctionResult,decodeAbiParameters,serializeTransaction,keccak256,privateKeyToAccount,generatePrivateKey];`,
  "full client actions (what we have now)": `import {createPublicClient,createWalletClient,http,custom,parseEventLogs} from "viem";
     import {privateKeyToAccount,generatePrivateKey} from "viem/accounts";
     globalThis.x=[createPublicClient,createWalletClient,http,custom,parseEventLogs,privateKeyToAccount,generatePrivateKey];`,
  "preact only": `import {render,h} from "preact"; import {useState} from "preact/hooks"; globalThis.x=[render,h,useState];`,
};
for (const [name, code] of Object.entries(cases)) {
  const r = await build({ stdin: { contents: code, resolveDir: process.cwd(), loader: "ts" }, bundle: true, format: "esm",
    platform: "browser", target: "es2020", minify: true, write: false, define: { "process.env.NODE_ENV": '"production"' } });
  const b = r.outputFiles[0].contents;
  console.log(String((gzipSync(b,{level:9}).length/1024).toFixed(1)).padStart(7), "KB gz  ", String((b.length/1024).toFixed(0)).padStart(4), "KB raw  ", name);
}
