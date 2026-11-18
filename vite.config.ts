import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { validateConnection } from "./src/shared/media-types.js";
import { localApi } from "./dev/local-api.js";
import { LOCAL_BUCKET } from "./dev/fixtures.js";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, root, "MONTHLY_");
  const feed = mode === "feed";
  const local = mode !== "aws" && !feed;
  if (mode === "aws" && (!environment.MONTHLY_API_URL || !environment.MONTHLY_BUCKET)) {
    throw new Error("Set MONTHLY_API_URL and MONTHLY_BUCKET in .env.local (copy .env.example) or the environment.");
  }
  if (feed && !environment.MONTHLY_FEED_URL) {
    throw new Error("Set MONTHLY_FEED_URL in .env.local or the environment to your public media URL including its prefix.");
  }
  const config = mode === "aws" ? validateConnection(environment.MONTHLY_API_URL, environment.MONTHLY_BUCKET) : null;
  return {
    root: fileURLToPath(new URL(feed ? "./examples/feed" : "./examples", import.meta.url)),
    envDir: root,
    envPrefix: [],
    plugins: local ? [basicSsl({ name: "monthly-local" }), localApi(environment)] : [],
    define: {
      "process.env.MONTHLY_API_URL": local ? "window.location.origin" : JSON.stringify(config?.apiUrl ?? ""),
      "process.env.MONTHLY_BUCKET": JSON.stringify(local ? LOCAL_BUCKET : config?.bucket ?? ""),
      "process.env.MONTHLY_DEV_MODE": JSON.stringify(local ? "mock" : mode),
      "process.env.MONTHLY_FEED_URL": JSON.stringify(feed ? environment.MONTHLY_FEED_URL : ""),
    },
    server: { host: "localhost", port: 8080, strictPort: true },
  };
});
