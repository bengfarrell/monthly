import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const result = await build({
  entryPoints: ["lambda/handler.ts"], bundle: true, minify: true,
  platform: "node", target: ["node22"], format: "esm",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  outfile: "handler.mjs", write: false,
});
mkdirSync("dist", { recursive: true });
writeFileSync("dist/monthly-lambda.zip", zipSync({ "handler.mjs": result.outputFiles[0].contents }, { level: 9, mtime: new Date(1980, 0, 1) }));
console.log("Lambda ZIP: dist/monthly-lambda.zip (handler: handler.handler)");
