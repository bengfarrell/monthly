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
  private focusedIndex?: number;
  private overviewScroll = 0;
  private assetOpener?: HTMLButtonElement;
  private figures: HTMLElement[] = [];
  private expanders: HTMLButtonElement[] = [];
  private mediaList?: HTMLDivElement;
  private copy?: HTMLDivElement;
  private toolbar?: HTMLDivElement;
  private back?: HTMLButtonElement;
  private previous?: HTMLButtonElement;
  private next?: HTMLButtonElement;
  private position?: HTMLParagraphElement;

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
    dialog.addEventListener("cancel", event => {
      if (this.focusedIndex === undefined) return;
      event.preventDefault();
      this.showOverview();
    }, { signal: this.events.signal });
    dialog.addEventListener("keydown", event => {
      if (this.focusedIndex === undefined || !(event.target instanceof HTMLElement) ||
          !event.target.closest(".monthly-post-viewer-asset-tools, .monthly-post-viewer-image-button") ||
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      const index = this.focusedIndex + direction;
      if (!direction || index < 0 || index >= this.assets.length) return;
      event.preventDefault();
      this.showAsset(index);
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
    mediaList.classList.toggle("monthly-post-viewer-media-multiple", post.media.length > 1);
    this.mediaList = mediaList;
    this.copy = copy;
    for (const [index, media] of post.media.entries()) {
      const kind = mediaType(media.key)?.split("/")[0];
      if (!["image", "video", "audio"].includes(kind ?? "")) throw new Error("Unsupported post media.");
      const name = media.key.split("/").at(-1)!;
      const figure = document.createElement("figure");
      figure.classList.toggle("monthly-post-viewer-audio", kind === "audio");
      const expand = document.createElement("button");
      expand.type = "button";
      expand.setAttribute("aria-label", `Enlarge ${kind}: ${name}`);
      expand.addEventListener("click", () => {
        if (this.focusedIndex === undefined) this.assetOpener = expand;
        this.showAsset(index);
      });
      this.expanders.push(expand);
      let asset: HTMLImageElement | HTMLMediaElement;
      if (kind === "image") {
        const image = document.createElement("img");
        image.alt = name;
        image.referrerPolicy = "no-referrer";
        image.loading = index === selectedIndex ? "eager" : "lazy";
        expand.className = "monthly-post-viewer-image-button";
        expand.append(image);
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
        expand.className = "monthly-post-viewer-enlarge";
        expand.textContent = "Enlarge";
      }
      this.assets.push(asset);
      asset.addEventListener("error", () => {
        if (!this.assets.includes(asset)) return;
        this.error.textContent = "Some media could not be displayed. Try opening its original file.";
        this.error.hidden = false;
        console.error("Monthly feed: Could not load expanded media.", media.url);
      }, { once: true });
      asset.src = kind === "image" ? firstThumbnail(media)?.url ?? media.url : media.url;
      const original = document.createElement("a");
      original.href = media.url;
      original.target = "_blank";
      original.rel = "noopener noreferrer";
      original.textContent = `Open original: ${name}`;
      const caption = document.createElement("figcaption");
      caption.append(original);
      if (kind === "image") figure.append(expand, caption);
      else figure.append(asset, expand, caption);
      this.figures.push(figure);
      mediaList.append(figure);
    }
    const toolbar = document.createElement("div");
    toolbar.className = "monthly-post-viewer-asset-tools";
    toolbar.hidden = true;
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = `Back to ${this.label.toLowerCase()}`;
    back.addEventListener("click", () => this.showOverview());
    const previous = document.createElement("button");
    previous.type = "button";
    previous.textContent = "Previous asset";
    previous.addEventListener("click", () => this.showAsset(this.focusedIndex! - 1));
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "Next asset";
    next.addEventListener("click", () => this.showAsset(this.focusedIndex! + 1));
    const position = document.createElement("p");
    position.setAttribute("role", "status");
    toolbar.append(back, previous, position, next);
    this.toolbar = toolbar;
    this.back = back;
    this.previous = previous;
    this.next = next;
    this.position = position;
    this.content.replaceChildren(...(post.media.length ? [toolbar, mediaList, copy] : [copy]));
    this.content.classList.toggle("monthly-post-viewer-text-only", !post.media.length);
    if (!this.dialog.open) this.dialog.showModal();
    this.previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    this.dialog.scrollTop = 0;
    if (selectedIndex > 0) this.assets[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }

  private showAsset(index: number) {
    if (!this.post || !Number.isInteger(index) || index < 0 || index >= this.assets.length) return;
    if (this.focusedIndex === undefined) this.overviewScroll = this.dialog.scrollTop;
    this.focusedIndex = index;
    this.content.classList.add("monthly-post-viewer-focused");
    this.toolbar!.hidden = false;
    this.copy!.hidden = true;
    this.mediaList!.classList.add("monthly-post-viewer-media-focused");
    this.previous!.disabled = index === 0;
    this.next!.disabled = index === this.assets.length - 1;
    this.position!.textContent = `Asset ${index + 1} of ${this.assets.length}: ${this.post.media[index].key.split("/").at(-1)}`;
    for (const [assetIndex, asset] of this.assets.entries()) {
      const selected = assetIndex === index;
      this.figures[assetIndex].hidden = !selected;
      this.expanders[assetIndex].hidden = asset instanceof HTMLMediaElement && selected;
      if (asset instanceof HTMLMediaElement) {
        if (!selected) asset.pause();
        else asset.preload = "metadata";
      } else if (selected) {
        asset.loading = "eager";
        asset.src = this.post.media[assetIndex].url;
      }
    }
    this.dialog.scrollTop = 0;
    this.back!.focus({ preventScroll: true });
  }

  private showOverview() {
    if (this.focusedIndex === undefined || !this.post) return;
    this.focusedIndex = undefined;
    this.content.classList.remove("monthly-post-viewer-focused");
    this.mediaList!.classList.remove("monthly-post-viewer-media-focused");
    this.toolbar!.hidden = true;
    this.copy!.hidden = false;
    for (const [index, asset] of this.assets.entries()) {
      this.figures[index].hidden = false;
      this.expanders[index].hidden = false;
      if (asset instanceof HTMLImageElement) asset.src = firstThumbnail(this.post.media[index])?.url ?? this.post.media[index].url;
    }
    this.dialog.scrollTop = this.overviewScroll;
    this.assetOpener?.focus({ preventScroll: true });
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
    this.figures = [];
    this.expanders = [];
    this.focusedIndex = undefined;
    this.assetOpener = undefined;
    this.mediaList = this.copy = this.toolbar = undefined;
    this.back = this.previous = this.next = undefined;
    this.position = undefined;
    this.content.classList.remove("monthly-post-viewer-focused");
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
