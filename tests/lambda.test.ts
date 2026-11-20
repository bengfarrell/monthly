import assert from "node:assert/strict";
import { test } from "node:test";
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHandler, parseBuckets, signUpload, MAX_FILE_SIZE, PART_SIZE } from "../lambda/handler.js";
import { MEDIA_TYPES } from "../src/shared/media-types.js";
import type { HandlerOptions, MediaEvent, UploadCommand } from "../lambda/handler.js";

const config = {
  username: "owner", password: "fixture-only-password",
  buckets: {
    "first-bucket": { prefix: "media/", region: "us-west-2", publicBaseUrl: "https://first.example.com" },
    "second-bucket": { prefix: "media/", region: "us-east-1", publicBaseUrl: "https://second.example.com" },
  },
};
const now = () => new Date("2026-11-15T00:00:00Z");
function event(route: string, body?: object, bucket = "first-bucket"): MediaEvent {
  return {
    routeKey: route, headers: { authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}` },
    queryStringParameters: { bucket }, ...(body && { body: JSON.stringify({ ...body, bucket }) }),
  };
}
function setup(options: Partial<HandlerOptions> = {}) {
  const commands: (UploadCommand | ListObjectsV2Command | GetObjectCommand)[] = [];
  const errors: unknown[][] = [];
  const handle = createHandler({
    config, now, logger: { error: (...args) => errors.push(args) },
    clientForRegion: () => ({ send: async command => {
      commands.push(command);
      if (command instanceof GetObjectCommand) throw Object.assign(new Error("Missing index"), { name: "NoSuchKey" });
      return { Contents: [{ Key: "media/2026/11/image #1.png", Size: 123 }], IsTruncated: true, NextContinuationToken: "next" };
    } }),
    sign: async (client, command, signing) => {
      commands.push(command);
      return "https://s3.example.com/signed";
    },
    ...options,
  });
  return { handle, commands, errors };
}
async function prepare(handle: ReturnType<typeof createHandler>, overrides = {}, bucket?: string) {
  const response = await handle(event("POST /uploads", { name: "file.png", type: "image/png", size: 123, ...overrides }, bucket));
  assert.equal(response.statusCode, 201);
  return JSON.parse(response.body);
}

test("every route requires Basic credentials; allowlist rejects unknown buckets before S3", async () => {
  const { handle, commands } = setup();
  for (const route of ["GET /media", "POST /uploads", "POST /sign", "POST /posts", "GET /posts", "POST /posts/edit"]) {
    assert.equal((await handle({ ...event(route, {}), headers: {} })).statusCode, 401);
    assert.equal((await handle(event(route, {}, "unknown-bucket"))).statusCode, 403);
  }
  assert.equal(commands.length, 0);
  assert.throws(() => parseBuckets("{}"));
  assert.throws(() => parseBuckets({ "first-bucket": { ...config.buckets["first-bucket"], prefix: "../" } }));
});

test("listing is prefix scoped and returns encoded CDN URLs and pagination", async () => {
  const { handle, commands } = setup();
  const response = await handle({ ...event("GET /media"), queryStringParameters: { bucket: "first-bucket", month: "2026-11" } });
  const page = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.ok("Prefix" in commands[0].input);
  assert.equal(commands[0].input.Prefix, "media/2026/11/");
  assert.equal(page.items[0].url, "https://first.example.com/media/2026/11/image%20%231.png");
  assert.equal(page.cursor, "next");
});

test("monthly post metadata does not appear in the media library", async () => {
  const { handle } = setup({ clientForRegion: () => ({ send: async command => {
    if (command instanceof GetObjectCommand) throw Object.assign(new Error("Missing index"), { name: "NoSuchKey" });
    return { Contents: [{ Key: "media/2026/11/posts.json", Size: 100 }, { Key: "media/2026/11/thumbnails.json", Size: 100 },
      { Key: "media/2026/11/photo.png", Size: 123 }] };
  } }) });
  const response = await handle(event("GET /media"));
  assert.deepEqual(JSON.parse(response.body).items.map((item: { key: string }) => item.key), ["media/2026/11/photo.png"]);
});

test("library lists videos and companion posters independently across pages", async () => {
  const video = { Key: "media/2026/11/clip.mp4", Size: 123 };
  const poster = { Key: `${video.Key}.poster.jpg`, Size: 45 };
  const commands: ListObjectsV2Command[] = [];
  const { handle } = setup({ clientForRegion: () => ({ send: async command => {
    if (command instanceof GetObjectCommand) throw Object.assign(new Error("Missing index"), { name: "NoSuchKey" });
    assert.ok(command instanceof ListObjectsV2Command);
    commands.push(command);
    return { Contents: command.input.Prefix === poster.Key ? [poster] : command.input.ContinuationToken ? [poster] : [video],
      IsTruncated: !command.input.ContinuationToken && command.input.Prefix !== poster.Key, NextContinuationToken: "next" };
  } }) });
  const response = await handle(event("GET /media"));
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).items[0].poster, undefined);
  assert.equal(commands.length, 1);
  const next = await handle({ ...event("GET /media"), queryStringParameters: { bucket: "first-bucket", cursor: "next" } });
  assert.deepEqual(JSON.parse(next.body).items.map((item: { key: string }) => item.key), [poster.Key]);
});

test("poster grants use the exact sanitized video filename, including maximum-length originals", async () => {
  const { handle } = setup();
  for (const name of ["a video.mp4", `${"long-".repeat(45)}.webm`, "../../clip.MOV"]) {
    const video = await prepare(handle, { name, type: name.endsWith(".webm") ? "video/webm" : name.endsWith(".MOV") ? "video/quicktime" : "video/mp4" });
    const poster = await prepare(handle, { name: "poster.jpg", type: "image/jpeg", posterFor: name });
    assert.equal(poster.key, `${video.key}.poster.jpg`);
  }
  assert.equal((await handle(event("POST /uploads", { name: "video.mp4.poster.jpg", size: 123, type: "image/jpeg" }))).statusCode, 400);
  for (const fields of [{ posterFor: "photo.png" }, { posterFor: 123 }, { posterFor: "clip.mp4", type: "image/png", name: "poster.png" }]) {
    assert.equal((await handle(event("POST /uploads", { name: "poster.jpg", type: "image/jpeg", size: 123, ...fields }))).statusCode, 400);
  }
});

test("keys preserve ordinary filenames, sanitize paths and share limits and types", async () => {
  const { handle } = setup();
  assert.equal((await prepare(handle)).key, "media/2026/11/file.png");
  assert.equal((await prepare(handle, { name: "../../a video.mp4", type: "video/mp4", month: "2024-02" })).key, "media/2024/02/a-video.mp4");
  for (const [type, extensions] of MEDIA_TYPES) {
    for (const extension of extensions) await prepare(handle, { name: `file.${extension}`, type });
  }
  for (const fields of [{ size: 0 }, { size: MAX_FILE_SIZE + 1 }, { type: "text/plain" }, { month: "2026-13" }]) {
    assert.equal((await handle(event("POST /uploads", { name: "file.png", type: "image/png", size: 1, ...fields }))).statusCode, 400);
  }
  assert.equal((await handle({ ...event("POST /uploads"), body: "[]" })).statusCode, 400);
});

test("grants bind bucket, prefix, credentials and expiry", async () => {
  const { handle } = setup();
  const grant = await prepare(handle);
  assert.equal((await handle(event("POST /sign", { ...grant, method: "PUT" }, "second-bucket"))).statusCode, 403);
  assert.equal((await handle(event("POST /sign", { ...grant, key: "outside", method: "PUT" }))).statusCode, 403);
  assert.equal((await handle(event("POST /sign", { ...grant, ticket: `${grant.ticket}x`, method: "PUT" }))).statusCode, 403);
  const expired = setup({ now: () => new Date("2026-11-16T00:00:00Z") });
  assert.equal((await expired.handle(event("POST /sign", { ...grant, method: "PUT" }))).statusCode, 403);
  const rotated = setup({ config: { ...config, password: "new-fixture-only-password" } });
  assert.equal((await rotated.handle(event("POST /sign", { ...grant, method: "PUT" }))).statusCode, 401);
});

test("multipart operations preserve exact key and last part size without ACL changes", async () => {
  const { handle, commands } = setup();
  const grant = await prepare(handle, { size: PART_SIZE * 10 + 17 });
  const operations = [
    { method: "POST" }, { method: "PUT", uploadId: "id", partNumber: 11 },
    { method: "GET", uploadId: "id" }, { method: "POST", uploadId: "id" }, { method: "DELETE", uploadId: "id" },
  ];
  for (const operation of operations) assert.equal((await handle(event("POST /sign", { ...grant, ...operation }))).statusCode, 200);
  assert.ok("ContentLength" in commands[1].input);
  assert.equal(commands[1].input.ContentLength, 17);
  for (const command of commands) {
    assert.ok("Key" in command.input);
    assert.equal(command.input.Key, grant.key);
    assert.equal("ACL" in command.input ? command.input.ACL : undefined, undefined);
  }
  assert.equal((await handle(event("POST /sign", { ...grant, method: "PUT", uploadId: "id", partNumber: 12 }))).statusCode, 400);
});

test("actual regional signatures bind Content-Length and only intended creation headers", async () => {
  const { handle } = setup({
    clientForRegion: region => new S3Client({
      region, credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" }, requestChecksumCalculation: "WHEN_REQUIRED",
    }),
    sign: signUpload,
  });
  const grant = await prepare(handle, {}, "second-bucket");
  for (const operation of [{ method: "PUT" }, { method: "POST" }, { method: "PUT", uploadId: "id", partNumber: 1 }]) {
    const response = await handle(event("POST /sign", { ...grant, ...operation }, "second-bucket"));
    const url = new URL(JSON.parse(response.body).url);
    assert.match(url.hostname, /second-bucket\.s3\.us-east-1/);
    const headers = url.searchParams.get("X-Amz-SignedHeaders")!;
    assert.equal(headers.includes("content-type"), !operation.uploadId);
    if (operation.method === "PUT") assert.ok(headers.includes("content-length"));
  }
});

test("unexpected S3 failures are logged and never returned as empty success", async () => {
  const { handle, errors } = setup({ clientForRegion: () => ({ send: async () => { throw new Error("AccessDenied"); } }) });
  assert.equal((await handle(event("GET /media"))).statusCode, 500);
  assert.equal(errors.length, 1);
});

test("library listing does not look up thumbnail indexes or companion posters", async () => {
  const { handle, errors } = setup({ clientForRegion: () => ({ send: async command => {
    assert.ok(command instanceof ListObjectsV2Command);
    assert.equal(command.input.Prefix, "media/");
    return { Contents: [{ Key: "media/2026/11/clip.mp4", Size: 123 }] };
  } }) });
  assert.equal((await handle(event("GET /media"))).statusCode, 200);
  assert.equal(errors.length, 0);
});
