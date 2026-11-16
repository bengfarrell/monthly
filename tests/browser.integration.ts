import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright";
import { createHandler, PART_SIZE } from "../lambda/handler.js";
import type { UploadCommand } from "../lambda/handler.js";
import type { Browser } from "playwright";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_BUCKET, LOCAL_PASSWORD, LOCAL_USERNAME, loadAssets } from "../dev/fixtures.js";
import type { MediaPage, SignedUpload, UploadGrant } from "../src/core/api.js";

type UploadInput = UploadCommand["input"] & {
  PartNumber?: number; ContentLength?: number; ContentType?: string;
};

test("production bundles register Web Awesome controls and include the theme without a CDN", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.MONTHLY_BROWSER_CHANNEL && { channel: process.env.MONTHLY_BROWSER_CHANNEL }) });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    const unexpectedRequests: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const assets: Record<string, { contentType: string; body: string }> = {
      "/": {
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8">
          <link rel="icon" href="data:,"><link rel="stylesheet" href="/monthly.css"></head>
          <body><monthly-media api-url="https://api.monthly.test" bucket="fixture-bucket"></monthly-media>
          <script type="module" src="/monthly.js"></script></body></html>`,
      },
      "/monthly.js": { contentType: "text/javascript", body: readFileSync("dist/monthly.js", "utf8") },
      "/monthly.css": { contentType: "text/css", body: readFileSync("dist/monthly.css", "utf8") },
    };
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      const asset = url.origin === "https://monthly.test" ? assets[url.pathname] : undefined;
      if (asset) return route.fulfill(asset);
      unexpectedRequests.push(url.href);
      return route.abort();
    });
    await page.goto("https://monthly.test");
    const signIn = page.getByRole("button", { name: "Sign in", exact: true });
    await signIn.waitFor();
    assert.equal(await signIn.evaluate(button => button.getRootNode() instanceof ShadowRoot), true);
    assert.equal(await page.evaluate(() => ["wa-button", "wa-card", "wa-badge", "wa-callout", "wa-progress-bar"].every(tag => customElements.get(tag))), true);
    assert.notEqual(await page.locator("monthly-media").evaluate(element => getComputedStyle(element).getPropertyValue("--wa-color-brand-fill-loud").trim()), "");
    assert.notEqual(await signIn.evaluate(button => getComputedStyle(button).backgroundColor), "rgba(0, 0, 0, 0)");
    await signIn.click();
    assert.equal(await page.locator("input[name=username]").evaluate(input => (input as HTMLInputElement).validity.valueMissing), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedRequests, []);
  } finally { await browser.close(); }
});

test("Vite hot-updates CSS, reloads source and HTML, and keeps env files private", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(process.cwd(), ".monthly-vite-"));
  let browser: Browser | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    cpSync("src", join(directory, "src"), { recursive: true });
    cpSync("examples", join(directory, "examples"), { recursive: true });
    writeFileSync(join(directory, ".env.local"), "VITE_PRIVATE_FIXTURE=must-not-be-exposed\n");
    const mainPath = join(directory, "examples/main.ts");
    const main = readFileSync(mainPath, "utf8") + '\ndocument.body.dataset.privateValue = String(import.meta.env.VITE_PRIVATE_FIXTURE);\n';
    writeFileSync(mainPath, main);
    server = await createServer({
      configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
      root: join(directory, "examples"), envDir: directory, server: { port: 0 },
      define: {
        "process.env.MONTHLY_API_URL": JSON.stringify("https://api.monthly.test"),
        "process.env.MONTHLY_BUCKET": JSON.stringify("fixture-bucket"),
      },
    });
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.MONTHLY_BROWSER_CHANNEL && { channel: process.env.MONTHLY_BROWSER_CHANNEL }) });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(origin);
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.body.dataset.privateValue), "undefined");
    assert.equal((await page.request.get(`${origin}/@fs${directory}/.env.local`)).status(), 403);
    assert.match(await (await page.request.get(`${origin}/main.ts`)).text(), /sourceMappingURL/);
    await page.evaluate(() => { document.body.dataset.marker = "preserved"; });
    const cssPath = join(directory, "src/styles.css");
    writeFileSync(cssPath, readFileSync(cssPath, "utf8") + "\n.monthly-button { --monthly-button-background: rgb(12, 34, 56); --monthly-button-hover: rgb(12, 34, 56); }\n");
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".monthly-button")!.shadowRoot!.querySelector("button")!).backgroundColor === "rgb(12, 34, 56)");
    assert.equal(await page.evaluate(() => document.body.dataset.marker), "preserved");
    writeFileSync(mainPath, main + '\ndocument.body.dataset.reloaded = "yes";\n');
    await page.waitForFunction(() => document.body.dataset.reloaded === "yes");
    assert.equal(await page.evaluate(() => document.body.dataset.marker), undefined);
    const htmlPath = join(directory, "examples/index.html");
    writeFileSync(htmlPath, readFileSync(htmlPath, "utf8").replace("<title>Monthly media</title>", "<title>Vite reload verified</title>"));
    await page.waitForFunction(() => document.title === "Vite reload verified");
    writeFileSync(mainPath, main + "\nconst = ;\n");
    await page.locator("vite-error-overlay").waitFor();
    writeFileSync(mainPath, main);
    await page.locator("vite-error-overlay").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  } finally {
    await browser?.close();
    await server?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local Lambda server uses fixtures, enforces auth, paginates, and handles real browser uploads without AWS", { timeout: 120000 }, async () => {
  const server = await createServer({ server: { port: 0 } });
  let browser: Browser | undefined;
  try {
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.MONTHLY_BROWSER_CHANNEL && { channel: process.env.MONTHLY_BROWSER_CHANNEL }) });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    const headers = { Authorization: `Basic ${Buffer.from(`${LOCAL_USERNAME}:${LOCAL_PASSWORD}`).toString("base64")}` };
    const assets = loadAssets();
    assert.equal((await page.request.get(`${origin}/media?bucket=${LOCAL_BUCKET}`)).status(), 401);
    assert.equal((await page.request.get(`${origin}/media?bucket=not-local`, { headers })).status(), 403);
    assert.equal((await page.request.post(`${origin}/uploads`, { headers, data: "[" })).status(), 400);
    assert.equal((await page.request.post(`${origin}/uploads`, { headers, data: "x".repeat(8193) })).status(), 413);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: URLSearchParams = new URLSearchParams({ bucket: LOCAL_BUCKET, ...(cursor && { cursor }) });
      const response = await page.request.get(`${origin}/media?${query}`, { headers });
      assert.equal(response.status(), 200);
      const data: MediaPage = await response.json();
      assert.ok(data.items.length <= 50);
      seen.push(...data.items.map(item => item.key));
      cursor = data.cursor;
    } while (cursor);
    assert.deepEqual(seen, assets.map(item => item.key).sort());
    const emptyMonth = JSON.parse(readFileSync(new URL("../dev/assets.json", import.meta.url), "utf8")).months.find(
      (month: { items: unknown[] }) => !month.items.length,
    ).month;
    const empty: MediaPage = await (await page.request.get(`${origin}/media?bucket=${LOCAL_BUCKET}&month=${emptyMonth}`, { headers })).json();
    assert.deepEqual(empty.items, []);
    const preview = await page.request.get(`${origin}/${assets[0].key}`, { maxRedirects: 0 });
    assert.equal(preview.status(), 302);
    assert.equal(preview.headers().location, assets[0].url);
    assert.equal((await page.request.put(`${origin}/__monthly/s3/missing`, { data: "test" })).status(), 403);
    const outsideRequests: string[] = [];
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      outsideRequests.push(url.href);
      if (url.hostname === "picsum.photos") {
        return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9N8AAAAASUVORK5CYII=", "base64") });
      }
      return route.abort();
    });
    await page.goto(origin);
    await page.locator("input[name=username]").fill(LOCAL_USERNAME);
    await page.locator("input[name=password]").fill(LOCAL_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Upload", exact: true }).click();
    const month = assets.at(-1)!.key.slice("mock-assets/".length, "mock-assets/".length + 7).replace("/", "-");
    await page.getByLabel("Upload month").fill(month);
    for (const [name, size] of [["local-test.png", 123], ["local-test.png", 456], ["large-local.mp4", 101 * 1024 ** 2]] as const) {
      await page.getByLabel("Choose files", { exact: true }).evaluate((input, { name, size }) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(size)], name, { type: name.endsWith(".mp4") ? "video/mp4" : "image/png" }));
        (input as HTMLInputElement).files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, { name, size });
      const signedResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/sign");
      await page.getByRole("button", { name: "Upload files", exact: true }).click();
      const signed: SignedUpload = await (await signedResponse).json();
      assert.equal(new URL(signed.url).origin, origin);
      await page.getByRole("status").filter({ hasText: "1 uploaded; 0 failed." }).waitFor();
    }
    const uploaded: MediaPage = await (await page.request.get(`${origin}/media?bucket=${LOCAL_BUCKET}&month=${month}`, { headers })).json();
    assert.equal(uploaded.items.filter(item => item.key.endsWith("/local-test.png")).length, 1);
    assert.equal(uploaded.items.find(item => item.key.endsWith("/local-test.png"))!.size, 456);
    assert.equal(uploaded.items.find(item => item.key.endsWith("/large-local.mp4"))!.size, 101 * 1024 ** 2);
    const grant: UploadGrant = await (await page.request.post(`${origin}/uploads`, { headers, data: {
      bucket: LOCAL_BUCKET, name: "cancelled.png", size: 123, type: "image/png", month,
    } })).json();
    const sign = async (operation: object) => {
      const response = await page.request.post(`${origin}/sign`, { headers, data: {
        bucket: LOCAL_BUCKET, key: grant.key, ticket: grant.ticket, ...operation,
      } });
      assert.equal(response.status(), 200);
      const signed: SignedUpload = await response.json();
      return signed.url;
    };
    const initiated = await page.request.post(await sign({ method: "POST" }));
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await initiated.text())![1];
    assert.equal((await page.request.put(await sign({ method: "PUT", uploadId, partNumber: 1 }), { data: Buffer.alloc(123) })).status(), 200);
    const parts = await page.request.get(await sign({ method: "GET", uploadId }));
    assert.match(await parts.text(), /<Size>123<\/Size>/);
    assert.equal((await page.request.delete(await sign({ method: "DELETE", uploadId }))).status(), 204);
    assert.equal((await page.request.get(await sign({ method: "GET", uploadId }))).status(), 404);
    assert.ok(outsideRequests.every(url => new URL(url).hostname === "picsum.photos"));
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("Lit media views preserve login, filtering, clipboard, uploads, styling and multi-site configuration", { timeout: 120000 }, async () => {
  const server = await createServer({ mode: "aws", server: { port: 0 } });
  let browser: Browser | undefined;
  let releaseUpload: (() => void) | undefined;
  try {
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    const origin = `http://127.0.0.1:${port}`;
    const apiOrigin = "https://api.monthly.test";
    const username = "fixture";
    const password = "fixture-only-password";
    const requests: { path: string; query: Record<string, string>; body: unknown; authorization?: string }[] = [];
    const s3Requests: { operation: string; size: number; part?: number; bucket?: string }[] = [];
    const signatures = new Map<string, { constructor: { name: string }; input: UploadInput }>();
    let outage = false;
    let holdUpload = false;
    let uploadGate: Promise<void> | undefined;
    const handler = createHandler({
      config: {
        username, password,
        buckets: {
          "first-bucket": { prefix: "media/", publicBaseUrl: "https://cdn.monthly.test", region: "us-west-2" },
          "second-bucket": { prefix: "uploads/", publicBaseUrl: "https://second.monthly.test", region: "us-east-1" },
        },
      },
      clientForRegion: () => ({ send: async command => ({
        Contents: command.input.ContinuationToken ? [] : [
          { Key: `${command.input.Bucket === "first-bucket" ? "media" : "uploads"}/2026/11/existing.png`, Size: 123 },
          { Key: `media/2026/11/${"long-filename-".repeat(12)}recording.wav`, Size: 123 },
        ],
        IsTruncated: !command.input.ContinuationToken,
        NextContinuationToken: command.input.ContinuationToken ? undefined : "next",
      }) }),
      sign: async (client, command) => {
        const url = new URL("https://s3.monthly.test/upload");
        url.searchParams.set("operation", command.constructor.name);
        url.searchParams.set("key", command.input.Key!);
        if ("PartNumber" in command.input && command.input.PartNumber) url.searchParams.set("part", String(command.input.PartNumber));
        signatures.set(url.href, command);
        return url.href;
      },
    });
    browser = await chromium.launch({ headless: true, ...(process.env.MONTHLY_BROWSER_CHANNEL && { channel: process.env.MONTHLY_BROWSER_CHANNEL }) });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/config.ts") return route.fulfill({
        contentType: "text/javascript", body: `export const API_URL=${JSON.stringify(apiOrigin)}; export const BUCKET="first-bucket";`,
      });
      const cors = {
        "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        "access-control-allow-headers": "*", "access-control-expose-headers": "ETag", ETag: '"fixture-etag"',
      };
      if (url.origin === apiOrigin) {
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        const postData = request.postData();
        const body: unknown = postData ? JSON.parse(postData) : null;
        requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body, authorization: request.headers().authorization });
        if (outage && url.pathname === "/media") return route.fulfill({ status: 503, headers: cors, json: { error: "Fixture outage" } });
        const response = await handler({
          routeKey: `${request.method()} ${url.pathname}`, headers: request.headers(),
          body: request.postData(), queryStringParameters: Object.fromEntries(url.searchParams),
        });
        return route.fulfill({ status: response.statusCode, headers: { ...response.headers, ...cors }, body: response.body });
      }
      if (url.origin === "https://s3.monthly.test") {
        assert.equal(request.headers().authorization, undefined);
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        const command = signatures.get(url.href);
        assert.ok(command);
        const size = request.postDataBuffer()?.length || 0;
        s3Requests.push({ operation: command.constructor.name, size, part: command.input.PartNumber, bucket: command.input.Bucket });
        if (command.input.ContentLength !== undefined) assert.equal(size, command.input.ContentLength);
        if (command.input.ContentType) assert.equal(request.headers()["content-type"], command.input.ContentType);
        if (holdUpload) { holdUpload = false; await uploadGate; }
        if (command.constructor.name === "CreateMultipartUploadCommand") return route.fulfill({
          headers: cors, contentType: "application/xml",
          body: "<InitiateMultipartUploadResult><UploadId>fixture-id</UploadId></InitiateMultipartUploadResult>",
        });
        if (command.constructor.name === "CompleteMultipartUploadCommand") return route.fulfill({
          headers: cors, contentType: "application/xml",
          body: `<CompleteMultipartUploadResult><Location>https://s3.monthly.test/upload</Location><Key>${command.input.Key}</Key><Bucket>${command.input.Bucket}</Bucket><ETag>fixture-etag</ETag></CompleteMultipartUploadResult>`,
        });
        return route.fulfill({ headers: cors, body: "" });
      }
      if (["https://cdn.monthly.test", "https://second.monthly.test"].includes(url.origin)) return route.fulfill({
        contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9N8AAAAASUVORK5CYII=", "base64"),
      });
      if (url.origin !== origin) return route.abort();
      return route.continue();
    });
    await page.goto(origin);
    const signIn = async (value = password) => {
      await page.locator(".monthly-login input[name=username]").fill(username);
      await page.locator(".monthly-login input[name=password]").fill(value);
      await page.locator(".monthly-login input[name=password]").press("Enter");
    };
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    assert.equal(requests.length, 0);
    assert.equal(await page.locator("input[name=username]").evaluate(input => (input as HTMLInputElement).validity.valueMissing), true);
    await signIn("wrong-password");
    await page.getByRole("alert").filter({ hasText: "Invalid username" }).waitFor();
    assert.equal(await page.locator("input[name=password]").inputValue(), "");
    await signIn();
    await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
    assert.equal(await page.locator("input[name=password]").inputValue(), "");
    assert.equal(await page.locator("monthly-library monthly-asset").count(), 2);
    assert.equal(await page.locator("monthly-library audio").count(), 1);
    assert.equal(await page.locator("monthly-library audio").getAttribute("preload"), "none");
    const titles = await page.locator("monthly-library .monthly-title").evaluateAll(nodes => nodes.map(node => ({
      height: node.getBoundingClientRect().height, line: parseFloat(getComputedStyle(node).lineHeight), tooltip: node.getAttribute("title"), text: node.textContent,
    })));
    for (const title of titles) {
      assert.ok(Math.abs(title.height - title.line * 3) < 1);
      assert.equal(title.tooltip, title.text);
    }
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const firstAsset = page.locator("monthly-library monthly-asset").first();
    await firstAsset.getByRole("button", { name: "Copy URL" }).click();
    await firstAsset.getByRole("status").filter({ hasText: "URL copied." }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await firstAsset.locator("input").inputValue());
    const monthRequest = page.waitForRequest(request => request.method() === "GET" && request.url().includes("month=2025-01"));
    await page.locator("monthly-library input[type=month]").fill("2025-01");
    await monthRequest;
    await page.waitForFunction(() => document.querySelector("monthly-library wa-button[type=submit]")?.shadowRoot?.querySelector("button")?.disabled === false);
    await page.getByRole("button", { name: "Load more" }).click();
    await page.waitForFunction(() => !document.querySelector("monthly-library")!.textContent!.includes("Load more"));
    assert.equal(requests.at(-1)!.query.month, "2025-01");
    assert.equal(requests.at(-1)!.query.cursor, "next");
    await page.getByRole("tab", { name: "Browse", exact: true }).press("End");
    assert.equal(await page.getByRole("tab", { name: "Upload", exact: true }).getAttribute("aria-selected"), "true");
    await page.getByRole("tab", { name: "Upload", exact: true }).press("Home");
    assert.equal(await page.getByRole("tab", { name: "Browse", exact: true }).getAttribute("aria-selected"), "true");
    await page.getByRole("tab", { name: "Upload", exact: true }).click();
    await page.getByLabel("Choose files", { exact: true }).setInputFiles({ name: "small.png", mimeType: "image/png", buffer: Buffer.alloc(123) });
    uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
    holdUpload = true;
    const uploadStarted = page.waitForRequest(request => request.url().startsWith("https://s3.monthly.test/") && request.method() === "PUT");
    await page.getByRole("button", { name: "Upload files", exact: true }).click();
    await uploadStarted;
    await page.getByRole("tab", { name: "Browse", exact: true }).click();
    assert.equal(await page.locator("monthly-library input[type=month]").inputValue(), "2025-01");
    assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).isDisabled(), true);
    await page.getByRole("tab", { name: "Upload", exact: true }).click();
    releaseUpload!();
    await page.locator("monthly-upload monthly-asset").first().waitFor();
    assert.match(await page.locator("monthly-upload monthly-asset input").first().inputValue(), /\/media\/\d{4}\/\d{2}\/small\.png$/);
    await page.getByLabel("Choose files", { exact: true }).setInputFiles({ name: "recording.wav", mimeType: "audio/x-wav", buffer: Buffer.alloc(123) });
    await page.getByRole("button", { name: "Upload files", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("monthly-upload monthly-asset").length === 2);
    await page.getByLabel("Choose files", { exact: true }).evaluate(input => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(101 * 1024 ** 2)], "large.mp4", { type: "video/mp4" }));
      (input as HTMLInputElement).files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Upload files", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("monthly-upload monthly-asset").length === 3);
    const parts = s3Requests.filter(request => request.operation === "UploadPartCommand");
    assert.equal(parts.length, 11);
    assert.equal(parts[0].size, PART_SIZE);
    assert.equal(parts.at(-1)!.size, 1024 ** 2);
    assert.ok(s3Requests.some(request => request.operation === "CompleteMultipartUploadCommand"));
    await page.addStyleTag({ content: "monthly-media { --monthly-button-background: rgb(220, 230, 240); } monthly-asset .monthly-title { color: rgb(50, 60, 70); }" });
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".monthly-auth-actions wa-button")!.shadowRoot!.querySelector("button")!).backgroundColor === "rgb(220, 230, 240)");
    assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).evaluate(button => getComputedStyle(button).backgroundColor), "rgb(220, 230, 240)");
    assert.equal(await page.locator("monthly-upload .monthly-title").first().evaluate(title => getComputedStyle(title).color), "rgb(50, 60, 70)");
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("tab", { name: "Browse", exact: true }).click();
    outage = true;
    await page.getByRole("button", { name: "Refresh library" }).click();
    await page.getByRole("alert").filter({ hasText: "Fixture outage" }).waitFor();
    outage = false;
    await page.getByRole("button", { name: "Refresh library" }).click();
    await page.waitForFunction(() => !document.querySelector("monthly-library [role=alert]"));
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    assert.equal(await page.locator("monthly-upload monthly-asset").count(), 0);
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    await page.evaluate(() => { document.querySelector("monthly-media")!.bucket = "second-bucket"; });
    await signIn();
    await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
    assert.match(await page.locator("monthly-library monthly-asset input").first().inputValue(), /^https:\/\/second\.monthly\.test\/uploads\//);
    assert.equal(requests.at(-1)!.query.bucket, "second-bucket");
    await page.reload();
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    assert.equal(await page.locator("input[name=password]").inputValue(), "");
    const injectedController = await page.evaluate(async () => {
      const external = document.querySelector("monthly-media")!.observed!;
      const element = document.createElement("monthly-media");
      document.body.append(element);
      await element.updateComplete;
      const errorBefore = Boolean(element.querySelector("[role=alert]"));
      element.controller = external;
      await element.updateComplete;
      const errorAfter = Boolean(element.querySelector("[role=alert]"));
      const hasForm = Boolean(element.querySelector(".monthly-login"));
      const destroy = external.destroy;
      let destroyed = false;
      external.destroy = () => { destroyed = true; };
      element.remove();
      external.destroy = destroy;
      return { errorBefore, errorAfter, hasForm, destroyed };
    });
    assert.deepEqual(injectedController, { errorBefore: true, errorAfter: false, hasForm: true, destroyed: false });
    assert.deepEqual(errors, []);
  } finally {
    releaseUpload?.();
    await browser?.close();
    await server.close();
  }
});
