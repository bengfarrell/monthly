import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "vite";
import { chromium } from "playwright";
import { createHandler, PART_SIZE } from "../lambda/handler.js";
import type { UploadCommand } from "../lambda/handler.js";
import type { Browser, Page } from "playwright";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_BUCKET, LOCAL_PASSWORD, LOCAL_USERNAME, loadAssets } from "../dev/fixtures.js";
import type { MediaPage, SignedUpload, UploadGrant } from "../src/core/api.js";
import { ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { MockS3 } from "../dev/mock-s3.js";
import { feedMonths } from "../src/shared/posts.js";

test("opt-in post viewer supports historical links, current grids, media, history and lifecycle cleanup", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.MONTHLY_BROWSER_CHANNEL && { channel: process.env.MONTHLY_BROWSER_CHANNEL }) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
    const errors: string[] = [];
    const requests: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const video = Buffer.from(await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext("2d")!;
      const stream = canvas.captureStream(15);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const done = new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks)); });
      recorder.start();
      const timer = setInterval(() => {
        context.fillStyle = "blue"; context.fillRect(0, 0, canvas.width, canvas.height);
      }, 30);
      await new Promise(resolve => setTimeout(resolve, 1000));
      recorder.stop();
      const result = await done;
      clearInterval(timer);
      stream.getTracks().forEach(track => track.stop());
      return [...new Uint8Array(await result.arrayBuffer())];
    }));
    const audio = Buffer.alloc(44 + 44100 * 4);
    audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
    audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(44100, 24); audio.writeUInt32LE(88200, 28); audio.writeUInt16LE(2, 32);
    audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9N8AAAAASUVORK5CYII=", "base64");
    const months = feedMonths();
    const id = "bb3ff98b-df57-4bcb-81af-88ab6de0e3a8";
    const recentId = "11111111-1111-4111-8111-111111111111";
    const textId = "21111111-1111-4111-8111-111111111111";
    const cdn = "https://feed.monthly.test/uploads/";
    const media = (month: string, name: string) => {
      const key = `${month.replace("-", "/")}/${name}`;
      const thumbnail = { key: `${key}.thumb-960x540.jpg`, size: 123, url: `${cdn}${key}.thumb-960x540.jpg` };
      return { key, size: 1000, url: `${cdn}${key}`,
        ...(/\.(jpg|webm)$/.test(name) && { thumbnails: { "960x540": thumbnail } }) };
    };
    const post = (month: string, id: string, attachments: string[] = []) => ({
      id, created: `${month}-01T00:00:00.000Z`, text: "Full memo\n<script>window.injected = true</script>",
      tags: ["memo", "photo"], media: attachments.map(name => media(month, name)),
    });
    const old = post("2025-03", id, ["original.jpg", "video.webm", "audio.wav", "second.jpg"]);
    const html = (enabled = true) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
      <link rel="icon" href="data:,"><link rel="stylesheet" href="/monthly.css"></head>
      <body><monthly-feed style="font:16px/1.5 system-ui" base-url="${cdn}" ${enabled ? 'post-viewer post-prefix="note-" post-label="Memo"' : ""}></monthly-feed>
      <script type="module" src="/monthly.js"></script></body></html>`;
    let release: (() => void) | undefined;
    await page.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === "https://monthly.test") {
        if (url.pathname === "/monthly.js") return route.fulfill({ contentType: "text/javascript", body: readFileSync("dist/monthly.js") });
        if (url.pathname === "/monthly.css") return route.fulfill({ contentType: "text/css", body: readFileSync("dist/monthly.css") });
        return route.fulfill({ contentType: "text/html", body: html(url.pathname !== "/plain/") });
      }
      if (!url.href.startsWith(cdn)) return route.abort();
      requests.push(url.href);
      if (url.pathname.endsWith("/posts.json")) {
        assert.equal(request.headers().authorization, undefined);
        const month = url.pathname.split("/").slice(-3, -1).join("-");
        if (month === "2025-04") {
          await new Promise<void>(resolve => { release = resolve; });
          return route.fulfill({ json: [], headers: { "Access-Control-Allow-Origin": "*" } });
        }
        if (month === "2025-05") return route.fulfill({ status: 503, body: "Unavailable", headers: { "Access-Control-Allow-Origin": "*" } });
        const index = months.indexOf(month);
        const posts = month === "2025-03" ? [old] : index < 0 ? [] : [
          post(month, index === 0 ? recentId : `${index + 3}1111111-1111-4111-8111-111111111111`, ["original.jpg", "video.webm", "audio.wav"]),
          post(month, index === 0 ? textId : `${index + 6}1111111-1111-4111-8111-111111111111`),
        ];
        return route.fulfill({ json: posts, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const body = url.pathname.endsWith(".webm") ? video : url.pathname.endsWith(".wav") ? audio : image;
      const contentType = url.pathname.endsWith(".webm") ? "video/webm" : url.pathname.endsWith(".wav") ? "audio/wav" : "image/png";
      const headers: Record<string, string> = { "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*" };
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? "");
      if (range) {
        const start = Number(range[1]), end = Math.min(Number(range[2] || body.length - 1), body.length - 1);
        headers["Content-Range"] = `bytes ${start}-${end}/${body.length}`;
        return route.fulfill({ status: 206, contentType, headers, body: body.subarray(start, end + 1) });
      }
      return route.fulfill({ contentType, headers, body });
    });
    const waitClosed = () => page.waitForFunction(() => {
      const dialog = document.querySelector<HTMLDialogElement>("dialog");
      return !dialog?.open && !document.querySelector("[data-post-viewer-content]")?.children.length;
    });
    await page.goto(`https://monthly.test/updates/?month=2025-03#note-${id}`);
    await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("dialog")?.open && document.querySelectorAll(".monthly-post").length === 6);
    assert.deepEqual(await page.locator(".monthly-feed-month-title time").evaluateAll(nodes => nodes.map(node => node.getAttribute("datetime"))), months);
    assert.equal(requests.filter(url => url.endsWith("/2025/03/posts.json")).length, 1);
    assert.equal(requests.some(url => url.includes("/2025/02/")), false);
    assert.equal(await page.locator(".monthly-post-viewer-text").textContent(), old.text);
    assert.equal(await page.evaluate(() => "injected" in window), false);
    assert.deepEqual(await page.locator(".monthly-post-viewer-tags li").allTextContents(), ["#memo", "#photo"]);
    assert.equal(await page.locator(".monthly-post-viewer-media figure").count(), 4);
    assert.equal(await page.locator(".monthly-post-viewer-heading a").count(), 0);
    assert.equal(await page.locator(".monthly-post-viewer-media figcaption a").count(), 4);
    assert.equal(await page.locator(".monthly-post-viewer-media img").first().getAttribute("src"), old.media[0].thumbnails?.["960x540"].url);
    assert.equal(requests.includes(old.media[0].url), false);
    assert.equal(requests.includes(old.media[3].url), false);
    assert.equal(requests.includes(old.media[1].url), false);
    assert.equal(requests.includes(old.media[2].url), false);
    assert.equal(await page.locator(".monthly-post-viewer-media").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length), 2);
    assert.equal(await page.locator(".monthly-post-media").first().evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length), 2);
    const tile = await page.locator(".monthly-post-media img").first().evaluate(node => ({
      width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
    }));
    assert.ok(Math.abs(tile.width / tile.height - 4 / 3) < 0.01);
    assert.equal(await page.locator(".monthly-post-attachment-audio").first().evaluate(node => getComputedStyle(node).gridColumn), "1 / -1");
    const originalPostUrl = page.url();
    const enlargeImage = page.getByRole("button", { name: "Enlarge image: original.jpg", exact: true });
    await enlargeImage.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Back to memo" }).waitFor();
    assert.equal(await page.locator(".monthly-post-viewer-media figure:visible").count(), 1);
    assert.equal(await page.locator(".monthly-post-viewer-media img").first().getAttribute("src"), old.media[0].url);
    assert.equal(await page.locator(".monthly-post-viewer-copy").isHidden(), true);
    assert.equal(await page.getByRole("button", { name: "Previous asset" }).isDisabled(), true);
    assert.equal(page.url(), originalPostUrl);
    await page.keyboard.press("ArrowRight");
    await page.getByRole("status").filter({ hasText: "Asset 2 of 4" }).waitFor();
    await page.getByRole("button", { name: "Next asset" }).click();
    await page.getByRole("status").filter({ hasText: "Asset 3 of 4" }).waitFor();
    await page.getByRole("button", { name: "Next asset" }).click();
    await page.getByRole("status").filter({ hasText: "Asset 4 of 4" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Next asset" }).isDisabled(), true);
    assert.equal(await page.locator(".monthly-post-viewer-media img").last().getAttribute("src"), old.media[3].url);
    assert.equal(page.url(), originalPostUrl);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("dialog").evaluate(node => node instanceof HTMLDialogElement && node.open), true);
    assert.equal(await page.locator(".monthly-post-viewer-media figure:visible").count(), 4);
    assert.equal(await enlargeImage.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator(".monthly-post-viewer-media img").last().getAttribute("src"), old.media[3].thumbnails?.["960x540"].url);
    assert.equal(await page.locator(".monthly-post-viewer-copy").isVisible(), true);
    assert.equal(await page.locator(".monthly-post-viewer-media video").getAttribute("poster"), old.media[1].thumbnails?.["960x540"].url);
    await page.getByRole("button", { name: "Close memo viewer" }).click();
    await waitClosed();
    assert.equal(page.url(), "https://monthly.test/updates/");
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "MONTHLY-FEED");
    assert.equal(await page.locator(".monthly-feed-posts").first().evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length), 3);
    const recentArticle = page.locator(`#note-${recentId}`);
    await recentArticle.locator(".monthly-post-open").click();
    await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("dialog")?.open);
    assert.equal(new URL(page.url()).hash, `#note-${recentId}`);
    await page.goBack(); await waitClosed();
    await page.goForward();
    await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("dialog")?.open);
    await page.keyboard.press("Escape"); await waitClosed();
    await page.waitForFunction(() => !location.hash);
    assert.equal(await page.evaluate(() => document.activeElement?.className), "monthly-post-open");
    await recentArticle.locator("img.monthly-preview").click();
    await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("dialog")?.open);
    const staleImage = await page.locator(".monthly-post-viewer-media img").elementHandle();
    await staleImage!.evaluate(node => node.dispatchEvent(new Event("error")));
    await page.getByRole("status").filter({ hasText: "opening its original" }).waitFor();
    await page.evaluate(() => {
      const feed = document.querySelector("monthly-feed")!;
      feed.querySelector<HTMLDialogElement>("dialog")!.close();
      feed.openPost(feed.observed!.state.posts[0], feed);
    });
    await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("dialog")?.open);
    await staleImage!.evaluate(node => node.dispatchEvent(new Event("error")));
    assert.equal(await page.locator("[data-post-viewer-error]").isHidden(), true);
    await page.mouse.click(2, 2);
    await waitClosed();
    await page.waitForFunction(() => !location.hash);
    await recentArticle.locator("img.monthly-preview").click();
    await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("dialog")?.open);
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.tagName === "BODY" ||
      Boolean(document.querySelector("dialog")?.contains(document.activeElement))), true);
    await page.keyboard.press("Escape"); await waitClosed();
    await page.waitForFunction(() => !location.hash);
    assert.equal(await page.evaluate(() => document.activeElement?.className), "monthly-post-open");

    await page.evaluate(async () => {
      const feed = document.querySelector("monthly-feed")!;
      feed.observed!.setState({ posts: feed.observed!.state.posts.map(post => ({ ...post, text: post.text + "\nUpdated" })) });
      await feed.updateComplete;
    });
    assert.equal(await page.locator(".monthly-post-open").count(), 6);
    assert.equal(await page.locator(".monthly-post-expand").count(), 0);
    assert.deepEqual(await page.locator(".monthly-post").evaluateAll(posts =>
      posts.map(post => post.querySelectorAll(".monthly-post-open").length)), [1, 1, 1, 1, 1, 1]);
    await page.locator(`#note-${textId} .monthly-post-open`).click();
    await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("dialog")?.open);
    assert.equal(await page.locator(".monthly-post-viewer-media figure").count(), 0);
    assert.match(await page.locator(".monthly-post-viewer-text").textContent() ?? "", /Updated/);
    await page.getByRole("button", { name: "Close memo viewer" }).click(); await waitClosed();
    await page.waitForFunction(() => !location.hash);

    const preview = recentArticle.locator("audio");
    await preview.evaluate(async node => {
      if (!(node instanceof HTMLAudioElement)) throw new Error("Expected inline audio.");
      await node.play(); node.currentTime = 0.5; node.pause();
    });
    await recentArticle.getByRole("link", { name: "Expand memo" }).click();
    await page.getByRole("button", { name: "Enlarge audio: audio.wav", exact: true }).click();
    const expanded = page.locator(".monthly-post-viewer-media audio");
    await page.waitForFunction(() => document.querySelector<HTMLAudioElement>(".monthly-post-viewer-media audio")?.currentTime === 0.5);
    assert.equal(await expanded.evaluate(node => node instanceof HTMLAudioElement && node.paused), true);
    await expanded.evaluate(async node => {
      if (!(node instanceof HTMLAudioElement)) throw new Error("Expected expanded audio.");
      await node.play(); node.currentTime = 0.75; node.pause();
    });
    assert.equal(await page.locator(".monthly-post-viewer-media figure:visible").count(), 1);
    assert.equal(await expanded.evaluate(node => node instanceof HTMLAudioElement && node.currentTime), 0.75);
    await expanded.evaluate(async node => { await (node as HTMLAudioElement).play(); });
    await page.getByRole("button", { name: "Previous asset" }).click();
    assert.equal(await expanded.evaluate(node => node instanceof HTMLAudioElement && node.paused), true);
    await page.getByRole("button", { name: "Next asset" }).click();
    assert.ok(await expanded.evaluate(node => node instanceof HTMLAudioElement && node.currentTime >= 0.75));
    await expanded.evaluate(node => { (node as HTMLAudioElement).currentTime = 0.75; });
    await page.getByRole("button", { name: "Back to memo" }).click();
    await page.getByRole("button", { name: "Close memo viewer" }).click(); await waitClosed();
    await page.waitForFunction(() => !location.hash);
    assert.ok(Math.abs(await preview.evaluate(node => {
      if (!(node instanceof HTMLAudioElement)) throw new Error("Expected inline audio.");
      return node.currentTime;
    }) - 0.75) < 0.05);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`https://monthly.test/updates/?month=2025-03#note-${id}`);
    await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("dialog")?.open);
    assert.equal(await page.locator(".monthly-post-viewer-content").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length), 1);
    assert.equal(await page.locator("dialog").evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.getByRole("button", { name: "Enlarge image: second.jpg", exact: true }).tap();
    assert.equal(await page.locator("dialog").evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await page.locator(".monthly-post-viewer-media figure:visible").count(), 1);
    await page.getByRole("button", { name: "Back to memo" }).tap();
    assert.equal(await page.locator(".monthly-post-viewer-tags li").first().evaluate(node => getComputedStyle(node).borderTopStyle), "solid");
    await page.locator(".monthly-post-viewer-media video").evaluate(async node => {
      if (!(node instanceof HTMLVideoElement)) throw new Error("Expected expanded video.");
      await node.play();
    });
    await page.locator(".monthly-post-viewer-media audio").evaluate(async node => {
      if (!(node instanceof HTMLAudioElement)) throw new Error("Expected expanded audio.");
      await node.play();
    });
    const assets = await page.locator(".monthly-post-viewer-media video, .monthly-post-viewer-media audio").elementHandles();
    await page.locator("dialog").evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.getByRole("button", { name: "Close memo viewer" }).tap(); await waitClosed();
    for (const asset of assets) assert.equal(await asset.evaluate(node => node instanceof HTMLMediaElement && node.paused && !node.getAttribute("src")), true);
    assert.equal(await page.evaluate(() => document.documentElement.style.overflow), "");

    await page.goto("https://monthly.test/updates/?month=2025-04#note-missing");
    await page.waitForFunction(() => document.querySelector(".monthly-post-status")?.textContent?.includes("Loading"));
    await page.evaluate(() => { history.replaceState(null, "", "/updates/"); dispatchEvent(new HashChangeEvent("hashchange")); });
    release!();
    await page.waitForFunction(() => !document.querySelector(".monthly-post-status"));
    assert.equal(await page.locator("dialog").evaluate(node => node instanceof HTMLDialogElement && node.open), false);
    await page.goto("https://monthly.test/updates/?month=2025-05#note-missing");
    await page.getByRole("alert").filter({ hasText: "could not be loaded" }).waitFor();
    await page.goto("https://monthly.test/updates/?month=2025-13#note-missing");
    await page.getByRole("alert").filter({ hasText: "invalid month" }).waitFor();
    await page.goto("https://monthly.test/updates/?month=2025-06#note-missing");
    await page.getByRole("alert").filter({ hasText: "no longer available" }).waitFor();

    await page.goto("https://monthly.test/plain/?month=2025-03#note-missing");
    await page.locator(".monthly-post").first().waitFor();
    assert.equal(await page.locator("dialog, .monthly-post-expand, .monthly-post-open").count(), 0);
    await page.evaluate(async second => {
      const feed = document.querySelector("monthly-feed")!;
      const post = feed.observed!.state.posts[0];
      feed.observed!.setState({ posts: [{ ...post, media: [post.media[0], second] }] });
      await feed.updateComplete;
    }, media(months[0], "second.jpg"));
    assert.equal(await page.locator(".monthly-post-media img").count(), 2);
    assert.equal(await page.locator(".monthly-post-media").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length), 2);
    await page.evaluate(() => { document.querySelector("monthly-feed")!.postViewer = true; });
    await page.locator(".monthly-post-open").first().waitFor();
    await page.locator(".monthly-post-open").first().click();
    await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("dialog")?.open);
    await page.evaluate(() => { document.querySelector("monthly-feed")!.postViewer = false; });
    await page.waitForFunction(() => !document.querySelector("dialog"));
    assert.equal(await page.evaluate(() => document.documentElement.style.overflow), "");
    await page.evaluate(async () => {
      const feed = document.querySelector("monthly-feed")!;
      feed.postViewer = true;
      await feed.updateComplete;
      feed.remove();
      document.body.append(feed);
    });
    await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("dialog")?.open);
    await page.evaluate(() => document.querySelector("monthly-feed")!.remove());
    assert.equal(await page.evaluate(() => document.documentElement.style.overflow), "");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

type UploadInput = UploadCommand["input"] & {
  PartNumber?: number; ContentLength?: number; ContentType?: string;
};

async function queueVideo(page: Page, name: string, size = 0, label = "Choose files") {
  await page.getByLabel(label, { exact: true }).evaluate(async (input, { name, size }) => {
    const ebml = {
      join(...parts: Uint8Array[]) {
        const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
        let offset = 0;
        for (const part of parts) { result.set(part, offset); offset += part.length; }
        return result;
      },
      hex(value: string) { return Uint8Array.from(value.match(/../g)!.map(byte => parseInt(byte, 16))); },
      text(value: string) { return new TextEncoder().encode(value); },
      element(id: string, data: Uint8Array): Uint8Array {
        const length = data.length < 127 ? new Uint8Array([0x80 | data.length]) :
          new Uint8Array([0x40 | (data.length >> 8), data.length & 255]);
        return ebml.join(ebml.hex(id), length, data);
      },
    };
    const { join, hex, text, element } = ebml;
    const canvas = document.createElement("canvas");
    canvas.width = 1920;
    canvas.height = 1080;
    const context = canvas.getContext("2d")!;
    const encoder = {
      async frame(color: string) {
        context.fillStyle = color;
        context.fillRect(0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/webp", 0.8));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const view = new DataView(bytes.buffer);
        for (let offset = 12; offset < bytes.length;) {
          const length = view.getUint32(offset + 4, true);
          if (new TextDecoder().decode(bytes.slice(offset, offset + 4)) === "VP8 ") return bytes.slice(offset + 8, offset + 8 + length);
          offset += 8 + length + (length % 2);
        }
        throw new Error("The browser did not encode a VP8 test frame.");
      },
    };
    const { frame } = encoder;
    const duration = new Uint8Array(8);
    new DataView(duration.buffer).setFloat64(0, 2000);
    const header = element("1a45dfa3", join(element("4286", hex("01")), element("42f7", hex("01")),
      element("42f2", hex("04")), element("42f3", hex("08")), element("4282", text("webm")),
      element("4287", hex("02")), element("4285", hex("02"))));
    const info = element("1549a966", join(element("2ad7b1", hex("0f4240")), element("4489", duration),
      element("4d80", text("monthly-test")), element("5741", text("monthly-test"))));
    const tracks = element("1654ae6b", element("ae", join(element("d7", hex("01")), element("73c5", hex("01")),
      element("83", hex("01")), element("86", text("V_VP8")), element("e0", join(element("b0", hex("0780")), element("ba", hex("0438")))))));
    const cluster = element("1f43b675", join(element("e7", hex("00")),
      element("a3", join(hex("81000080"), await frame("red"))), element("a3", join(hex("8103e880"), await frame("blue")))));
    const bytes = join(header, element("18538067", join(info, tracks, cluster)));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes, new Uint8Array(Math.max(0, size - bytes.length))], name, { type: "video/webm" }));
    (input as HTMLInputElement).files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { name, size });
  await page.locator('.monthly-poster-picker input[type="range"]:not(:disabled)').waitFor();
}

async function queueImage(page: Page, name: string, size = 0, width = 1920, height = 1080, label = "Choose files", noise = false) {
  await page.getByLabel(label, { exact: true }).evaluate(async (input, { name, size, width, height, noise }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "red";
    context.fillRect(0, 0, width / 2, height);
    if (noise) {
      const pixels = context.createImageData(width, height);
      for (let offset = 0; offset < pixels.data.length; offset += 65536) {
        crypto.getRandomValues(pixels.data.subarray(offset, offset + 65536));
      }
      for (let offset = 3; offset < pixels.data.length; offset += 4) pixels.data[offset] = 255;
      context.putImageData(pixels, 0, 0);
    }
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/png"));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob, new Uint8Array(Math.max(0, size - blob.size))], name, { type: "image/png" }));
    (input as HTMLInputElement).files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { name, size, width, height, noise });
}

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
    assert.equal(await page.evaluate(() => ["wa-button", "wa-card", "wa-badge", "wa-callout", "wa-progress-bar", "monthly-post", "monthly-feed", "monthly-posts-editor"].every(tag => customElements.get(tag))), true);
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
    const origin = `https://localhost:${address.port}`;
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
    const origin = `https://localhost:${address.port}`;
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
    await page.getByLabel("Choose files", { exact: true }).setInputFiles({ name: "undecodable.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(123) });
    await page.getByRole("alert").filter({ hasText: "cannot decode" }).waitFor();
    const uploadRequests: string[] = [];
    page.on("request", request => { if (["/uploads", "/sign"].includes(new URL(request.url()).pathname)) uploadRequests.push(request.url()); });
    await page.getByRole("button", { name: "Upload files", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "cannot decode" }).waitFor();
    assert.deepEqual(uploadRequests, []);
    await page.getByRole("button", { name: "Remove undecodable.mp4", exact: true }).click();
    let failPosters = true;
    let videoUploadBytes = 0;
    await page.route("**/__monthly/s3/*", route => {
      const request = route.request();
      if (request.method() === "PUT" && request.headers()["content-type"] === "image/jpeg") {
        if (failPosters) return route.fulfill({ status: 500, body: "Poster storage unavailable" });
      } else if (request.method() === "PUT") {
        videoUploadBytes += request.postDataBuffer()?.length ?? 0;
      }
      return route.fallback();
    });
    for (const [name, size] of [["local-test.png", 123], ["local-test.png", 456], ["large-local.webm", 101 * 1024 ** 2]] as const) {
      if (name.endsWith(".webm")) await queueVideo(page, name, size);
      else await page.getByLabel("Choose files", { exact: true }).evaluate((input, { name, size }) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(size)], name, { type: name.endsWith(".mp4") ? "video/mp4" : "image/png" }));
        (input as HTMLInputElement).files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, { name, size });
      const signedResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/sign");
      await page.getByRole("button", { name: "Upload files", exact: true }).click();
      const signed: SignedUpload = await (await signedResponse).json();
      assert.equal(new URL(signed.url).origin, origin);
      if (name.endsWith(".webm")) {
        await page.getByRole("status").filter({ hasText: "0 uploaded; 1 failed." }).waitFor();
        const uploadedBytes = videoUploadBytes;
        failPosters = false;
        await page.getByRole("button", { name: "Upload files", exact: true }).click();
        await page.getByRole("status").filter({ hasText: "1 uploaded; 0 failed." }).waitFor();
        assert.equal(videoUploadBytes, uploadedBytes, "Retry should upload only the missing poster.");
      }
      await page.getByRole("status").filter({ hasText: "1 uploaded; 0 failed." }).waitFor();
    }
    const uploaded: MediaPage = await (await page.request.get(`${origin}/media?bucket=${LOCAL_BUCKET}&month=${month}`, { headers })).json();
    assert.equal(uploaded.items.filter(item => item.key.endsWith("/local-test.png")).length, 1);
    assert.equal(uploaded.items.find(item => item.key.endsWith("/local-test.png"))!.size, 456);
    const uploadedVideo = uploaded.items.find(item => item.key.endsWith("/large-local.webm"))!;
    assert.equal(uploadedVideo.size, 101 * 1024 ** 2);
    assert.equal(uploadedVideo.thumbnails, undefined);
    assert.equal(uploaded.items.some(item => item.key === `${uploadedVideo.key}.thumb-1280x720.jpg`), true);
    await queueImage(page, "large-image.png", 1024 ** 2 + 1);
    assert.equal(await page.getByLabel("Create thumbnail for large-image.png", { exact: true }).isChecked(), true);
    const imageSize = page.getByLabel("Thumbnail longest edge for large-image.png", { exact: true });
    await page.waitForFunction(() => document.querySelector("monthly-upload")!.model!.state.files[0].image?.dimensions === "960x540");
    assert.equal(await imageSize.inputValue(), "960");
    await imageSize.fill("640");
    await imageSize.press("Tab");
    await page.waitForFunction(() => document.querySelector("monthly-upload")!.model!.state.files[0].image?.dimensions === "640x360");
    const thumbnailPixels = await page.locator('img[alt="Thumbnail for large-image.png"]').evaluate(async image => {
      await (image as HTMLImageElement).decode();
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext("2d")!;
      context.drawImage(image as HTMLImageElement, 0, 0);
      return { width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight,
        white: [...context.getImageData(639, 0, 1, 1).data] };
    });
    assert.deepEqual(thumbnailPixels, { width: 640, height: 360, white: [255, 255, 255, 255] });
    const indexRequests: string[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/thumbnails") indexRequests.push(request.url());
    });
    await page.evaluate(() => { void document.querySelector("monthly-upload")!.model!.uppy.upload(); });
    await page.getByRole("status").filter({ hasText: "1 uploaded; 0 failed." }).waitFor();
    assert.deepEqual(indexRequests, []);
    const imagePage: MediaPage = await (await page.request.get(`${origin}/media?bucket=${LOCAL_BUCKET}&month=${month}`, { headers })).json();
    const uploadedImage = imagePage.items.find(item => item.key.endsWith("/large-image.png"))!;
    assert.equal(uploadedImage.size, 1024 ** 2 + 1);
    assert.equal(uploadedImage.thumbnails, undefined);
    assert.equal(imagePage.items.some(item => item.key === `${uploadedImage.key}.thumb-640x360.jpg`), true);
    await queueImage(page, "tiny-image.png", 0, 120, 60);
    const tinyToggle = page.getByLabel("Create thumbnail for tiny-image.png", { exact: true });
    assert.equal(await tinyToggle.isChecked(), false);
    await tinyToggle.check();
    const tinyPreview = page.locator('img[alt="Thumbnail for tiny-image.png"]');
    await tinyPreview.waitFor();
    assert.deepEqual(await tinyPreview.evaluate(async image => {
      await (image as HTMLImageElement).decode();
      return [(image as HTMLImageElement).naturalWidth, (image as HTMLImageElement).naturalHeight];
    }), [120, 60]);
    await tinyToggle.uncheck();
    await tinyPreview.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Remove tiny-image.png", exact: true }).click();
    await queueImage(page, "noise-image.png", 0, 2048, 2048, "Choose files", true);
    await page.waitForFunction(() => document.querySelector("monthly-upload")!.model!.state.files[0].image?.dimensions === "960x960");
    assert.ok(await page.evaluate(() => document.querySelector("monthly-upload")!.model!.uppy.getFiles()
      .find(file => file.name.endsWith(".thumb-960x960.jpg"))!.size! <= 1024 ** 2));
    const noiseSize = page.getByLabel("Thumbnail longest edge for noise-image.png", { exact: true });
    await noiseSize.fill("2048");
    await noiseSize.press("Tab");
    await page.getByRole("alert").filter({ hasText: "thumbnail exceeds 1 MiB" }).waitFor();
    const preparationsBeforeOversizedThumbnail = uploadRequests.length;
    await page.getByRole("button", { name: "Upload files", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "thumbnail exceeds 1 MiB" }).waitFor();
    assert.equal(uploadRequests.length, preparationsBeforeOversizedThumbnail);
    await noiseSize.fill("320");
    await noiseSize.press("Tab");
    await page.waitForFunction(() => document.querySelector("monthly-upload")!.model!.state.files[0].image?.dimensions === "320x320");
    await page.getByRole("button", { name: "Remove noise-image.png", exact: true }).click();
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
    await page.getByRole("tab", { name: "Post", exact: true }).click();
    assert.equal(await page.locator("monthly-post input[type=month]").count(), 0);
    const text = "Morning update #Outside #HELLO\n<img src=x onerror=alert(1)>";
    await page.getByLabel("Message", { exact: true }).fill(text);
    await page.getByLabel("Tags (comma-separated)", { exact: true }).fill("personal, outside");
    await page.getByLabel("Choose post media", { exact: true }).setInputFiles([
      { name: "post-audio.mp3", mimeType: "audio/mpeg", buffer: Buffer.alloc(123) },
    ]);
    await queueImage(page, "post-photo.png", 1024 ** 2 + 1, 1920, 1080, "Choose post media");
    const previewRequests: string[] = [];
    page.on("request", request => { if (request.method() === "GET") previewRequests.push(new URL(request.url()).pathname); });
    await queueVideo(page, "post-video.webm", 0, "Choose post media");
    const posterDimensions = await page.locator('img[alt="Poster frame for post-video.webm"]').evaluate(async image => {
      await (image as HTMLImageElement).decode();
      return { width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight };
    });
    assert.deepEqual(posterDimensions, { width: 1280, height: 720 });
    const picker = page.getByLabel("Poster frame for post-video.webm", { exact: true });
    await picker.evaluate(input => {
      (input as HTMLInputElement).value = "0";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => {
      const file = document.querySelector("monthly-post")!.model!.uploader.state.files.find(file => file.name === "post-video.webm");
      return file?.video?.time === 0 && !file.video.checking;
    });
    const color = await page.locator('img[alt="Poster frame for post-video.webm"]').evaluate(async image => {
      await (image as HTMLImageElement).decode();
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d")!;
      context.drawImage(image as HTMLImageElement, 0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    });
    assert.ok(color[0] > 200 && color[2] < 50, `Expected the scrubbed red frame, got ${color}`);
    await page.getByRole("button", { name: "Publish post", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Post published." }).waitFor();
    await page.locator("monthly-feed article").waitFor();
    assert.equal(await page.locator("monthly-feed .monthly-post-text").textContent(), text);
    assert.equal(await page.locator("monthly-feed img").count(), 1);
    assert.match((await page.locator("monthly-feed img").getAttribute("src"))!, /post-photo\.png\.thumb-960x540\.jpg$/);
    assert.equal(await page.locator("monthly-feed video[controls]").count(), 1);
    assert.match((await page.locator("monthly-feed video").getAttribute("poster"))!, /post-video\.webm\.thumb-1280x720\.jpg$/);
    assert.equal(await page.locator("monthly-feed audio[controls]").count(), 1);
    assert.equal(await page.locator("monthly-feed .monthly-post-media a").count(), 0);
    assert.equal((await page.locator("monthly-feed .monthly-post-media").textContent())!.trim(), "");
    assert.deepEqual(await page.locator("monthly-feed .monthly-post-tags li").allTextContents(), ["#personal", "#outside", "#hello"]);
    assert.equal(await page.getByLabel("Message", { exact: true }).inputValue(), "");
    const currentMonth = new Date().toISOString().slice(0, 7);
    const publicJson = await page.request.get(`${origin}/mock-assets/${currentMonth.replace("-", "/")}/posts.json`);
    assert.equal(publicJson.status(), 200);
    const posts = await publicJson.json();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].media.length, 3);
    assert.equal(posts[0].media.find((item: { key: string }) => item.key.endsWith("post-video.webm")).thumbnails["1280x720"].time, 0);
    assert.ok(posts[0].media.every((item: { key: string }) => item.key.startsWith(`mock-assets/${currentMonth.replace("-", "/")}/`)));
    await page.getByLabel("Message", { exact: true }).fill("Another text-only update");
    await page.getByRole("button", { name: "Publish post", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("monthly-feed article").length === 2);
    assert.equal(await page.locator("monthly-feed .monthly-post-text").first().textContent(), "Another text-only update");
    await page.getByRole("tab", { name: "Browse", exact: true }).click();
    await page.getByLabel("Browse month", { exact: true }).fill(currentMonth);
    await page.getByRole("button", { name: "Edit posts.json", exact: true }).click();
    const json = page.getByLabel("Monthly posts JSON", { exact: true });
    await json.waitFor();
    const loaded = await json.inputValue();
    const edited = JSON.parse(loaded);
    assert.equal(edited.length, 2);
    await json.fill("{ broken");
    await page.getByRole("alert").filter({ hasText: "Invalid JSON" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save posts.json", exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel("Browse month", { exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).isDisabled(), true);
    edited[0].text = "Edited from Browse JSON";
    edited[0].extra = { preserved: true };
    const editedImage = edited[0].media.find((item: { key: string }) => item.key.endsWith("/post-photo.png"));
    const secondThumbnailKey = `${editedImage.key}.thumb-320x180.jpg`;
    editedImage.thumbnails["320x180"] = { key: secondThumbnailKey, url: `${origin}/${secondThumbnailKey}`, size: 45 };
    const content = `${JSON.stringify(edited, null, 2)}\n`;
    await json.fill(content);
    await page.getByRole("status").filter({ hasText: "Valid JSON: 2 posts." }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save posts.json", exact: true }).isDisabled(), false);
    const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/posts/edit");
    await page.getByRole("button", { name: "Save posts.json", exact: true }).click();
    assert.equal((await savedResponse).status(), 200);
    await page.getByRole("status").filter({ hasText: "Saved posts.json." }).waitFor();
    await page.locator("monthly-feed .monthly-post-text").filter({ hasText: "Edited from Browse JSON" }).waitFor();
    assert.equal(await json.inputValue(), content);
    assert.equal(await page.getByLabel("Browse month", { exact: true }).isDisabled(), false);
    const savedFile = await (await page.request.get(`${origin}/mock-assets/${currentMonth.replace("-", "/")}/posts.json`)).text();
    assert.equal(savedFile, content);
    assert.match((await page.locator("monthly-feed img").getAttribute("src"))!, /post-photo\.png\.thumb-960x540\.jpg$/);
    assert.equal(previewRequests.some(path => path.endsWith("/post-photo.png") || path.endsWith("/post-photo.png.thumb-320x180.jpg")), false);
    assert.equal(JSON.parse(savedFile)[0].media[2].thumbnails["1280x720"].time, 0);
    edited[0].text = "Local edits kept on conflict";
    const localEdits = JSON.stringify(edited, null, 2);
    await json.fill(localEdits);
    assert.equal((await page.request.post(`${origin}/posts`, { headers, data: {
      bucket: LOCAL_BUCKET, month: currentMonth, id: randomUUID(), text: "Concurrent update", tags: [], media: [],
    } })).status(), 201);
    await page.getByRole("button", { name: "Save posts.json", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "The posts file changed" }).waitFor();
    assert.equal(await json.inputValue(), localEdits);
    assert.equal(await page.getByRole("button", { name: "Reload posts.json", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Discard JSON changes", exact: true }).click();
    await page.getByRole("button", { name: "Reload posts.json", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Valid JSON: 3 posts." }).waitFor();
    const reloaded = JSON.parse(await json.inputValue());
    assert.equal(reloaded[2].text, "Concurrent update");
    assert.deepEqual(reloaded[0].extra, { preserved: true });
    await page.getByLabel("Browse month", { exact: true }).fill(emptyMonth);
    await page.getByRole("button", { name: "Edit posts.json", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "No posts.json exists" }).waitFor();
    await page.getByLabel("Browse month", { exact: true }).fill("");
    assert.equal(await page.getByRole("button", { name: "Edit posts.json", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    assert.equal(await page.locator("monthly-feed article").count(), 2);
    assert.ok(outsideRequests.every(url => ["picsum.photos", "interactive-examples.mdn.mozilla.net"].includes(new URL(url).hostname)));
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
    const origin = `http://localhost:${port}`;
    const apiOrigin = "https://api.monthly.test";
    const username = "fixture";
    const password = "fixture-only-password";
    const requests: { path: string; query: Record<string, string>; body: unknown; authorization?: string }[] = [];
    const s3Requests: { operation: string; size: number; part?: number; bucket?: string }[] = [];
    const signatures = new Map<string, { constructor: { name: string }; input: UploadInput }>();
    let outage = false;
    let holdUpload = false;
    let uploadGate: Promise<void> | undefined;
    const s3 = new MockS3([]);
    const handler = createHandler({
      config: {
        username, password,
        buckets: {
          "first-bucket": { prefix: "media/", publicBaseUrl: "https://cdn.monthly.test", region: "us-west-2" },
          "second-bucket": { prefix: "uploads/", publicBaseUrl: "https://second.monthly.test", region: "us-east-1" },
        },
      },
      clientForRegion: () => ({ send: async command => {
        if (!(command instanceof ListObjectsV2Command)) return s3.send(command instanceof GetObjectCommand ?
          new GetObjectCommand({ ...command.input, Bucket: LOCAL_BUCKET }) : new PutObjectCommand({ ...command.input, Bucket: LOCAL_BUCKET }));
        return ({
        Contents: command.input.ContinuationToken ? [] : [
          { Key: `${command.input.Bucket === "first-bucket" ? "media" : "uploads"}/2026/11/existing.png`, Size: 123 },
          { Key: `media/2026/11/${"long-filename-".repeat(12)}recording.wav`, Size: 123 },
        ],
        IsTruncated: !command.input.ContinuationToken,
        NextContinuationToken: command.input.ContinuationToken ? undefined : "next",
      }); } }),
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
    assert.equal(await page.getByRole("tab", { name: "Post", exact: true }).getAttribute("aria-selected"), "true");
    await page.getByRole("tab", { name: "Post", exact: true }).press("Home");
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
    await queueVideo(page, "large.webm", 101 * 1024 ** 2);
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

test("standalone feed demo reads public CDN posts without API settings or a manager", { timeout: 30000 }, async () => {
  const previous = {
    MONTHLY_FEED_URL: process.env.MONTHLY_FEED_URL,
    MONTHLY_API_URL: process.env.MONTHLY_API_URL,
    MONTHLY_BUCKET: process.env.MONTHLY_BUCKET,
  };
  let server: Awaited<ReturnType<typeof createServer>>;
  try {
    process.env.MONTHLY_API_URL = "";
    process.env.MONTHLY_BUCKET = "";
    process.env.MONTHLY_FEED_URL = "";
    await assert.rejects(createServer({ mode: "feed", server: { port: 0 } }), /Set MONTHLY_FEED_URL/);
    process.env.MONTHLY_FEED_URL = "https://feed.monthly.test/wp-content/uploads/";
    server = await createServer({ mode: "feed", server: { port: 0 } });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  let browser: Browser | undefined;
  try {
    assert.equal(server.config.server.host, "localhost");
    assert.equal(server.config.server.https, undefined);
    assert.equal(server.config.plugins.some(plugin => plugin.name === "monthly-local-lambda"), false);
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://localhost:${address.port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.MONTHLY_BROWSER_CHANNEL && { channel: process.env.MONTHLY_BROWSER_CHANNEL }) });
    const page = await browser.newPage();
    const requests: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const warnings: string[] = [];
    const appErrors: string[] = [];
    page.on("console", message => {
      if (!message.text().startsWith("Monthly feed:")) return;
      if (message.type() === "warning") warnings.push(message.text());
      if (message.type() === "error") appErrors.push(message.text());
    });
    const created = new Date().toISOString();
    const month = created.slice(0, 7).replace("-", "/");
    const date = new Date(created);
    const forbiddenMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)).toISOString().slice(0, 7).replace("-", "/");
    let text = "A deployed post";
    let available = true;
    let historical = false;
    await page.route("https://feed.monthly.test/**", route => {
      const request = route.request();
      requests.push(new URL(request.url()).pathname);
      assert.equal(request.method(), "GET");
      assert.equal(request.headers().authorization, undefined);
      const current = request.url().includes(`/${month}/`);
      const previousMonth = request.url().includes(`/${forbiddenMonth}/`);
      return route.fulfill({
        status: available && (current || (historical && previousMonth)) ? 200 : previousMonth ? 403 : 404,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify(Array.from({ length: current ? historical ? 2 : 3 : 1 }, (_, index) => ({
          id: `6e809217-28d0-41bd-b722-4fc7b552486${index}`,
          created: current ? created : `${forbiddenMonth.replace("/", "-")}-15T12:00:00.000Z`,
          text: current ? text : "A post from last month", tags: ["demo"], media: [],
        }))),
      });
    });
    await page.goto(origin);
    await page.getByRole("heading", { name: "My Monthly Feed", exact: true }).waitFor();
    await page.locator("monthly-feed article").first().waitFor();
    assert.equal(await page.title(), "My Monthly Feed");
    assert.equal(await page.locator("header").evaluate(header => getComputedStyle(header).backgroundColor), "rgb(0, 0, 0)");
    assert.equal(await page.getByRole("heading", { name: "My Monthly Feed", exact: true }).evaluate(heading => getComputedStyle(heading).color), "rgb(255, 255, 255)");
    assert.equal(await page.getByRole("heading", { name: "Recent posts", exact: true }).count(), 0);
    assert.equal(await page.locator("monthly-media").count(), 0);
    assert.equal(await page.locator("input[type=password]").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Refresh posts", exact: true }).count(), 0);
    assert.equal(await page.getByText("The current month and previous two months. Public and read-only; no sign-in needed.", { exact: true }).count(), 0);
    assert.equal(await page.locator(".monthly-post-text").first().textContent(), text);
    const timestamp = await page.locator("monthly-feed article").first().evaluate(article => {
      const date = article.querySelector<HTMLTimeElement>(".monthly-post-date")!;
      const message = article.querySelector(".monthly-post-text")!;
      const style = getComputedStyle(date);
      return {
        datetime: date.dateTime,
        smaller: parseFloat(style.fontSize) < parseFloat(getComputedStyle(message).fontSize),
        muted: style.color !== getComputedStyle(message).color,
        display: style.display, align: style.textAlign,
        afterMedia: date.previousElementSibling?.classList.contains("monthly-post-media"),
        beforeTags: date.nextElementSibling?.classList.contains("monthly-post-tags"),
      };
    });
    assert.deepEqual(timestamp, { datetime: created, smaller: true, muted: true, display: "block", align: "right", afterMedia: true, beforeTags: true });
    const tagStyle = await page.locator("monthly-feed article").first().evaluate(article => {
      const date = getComputedStyle(article.querySelector(".monthly-post-date")!);
      const tags = getComputedStyle(article.querySelector(".monthly-post-tags")!);
      const tag = getComputedStyle(article.querySelector(".monthly-post-tags li")!);
      return {
        sameSize: tag.fontSize === date.fontSize, sameColor: tag.color === date.color,
        align: tags.textAlign, justify: tags.justifyContent,
        bordered: tag.borderTopStyle === "solid" && parseFloat(tag.borderTopWidth) === 1,
        rounded: parseFloat(tag.borderTopLeftRadius) > 0,
      };
    });
    assert.deepEqual(tagStyle, { sameSize: true, sameColor: true, align: "left", justify: "flex-start", bordered: true, rounded: true });
    assert.equal(requests.length, 3);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some(message => message.includes("403")));
    assert.ok(warnings.some(message => message.includes("404")));
    assert.deepEqual(await page.locator(".monthly-feed-month-title time").evaluateAll(nodes => nodes.map(node => node.getAttribute("datetime"))), [month.replace("/", "-")]);
    assert.equal(await page.locator("monthly-feed [role=status], monthly-feed [role=alert]").count(), 0);
    assert.ok(requests.every(path => /^\/wp-content\/uploads\/\d{4}\/\d{2}\/posts\.json$/.test(path)));
    for (const [width, columns] of [[2560, 3], [1440, 3], [1024, 2], [768, 1], [375, 1], [320, 1]] as const) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.locator(".monthly-feed-posts").evaluate(grid => ({
        columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        widths: Array.from(grid.children, card => card.getBoundingClientRect().width),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }));
      assert.equal(layout.columns, columns, `Column count at ${width}px`);
      assert.equal(layout.overflow, false, `Horizontal overflow at ${width}px`);
      assert.ok(layout.widths.every(cardWidth => cardWidth >= (columns > 1 ? 352 : 240) && cardWidth <= 700), `Readable post widths at ${width}px`);
    }
    text = "A newly published post";
    historical = true;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await page.waitForFunction(text => document.querySelector(".monthly-post-text")?.textContent === text, text);
    assert.equal(requests.length, 6);
    assert.equal(warnings.length, 3);
    const sections = page.locator(".monthly-feed-month");
    assert.equal(await sections.count(), 2);
    assert.deepEqual(await page.locator(".monthly-feed-month-title time").evaluateAll(nodes => nodes.map(node => node.getAttribute("datetime"))), [
      month.replace("/", "-"), forbiddenMonth.replace("/", "-"),
    ]);
    assert.equal(await sections.first().locator("article").count(), 2);
    assert.equal(await sections.last().locator("article").count(), 1);
    const monthLayout = await sections.evaluateAll(nodes => nodes.map(section => {
      const grid = section.querySelector(".monthly-feed-posts")!;
      const heading = section.querySelector("h2")!;
      const bounds = section.getBoundingClientRect();
      return {
        top: bounds.top, bottom: bounds.bottom,
        columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        headingWidth: heading.getBoundingClientRect().width, gridWidth: grid.getBoundingClientRect().width,
      };
    }));
    assert.ok(monthLayout[1].top > monthLayout[0].bottom);
    assert.ok(monthLayout.every(month => month.columns === 3 && Math.abs(month.headingWidth - month.gridWidth) < 1));
    available = false;
    await page.reload();
    await page.waitForFunction(() => {
      const state = document.querySelector("monthly-feed")?.observed?.state;
      return state?.loaded && !state.loading && !state.posts.length;
    });
    assert.equal(await page.locator("monthly-feed [role=status], monthly-feed [role=alert]").count(), 0);
    assert.equal(warnings.length, 6);
    assert.deepEqual(appErrors, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
