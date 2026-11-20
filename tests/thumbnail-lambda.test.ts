import assert from "node:assert/strict";
import { test } from "node:test";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHandler, type MediaEvent, type MediaS3Client } from "../lambda/handler.js";
import { MockS3 } from "../dev/mock-s3.js";
import { LOCAL_BUCKET, LOCAL_PREFIX } from "../dev/fixtures.js";
import { MAX_THUMBNAIL_SIZE, mediaUrl, thumbnailKey } from "../src/shared/media-types.js";

const month = "2026-11";
const folder = `${LOCAL_PREFIX}2026/11/`;
const key = `${folder}photo.png`;
const indexKey = `${folder}thumbnails.json`;
const base = "https://cdn.example.com";
const config = { username: "owner", password: "fixture-only-password",
  buckets: { [LOCAL_BUCKET]: { prefix: LOCAL_PREFIX, region: "us-east-1", publicBaseUrl: base } } };
function event(routeKey: string, body?: object): MediaEvent {
  return { routeKey, headers: { authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}` },
    queryStringParameters: { bucket: LOCAL_BUCKET, month },
    ...(body && { body: JSON.stringify({ bucket: LOCAL_BUCKET, month, ...body }) }) };
}
function files(original = key) {
  return Object.fromEntries(["600x300", "960x480"].map(dimensions =>
    [dimensions, { key: thumbnailKey(original, dimensions), size: 45, url: "https://untrusted.example/thumbnail.jpg" }]));
}
function setup(client?: MediaS3Client) {
  const s3 = new MockS3([{ key, size: 2 * 1024 ** 2, url: mediaUrl(base, key), modified: "2026-11-15T00:00:00.000Z" }]);
  const writes: PutObjectCommand[] = [];
  const reads: GetObjectCommand[] = [];
  const errors: unknown[] = [];
  const handle = createHandler({ config, now: () => new Date("2026-11-15T00:00:00.000Z"),
    logger: { error: (...args) => errors.push(args) }, clientForRegion: () => client ?? { send: async command => {
      if (command instanceof PutObjectCommand) writes.push(command);
      if (command instanceof GetObjectCommand) reads.push(command);
      return s3.send(command);
    } },
  });
  return { handle, s3, writes, reads, errors };
}

test("thumbnail grants derive exact dimension companions for images and videos, without filename truncation", async () => {
  const { handle } = setup();
  for (const name of ["photo.png", "a video.mp4", `${"long-".repeat(45)}.webm`]) {
    const type = name.endsWith(".png") ? "image/png" : name.endsWith(".mp4") ? "video/mp4" : "video/webm";
    const original = await handle(event("POST /uploads", { name, size: 123, type }));
    assert.equal(original.statusCode, 201);
    const thumbnail = await handle(event("POST /uploads", {
      name: "thumbnail.jpg", type: "image/jpeg", size: 45, thumbnailFor: name, dimensions: "600x300",
    }));
    assert.equal(thumbnail.statusCode, 201);
    assert.equal(JSON.parse(thumbnail.body).key, thumbnailKey(JSON.parse(original.body).key, "600x300"));
  }
  for (const override of [{ dimensions: "0x300" }, { thumbnailFor: "file.mp3" }, { size: MAX_THUMBNAIL_SIZE + 1 },
    { posterFor: "clip.mp4" }, { type: "image/png", name: "thumbnail.png" }]) {
    assert.equal((await handle(event("POST /uploads", {
      name: "thumbnail.jpg", type: "image/jpeg", size: 45, thumbnailFor: "photo.png", dimensions: "600x300", ...override,
    }))).statusCode, 400);
  }
  assert.equal((await handle(event("POST /uploads", { name: "photo.png.thumb-600x300.jpg", type: "image/jpeg", size: 45 }))).statusCode, 400);
});

test("the monthly index persists ordered maps, canonicalizes URLs and hides all generated objects", async () => {
  const { handle, s3, writes, reads } = setup();
  const response = await handle(event("POST /thumbnails", { key, thumbnails: files() }));
  assert.equal(response.statusCode, 200);
  const thumbnails = JSON.parse(response.body).thumbnails;
  assert.deepEqual(Object.keys(thumbnails), ["600x300", "960x480"]);
  assert.equal(thumbnails["600x300"].url, mediaUrl(base, thumbnailKey(key, "600x300")));
  assert.equal(writes[0].input.IfNoneMatch, "*");
  assert.equal(writes[0].input.ContentType, "application/json");
  assert.equal(writes[0].input.CacheControl, "no-cache");
  assert.deepEqual(JSON.parse(s3.documents.get(indexKey)!.body), { [key]: thumbnails });
  for (const generated of [indexKey, `${folder}posts.json`, thumbnailKey(key, "600x300"), thumbnailKey(key, "960x480")]) {
    s3.assets.set(generated, { ...s3.assets.get(key)!, key: generated });
  }
  const page = JSON.parse((await handle(event("GET /media"))).body);
  assert.deepEqual(page.items.map((item: { key: string }) => item.key), [key]);
  assert.deepEqual(page.items[0].thumbnails, thumbnails);
  assert.equal(reads.length, 2);
});

test("parallel thumbnail saves conditionally merge without losing other media entries", async () => {
  const { handle, s3, writes } = setup();
  const keys = [key, `${folder}other.png`, `${folder}clip.mp4`];
  const responses = await Promise.all(keys.map(key => handle(event("POST /thumbnails", { key, thumbnails: files(key) }))));
  assert.ok(responses.every(response => response.statusCode === 200));
  assert.deepEqual(Object.keys(JSON.parse(s3.documents.get(indexKey)!.body)).sort(), [...keys].sort());
  assert.ok(writes.some(write => write.input.IfMatch));
});

test("replacing a map or disabling thumbnails cannot rediscover obsolete companions or legacy posters", async () => {
  const { handle, s3 } = setup();
  const video = `${folder}clip.mp4`;
  for (const generated of [video, `${video}.poster.jpg`, thumbnailKey(video, "600x300"), thumbnailKey(video, "960x480")]) {
    s3.assets.set(generated, { ...s3.assets.get(key)!, key: generated });
  }
  assert.equal((await handle(event("POST /thumbnails", { key: video, thumbnails: files(video) }))).statusCode, 200);
  assert.equal((await handle(event("POST /thumbnails", { key: video, thumbnails: { "960x480": files(video)["960x480"] } }))).statusCode, 200);
  let page = JSON.parse((await handle(event("GET /media"))).body);
  assert.deepEqual(Object.keys(page.items.find((item: { key: string }) => item.key === video).thumbnails), ["960x480"]);
  assert.equal((await handle(event("POST /thumbnails", { key: video, thumbnails: {} }))).statusCode, 200);
  page = JSON.parse((await handle(event("GET /media"))).body);
  const item = page.items.find((item: { key: string }) => item.key === video);
  assert.deepEqual(item.thumbnails, {});
  assert.equal(item.poster, undefined);
  assert.equal(s3.assets.has(`${video}.poster.jpg`), true);
});

test("invalid thumbnail associations fail before writing any index", async () => {
  const { handle, writes } = setup();
  for (const body of [
    { key: `${LOCAL_PREFIX}2026/10/photo.png`, thumbnails: {} },
    { key: `${folder}audio.mp3`, thumbnails: {} },
    { key, thumbnails: { "600x300": { key: thumbnailKey(`${folder}other.png`, "600x300"), size: 45 } } },
    { key, thumbnails: { "600x300": { key: thumbnailKey(key, "600x300"), size: MAX_THUMBNAIL_SIZE + 1 } } },
    { key, thumbnails: [] },
  ]) assert.equal((await handle(event("POST /thumbnails", body))).statusCode, 400);
  assert.equal(writes.length, 0);
});

test("corrupt or unreadable thumbnail indexes remain explicit errors and are never overwritten", async () => {
  for (const body of ["not JSON", "[]", JSON.stringify({ [key]: files() })]) {
    const { handle, s3, errors, writes } = setup();
    s3.documents.set(indexKey, { body, etag: '"original"' });
    assert.equal((await handle(event("GET /media"))).statusCode, 500);
    assert.equal((await handle(event("POST /thumbnails", { key, thumbnails: {} }))).statusCode, 500);
    assert.equal(errors.length, 2);
    assert.equal(writes.length, 0);
    assert.equal(s3.documents.get(indexKey)!.body, body);
  }
  const s3 = new MockS3([{ key, size: 123, url: mediaUrl(base, key), modified: "2026-11-15T00:00:00.000Z" }]);
  const { handle, errors } = setup({ send: async command => {
    if (command instanceof GetObjectCommand) throw Object.assign(new Error("Access denied"), { name: "AccessDenied" });
    return s3.send(command);
  } });
  assert.equal((await handle(event("GET /media"))).statusCode, 500);
  assert.equal(errors.length, 1);
});

test("persistent conditional index conflicts are retryable and never fall back to unconditional writes", async () => {
  const writes: PutObjectCommand[] = [];
  const { handle } = setup({ send: async command => {
    if (command instanceof GetObjectCommand) throw Object.assign(new Error("Not found"), { name: "NoSuchKey" });
    assert.ok(command instanceof PutObjectCommand);
    writes.push(command);
    throw Object.assign(new Error("Changed"), { name: "ConditionalRequestConflict" });
  } });
  assert.equal((await handle(event("POST /thumbnails", { key, thumbnails: files() }))).statusCode, 409);
  assert.equal(writes.length, 5);
  assert.ok(writes.every(write => write.input.IfNoneMatch === "*"));
});
