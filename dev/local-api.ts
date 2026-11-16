import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createHandler } from "../lambda/handler.js";
import { asError } from "../src/shared/errors.js";
import { FIXTURE_FILE, LOCAL_BUCKET, LOCAL_PASSWORD, LOCAL_PREFIX, LOCAL_USERNAME, loadAssets } from "./fixtures.js";
import { LocalHttpError, MockS3, readBody } from "./mock-s3.js";

export function localApi(environment: Record<string, string>): Plugin {
  return {
    name: "monthly-local-lambda",
    configureServer(server) {
      const s3 = new MockS3(loadAssets());
      const handlers = new Map<string, ReturnType<typeof createHandler>>();
      const fixtures = fileURLToPath(FIXTURE_FILE);
      server.watcher.add(fixtures);
      server.watcher.on("change", filename => {
        if (filename === fixtures) void server.restart().catch(error => {
          server.config.logger.error(`Could not reload mock assets: ${asError(error).message}`);
        });
      });
      async function handle(request: IncomingMessage, response: ServerResponse) {
        const authority = request.headers[":authority"] ?? request.headers.host;
        if (typeof authority !== "string" || !authority) throw new LocalHttpError(400, "Request host is missing.");
        const url = new URL(request.url!, `https://${authority}`);
        response.setHeader("Cache-Control", "no-store");
        if (url.pathname.startsWith(`/${LOCAL_PREFIX}`)) {
          if (request.method !== "GET" && request.method !== "HEAD") throw new LocalHttpError(405, "Method not allowed.");
          const asset = s3.assets.get(decodeURIComponent(url.pathname.slice(1)));
          if (!asset) throw new LocalHttpError(404, "Mock asset not found.");
          response.writeHead(302, { Location: asset.url }).end();
          return;
        }
        if (url.pathname.startsWith("/__monthly/s3/")) {
          await s3.upload(url.pathname.slice("/__monthly/s3/".length), request, response);
          return;
        }
        let handler = handlers.get(url.origin);
        if (!handler) {
          handler = createHandler({
            config: {
              username: environment.MONTHLY_DEV_USERNAME ?? LOCAL_USERNAME,
              password: environment.MONTHLY_DEV_PASSWORD ?? LOCAL_PASSWORD,
              buckets: { [LOCAL_BUCKET]: { prefix: LOCAL_PREFIX, region: "us-east-1", publicBaseUrl: url.origin } },
            },
            clientForRegion: () => s3,
            sign: async (client, command, options) => s3.sign(command, url.origin, options.expiresIn),
          });
          handlers.set(url.origin, handler);
        }
        const { text } = await readBody(request, 8192);
        const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [
          name, Array.isArray(value) ? value.join(", ") : value,
        ]));
        const result = await handler({
          routeKey: `${request.method} ${url.pathname}`,
          headers, body: text || null, queryStringParameters: Object.fromEntries(url.searchParams),
        });
        response.writeHead(result.statusCode, result.headers).end(result.body);
      }
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0] ?? "";
        if (!["/media", "/uploads", "/sign"].includes(path) &&
            !path.startsWith(`/${LOCAL_PREFIX}`) && !path.startsWith("/__monthly/s3/")) {
          next();
          return;
        }
        void handle(request, response).catch(error => {
          const failure = asError(error);
          const status = error instanceof LocalHttpError ? error.status : 500;
          if (status === 500) server.config.logger.error(`Local Lambda adapter failed: ${failure.stack ?? failure.message}`);
          if (!response.headersSent && !response.destroyed) {
            response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({
              error: status === 500 ? "Local media service failed. Check the development server logs." : failure.message,
            }));
          }
        });
      });
    },
  };
}
