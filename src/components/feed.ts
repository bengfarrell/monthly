import { LitElement, html, nothing, type PropertyValues } from "lit";
import { PostFeed } from "../core/feed.js";
import type { Unsubscribe } from "../core/store.js";
import { asError } from "../shared/errors.js";
import { firstThumbnail, mediaType } from "../shared/media-types.js";
import type { Post } from "../shared/posts.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";

export class MonthlyFeed extends LitElement {
  declare baseUrl?: string;
  declare model?: PostFeed;
  declare configurationError?: Error | null;
  observed?: PostFeed;
  owned?: PostFeed;
  unsubscribe?: Unsubscribe;
  static properties = { baseUrl: { attribute: "base-url" }, model: { attribute: false }, configurationError: { state: true } };
  createRenderRoot() { return this; }
  connectedCallback() { super.connectedCallback(); this.observe(); }
  willUpdate(changed: PropertyValues<this>) { if (changed.has("baseUrl") || changed.has("model")) this.observe(); }
  disconnectedCallback() {
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
  render() {
    if (this.configurationError) return html`<wa-callout variant="danger" role="alert">${this.configurationError.message}</wa-callout>`;
    const state = this.observed?.state;
    if (!state) return nothing;
    const months = new Map<string, Post[]>();
    for (const post of state.posts) {
      const month = post.created.slice(0, 7);
      const posts = months.get(month);
      if (posts) posts.push(post);
      else months.set(month, [post]);
    }
    return html`
      ${state.loading ? html`<p role="status">Loading posts...</p>` : nothing}
      ${state.loaded && !state.posts.length && !state.errors.length ? html`<p role="status">No recent posts.</p>` : nothing}
      <div class="monthly-feed" aria-busy=${String(state.loading)}>
        ${[...months].map(([month, posts]) => {
          const label = new Date(`${month}-01T00:00:00.000Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
          return html`<section class="monthly-feed-month" aria-label=${label}>
            <h2 class="monthly-feed-month-title"><time datetime=${month}>${label}</time></h2>
            <div class="monthly-feed-posts">
              ${posts.map(post => html`<article class="monthly-post">
                <p class="monthly-post-text">${post.text}</p>
                <div class="monthly-post-media">${post.media.map(item => {
                  const type = mediaType(item.key);
                  const name = item.key.split("/").at(-1)!;
                  const thumbnail = firstThumbnail(item);
                  return type?.startsWith("image/") ? html`<img class="monthly-preview" src=${thumbnail?.url ?? item.url} alt=${name} loading="lazy" referrerpolicy="no-referrer">` :
                    type?.startsWith("video/") ? html`<video class="monthly-preview" src=${item.url} poster=${thumbnail?.url ?? nothing} aria-label=${name} controls preload=${thumbnail ? "none" : "metadata"}></video>` :
                      type?.startsWith("audio/") ? html`<audio class="monthly-preview" src=${item.url} aria-label=${name} controls preload="metadata"></audio>` : nothing;
                })}</div>
                <time class="monthly-post-date" datetime=${post.created}>${new Date(post.created).toLocaleString()}</time>
                <ul class="monthly-post-tags" aria-label="Tags">${post.tags.map(tag => html`<li>#${tag}</li>`)}</ul>
              </article>`)}
            </div>
          </section>`;
        })}
      </div>
    `;
  }
}
