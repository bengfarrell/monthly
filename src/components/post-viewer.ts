import { firstThumbnail, mediaType } from "../shared/media-types.js";
import type { Post } from "../shared/posts.js";

export interface PostViewerOptions { label?: string; onClose?: () => void }
export interface OpenPostOptions {
  opener?: HTMLElement;
  previews?: ReadonlyMap<string, HTMLMediaElement>;
  selectedIndex?: number;
}
interface Player { asset: HTMLMediaElement; preview?: HTMLMediaElement }

export class PostViewer {
  readonly content: HTMLDivElement;
  readonly title: HTMLHeadingElement;
  readonly error: HTMLParagraphElement;
  readonly events = new AbortController();
  readonly label: string;
  readonly onClose?: () => void;
  post?: Post;
  opener?: HTMLElement;
  players: Player[] = [];
  assets: (HTMLImageElement | HTMLMediaElement)[] = [];
  private closing = false;
  private previousOverflow?: string;

  constructor(readonly dialog: HTMLDialogElement, { label = "Post", onClose }: PostViewerOptions = {}) {
    this.label = label;
    this.onClose = onClose;
    this.content = dialog.querySelector<HTMLDivElement>("[data-post-viewer-content]")!;
    this.title = dialog.querySelector<HTMLHeadingElement>("[data-post-viewer-title]")!;
    this.error = dialog.querySelector<HTMLParagraphElement>("[data-post-viewer-error]")!;
    dialog.addEventListener("close", () => {
      if (!dialog.open && this.post && !this.closing) {
        this.reset();
        this.onClose?.();
      }
    }, { signal: this.events.signal });
    dialog.addEventListener("click", event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    }, { signal: this.events.signal });
  }

  open(post: Post, { opener, previews, selectedIndex = 0 }: OpenPostOptions = {}) {
    this.reset();
    this.post = post;
    this.opener = opener;
    this.title.textContent = `${this.label} \u00b7 ${new Date(post.created).toLocaleDateString(undefined, {
      month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
    })}`;
    this.error.hidden = true;
    const copy = document.createElement("div");
    copy.className = "monthly-post-viewer-copy";
    const date = document.createElement("time");
    date.dateTime = post.created;
    date.textContent = new Date(post.created).toLocaleString(undefined, { timeZone: "UTC" }) + " UTC";
    const text = document.createElement("p");
    text.className = "monthly-post-viewer-text";
    text.textContent = post.text;
    const tags = document.createElement("ul");
    tags.className = "monthly-post-viewer-tags";
    tags.setAttribute("aria-label", "Tags");
    for (const tag of post.tags) {
      const item = document.createElement("li");
      item.textContent = `#${tag}`;
      tags.append(item);
    }
    copy.append(date, text, tags);
    const mediaList = document.createElement("div");
    mediaList.className = "monthly-post-viewer-media";
    for (const [index, media] of post.media.entries()) {
      const kind = mediaType(media.key)?.split("/")[0];
      if (!["image", "video", "audio"].includes(kind ?? "")) throw new Error("Unsupported post media.");
      const name = media.key.split("/").at(-1)!;
      const figure = document.createElement("figure");
      let asset: HTMLImageElement | HTMLMediaElement;
      if (kind === "image") {
        const image = document.createElement("img");
        image.alt = name;
        image.referrerPolicy = "no-referrer";
        image.loading = index === selectedIndex ? "eager" : "lazy";
        asset = image;
      } else {
        const player = kind === "video" ? document.createElement("video") : document.createElement("audio");
        const preview = previews?.get(media.key);
        preview?.pause();
        const position = preview?.currentTime ?? 0;
        player.controls = true;
        player.preload = index === selectedIndex ? "metadata" : "none";
        player.setAttribute("aria-label", name);
        const thumbnail = firstThumbnail(media);
        if (player instanceof HTMLVideoElement) {
          player.playsInline = true;
          if (thumbnail) player.poster = thumbnail.url;
        }
        const binding = { asset: player, preview };
        this.players.push(binding);
        player.addEventListener("loadedmetadata", () => {
          if (this.players.includes(binding) && Number.isFinite(position)) {
            player.currentTime = Number.isFinite(player.duration) ? Math.min(position, player.duration) : position;
          }
        }, { once: true });
        asset = player;
      }
      this.assets.push(asset);
      asset.addEventListener("error", () => {
        if (!this.assets.includes(asset)) return;
        this.error.textContent = "Some media could not be displayed. Try opening its original file.";
        this.error.hidden = false;
        console.error("Monthly feed: Could not load expanded media.", media.url);
      }, { once: true });
      asset.src = media.url;
      const original = document.createElement("a");
      original.href = media.url;
      original.target = "_blank";
      original.rel = "noopener noreferrer";
      original.textContent = `Open original: ${name}`;
      const caption = document.createElement("figcaption");
      caption.append(original);
      figure.append(asset, caption);
      mediaList.append(figure);
    }
    this.content.replaceChildren(...(post.media.length ? [mediaList, copy] : [copy]));
    this.content.classList.toggle("monthly-post-viewer-text-only", !post.media.length);
    if (!this.dialog.open) this.dialog.showModal();
    this.previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    this.dialog.scrollTop = 0;
    if (selectedIndex > 0) this.assets[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }

  close() {
    this.closing = true;
    if (this.dialog.open) this.dialog.close();
    this.reset();
    this.closing = false;
  }

  reset() {
    for (const { asset, preview } of this.players) {
      asset.pause();
      if (asset.readyState >= 1 && preview && preview.readyState >= 1) {
        preview.currentTime = Number.isFinite(preview.duration)
          ? Math.min(asset.currentTime, preview.duration) : asset.currentTime;
      }
      asset.removeAttribute("src");
      asset.load();
    }
    this.players = [];
    this.assets = [];
    this.content.replaceChildren();
    if (this.previousOverflow !== undefined) {
      document.documentElement.style.overflow = this.previousOverflow;
      this.previousOverflow = undefined;
    }
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    this.post = this.opener = undefined;
  }

  destroy() {
    this.close();
    this.events.abort();
  }
}
