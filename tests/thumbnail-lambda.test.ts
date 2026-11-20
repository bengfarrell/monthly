import assert from "node:assert/strict";
import { test } from "node:test";
import { GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createHandler, type MediaEvent } from "../lambda/handler.js";
import { MAX_THUMBNAIL_SIZE, thumbnailKey } from "../src/shared/media-types.js";

const month = "2026-11";
const folder = "media/2026/11/";
const key = `${folder}photo.png`;
const bucket = "fixture-bucket";
const config = {
  username: "owner", password: "fixture-only-password",
  buckets: { [bucket]: { prefix: "media/", region: "us-east-1", publicBaseUrl: "https://cdn.example.com" } },
};
function event(routeKey: string, body?: object): MediaEvent {
  return {
    routeKey, headers: { authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}` },
    queryStringParameters: { bucket, month },
    ...(body && { body: JSON.stringify({ bucket, month, ...body }) }),
  };
}
function setup() {
  const commands: (ListObjectsV2Command | GetObjectCommand | PutObjectCommand)[] = [];
  const keys = [
    key, thumbnailKey(key, "600x300"), thumbnailKey(key, "960x480"),
    `${folder}clip.mp4`, `${folder}clip.mp4.poster.jpg`,
    `${folder}posts.json`, `${folder}thumbnails.json`, `${folder}notes.txt`, folder,
  ];
  const handle = createHandler({
    config, now: () => new Date("2026-11-15T00:00:00.000Z"),
    clientForRegion: () => ({ send: async command => {
      commands.push(command);
      assert.ok(command instanceof ListObjectsV2Command, "Library must only list S3 objects.");
      return { Contents: keys.map(Key => ({ Key, Size: 123 })), IsTruncated: false };
    } }),
  });
  return { handle, commands, keys };
}

test("thumbnail grants derive exact companion keys for images and videos", async () => {
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
});

test("library returns every media object including thumbnails and legacy posters, without associations", async () => {
  const { handle, commands, keys } = setup();
  const response = await handle(event("GET /media"));
  assert.equal(response.statusCode, 200);
  const page = JSON.parse(response.body);
  assert.deepEqual(page.items.map((item: { key: string }) => item.key), keys.slice(0, 5));
  assert.ok(page.items.every((item: { thumbnails?: unknown; poster?: unknown }) =>
    item.thumbnails === undefined && item.poster === undefined));
  assert.equal(commands.length, 1);
  assert.ok(commands[0] instanceof ListObjectsV2Command);
  assert.equal(commands[0].input.Prefix, folder);
});

test("thumbnail association endpoint is retired and never accesses S3", async () => {
  const { handle, commands } = setup();
  const response = await handle(event("POST /thumbnails", { key, thumbnails: {} }));
  assert.equal(response.statusCode, 404);
  assert.equal(commands.length, 0);
});
