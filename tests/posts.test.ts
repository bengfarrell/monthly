import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHandler, type MediaEvent, type MediaS3Client } from "../lambda/handler.js";
import { MockS3 } from "../dev/mock-s3.js";
import { LOCAL_BUCKET, LOCAL_PREFIX } from "../dev/fixtures.js";
import { MediaApi, MediaAuth, MediaUploader, PostComposer, PostFeed, feedMonths, postTags, postUrl, readPosts, thumbnailKey, thumbnailInputs } from "../src/core/index.js";
import type { Post, PostInput } from "../src/core/index.js";

const now = () => new Date("2026-01-15T12:00:00.000Z");
const month = "2026-01";
const key = `${LOCAL_PREFIX}2026/01/posts.json`;
const asset = { key: `${LOCAL_PREFIX}2026/01/photo.png`, size: 12, url: `https://cdn.example.com/${LOCAL_PREFIX}2026/01/photo.png` };
const input = (): PostInput => ({ id: randomUUID(), text: "An update #Hello", tags: ["hello", "photo"], media: [asset] });
const saved = (draft: PostInput, created = now().toISOString()): Post => ({
  ...draft, media: draft.media.map(({ poster, thumbnails, ...item }) => ({ ...item, url: asset.url,
    ...(poster && { poster: { ...poster, url: `https://cdn.example.com/${poster.key}` } }),
    ...(thumbnails !== undefined && { thumbnails: Object.fromEntries(Object.entries(thumbnails).map(([dimensions, file]) =>
      [dimensions, { ...file, url: `https://cdn.example.com/${file.key}` }])) }) })), created,
});
const post = (date = now().toISOString()): Post => saved(input(), date);
const config = {
  username: "owner", password: "fixture-only-password",
  buckets: { [LOCAL_BUCKET]: { prefix: LOCAL_PREFIX, region: "us-east-1", publicBaseUrl: "https://cdn.example.com" } },
};
function event(body: object): MediaEvent {
  return {
    routeKey: "POST /posts", body: JSON.stringify({ bucket: LOCAL_BUCKET, month, ...body }),
    headers: { authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}` },
  };
}
function setup(client?: MediaS3Client) {
  const s3 = new MockS3([]);
  const errors: unknown[] = [];
  const writes: PutObjectCommand[] = [];
  const handle = createHandler({
    config, now, logger: { error: (...args) => errors.push(args) },
    clientForRegion: () => client ?? { send: async command => {
      if (command instanceof PutObjectCommand) writes.push(command);
      return s3.send(command);
    } },
  });
  return { s3, handle, errors, writes };
}

test("hashtags merge with explicit tags, normalize Unicode, and deduplicate without changing the message", () => {
  const text = "#Hello #hello (#Café) #Cafe\u0301 #日本語 #my_tag foo#notatag\n#2026";
  assert.deepEqual(postTags(text, ["#HELLO", " Personal ", "Cafe\u0301", ""]), ["hello", "personal", "café", "日本語", "my_tag", "2026"]);
  assert.equal(text.includes("#Hello"), true);
});

test("feed window is exactly three UTC calendar months, including year boundaries", () => {
  assert.deepEqual(feedMonths(now()), ["2026-01", "2025-12", "2025-11"]);
  assert.deepEqual(feedMonths(new Date("2026-03-31T23:59:59Z")), ["2026-03", "2026-02", "2026-01"]);
});

test("post links use the consumer's route and configurable ID prefix without mutating the base URL", () => {
  const item = post();
  const base = new URL("https://example.com/memos/?other=keep#old");
  assert.equal(postUrl(item, base, "note-").href, `https://example.com/memos/?other=keep&month=2026-01#note-${item.id}`);
  assert.equal(base.href, "https://example.com/memos/?other=keep#old");
  assert.equal(postUrl(item, "https://example.com/updates/").hash, `#post-${item.id}`);
});

test("historical post loading fetches one validated month independently without changing grid state", async () => {
  const old = post("2025-03-01T00:00:00.000Z");
  const requests: string[] = [];
  const feed = new PostFeed({ baseUrl: "https://cdn.example.com/media/", now, fetch: async (url, options) => {
    requests.push(String(url));
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.headers, undefined);
    return Response.json([old]);
  } });
  const before = feed.state;
  assert.deepEqual(await feed.loadPost(old.id, "2025-03"), old);
  assert.deepEqual(requests, ["https://cdn.example.com/media/2025/03/posts.json"]);
  assert.equal(feed.state, before);
  await assert.rejects(feed.loadPost(old.id, "2025-13"), /Month/);
  assert.equal(requests.length, 1);
});

test("loaded recent posts are reused; missing historical posts and failures are explicit", async t => {
  const warnings = t.mock.method(console, "warn", () => {});
  const item = post();
  let response = Response.json([item]);
  let requests = 0;
  const feed = new PostFeed({ baseUrl: "https://cdn.example.com/media/", now, fetch: async () => {
    requests++;
    return response.clone();
  } });
  feed.setState({ posts: [item], loaded: true });
  assert.equal(await feed.loadPost(item.id, month), item);
  assert.equal(await feed.loadPost(randomUUID(), month), undefined);
  assert.equal(requests, 0);
  response = new Response("", { status: 404 });
  assert.equal(await feed.loadPost(randomUUID(), "2025-03"), undefined);
  assert.equal(warnings.mock.callCount(), 1);
  response = new Response("", { status: 503 });
  await assert.rejects(feed.loadPost(randomUUID(), "2025-03"), /503/);
  response = Response.json([{ ...item, created: "bad" }]);
  await assert.rejects(feed.loadPost(item.id, "2025-03"), /timestamp/);
  assert.deepEqual(feed.state.posts, [item]);
});

test("historical requests honor caller cancellation and destroy without affecting grid refreshes", async () => {
  const pending: ((response: Response) => void)[] = [];
  const feed = new PostFeed({ baseUrl: "https://cdn.example.com/media/", now,
    fetch: () => new Promise<Response>(resolve => pending.push(resolve)) });
  const cancel = new AbortController();
  const old = feed.loadPost(randomUUID(), "2025-03", cancel.signal);
  const canceled = assert.rejects(old, { name: "AbortError" });
  cancel.abort();
  pending[0](Response.json([]));
  await canceled;
  const detached = feed.loadPost(randomUUID(), "2025-04");
  const destroyed = assert.rejects(detached, { name: "AbortError" });
  const loading = feed.load();
  pending.slice(2).forEach(resolve => resolve(Response.json([])));
  await loading;
  feed.destroy();
  pending[1](Response.json([]));
  await destroyed;
  assert.equal(feed.state.loaded, true);
});

test("posting creates then appends to the same month JSON with canonical media URLs and conditional writes", async () => {
  const { handle, s3, writes } = setup();
  const first = input();
  const response = await handle(event({ ...first, media: [{ ...asset, url: "https://untrusted.example/file" }] }));
  assert.equal(response.statusCode, 201);
  const saved = JSON.parse(response.body);
  assert.equal(saved.post.created, now().toISOString());
  assert.equal(saved.post.media[0].url, asset.url);
  assert.equal(saved.url, `https://cdn.example.com/${key}`);
  const second = { ...input(), text: "Text only", tags: [], media: [] };
  assert.equal((await handle(event(second))).statusCode, 201);
  const posts = readPosts(JSON.parse(s3.documents.get(key)!.body), month);
  assert.deepEqual(posts.map(post => post.text), [first.text, second.text]);
  assert.equal(s3.documents.size, 1);
  assert.equal(writes[0].input.IfNoneMatch, "*");
  assert.ok(writes[1].input.IfMatch);
  assert.equal(writes[0].input.ContentType, "application/json");
  assert.equal(writes[0].input.CacheControl, "no-cache");
});

test("post JSON preserves video posters, canonicalizes their URLs and keeps retries idempotent", async () => {
  const { handle, s3 } = setup();
  const video = { key: `${LOCAL_PREFIX}2026/01/clip.mp4`, size: 123 };
  const draft = { ...input(), media: [{ ...video,
    poster: { key: `${video.key}.poster.jpg`, size: 45, time: 0.75, url: "https://untrusted.example/poster.jpg" },
  }] };
  const response = await handle(event(draft));
  assert.equal(response.statusCode, 201);
  const saved = JSON.parse(response.body).post;
  assert.equal(saved.media.length, 1);
  assert.deepEqual(saved.media[0].poster, {
    key: `${video.key}.poster.jpg`, size: 45, time: 0.75, url: `https://cdn.example.com/${video.key}.poster.jpg`,
  });
  assert.deepEqual(readPosts(JSON.parse(s3.documents.get(key)!.body), month), [saved]);
  assert.equal((await handle(event(draft))).statusCode, 200);
  for (const override of [
    { key: `${LOCAL_PREFIX}2025/12/clip.mp4.poster.jpg` }, { key: `${LOCAL_PREFIX}2026/01/other.mp4.poster.jpg` },
    { size: 0 }, { time: -1 }, { time: "1" },
  ]) {
    assert.equal((await handle(event({ ...input(), media: [{ ...video, poster: { ...draft.media[0].poster, ...override } }] }))).statusCode, 400);
  }
  assert.throws(() => readPosts([{ ...saved, media: [{ ...saved.media[0], poster: { ...saved.media[0].poster, url: "javascript:bad" } }] }], month), /HTTPS/);
});

test("post JSON and the API preserve ordered image thumbnail maps and idempotent retries", async () => {
  const { handle, s3 } = setup();
  const thumbnails = Object.fromEntries(["600x300", "960x480"].map(dimensions => [dimensions, {
    key: thumbnailKey(asset.key, dimensions), size: 45, url: "https://untrusted.example/thumbnail.jpg",
  }]));
  const draft = { ...input(), media: [{ ...asset, thumbnails }] };
  const response = await handle(event(draft));
  assert.equal(response.statusCode, 201);
  const saved = JSON.parse(response.body).post;
  assert.deepEqual(Object.keys(saved.media[0].thumbnails), ["600x300", "960x480"]);
  assert.equal(saved.media[0].thumbnails["600x300"].url, `https://cdn.example.com/${thumbnailKey(asset.key, "600x300")}`);
  assert.deepEqual(readPosts(JSON.parse(s3.documents.get(key)!.body), month), [saved]);
  assert.equal((await handle(event(draft))).statusCode, 200);
  const auth = new MediaAuth();
  auth.login("owner", "fixture-password");
  const api = new MediaApi({ apiUrl: "https://api.example.com", bucket: LOCAL_BUCKET, auth, fetch: async (url, options) => {
    assert.deepEqual(JSON.parse(String(options?.body)).media, [{ key: asset.key, size: asset.size, thumbnails: thumbnailInputs(thumbnails) }]);
    return Response.json({ bucket: LOCAL_BUCKET, post: saved });
  } });
  assert.deepEqual((await api.post(draft, month)).media[0].thumbnails, saved.media[0].thumbnails);
});

test("post writes require auth and validate month, text, tags and current-month media", async () => {
  const { handle, s3 } = setup();
  assert.equal((await handle({ ...event(input()), headers: {} })).statusCode, 401);
  for (const override of [
    { month: "2025-12" }, { text: "", media: [] }, { text: "x".repeat(4001) }, { tags: "not-an-array" },
    { tags: ["x".repeat(65)] }, { tags: Array(33).fill("tag") }, { id: "../bad" },
    { media: [{ ...asset, key: `${LOCAL_PREFIX}2025/12/photo.png` }] },
    { media: [{ ...asset, key: `${LOCAL_PREFIX}2026/01/../photo.png` }] },
    { media: [{ ...asset, key: `${LOCAL_PREFIX}2026/01/file.json` }] },
    { media: [{ ...asset, size: 0 }] },
  ]) {
    assert.equal((await handle(event({ ...input(), ...override }))).statusCode, 400, JSON.stringify(override));
  }
  assert.equal(s3.documents.size, 0);
  const unicodePost = { ...input(), text: "日".repeat(4000) };
  assert.equal((await handle(event(unicodePost))).statusCode, 201);
});

test("retries are idempotent and an existing ID cannot be reused for a different post", async () => {
  const { handle, s3 } = setup();
  const draft = input();
  assert.equal((await handle(event(draft))).statusCode, 201);
  assert.equal((await handle(event(draft))).statusCode, 200);
  assert.equal(JSON.parse(s3.documents.get(key)!.body).length, 1);
  assert.equal((await handle(event({ ...draft, text: "Changed" }))).statusCode, 409);
});

test("simultaneous first posts and subsequent appends preserve every post", async () => {
  const { handle, s3 } = setup();
  for (let batch = 0; batch < 2; batch++) {
    const responses = await Promise.all(Array.from({ length: 3 }, () => handle(event(input()))));
    assert.deepEqual(responses.map(response => response.statusCode), [201, 201, 201]);
  }
  const posts = JSON.parse(s3.documents.get(key)!.body);
  assert.equal(posts.length, 6);
  assert.equal(new Set(posts.map((post: Post) => post.id)).size, 6);
});

test("corrupt JSON, missing ETags and storage failures are explicit and never overwrite data", async () => {
  const { handle, s3, errors, writes } = setup();
  for (const body of ["not json", "{}", JSON.stringify([{ ...post(), created: "2025-12-01T00:00:00.000Z" }])]) {
    s3.documents.set(key, { body, etag: '"original"' });
    assert.equal((await handle(event(input()))).statusCode, 500);
    assert.equal(s3.documents.get(key)!.body, body);
  }
  assert.equal(writes.length, 0);
  assert.equal(errors.length, 3);
  for (const client of [
    { send: async () => { throw Object.assign(new Error("denied"), { name: "AccessDenied" }); } },
    { send: async () => ({ Body: { transformToString: async () => "[]" } }) },
  ]) {
    assert.equal((await setup(client).handle(event(input()))).statusCode, 500);
  }
});

test("persistent conditional conflicts return a retryable error instead of unconditional overwrite", async () => {
  let writes = 0;
  const { handle } = setup({ send: async command => {
    if (command instanceof GetObjectCommand) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    writes++;
    throw Object.assign(new Error("conflict"), { name: "PreconditionFailed" });
  } });
  assert.equal((await handle(event(input()))).statusCode, 409);
  assert.equal(writes, 5);
});

test("feed fetches public JSON without auth and warns for missing months without expanding the window", async t => {
  const warnings = t.mock.method(console, "warn", () => {});
  const requests: string[] = [];
  const recent = post();
  const old = post("2025-11-20T00:00:00.000Z");
  const feed = new PostFeed({ baseUrl: `https://cdn.example.com/${LOCAL_PREFIX}`, now, fetch: async (url, options) => {
    requests.push(String(url));
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.headers, undefined);
    assert.equal(options?.cache, "no-cache");
    return String(url).includes("/2026/01/") ? Response.json([recent]) :
      String(url).includes("/2025/11/") ? Response.json([old]) : new Response("", { status: 404 });
  } });
  await feed.load();
  assert.deepEqual(requests.map(url => new URL(url).pathname), feedMonths(now()).map(month => `/${LOCAL_PREFIX}${month.replace("-", "/")}/posts.json`));
  assert.deepEqual(feed.state.posts, [recent, old]);
  assert.deepEqual(feed.state.errors, []);
  assert.equal(warnings.mock.callCount(), 1);
  assert.match(warnings.mock.calls[0].arguments.join(" "), /2025-12.*404/);
});

test("feed keeps available posts and logs warnings while retaining non-404 errors for diagnostics", async t => {
  const warnings = t.mock.method(console, "warn", () => {});
  const feed = new PostFeed({ baseUrl: "https://cdn.example.com/media", now, fetch: async url =>
    String(url).includes("/2026/01/") ? Response.json([post()]) :
      String(url).includes("/2025/12/") ? new Response("", { status: 403 }) : Response.json({ invalid: true }),
  });
  await feed.load();
  assert.equal(feed.state.posts.length, 1);
  assert.equal(feed.state.errors.length, 2);
  assert.match(feed.state.errors[0].message, /403/);
  assert.equal(feed.state.loaded, true);
  assert.equal(feed.state.loading, false);
  assert.equal(warnings.mock.callCount(), 2);
  assert.match(warnings.mock.calls[0].arguments.join(" "), /403/);
});

test("superseded and destroyed feed requests cannot replace newer state or log stale warnings", async t => {
  const warnings = t.mock.method(console, "warn", () => {});
  const pending: ((response: Response) => void)[] = [];
  const feed = new PostFeed({ baseUrl: "https://cdn.example.com/media", now, fetch: () =>
    new Promise<Response>(resolve => pending.push(resolve)),
  });
  const old = feed.load();
  const latest = feed.load();
  pending.slice(3).forEach(resolve => resolve(Response.json([])));
  await latest;
  pending.slice(0, 3).forEach(resolve => resolve(new Response("", { status: 404 })));
  await old;
  assert.deepEqual(feed.state.posts, []);
  const destroyed = feed.load();
  feed.destroy();
  pending.slice(6).forEach(resolve => resolve(new Response("", { status: 403 })));
  await destroyed;
  assert.deepEqual(feed.state.posts, []);
  assert.equal(warnings.mock.callCount(), 0);
});

test("API sends tags separately, strips client media URLs and validates the saved post", async () => {
  const auth = new MediaAuth();
  auth.login("owner", "fixture-password");
  const draft = input();
  const api = new MediaApi({
    apiUrl: "https://api.example.com", bucket: LOCAL_BUCKET, auth,
    fetch: async (url, options) => {
      assert.equal(new URL(String(url)).pathname, "/posts");
      const body = JSON.parse(String(options?.body));
      assert.deepEqual(body.tags, draft.tags);
      assert.deepEqual(body.media, [{ key: asset.key, size: asset.size }]);
      assert.equal(body.month, month);
      return Response.json({ bucket: LOCAL_BUCKET, post: { ...draft, created: now().toISOString() } });
    },
  });
  assert.equal((await api.post(draft, month)).id, draft.id);
});

test("API sends video poster metadata without trusting client poster URLs", async () => {
  const auth = new MediaAuth();
  auth.login("owner", "fixture-password");
  const video = { key: `${LOCAL_PREFIX}2026/01/clip.mp4`, size: 123, url: "https://cdn.example.com/clip.mp4" };
  const poster = { key: `${video.key}.poster.jpg`, size: 45, time: 0.5, url: "https://cdn.example.com/poster.jpg" };
  const draft = { ...input(), media: [{ ...video, poster }] };
  const api = new MediaApi({ apiUrl: "https://api.example.com", bucket: LOCAL_BUCKET, auth, fetch: async (url, options) => {
    assert.deepEqual(JSON.parse(String(options?.body)).media, [{ key: video.key, size: video.size,
      poster: { key: poster.key, size: poster.size, time: poster.time } }]);
    return Response.json({ bucket: LOCAL_BUCKET, post: { ...draft, created: now().toISOString() } });
  } });
  assert.deepEqual((await api.post(draft, month)).media[0].poster, poster);
});

test("composer parses tags, uploads once, and retries the identical post after a failed save", async t => {
  const drafts: PostInput[] = [];
  let uploads = 0;
  const api = {
    prepare: async () => { throw new Error("not used"); },
    sign: async () => { throw new Error("not used"); },
    post: async (draft: PostInput, requestedMonth: string) => {
      assert.equal(requestedMonth, month);
      drafts.push(draft);
      if (drafts.length === 1) throw new Error("Network failed after save");
      return saved(draft);
    },
  };
  const uploader = new MediaUploader(api, { month });
  uploader.setState({ files: [{ id: "file", name: "photo.png", size: 12, complete: false, error: null, progress: 0 }] });
  uploader.upload = async () => {
    uploads++;
    uploader.setState({ files: uploader.state.files.map(file => ({ ...file, complete: true })) });
    return undefined;
  };
  uploader.completedMedia = () => [asset];
  const composer = new PostComposer(api, uploader, now);
  t.after(() => composer.destroy());
  composer.setText("Hello #Photo #HELLO");
  composer.setTags("personal, photo");
  assert.equal(await composer.publish(), false);
  assert.equal(composer.state.pending, true);
  assert.match(composer.state.error!.message, /Network/);
  composer.setText("Cannot change an uncertain post");
  assert.equal(await composer.publish(), true);
  assert.equal(uploads, 1);
  assert.deepEqual(drafts[0].tags, ["personal", "photo", "hello"]);
  assert.deepEqual(drafts[0], drafts[1]);
  assert.equal(composer.state.text, "");
  assert.equal(composer.state.pending, false);
  assert.equal(composer.state.posted!.text, "Hello #Photo #HELLO");
});

test("composer rejects invalid drafts before uploading and supports text-only posts in the current month", async t => {
  let saves = 0;
  const api = {
    prepare: async () => { throw new Error("not used"); },
    sign: async () => { throw new Error("not used"); },
    post: async (draft: PostInput, requestedMonth: string) => {
      saves++;
      assert.equal(requestedMonth, month);
      return saved(draft);
    },
  };
  const composer = new PostComposer(api, new MediaUploader(api, { month: "2025-12" }), now);
  t.after(() => composer.destroy());
  assert.equal(await composer.publish(), false);
  assert.equal(saves, 0);
  composer.setText("Text-only update");
  assert.equal(await composer.publish(), true);
  assert.equal(saves, 1);
});

test("composer never associates already uploaded previous-month media with the new month", async t => {
  const api = {
    prepare: async () => { throw new Error("not used"); },
    sign: async () => { throw new Error("not used"); },
    post: async (): Promise<Post> => { throw new Error("must not save"); },
  };
  const uploader = new MediaUploader(api, { month: "2025-12" });
  uploader.setState({ files: [{ id: "old", name: "photo.png", size: 12, progress: 100, complete: true, error: null }] });
  const composer = new PostComposer(api, uploader, now);
  t.after(() => composer.destroy());
  composer.setText("An update");
  assert.equal(await composer.publish(), false);
  assert.match(composer.state.error!.message, /month changed/);
});

test("cancelled media uploads never publish an unintended text-only update", async t => {
  let saves = 0;
  const api = {
    prepare: async () => { throw new Error("not used"); },
    sign: async () => { throw new Error("not used"); },
    post: async (): Promise<Post> => { saves++; return post(); },
  };
  const uploader = new MediaUploader(api, { month });
  uploader.setState({ files: [{ id: "cancelled", name: "photo.png", size: 12, progress: 0, complete: false, error: null }] });
  uploader.upload = async () => { uploader.setState({ files: [] }); return undefined; };
  const composer = new PostComposer(api, uploader, now);
  t.after(() => composer.destroy());
  composer.setText("Keep my draft after cancellation");
  assert.equal(await composer.publish(), false);
  assert.equal(saves, 0);
  assert.equal(composer.state.text, "Keep my draft after cancellation");
  assert.equal(composer.state.pending, false);
  assert.ok(composer.state.error);
});
