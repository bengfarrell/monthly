import { build, type BuildOptions } from "esbuild";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir } from "node:fs/promises";
import { loadDemoConfig } from "./config.js";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const config = loadDemoConfig();
await mkdir("dist/modules", { recursive: true });
await copyFile("src/styles.css", "dist/modules/styles.css");
const options: BuildOptions = {
  entryPoints: { monthly: "src/index.ts", config: "examples/config.ts" }, bundle: true, minify: true,
  format: "esm", target: ["es2022"], outdir: "dist",
  define: {
    "process.env.MONTHLY_API_URL": JSON.stringify(config.apiUrl),
    "process.env.MONTHLY_BUCKET": JSON.stringify(config.bucket),
  },
};
await build(options);
console.log("Static assets: dist/monthly.js and dist/monthly.css");
