import { LitElement, html, nothing, type PropertyValues } from "lit";
import { PostFeed } from "../core/feed.js";
import type { Unsubscribe } from "../core/store.js";
import { asError } from "../shared/errors.js";
import { firstThumbnail, mediaType, validateMonth } from "../shared/media-types.js";
import { feedMonths, postUrl, type Post } from "../shared/posts.js";
import { PostViewer } from "./post-viewer.js";
import { expandIcon } from "./icons.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";

export class MonthlyFeed extends LitElement {
  declare baseUrl?: string;
  declare model?: PostFeed;
  declare configurationError?: Error | null;
  postViewer = false;
  postPrefix = "post-";
  postLabel = "Post";
  postStatus = "";
  observed?: PostFeed;
  owned?: PostFeed;
  unsubscribe?: Unsubscribe;
  viewer?: PostViewer;
  private linkRequest?: AbortController;
  private handledUrl?: string;
  static properties = {
    baseUrl: { attribute: "base-url" }, model: { attribute: false }, configurationError: { state: true },
    postViewer: { attribute: "post-viewer", type: Boolean },
    postPrefix: { attribute: "post-prefix" }, postLabel: { attribute: "post-label" },
    postStatus: { state: true },
  };
  createRenderRoot() { return this; }
  connectedCallback() { super.connectedCallback(); this.observe(); this.requestUpdate(); }
  willUpdate(changed: PropertyValues<this>) {
    if (changed.has("baseUrl") || changed.has("model")) this.observe();
    if (changed.has("postViewer") || changed.has("postPrefix") || changed.has("postLabel") ||
      changed.has("baseUrl") || changed.has("model")) this.stopViewer();
  }
  updated() {
    if (!this.postViewer || this.configurationError) return;
    if (!this.viewer) {
      const dialog = this.querySelector<HTMLDialogElement>("[data-post-viewer]");
      if (!dialog) return;
      this.viewer = new PostViewer(dialog, { label: this.postLabel, onClose: () => this.exitPost() });
      if (!this.hasAttribute("tabindex")) this.tabIndex = -1;
      window.addEventListener("hashchange", this.onLocationChange);
      window.addEventListener("popstate", this.onLocationChange);
    }
    void this.revealPost();
  }
  disconnectedCallback() {
    this.stopViewer();
    this.unsubscribe?.();
    this.owned?.destroy();
    this.observed = this.owned = undefined;
    super.disconnectedCallback();
  }
  observe() {
    if (this.model || this.owned?.baseUrl !== `${this.baseUrl?.replace(/\/+$/, "")}/`) {
      this.owned?.destroy();
      this.owned = undefined;
      this.configurationError = null;
      if (!this.model) {
        try { this.owned = new PostFeed({ baseUrl: this.baseUrl ?? "" }); }
        catch (error) { this.configurationError = asError(error); }
      }
    }
    const active = this.model ?? this.owned;
    if (active === this.observed) return;
    this.unsubscribe?.();
    this.observed = active;
    this.unsubscribe = active?.subscribe(() => this.requestUpdate());
    if (active && !active.state.loaded && !active.state.loading) void active.load();
  }
  private stopViewer() {
    window.removeEventListener("hashchange", this.onLocationChange);
    window.removeEventListener("popstate", this.onLocationChange);
    this.linkRequest?.abort();
    this.viewer?.destroy();
    this.viewer = undefined;
    this.handledUrl = undefined;
    this.postStatus = "";
  }
  private onLocationChange = () => {
    if (window.location.href === this.handledUrl) return;
    this.linkRequest?.abort();
    this.viewer?.close();
    this.handledUrl = undefined;
    this.postStatus = "";
    void this.revealPost();
  };
  private link(post: Post) { return postUrl(post, window.location.href, this.postPrefix); }
  private gridUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete("month");
    url.hash = "";
    return url;
  }
  private showPost(post: Post, opener?: HTMLElement, selectedIndex = 0) {
    const article = [...this.querySelectorAll<HTMLElement>(".monthly-post")]
      .find(article => article.id === `${this.postPrefix}${post.id}`);
    const previews = new Map<string, HTMLMediaElement>();
    for (const preview of article?.querySelectorAll<HTMLMediaElement>("video.monthly-preview, audio.monthly-preview") ?? []) {
      if (preview.dataset.mediaKey) previews.set(preview.dataset.mediaKey, preview);
    }
    this.postStatus = "";
    this.viewer?.open(post, {
      opener: opener ?? article?.querySelector<HTMLElement>(".monthly-post-open") ?? this,
      previews, selectedIndex,
    });
  }
  openPost(post: Post, opener?: HTMLElement, selectedIndex = 0) {
    if (!this.postViewer || !this.viewer) throw new Error("Enable post-viewer before opening a post.");
    this.linkRequest?.abort();
    const url = this.link(post);
    if (url.href !== window.location.href) {
      if (!window.location.hash.startsWith(`#${this.postPrefix}`)) {
        window.history.replaceState(window.history.state, "", this.gridUrl());
      }
      window.history.pushState({ monthlyPostViewer: url.href }, "", url);
    }
    this.handledUrl = window.location.href;
    this.showPost(post, opener, selectedIndex);
  }
  private onPostClick(event: MouseEvent, post: Post, selectedIndex = 0) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const target = event.currentTarget;
    const opener = target instanceof HTMLImageElement
      ? target.closest(".monthly-post")?.querySelector<HTMLAnchorElement>(".monthly-post-open") ?? this
      : target instanceof HTMLElement ? target : undefined;
    this.openPost(post, opener, selectedIndex);
  }
  private exitPost() {
    this.linkRequest?.abort();
    if (window.history.state?.monthlyPostViewer === window.location.href) {
      window.history.back();
    } else {
      const url = this.gridUrl();
      window.history.replaceState(window.history.state, "", url);
      this.handledUrl = url.href;
    }
    this.postStatus = "";
  }
  private async revealPost() {
    const url = new URL(window.location.href);
    const model = this.observed;
    if (!this.viewer || !model || !url.hash.startsWith(`#${this.postPrefix}`) || url.href === this.handledUrl) return;
    const month = url.searchParams.get("month");
    try {
      if (month !== null) validateMonth(month);
    } catch (error) {
      this.handledUrl = url.href;
      this.postStatus = `This ${this.postLabel.toLowerCase()} link has an invalid month. Showing recent posts instead.`;
      console.error("Monthly feed:", error);
      return;
    }
    const historical = month !== null && !feedMonths(model.now()).includes(month);
    if (!historical && (!model.state.loaded || model.state.loading)) return;
    this.handledUrl = url.href;
    const request = this.linkRequest = new AbortController();
    const id = url.hash.slice(this.postPrefix.length + 1);
    try {
      if (historical) this.postStatus = `Loading linked ${this.postLabel.toLowerCase()}...`;
      const post = month !== null ? await model.loadPost(id, month, request.signal) :
        model.state.posts.find(post => post.id === id);
      if (request.signal.aborted || window.location.href !== url.href) return;
      if (!post) {
        if (!historical && model.state.errors.length) throw new Error("Recent posts could not be loaded.");
        this.postStatus = `This ${this.postLabel.toLowerCase()} is no longer available.`;
        console.warn("Monthly feed: Linked post is unavailable.");
        return;
      }
      this.showPost(post);
    } catch (error) {
      if (request.signal.aborted) return;
      this.postStatus = `This ${this.postLabel.toLowerCase()} could not be loaded. Please try again.`;
      console.error("Monthly feed:", error);
    }
  }
  render() {
    if (this.configurationError) return html`<wa-callout variant="danger" role="alert">${this.configurationError.message}</wa-callout>`;
    if (this.postViewer && (!/^[a-zA-Z][\w-]*$/.test(this.postPrefix) || !this.postLabel.trim())) {
      return html`<wa-callout variant="danger" role="alert">A post viewer needs a nonempty label and an ID prefix starting with a letter, using letters, numbers, underscores or hyphens.</wa-callout>`;
    }
    const state = this.observed?.state;
    if (!state) return nothing;
    const months = new Map<string, Post[]>();
    for (const post of state.posts) {
      const month = post.created.slice(0, 7);
      const posts = months.get(month);
      if (posts) posts.push(post);
      else months.set(month, [post]);
    }
    const label = this.postLabel.toLowerCase();
    return html`
      ${state.loading ? html`<p role="status">Loading posts...</p>` : nothing}
      ${state.loaded && !state.posts.length && !state.errors.length ? html`<p role="status">No recent posts.</p>` : nothing}
      ${this.postStatus ? html`<p class="monthly-post-status" role="alert">${this.postStatus}</p>` : nothing}
      <div class="monthly-feed" aria-busy=${String(state.loading)}>
        ${[...months].map(([month, posts]) => {
          const monthLabel = new Date(`${month}-01T00:00:00.000Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
          return html`<section class="monthly-feed-month" aria-label=${monthLabel}>
            <h2 class="monthly-feed-month-title"><time datetime=${month}>${monthLabel}</time></h2>
            <div class="monthly-feed-posts">
              ${posts.map(post => html`<article class="monthly-post" id=${this.postViewer ? `${this.postPrefix}${post.id}` : nothing}
                tabindex=${this.postViewer ? "-1" : nothing}>
                <p class="monthly-post-text">${post.text}</p>
                <div class=${post.media.length > 1 ? "monthly-post-media monthly-post-media-multiple" : "monthly-post-media"}>${post.media.map((item, index) => {
                  const type = mediaType(item.key);
                  const name = item.key.split("/").at(-1)!;
                  const thumbnail = firstThumbnail(item);
                  const media = type?.startsWith("image/") ? html`<img class=${this.postViewer ? "monthly-preview monthly-expandable-image" : "monthly-preview"}
                    src=${thumbnail?.url ?? item.url} alt=${name} loading="lazy" referrerpolicy="no-referrer"
                    @click=${this.postViewer ? (event: MouseEvent) => this.onPostClick(event, post, index) : nothing}>` :
                    type?.startsWith("video/") ? html`<video class="monthly-preview" data-media-key=${item.key}
                      src=${item.url} poster=${thumbnail?.url ?? nothing} aria-label=${name} controls preload=${thumbnail ? "none" : "metadata"}></video>` :
                      type?.startsWith("audio/") ? html`<audio class="monthly-preview" data-media-key=${item.key}
                        src=${item.url} aria-label=${name} controls preload="metadata"></audio>` : nothing;
                  return html`<div class=${type?.startsWith("audio/") ? "monthly-post-attachment monthly-post-attachment-audio" : "monthly-post-attachment"}>${media}
                  </div>`;
                })}</div>
                <time class="monthly-post-date" datetime=${post.created}>${new Date(post.created).toLocaleString()}</time>
                <ul class="monthly-post-tags" aria-label="Tags">${post.tags.map(tag => html`<li>#${tag}</li>`)}</ul>
                ${this.postViewer ? html`<a class="monthly-post-open" href=${this.link(post).href} aria-haspopup="dialog"
                  @click=${(event: MouseEvent) => this.onPostClick(event, post)}>${expandIcon} Expand ${label}</a>` : nothing}
              </article>`)}
            </div>
          </section>`;
        })}
      </div>
      ${this.postViewer ? html`<dialog class="monthly-post-viewer" data-post-viewer aria-label=${`${this.postLabel} viewer`}>
        <header class="monthly-post-viewer-heading">
          <h2 data-post-viewer-title>${this.postLabel}</h2>
          <div class="monthly-post-viewer-actions">
            <form method="dialog"><button type="submit" autofocus aria-label=${`Close ${label} viewer`}>Close &times;</button></form>
          </div>
        </header>
        <div class="monthly-post-viewer-content" data-post-viewer-content></div>
        <p data-post-viewer-error role="status" hidden></p>
      </dialog>` : nothing}
    `;
  }
}
