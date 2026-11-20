import assert from "node:assert/strict";
import { test } from "node:test";
import type AwsS3 from "@uppy/aws-s3";
import type { AwsBody } from "@uppy/aws-s3";
import type { Meta } from "@uppy/core";
import { MediaApi, MediaAuth, MediaUploader, IMAGE_THUMBNAIL_THRESHOLD, MAX_THUMBNAIL_SIZE, firstThumbnail,
  openImage, readThumbnails, thumbnailInputs, thumbnailKey, uploadFilename, validateFile, validateThumbnails } from "../src/core/index.js";
import type { ImageSource, MediaFile, MediaItem, Thumbnails } from "../src/core/index.js";

const month = "2026-11";
const key = "media/2026/11/photo.png";
function thumbnails(mediaKey = key): Thumbnails {
  return Object.fromEntries(["600x300", "960x480"].map(dimensions => [dimensions, {
    key: thumbnailKey(mediaKey, dimensions), url: `https://cdn.example.com/${thumbnailKey(mediaKey, dimensions)}`, size: 45,
  }]));
}
function setup(options: {
  imageFactory?: (file: Blob, signal: AbortSignal) => Promise<ImageSource>;
  save?: (item: Pick<MediaItem, "key" | "thumbnails">, signal?: AbortSignal) => Promise<Thumbnails>;
} = {}) {
  const preparations: MediaFile[] = [];
  const saves: Pick<MediaItem, "key" | "thumbnails">[] = [];
  const sizes: number[] = [];
  const uploader = new MediaUploader({
    prepare: async file => {
      preparations.push(file);
      const original = `media/2026/11/${uploadFilename(file.thumbnailFor ?? file.name)}`;
      const key = file.thumbnailFor ? thumbnailKey(original, file.dimensions!) : original;
      return { key, url: `https://cdn.example.com/${key}`, ticket: "fixture", partSize: 10 * 1024 ** 2 };
    },
    sign: async (request, grant) => ({ key: grant.key, url: grant.url }),
    setThumbnails: async (item, requestedMonth, signal) => {
      assert.equal(requestedMonth, month);
      saves.push(item);
      return options.save ? options.save(item, signal) : item.thumbnails ?? {};
    },
  }, { month, imageFactory: options.imageFactory ?? (async () => ({
    width: 3840, height: 1920,
    capture: async maxDimension => {
      sizes.push(maxDimension);
      return { blob: new Blob(["jpeg"], { type: "image/jpeg" }), width: maxDimension, height: maxDimension / 2 };
    },
    destroy() {},
  })) });
  const add = (size = IMAGE_THUMBNAIL_THRESHOLD + 1, name = "photo.png") =>
    uploader.uppy.addFile({ name, type: "image/png", data: new Blob([new Uint8Array(size)]) });
  const finish = async () => {
    const plugin = uploader.uppy.getPlugin<AwsS3<Meta, AwsBody>>("AwsS3")!;
    for (const file of uploader.uppy.getFiles()) {
      const proposal = plugin.opts.generateObjectKey!(file);
      const signed = await uploader.signRequest({ key: proposal, method: "PUT" });
      uploader.uppy.setFileState(file.id, { progress: { ...file.progress, uploadStarted: Date.now(), uploadComplete: true,
        percentage: 100, bytesUploaded: file.size!, bytesTotal: file.size! } });
      uploader.uppy.emit("upload-success", uploader.uppy.getFile(file.id), { status: 200, body: { key: signed.key, location: signed.url } });
    }
  };
  return { uploader, add, finish, preparations, saves, sizes };
}

test("dimension maps preserve multiple files and order, while legacy posters remain readable", () => {
  const files = thumbnails();
  assert.deepEqual(readThumbnails(files, key), files);
  assert.deepEqual(Object.keys(readThumbnails(files, key)), ["600x300", "960x480"]);
  assert.deepEqual(firstThumbnail({ thumbnails: files }), files["600x300"]);
  assert.deepEqual(firstThumbnail({ poster: files["960x480"] }), files["960x480"]);
  assert.deepEqual(thumbnailInputs(files), {
    "600x300": { key: files["600x300"].key, size: 45 },
    "960x480": { key: files["960x480"].key, size: 45 },
  });
  for (const dimensions of ["0x300", "0600x300", "600X300", "600", "8193x300"]) {
    assert.throws(() => validateThumbnails({ [dimensions]: { ...files["600x300"], key: thumbnailKey(key, dimensions) } }, key));
  }
  for (const fields of [{ key: thumbnailKey("other.png", "600x300") }, { size: 0 }, { size: MAX_THUMBNAIL_SIZE + 1 }, { time: 1 }]) {
    assert.throws(() => validateThumbnails({ "600x300": { ...files["600x300"], ...fields } }, key));
  }
  const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`${i + 1}x1`, {
    key: thumbnailKey(key, `${i + 1}x1`), size: 1,
  }]));
  assert.throws(() => validateThumbnails(tooMany, key), /at most 20/);
  assert.throws(() => validateThumbnails({}, "audio.mp3"));
  assert.throws(() => readThumbnails({ "600x300": { ...files["600x300"], url: "http://unsafe.example/image.jpg" } }, key), /HTTPS/);
  assert.throws(() => validateFile({ name: "photo.png.thumb-600x300.jpg", size: 1 }), /reserved/);
  validateFile({ name: "thumbnail.jpg", size: MAX_THUMBNAIL_SIZE, thumbnailFor: "photo.png", dimensions: "600x300" });
});

test("only images strictly over 1 MiB default to a 960-pixel thumbnail; originals stay unchanged", async t => {
  const { uploader, add, sizes } = setup();
  t.after(() => uploader.destroy());
  add(IMAGE_THUMBNAIL_THRESHOLD - 1, "below.png");
  add(IMAGE_THUMBNAIL_THRESHOLD, "boundary.png");
  const id = add();
  const original = uploader.uppy.getFile(id)!.data;
  await uploader.ready();
  assert.deepEqual(uploader.state.files.map(file => file.image!.enabled), [false, false, true]);
  assert.deepEqual(sizes, [960]);
  assert.equal(uploader.state.files[2].image!.dimensions, "960x480");
  assert.equal(uploader.uppy.getFiles().length, 4);
  assert.equal(uploader.uppy.getFile(id)!.data, original);
  assert.equal(await uploader.configureImageThumbnail(id, true, 640), true);
  assert.equal(uploader.state.files[2].image!.dimensions, "640x320");
  assert.equal(uploader.uppy.getFiles().length, 4);
  assert.deepEqual(sizes, [960, 640]);
  assert.equal(await uploader.configureImageThumbnail(id, false, 640), true);
  assert.equal(uploader.uppy.getFiles().length, 3);
  assert.equal(uploader.state.files[2].image!.enabled, false);
  assert.equal(await uploader.configureImageThumbnail(id, true, 100), false);
  assert.match(uploader.state.error!.message, /320 and 2048/);
});

test("thumbnail decoding failure blocks selected images, but explicit opt-out permits originals", async t => {
  const { uploader, add, preparations } = setup({ imageFactory: async () => { throw new Error("Cannot decode this image"); } });
  t.after(() => uploader.destroy());
  const id = add();
  await assert.rejects(uploader.ready(), /Cannot decode/);
  await uploader.upload();
  assert.deepEqual(preparations, []);
  assert.equal(await uploader.configureImageThumbnail(id, false), true);
  await uploader.ready();
  assert.equal(uploader.state.files[0].error, null);
  await assert.rejects(openImage(new Blob(["not an image"])), /require a browser/);
});

test("opting out during decoding cannot restore a thumbnail or a stale error", async t => {
  let resolve!: (source: ImageSource) => void;
  let destroyed = 0;
  const { uploader, add } = setup({ imageFactory: () => new Promise(done => { resolve = done; }) });
  t.after(() => uploader.destroy());
  const id = add();
  const pending = uploader.ready();
  assert.equal(await uploader.configureImageThumbnail(id, false), true);
  resolve({ width: 10, height: 10, capture: async () => { throw new Error("Should not capture"); }, destroy() { destroyed++; } });
  await pending;
  assert.equal(destroyed, 1);
  assert.equal(uploader.state.files[0].image!.enabled, false);
  assert.equal(uploader.state.error, null);
  assert.equal(uploader.uppy.getFiles().length, 1);
});

test("metadata failures keep uploaded media incomplete and retry without another transport upload", async t => {
  let fail = true;
  const { uploader, add, finish, preparations, saves } = setup({ save: async item => {
    if (fail) throw new Error("Thumbnail index unavailable");
    return item.thumbnails ?? {};
  } });
  t.after(() => uploader.destroy());
  add();
  await uploader.ready();
  await finish();
  await uploader.upload();
  assert.equal(uploader.state.files[0].complete, false);
  assert.match(uploader.state.files[0].error!, /index unavailable/);
  assert.deepEqual(uploader.completedMedia(), []);
  assert.equal(uploader.setMonth("2026-12"), false);
  assert.equal(uploader.state.month, month);
  fail = false;
  await uploader.upload();
  assert.equal(uploader.state.files[0].complete, true);
  assert.equal(uploader.state.files[0].error, null);
  assert.equal(uploader.state.error, null);
  assert.equal(saves.length, 2);
  assert.equal(preparations.length, 2);
  assert.deepEqual(Object.keys(uploader.completedMedia()[0].thumbnails!), ["960x480"]);
});

test("unthumbnailable small images finalize an empty map to clear previous associations", async t => {
  const { uploader, add, finish, saves } = setup();
  t.after(() => uploader.destroy());
  add(123);
  await uploader.ready();
  await finish();
  await uploader.upload();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].thumbnails, undefined);
  assert.equal(uploader.completedMedia()[0].thumbnails, undefined);
  assert.equal(uploader.state.files[0].complete, true);
});

test("raw Uppy completion keeps busy state through index saving and cancellation ignores stale saves", async t => {
  let resolve!: (files: Thumbnails) => void;
  let signal: AbortSignal | undefined;
  const { uploader, add, finish } = setup({ save: (item, abort) => {
    signal = abort;
    return new Promise(done => { resolve = done; });
  } });
  t.after(() => uploader.destroy());
  add();
  await uploader.ready();
  await finish();
  uploader.setState({ uploading: true });
  uploader.uppy.emit("complete", { successful: uploader.uppy.getFiles(), failed: [], uploadID: "fixture" });
  assert.equal(uploader.state.uploading, true);
  assert.equal(uploader.state.files[0].complete, false);
  uploader.cancel();
  uploader.addFiles([new File(["image"], "replacement.png")]);
  assert.equal(signal!.aborted, true);
  resolve({});
  await new Promise(done => setImmediate(done));
  assert.equal(uploader.state.files[0].name, "replacement.png");
  assert.equal(uploader.state.files[0].complete, false);
  assert.equal(uploader.state.uploaded.length, 0);
  assert.equal(uploader.state.uploading, false);
});

test("API preserves library maps, sends dimension grants and saves only validated thumbnail inputs", async () => {
  const auth = new MediaAuth();
  auth.login("owner", "fixture-password");
  const files = thumbnails();
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const api = new MediaApi({ apiUrl: "https://api.example.com", bucket: "fixture-bucket", auth,
    fetch: async (url, options) => {
      const path = new URL(String(url)).pathname;
      const body = options?.body ? JSON.parse(String(options.body)) : {};
      requests.push({ path, body });
      return Response.json(path === "/media" ? { bucket: "fixture-bucket", items: [{ key, size: 123, url: `https://cdn.example.com/${key}`, thumbnails: files }], cursor: null } :
        path === "/uploads" ? { bucket: "fixture-bucket", ...files["600x300"], ticket: "fixture", partSize: 10 * 1024 ** 2 } :
          { bucket: "fixture-bucket", key, thumbnails: files });
    },
  });
  assert.deepEqual((await api.list()).items[0].thumbnails, files);
  await api.prepare({ name: "thumbnail.jpg", size: 45, thumbnailFor: "photo.png", dimensions: "600x300" }, month);
  assert.equal(requests[1].body.thumbnailFor, "photo.png");
  assert.equal(requests[1].body.dimensions, "600x300");
  assert.deepEqual(await api.setThumbnails({ key, thumbnails: files }, month), files);
  assert.deepEqual(requests[2].body.thumbnails, thumbnailInputs(files));
  api.fetch = async () => Response.json({ bucket: "fixture-bucket", key, thumbnails: {} });
  await assert.rejects(api.setThumbnails({ key, thumbnails: files }, month), /does not match/);
});
