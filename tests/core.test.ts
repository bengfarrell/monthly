import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaAuth, MediaApi, MediaLibrary, MediaUploader, MediaController, copyMediaUrl, MEDIA_TYPES, mediaType, validateFile, validateMonth, validateConnection, MAX_FILE_SIZE } from "../src/core/index.js";
import type { ListOptions, MediaPage, MediaFile } from "../src/core/index.js";
import type AwsS3 from "@uppy/aws-s3";
import type { AwsBody } from "@uppy/aws-s3";
import type { Meta } from "@uppy/core";

const configuration = { apiUrl: "https://api.example.com", bucket: "example-bucket" };
const item = { key: "media/2026/11/photo.png", size: 123, url: "https://media.example.com/media/2026/11/photo.png" };
const credentials = ["owner", "fixture-only-password"] as const;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

test("independent auth encodes Unicode, validates fields and retains no session after clearing", () => {
  const auth = new MediaAuth();
  assert.throws(() => auth.authorization, /Sign in/);
  auth.login("owner", "fixture:password");
  assert.equal(Buffer.from(auth.authorization.slice(6), "base64").toString(), "owner:fixture:password");
  const version = auth.version;
  auth.clear();
  assert.ok(auth.version > version);
  assert.throws(() => auth.authorization, /Sign in/);
  for (const args of [["", "password"], ["bad:username", "password"], ["owner", ""], ["owner", "line\nbreak"]] as const) {
    assert.throws(() => auth.login(args[0], args[1]));
  }
});

test("media types, boundaries, months and connection configuration are shared and validated", () => {
  for (const [type, extensions] of MEDIA_TYPES) {
    for (const extension of extensions) {
      const file = { name: `file.${extension.toUpperCase()}`, size: MAX_FILE_SIZE };
      assert.equal(mediaType(file.name), type);
      validateFile(file);
    }
  }
  for (const name of ["file.svg", "file.zip", ".mp3", "mp3"]) assert.throws(() => validateFile({ name, size: 1 }));
  for (const size of [0, -1, 1.5, MAX_FILE_SIZE + 1]) assert.throws(() => validateFile({ name: "file.png", size }));
  assert.equal(validateMonth("", true), "");
  assert.throws(() => validateMonth("2026-13"));
  assert.deepEqual(validateConnection(configuration.apiUrl, configuration.bucket), configuration);
  assert.throws(() => validateConnection("http://api.example.com", configuration.bucket));
  assert.throws(() => validateConnection("https://api.example.com/path", configuration.bucket));
});

test("API binds GET and POST to the configured bucket and omits cookies and referrers", async () => {
  const requests: { url: URL; options: RequestInit }[] = [];
  const auth = new MediaAuth();
  auth.login(...credentials);
  const api = new MediaApi({ ...configuration, auth, fetch: async (url, options) => {
    requests.push({ url: new URL(url instanceof Request ? url.url : url), options: options! });
    return Response.json({ bucket: configuration.bucket, items: [item], cursor: null });
  } });
  await api.list({ month: "2026-11", cursor: "next" });
  assert.equal(requests[0].url.searchParams.get("bucket"), configuration.bucket);
  assert.equal(requests[0].url.searchParams.get("cursor"), "next");
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(requests[0].options.referrerPolicy, "no-referrer");
  assert.match(new Headers(requests[0].options.headers).get("Authorization")!, /^Basic /);
  await api.request("/uploads", { bucket: "attacker" });
  assert.equal(JSON.parse(String(requests[1].options.body)).bucket, configuration.bucket);
});

test("API rejects mismatched buckets, unsafe URLs, malformed data and stale sessions", async () => {
  const auth = new MediaAuth();
  auth.login(...credentials);
  const api = new MediaApi({ ...configuration, auth, fetch: async () => Response.json({ bucket: "other", items: [], cursor: null }) });
  await assert.rejects(api.list(), /different bucket/);
  api.fetch = async () => Response.json({ bucket: configuration.bucket, items: [{ ...item, url: "javascript:alert(1)" }], cursor: null });
  await assert.rejects(api.list(), /HTTPS/);
  api.fetch = async () => new Response("<html>", { status: 500 });
  await assert.rejects(api.list(), /Invalid JSON/);
  const pending = deferred<Response>();
  api.fetch = () => pending.promise;
  const request = api.list();
  auth.clear();
  pending.resolve(Response.json({ bucket: configuration.bucket, items: [], cursor: null }));
  await assert.rejects(request, /Sign-in changed/);
});

test("library API preserves video posters and rejects unsafe or mismatched companions", async () => {
  const auth = new MediaAuth();
  auth.login(...credentials);
  const video = { ...item, key: "media/2026/11/video.mp4", poster: {
    key: "media/2026/11/video.mp4.poster.jpg", url: "https://media.example.com/media/2026/11/video.mp4.poster.jpg", size: 45,
  } };
  const api = new MediaApi({ ...configuration, auth, fetch: async () => Response.json({ bucket: configuration.bucket, items: [video], cursor: null }) });
  assert.deepEqual((await api.list()).items[0], video);
  for (const poster of [{ ...video.poster, url: "http://insecure.example/poster.jpg" }, { ...video.poster, key: "other.mp4.poster.jpg" }]) {
    api.fetch = async () => Response.json({ bucket: configuration.bucket, items: [{ ...video, poster }], cursor: null });
    await assert.rejects(api.list());
  }
});

test("library refresh cancels obsolete months, resets pagination and exposes real failures", async () => {
  const calls: (ListOptions & ReturnType<typeof deferred<MediaPage>>)[] = [];
  const api = { list: (options: ListOptions = {}) => {
    const result = deferred<MediaPage>();
    calls.push({ ...options, ...result });
    return result.promise;
  } };
  const library = new MediaLibrary(api);
  const old = library.load("2026-01");
  const latest = library.load("2026-02");
  assert.equal(calls[0].signal!.aborted, true);
  calls[1].resolve({ items: [item], cursor: "next" });
  await latest;
  calls[0].resolve({ items: [{ ...item, key: "old" }], cursor: null });
  await old;
  assert.equal(library.state.month, "2026-02");
  assert.deepEqual(library.state.items, [item]);
  const more = library.more();
  assert.equal(calls[2].cursor, "next");
  calls[2].resolve({ items: [], cursor: null });
  await more;
  const all = library.load("");
  assert.equal(calls[3].cursor, null);
  calls[3].resolve({ items: [], cursor: null });
  await all;
  assert.equal(library.state.month, "");
  api.list = async () => { throw new Error("S3 unavailable"); };
  assert.equal(await library.refresh(), false);
  assert.match(library.state.error!.message, /S3 unavailable/);
  library.reset();
  assert.equal(library.state.items.length, 0);
});

test("library reset prevents an in-flight response from restoring private assets", async () => {
  const pending = deferred<MediaPage>();
  const library = new MediaLibrary({ list: () => pending.promise });
  const load = library.refresh();
  library.reset();
  pending.resolve({ items: [item], cursor: null });
  await load;
  assert.deepEqual(library.state.items, []);
  assert.equal(library.state.loaded, false);
});

test("controller composes independent models, gates tabs and clears auth on sign out", async () => {
  let destroyed = false;
  const uploader = new MediaUploader(new MediaApi(configuration));
  const destroy = uploader.destroy.bind(uploader);
  uploader.destroy = () => { destroyed = true; destroy(); };
  const controller = new MediaController({
    ...configuration, uploaderFactory: () => uploader,
    fetch: async () => Response.json({ bucket: configuration.bucket, items: [item], cursor: null }),
  });
  assert.equal(await controller.signIn(...credentials), true);
  assert.equal(await controller.signIn("another-user", "another-password"), false);
  assert.match(controller.state.error!.message, /Sign out before/);
  assert.equal(controller.uploader, uploader);
  assert.equal(controller.state.authenticated, true);
  controller.selectTab("upload");
  assert.equal(controller.state.tab, "upload");
  controller.postsEditor!.setState({ dirty: true });
  assert.equal(controller.state.postsDirty, true);
  assert.equal(controller.signOut(), false);
  assert.match(controller.state.error!.message, /Save or discard/);
  controller.postsEditor!.setState({ dirty: false, saving: true });
  assert.equal(controller.state.uploading, true);
  assert.equal(controller.signOut(), false);
  controller.postsEditor!.setState({ saving: false });
  uploader.setState({ uploading: true });
  assert.equal(controller.signOut(), false);
  assert.match(controller.state.error!.message, /Finish or cancel/);
  uploader.setState({ uploading: false });
  assert.equal(controller.signOut(), true);
  assert.equal(destroyed, true);
  assert.equal(controller.state.authenticated, false);
  assert.equal(controller.postsEditor, null);
  assert.throws(() => controller.auth.authorization, /Sign in/);
});

test("unauthorized login remains locked and does not initialize an uploader", async () => {
  const controller = new MediaController({
    ...configuration, uploaderFactory: () => { throw new Error("Should not initialize"); },
    fetch: async () => Response.json({ error: "Invalid username or password." }, { status: 401 }),
  });
  assert.equal(await controller.signIn(...credentials), false);
  assert.equal(controller.state.authenticated, false);
  assert.equal(controller.state.signingIn, false);
  assert.match(controller.state.error!.message, /Invalid username/);
});

test("headless upload signing replaces proposal keys only once and reuses its multipart grant", async t => {
  const calls: { value: MediaFile; month: string }[] = [];
  const api: Pick<MediaApi, "prepare" | "sign"> = {
    prepare: async (value, month) => { calls.push({ value, month }); return {
      key: "media/2026/11/video.mp4", ticket: "ticket", url: item.url, partSize: 10 * 1024 ** 2,
    }; },
    sign: async (request, grant) => ({ ...request, key: grant.key, url: grant.url }),
  };
  const uploader = new MediaUploader(api, { month: "2026-11", videoFactory: async () => ({
    url: "blob:fixture", duration: 2, capture: async () => ({ blob: new Blob(["poster"], { type: "image/jpeg" }), width: 1280, height: 720 }), destroy() {},
  }) });
  t.after(() => uploader.destroy());
  const id = uploader.uppy.addFile({ name: "video.mp4", type: "video/mp4", data: new Blob([new Uint8Array(123)]) });
  await uploader.ready();
  const plugin = uploader.uppy.getPlugin<AwsS3<Meta, AwsBody>>("AwsS3");
  assert.ok(plugin);
  assert.ok("signRequest" in plugin.opts);
  const proposal = plugin.opts.generateObjectKey!(uploader.uppy.getFile(id)!);
  const first = await plugin.opts.signRequest({ key: proposal, method: "POST" });
  assert.equal(first.key, "media/2026/11/video.mp4");
  const second = await uploader.signRequest({ key: first.key!, method: "PUT", uploadId: "upload", partNumber: 1 });
  assert.equal(second.key, first.key);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].month, "2026-11");
  await assert.rejects(uploader.signRequest({ method: "PUT", key: "missing", uploadId: "upload" }), /authorization is missing/);
  assert.equal(uploader.setMonth("invalid"), false);
  assert.match(uploader.state.error!.message, /YYYY-MM/);
});

test("clipboard logic is reusable independently and exposes denied access explicitly", async () => {
  let copied;
  await copyMediaUrl(item.url, { writeText: async url => { copied = url; } });
  assert.equal(copied, item.url);
  await assert.rejects(copyMediaUrl(item.url, { writeText: async () => { throw new Error("denied"); } }), /Clipboard access failed/);
});
