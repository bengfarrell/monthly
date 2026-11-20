import assert from "node:assert/strict";
import { test } from "node:test";
import type AwsS3 from "@uppy/aws-s3";
import type { AwsBody } from "@uppy/aws-s3";
import type { Meta } from "@uppy/core";
import { MediaUploader, openVideo, thumbnailKey, uploadFilename, validateFile } from "../src/core/index.js";
import type { MediaFile, VideoSource } from "../src/core/index.js";

function setup(videoFactory: (file: Blob) => Promise<VideoSource> = async () => ({
  url: "blob:video-fixture", duration: 2,
  capture: async time => ({ blob: new Blob([`jpeg-${time}`], { type: "image/jpeg" }), width: 1280, height: 720 }), destroy() {},
})) {
  const preparations: MediaFile[] = [];
  const uploader = new MediaUploader({
    prepare: async file => {
      preparations.push(file);
      const originalKey = `media/2026/11/${uploadFilename(file.thumbnailFor ?? file.name)}`;
      const key = file.thumbnailFor ? thumbnailKey(originalKey, file.dimensions!) : originalKey;
      return { key, url: `https://cdn.example.com/${key}`,
        ticket: "fixture", partSize: 10 * 1024 ** 2 };
    },
    sign: async (request, grant) => ({ key: grant.key, url: grant.url }),
  }, { month: "2026-11", videoFactory });
  const add = (name = "video.mp4") => uploader.uppy.addFile({ name, type: "video/mp4", data: new Blob(["video-bytes"]) });
  const finish = async (id: string) => {
    const file = uploader.uppy.getFile(id)!;
    const plugin = uploader.uppy.getPlugin<AwsS3<Meta, AwsBody>>("AwsS3")!;
    assert.ok("signRequest" in plugin.opts);
    const proposal = plugin.opts.generateObjectKey!(file);
    const signed = await uploader.signRequest({ key: proposal, method: "PUT" });
    uploader.uppy.setFileState(id, { progress: { ...file.progress, uploadStarted: Date.now(), uploadComplete: true, percentage: 100, bytesUploaded: file.size!, bytesTotal: file.size! } });
    uploader.uppy.emit("upload-success", uploader.uppy.getFile(id), { status: 200, body: { key: signed.key, location: signed.url } });
    if (uploader.uppy.getFiles().every(file => file.progress.uploadComplete)) await uploader.upload();
  };
  return { uploader, add, finish, preparations };
}

test("decoding failure blocks upload and signing without preparing any S3 grants", async t => {
  const { uploader, add, preparations } = setup(async () => { throw new Error("This browser cannot decode this video."); });
  t.after(() => uploader.destroy());
  add();
  await assert.rejects(uploader.ready(), /cannot decode/);
  assert.match(uploader.state.files[0].error!, /cannot decode/);
  await uploader.upload();
  assert.match(uploader.state.error!.message, /cannot decode/);
  assert.equal(uploader.state.uploading, false);
  assert.deepEqual(preparations, []);
  await assert.rejects(uploader.uppy.upload(), /cannot decode/);
});

test("posters are internal assets and a video completes only after both uploads succeed", async t => {
  const { uploader, add, finish, preparations } = setup();
  t.after(() => uploader.destroy());
  const id = add("a video.mp4");
  const original = uploader.uppy.getFile(id)!.data;
  await uploader.ready();
  assert.equal(uploader.state.files.length, 1);
  assert.equal(uploader.uppy.getFiles().length, 2);
  assert.equal(uploader.state.files[0].video!.time, 1);
  assert.equal(await uploader.selectPoster(id, 0.25), true);
  assert.equal(uploader.uppy.getFile(id)!.data, original);
  assert.ok(original instanceof Blob);
  assert.equal(await original.text(), "video-bytes");
  assert.equal(uploader.uppy.getFiles().length, 2);
  const poster = uploader.uppy.getFiles().find(file => file.id !== id)!;
  await finish(id);
  assert.equal(uploader.state.files[0].complete, false);
  assert.deepEqual(uploader.completedMedia(), []);
  await finish(poster.id);
  assert.equal(uploader.state.files[0].complete, true);
  const media = uploader.completedMedia();
  assert.equal(media.length, 1);
  assert.equal(media[0].thumbnails!["1280x720"].key, thumbnailKey(media[0].key, "1280x720"));
  assert.equal(media[0].thumbnails!["1280x720"].time, 0.25);
  assert.equal(media[0].poster, undefined);
  assert.equal(preparations[1].thumbnailFor, "a video.mp4");
  assert.equal(preparations[1].dimensions, "1280x720");
  assert.deepEqual(uploader.state.uploaded, media);
  assert.equal(await uploader.selectPoster(id, 0.5), false);
});

test("failed poster uploads remain retryable without reporting a completed video", async t => {
  const { uploader, add, finish } = setup();
  t.after(() => uploader.destroy());
  const id = add();
  await uploader.ready();
  const poster = uploader.uppy.getFiles().find(file => file.id !== id)!;
  await finish(id);
  uploader.uppy.setFileState(poster.id, { error: "Poster upload failed" });
  uploader.uppy.emit("upload-error", uploader.uppy.getFile(poster.id), new Error("Poster upload failed"));
  assert.equal(uploader.state.files[0].complete, false);
  assert.match(uploader.state.files[0].error!, /Poster upload failed/);
  uploader.uppy.setFileState(poster.id, { error: null });
  await finish(poster.id);
  assert.equal(uploader.completedMedia().length, 1);
  assert.equal(uploader.state.uploaded.length, 1);
});

test("generated posters do not reduce the 20-original limit and removal cleans up companions", async t => {
  const { uploader, add } = setup();
  t.after(() => uploader.destroy());
  for (let index = 0; index < 20; index++) add(`video-${index}.mp4`);
  await uploader.ready();
  assert.equal(uploader.state.files.length, 20);
  assert.equal(uploader.uppy.getFiles().length, 40);
  assert.throws(() => add("extra.mp4"));
  uploader.removeFile(uploader.state.files[0].id);
  assert.equal(uploader.uppy.getFiles().length, 38);
  add("replacement.mp4");
  await uploader.ready();
  assert.equal(uploader.uppy.getFiles().length, 40);
  uploader.cancel();
  assert.equal(uploader.state.files.length, 0);
});

test("removing a video while decoding cannot restore its preview or companion", async t => {
  let resolve!: (source: VideoSource) => void;
  let destroyed = 0;
  const { uploader, add } = setup(() => new Promise(done => { resolve = done; }));
  t.after(() => uploader.destroy());
  const id = add();
  const pending = uploader.ready();
  uploader.removeFile(id);
  resolve({ url: "blob:fixture", duration: 2, capture: async () => ({ blob: new Blob(["poster"]), width: 1280, height: 720 }), destroy() { destroyed++; } });
  await pending;
  assert.equal(destroyed, 1);
  assert.deepEqual(uploader.state.files, []);
  assert.equal(uploader.uppy.getFiles().length, 0);
});

test("cancelling during decoding cannot start an upload or overwrite a replacement queue", async t => {
  let resolve!: (source: VideoSource) => void;
  const { uploader, add, preparations } = setup(() => new Promise(done => { resolve = done; }));
  t.after(() => uploader.destroy());
  add();
  const upload = uploader.upload();
  uploader.cancel();
  uploader.addFiles([new File(["image"], "replacement.png", { type: "image/png" })]);
  resolve({ url: "blob:fixture", duration: 2, capture: async () => ({ blob: new Blob(["poster"]), width: 1280, height: 720 }), destroy() {} });
  await upload;
  assert.equal(uploader.state.files[0].name, "replacement.png");
  assert.equal(uploader.state.uploading, false);
  assert.equal(uploader.state.error, null);
  assert.deepEqual(preparations, []);
});

test("invalid poster selections block uploading until a valid frame is chosen", async t => {
  const { uploader, add } = setup();
  t.after(() => uploader.destroy());
  const id = add();
  await uploader.ready();
  for (const time of [-1, NaN, Infinity, 2]) {
    assert.equal(await uploader.selectPoster(id, time), false);
    await assert.rejects(uploader.ready(), /within the video/);
  }
  assert.equal(await uploader.selectPoster(id, 0), true);
  await uploader.ready();
});

test("reserved companion names require association with a video and browser decoding needs DOM APIs", async () => {
  assert.throws(() => validateFile({ name: "clip.mp4.poster.jpg", size: 1 }), /reserved/);
  validateFile({ name: "clip.mp4.poster.jpg", size: 1, posterFor: "clip.mp4" });
  assert.throws(() => validateFile({ name: "poster.jpg", size: 1, posterFor: "photo.png" }), /associated with a video/);
  await assert.rejects(openVideo(new Blob(["invalid"])), /require a browser/);
});
