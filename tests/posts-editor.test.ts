import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createHandler, type MediaEvent, type MediaS3Client } from "../lambda/handler.js";
import { MockS3 } from "../dev/mock-s3.js";
import { LOCAL_BUCKET, LOCAL_PREFIX } from "../dev/fixtures.js";
import { MAX_POSTS_FILE_BYTES, MediaApi, MediaAuth, PostsEditor, mediaUrl, thumbnailKey, validatePostsJson, validatePostsFileSize } from "../src/core/index.js";
import type { Post, PostsFile } from "../src/core/index.js";

const month = "2026-01";
const key = `${LOCAL_PREFIX}2026/01/posts.json`;
const origin = "https://cdn.example.com";
const config = { username: "owner", password: "fixture-only-password",
  buckets: { [LOCAL_BUCKET]: { prefix: LOCAL_PREFIX, region: "us-east-1", publicBaseUrl: origin } } };
const post = (): Post => ({
  id: randomUUID(), created: "2026-01-15T12:00:00.000Z", text: "An update", tags: ["hello"],
  media: [{ key: `${LOCAL_PREFIX}2026/01/photo.png`, size: 12, url: mediaUrl(origin, `${LOCAL_PREFIX}2026/01/photo.png`) }],
});
const file = (content = JSON.stringify([post()], null, 2)): PostsFile => ({
  key, url: mediaUrl(origin, key), etag: '"original"', content,
});
function event(routeKey: string, body?: object): MediaEvent {
  return { routeKey, headers: { authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}` },
    queryStringParameters: { bucket: LOCAL_BUCKET, month },
    ...(body && { body: JSON.stringify({ bucket: LOCAL_BUCKET, month, ...body }) }) };
}
function setup(content = file().content, client?: MediaS3Client) {
  const s3 = new MockS3([]);
  s3.documents.set(key, { body: content, etag: '"original"' });
  const errors: unknown[] = [];
  const writes: PutObjectCommand[] = [];
  const handle = createHandler({ config, now: () => new Date("2026-01-15T12:00:00.000Z"),
    logger: { error: (...args) => errors.push(args) },
    clientForRegion: () => client ?? { send: async command => {
      if (command instanceof PutObjectCommand) writes.push(command);
      return s3.send(command);
    } },
  });
  return { s3, handle, errors, writes };
}

test("editor endpoints require auth, allowlisted buckets and a valid selected month", async () => {
  const { handle, writes } = setup();
  for (const route of ["GET /posts", "POST /posts/edit"]) {
    assert.equal((await handle({ ...event(route, {}), headers: {} })).statusCode, 401);
    assert.equal((await handle({ ...event(route, { bucket: "unknown" }), queryStringParameters: { bucket: "unknown", month } })).statusCode, 403);
    assert.equal((await handle({ ...event(route, { month: "../" }), queryStringParameters: { bucket: LOCAL_BUCKET, month: "../" } })).statusCode, 400);
  }
  assert.equal(writes.length, 0);
});

test("loading reads raw JSON and ETags, including corrupt files for repair, without creating missing files", async () => {
  const { handle, s3 } = setup("corrupt JSON");
  const response = await handle(event("GET /posts"));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { bucket: LOCAL_BUCKET, ...file("corrupt JSON") });
  s3.documents.delete(key);
  assert.equal((await handle(event("GET /posts"))).statusCode, 404);
  assert.equal(s3.documents.size, 0);
});

test("editing preserves exact text, extra fields and posters using a conditional write", async () => {
  const videoKey = `${LOCAL_PREFIX}2026/01/clip.mp4`;
  const content = `${JSON.stringify([{ ...post(), text: "Changed", extra: { preserved: true }, media: [{
    key: videoKey, size: 123, url: mediaUrl(origin, videoKey),
    poster: { key: `${videoKey}.poster.jpg`, size: 45, url: mediaUrl(origin, `${videoKey}.poster.jpg`), time: 0.5 },
  }] }], null, 2)}\n`;
  const { handle, s3, writes } = setup();
  const response = await handle(event("POST /posts/edit", { etag: '"original"', content }));
  assert.equal(response.statusCode, 200);
  const result: PostsFile = JSON.parse(response.body);
  assert.equal(result.content, content);
  assert.notEqual(result.etag, '"original"');
  assert.equal(s3.documents.get(key)!.body, content);
  assert.equal(writes[0].input.IfMatch, '"original"');
  assert.equal(writes[0].input.CacheControl, "no-cache");
  assert.equal(writes[0].input.ContentType, "application/json");
  assert.equal((await handle(event("POST /posts", { id: randomUUID(), text: "New post", tags: [], media: [] }))).statusCode, 201);
  assert.deepEqual(JSON.parse(s3.documents.get(key)!.body)[0].extra, { preserved: true });
  const latest = JSON.parse((await handle(event("GET /posts"))).body);
  assert.equal((await handle(event("POST /posts/edit", { etag: latest.etag, content: "[]" }))).statusCode, 200);
  assert.equal(s3.documents.get(key)!.body, "[]");
  assert.equal(s3.assets.size, 0);
});

test("invalid edited files fail before writing and keep stored JSON untouched", async () => {
  const original = file().content;
  const { handle, s3, writes } = setup(original);
  const draft = post();
  for (const content of ["not JSON", "{}", JSON.stringify([draft, draft]), JSON.stringify([{ ...draft, created: "2025-12-01T00:00:00.000Z" }]),
    JSON.stringify([{ ...draft, text: "x".repeat(4001) }]), JSON.stringify([{ ...draft, media: [{ ...draft.media[0], key: `${LOCAL_PREFIX}2025/12/photo.png` }] }]),
    JSON.stringify([{ ...draft, media: [{ ...draft.media[0], url: "https://untrusted.example/photo.png" }] }]),
    JSON.stringify([{ ...draft, media: [{ ...draft.media[0], key: `${LOCAL_PREFIX}2026/01/../photo.png` }] }]),
  ]) {
    const response = await handle(event("POST /posts/edit", { etag: '"original"', content }));
    assert.equal(response.statusCode, 400, content);
  }
  for (const etag of [undefined, "*", "", '"bad\r\nheader"']) {
    assert.equal((await handle(event("POST /posts/edit", { etag, content: "[]" }))).statusCode, 400);
  }
  assert.equal(writes.length, 0);
  assert.equal(s3.documents.get(key)!.body, original);
});

test("edited JSON accepts multiple thumbnails in order and rejects mismatched thumbnail CDN URLs", async () => {
  const draft = post();
  const item = draft.media[0];
  item.thumbnails = Object.fromEntries(["600x300", "960x480"].map(dimensions => [dimensions, {
    key: thumbnailKey(item.key, dimensions), size: 45, url: mediaUrl(origin, thumbnailKey(item.key, dimensions)),
  }]));
  const content = `${JSON.stringify([draft], null, 2)}\n`;
  const { handle, s3 } = setup();
  assert.equal((await handle(event("POST /posts/edit", { etag: '"original"', content }))).statusCode, 200);
  assert.equal(s3.documents.get(key)!.body, content);
  assert.deepEqual(Object.keys(validatePostsJson(content, month, file())[0].media[0].thumbnails!), ["600x300", "960x480"]);
  item.thumbnails["600x300"].url = "https://untrusted.example/thumbnail.jpg";
  assert.throws(() => validatePostsJson(JSON.stringify([draft]), month, file()), /Thumbnail URLs/);
});

test("past-month files are editable and cannot be redirected to another bucket or object path", async () => {
  const { handle, s3 } = setup();
  const oldKey = `${LOCAL_PREFIX}2025/12/posts.json`;
  s3.documents.set(oldKey, { body: "[]", etag: '"old"' });
  const response = await handle(event("POST /posts/edit", { month: "2025-12", etag: '"old"', content: "[]\n", key: "other/path.json" }));
  assert.equal(response.statusCode, 200);
  assert.equal(s3.documents.get(oldKey)!.body, "[]\n");
  assert.equal(s3.documents.has("other/path.json"), false);
});

test("stale edits cannot overwrite new posts or recreate a removed file", async () => {
  const original = post();
  const { handle, s3 } = setup(JSON.stringify([original]));
  assert.equal((await handle(event("POST /posts", { id: randomUUID(), text: "New post", tags: [], media: [] }))).statusCode, 201);
  const content = JSON.stringify([{ ...original, text: "Stale edit" }]);
  assert.equal((await handle(event("POST /posts/edit", { etag: '"original"', content }))).statusCode, 409);
  assert.equal(JSON.parse(s3.documents.get(key)!.body).length, 2);
  assert.equal(JSON.parse(s3.documents.get(key)!.body)[0].text, original.text);
  s3.documents.delete(key);
  assert.equal((await handle(event("POST /posts/edit", { etag: '"original"', content }))).statusCode, 409);
  assert.equal(s3.documents.size, 0);
});

test("two simultaneous editors cannot silently overwrite each other", async () => {
  const { handle, s3 } = setup();
  const responses = await Promise.all(["First edit", "Second edit"].map(text =>
    handle(event("POST /posts/edit", { etag: '"original"', content: JSON.stringify([{ ...post(), text }]) })),
  ));
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]);
  assert.equal(JSON.parse(s3.documents.get(key)!.body)[0].text, "First edit");
});

test("editor file size limits count UTF-8 bytes and accept the exact boundary", async () => {
  const content = `[]${" ".repeat(MAX_POSTS_FILE_BYTES - 2)}`;
  const { handle, s3 } = setup();
  assert.equal((await handle(event("POST /posts/edit", { etag: '"original"', content }))).statusCode, 200);
  assert.equal(s3.documents.get(key)!.body.length, MAX_POSTS_FILE_BYTES);
  assert.equal((await handle(event("POST /posts/edit", { etag: '"original"', content: `${content} ` }))).statusCode, 400);
  assert.throws(() => validatePostsFileSize("日".repeat(Math.ceil(MAX_POSTS_FILE_BYTES / 3))), /512 KiB/);
  s3.documents.set(key, { body: `${content} `, etag: '"large"' });
  assert.equal((await handle(event("GET /posts"))).statusCode, 413);
});

test("read and write storage errors stay explicit and are logged", async () => {
  for (const client of [
    { send: async () => { throw new Error("S3 denied"); } },
    { send: async () => ({ Body: { transformToString: async () => "[]" } }) },
  ]) {
    const { handle, errors } = setup("[]", client);
    assert.equal((await handle(event("GET /posts"))).statusCode, 500);
    assert.equal((await handle(event("POST /posts/edit", { etag: '"original"', content: "[]" }))).statusCode, 500);
    assert.equal(errors.length, 2);
  }
});

test("posts file API binds requests to the bucket, preserves corrupt reads, and validates saved responses", async () => {
  const auth = new MediaAuth();
  auth.login(config.username, config.password);
  const baseline = file("not JSON");
  const calls: { url: URL; options: RequestInit }[] = [];
  const api = new MediaApi({ apiUrl: "https://api.example.com", bucket: LOCAL_BUCKET, auth, fetch: async (url, options) => {
    calls.push({ url: new URL(String(url)), options: options! });
    return Response.json({ bucket: LOCAL_BUCKET, ...baseline });
  } });
  assert.deepEqual(await api.getPostsFile(month), baseline);
  assert.equal(calls[0].url.searchParams.get("bucket"), LOCAL_BUCKET);
  assert.equal(calls[0].url.searchParams.get("month"), month);
  await assert.rejects(api.getPostsFile(""), /YYYY-MM/);
  await assert.rejects(api.savePostsFile(month, "not JSON", baseline.etag), /Invalid JSON/);
  assert.equal(calls.length, 1);
  api.fetch = async (url, options) => {
    assert.equal(new URL(String(url)).pathname, "/posts/edit");
    assert.deepEqual(JSON.parse(String(options?.body)), { bucket: LOCAL_BUCKET, month, etag: baseline.etag, content: "[]\n" });
    return Response.json({ bucket: LOCAL_BUCKET, ...file("[]\n"), etag: '"saved"' });
  };
  assert.equal((await api.savePostsFile(month, "[]\n", baseline.etag)).etag, '"saved"');
  api.fetch = async () => Response.json({ bucket: LOCAL_BUCKET, ...file("[]") });
  await assert.rejects(api.savePostsFile(month, "[]\n", baseline.etag), /differs/);
  api.fetch = async () => Response.json({ bucket: LOCAL_BUCKET, ...file(), etag: "*" });
  await assert.rejects(api.getPostsFile(month), /ETag/);
});

test("editor validates in place, protects drafts, saves exact JSON and refreshes its ETag", async () => {
  let remote = file();
  let saves = 0;
  const editor = new PostsEditor({
    getPostsFile: async () => remote,
    savePostsFile: async (requestedMonth, content, etag) => {
      assert.equal(requestedMonth, month);
      assert.equal(etag, remote.etag);
      saves++;
      remote = { ...remote, content, etag: '"saved"' };
      return remote;
    },
  }, { month });
  assert.equal(await editor.load(), true);
  assert.equal(editor.state.postCount, 1);
  editor.setContent("{ broken");
  assert.equal(editor.state.dirty, true);
  assert.match(editor.state.validationError!.message, /Invalid JSON/);
  assert.equal(await editor.save(), false);
  assert.equal(saves, 0);
  assert.equal(await editor.load(), false);
  assert.equal(editor.setMonth("2025-12"), false);
  assert.equal(editor.state.month, month);
  editor.discard();
  assert.equal(editor.state.dirty, false);
  assert.equal(editor.state.validationError, null);
  editor.setContent("[]\n");
  assert.equal(editor.state.postCount, 0);
  assert.equal(await editor.save(), true);
  assert.equal(editor.state.file!.etag, '"saved"');
  assert.equal(editor.state.content, "[]\n");
  assert.equal(editor.state.saved, true);
  assert.equal(editor.state.dirty, false);
  editor.setContent("[]");
  assert.equal(await editor.save(), true);
  assert.equal(saves, 2);
  assert.equal(editor.setMonth("2025-12"), true);
  assert.equal(editor.state.file, null);
});

test("corrupt loaded JSON can be repaired and save conflicts leave the draft intact", async () => {
  const editor = new PostsEditor({ getPostsFile: async () => file("corrupt"), savePostsFile: async () => {
    throw new Error("The posts file changed. Reload before saving.");
  } }, { month });
  assert.equal(await editor.load(), true);
  assert.match(editor.state.validationError!.message, /Invalid JSON/);
  editor.setContent("[]");
  assert.equal(editor.state.validationError, null);
  assert.equal(await editor.save(), false);
  assert.equal(editor.state.dirty, true);
  assert.equal(editor.state.content, "[]");
  assert.match(editor.state.error!.message, /changed/);
  assert.equal(editor.state.saving, false);
});

test("superseded or destroyed editor requests cannot restore private content", async () => {
  let resolve!: (value: PostsFile) => void;
  let signal: AbortSignal | undefined;
  const editor = new PostsEditor({ getPostsFile: (month, requestSignal) => {
    signal = requestSignal;
    return new Promise(done => { resolve = done; });
  }, savePostsFile: async () => file() }, { month });
  const old = editor.load();
  assert.equal(editor.setMonth("2025-12"), true);
  assert.equal(signal!.aborted, true);
  resolve(file());
  assert.equal(await old, false);
  assert.equal(editor.state.file, null);
  const destroyed = editor.load();
  editor.destroy();
  resolve(file());
  assert.equal(await destroyed, false);
  assert.equal(editor.state.content, "");
  assert.equal(editor.state.file, null);
});

test("destroying during a save aborts the request and cannot restore saved private content", async () => {
  let resolve!: (value: PostsFile) => void;
  let signal: AbortSignal | undefined;
  const editor = new PostsEditor({ getPostsFile: async () => file(), savePostsFile: (month, content, etag, requestSignal) => {
    signal = requestSignal;
    return new Promise(done => { resolve = done; });
  } }, { month });
  await editor.load();
  editor.setContent("[]");
  const save = editor.save();
  assert.equal(editor.state.saving, true);
  assert.equal(editor.setMonth("2025-12"), false);
  editor.destroy();
  assert.equal(signal!.aborted, true);
  resolve(file("[]"));
  assert.equal(await save, false);
  assert.equal(editor.state.file, null);
  assert.equal(editor.state.content, "");
  assert.equal(editor.state.saved, false);
});

test("shared file validation reports post indexes and preserves validated data without altering input", () => {
  const draft = post();
  const content = JSON.stringify([draft]);
  assert.deepEqual(validatePostsJson(content, month, file()), [draft]);
  assert.throws(() => validatePostsJson(JSON.stringify([draft, { ...draft, text: "", media: [] }]), month), /Post 2:/);
  assert.throws(() => validatePostsJson(content, month, { ...file(), url: "https://cdn.example.com/wrong" }), /location/);
});
