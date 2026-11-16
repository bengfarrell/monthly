import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { validateConnection } from "../src/shared/media-types.js";

export function loadDemoConfig(filename = ".env.local", environment: NodeJS.ProcessEnv = process.env) {
  let local: NodeJS.ProcessEnv = {};
  try { local = parseEnv(readFileSync(filename, "utf8")); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const apiUrl = environment.MONTHLY_API_URL ?? local.MONTHLY_API_URL;
  const bucket = environment.MONTHLY_BUCKET ?? local.MONTHLY_BUCKET;
  if (!apiUrl || !bucket) {
    throw new Error("Set MONTHLY_API_URL and MONTHLY_BUCKET in .env.local (copy .env.example) or the environment.");
  }
  return validateConnection(apiUrl, bucket);
}
