import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { validateConnection } from "./src/shared/media-types.js";
import { localApi } from "./dev/local-api.js";
import { LOCAL_BUCKET } from "./dev/fixtures.js";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, root, "MONTHLY_");
  const local = mode !== "aws";
  if (!local && (!environment.MONTHLY_API_URL || !environment.MONTHLY_BUCKET)) {
    throw new Error("Set MONTHLY_API_URL and MONTHLY_BUCKET in .env.local (copy .env.example) or the environment.");
  }
  const config = local ? null : validateConnection(environment.MONTHLY_API_URL, environment.MONTHLY_BUCKET);
  return {
    root: fileURLToPath(new URL("./examples", import.meta.url)),
    envDir: root,
    envPrefix: [],
    plugins: local ? [basicSsl({ name: "monthly-local" }), localApi(environment)] : [],
    define: {
      "process.env.MONTHLY_API_URL": local ? "window.location.origin" : JSON.stringify(config!.apiUrl),
      "process.env.MONTHLY_BUCKET": JSON.stringify(local ? LOCAL_BUCKET : config!.bucket),
      "process.env.MONTHLY_DEV_MODE": JSON.stringify(local ? "mock" : "aws"),
    },
    server: { host: "127.0.0.1", port: 8080, strictPort: true },
  };
});
