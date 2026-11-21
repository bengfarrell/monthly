import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { buildSync } from "esbuild";
import ts from "typescript";

test("package exports provide JavaScript modules and strict consumer declarations", () => {
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"]);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/build.ts"], { env: {
    ...process.env, MONTHLY_API_URL: "https://api.example.com", MONTHLY_BUCKET: "example-bucket",
    MONTHLY_PRIVATE_FIXTURE: "must-not-be-bundled",
  } });
  const directory = mkdtempSync(join(process.cwd(), ".monthly-consumer-"));
  try {
    const filename = join(directory, "consumer.ts");
    writeFileSync(filename, `
      import { MediaController, PostFeed, PostComposer, PostsEditor, Store, postUrl, type Post, type MediaItem, type ControllerState } from "@bengfarrell/monthly/core";
      import type { MonthlyMedia } from "@bengfarrell/monthly/components";
      import type { MediaUploaderOptions } from "@bengfarrell/monthly";
      const controller = new MediaController({ apiUrl: "https://api.example.com", bucket: "example-bucket" });
      controller.subscribe((state: Readonly<ControllerState>) => state.authenticated);
      controller.library.subscribe(state => state.items.map((item: MediaItem) => item.url));
      const element: MonthlyMedia = document.createElement("monthly-media");
      element.controller = controller;
      controller.selectTab("post");
      const feed = new PostFeed({ baseUrl: "https://cdn.example.com/media/" });
      feed.subscribe(state => state.posts.map((post: Post) => post.text));
      document.createElement("monthly-feed").model = feed;
      const publicFeed = document.createElement("monthly-feed");
      publicFeed.postViewer = true;
      publicFeed.postPrefix = "note-";
      publicFeed.postLabel = "Memo";
      async function openLinkedPost(id: string, month: string, signal: AbortSignal) {
        const post = await feed.loadPost(id, month, signal);
        if (post) {
          const url: URL = postUrl(post, "https://example.com/memos/", "note-");
          publicFeed.openPost(post, publicFeed, 0);
        }
      }
      // @ts-expect-error Viewer enablement must be a boolean.
      publicFeed.postViewer = "yes";
      document.createElement("monthly-post").model = new PostComposer(controller.api);
      document.createElement("monthly-posts-editor").model = new PostsEditor(controller.api, { month: "2026-11" });
      document.createElement("monthly-library").editor = controller.postsEditor;
      const options: MediaUploaderOptions = { month: "2026-11" };
      const store = new Store({ count: 0 });
      store.setState({ count: 1 });
      // @ts-expect-error State updates must match the initial state.
      store.setState({ count: "one" });
      // @ts-expect-error Only supported tabs may be selected.
      controller.selectTab("invalid");
      // @ts-expect-error Element controllers must be MediaController instances.
      element.controller = {};
    `);
    const program = ts.createProgram([filename], {
      strict: true, noEmit: true, skipLibCheck: true,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: filename => filename,
      getNewLine: () => "\n",
    }));
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { MediaController, Store } from "@bengfarrell/monthly/core";
      const controller = new MediaController({ apiUrl: "https://api.example.com", bucket: "example-bucket" });
      if (controller.state.authenticated || new Store({ count: 1 }).state.count !== 1) process.exit(1);
      controller.destroy();
    `]);
    assert.equal(result.length, 0);
    assert.equal(readFileSync("dist/modules/styles.css", "utf8"), readFileSync("src/styles.css", "utf8"));
    const bundled = buildSync({
      entryPoints: ["@bengfarrell/monthly"], bundle: true, format: "esm",
      outfile: join(directory, "bundle.js"), write: false,
    });
    const css = bundled.outputFiles.find(file => file.path.endsWith(".css"));
    assert.ok(css);
    assert.match(css.text, /--wa-color-brand-fill-loud/);
    assert.doesNotMatch(css.text, /@import\s/);
    const config = readFileSync("dist/config.js", "utf8");
    assert.match(config, /https:\/\/api\.example\.com/);
    assert.match(config, /example-bucket/);
    assert.doesNotMatch(config, /must-not-be-bundled|process\.env/);
    assert.doesNotMatch(readFileSync("dist/monthly.js", "utf8"), /https:\/\/api\.example\.com|example-bucket/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Lambda ZIP runs independently with its dependencies bundled", () => {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/build-lambda.ts"]);
  const files = unzipSync(readFileSync("dist/monthly-lambda.zip"));
  assert.deepEqual(Object.keys(files), ["handler.mjs"]);
  const directory = mkdtempSync(join(tmpdir(), "monthly-lambda-"));
  try {
    const filename = join(directory, "handler.mjs");
    writeFileSync(filename, files["handler.mjs"]);
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
      const { handler } = await import(${JSON.stringify(pathToFileURL(filename).href)});
      const result = await handler({ routeKey: "GET /media", headers: {} });
      console.log(result.statusCode);
    `], { encoding: "utf8", env: {
      ...process.env, MEDIA_USERNAME: "fixture", MEDIA_PASSWORD: "fixture-only-password",
      MEDIA_BUCKETS: '{"example-bucket":{"prefix":"media/","region":"us-east-1","publicBaseUrl":"https://cdn.example.com"}}',
    } });
    assert.equal(result.trim(), "401");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
