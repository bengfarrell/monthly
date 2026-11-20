import { LitElement, html, nothing, type TemplateResult } from "lit";
import { firstThumbnail, formatBytes, mediaType } from "../shared/media-types.js";
import { copyIcon } from "./icons.js";
import { copyMediaUrl } from "../core/clipboard.js";
import type { MediaItem } from "../shared/media-types.js";
import { asError } from "../shared/errors.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/card/card.js";
import "@awesome.me/webawesome/dist/components/badge/badge.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";

let nextId = 0;

export class MonthlyAsset extends LitElement {
  declare item?: MediaItem;
  declare preview: boolean;
  declare message: string;
  declare error: string;
  inputId: string;
  static properties = { item: { attribute: false }, preview: { type: Boolean }, message: { state: true }, error: { state: true } };
  constructor() {
    super();
    this.preview = true;
    this.message = "";
    this.error = "";
    this.inputId = `monthly-url-${++nextId}`;
  }
  createRenderRoot() { return this; }

  async copy() {
    try {
      await copyMediaUrl(this.item!.url);
      this.error = "";
      this.message = "URL copied.";
    } catch (error) {
      const input = this.querySelector("input");
      input?.focus();
      input?.select();
      this.message = "";
      this.error = asError(error).message;
    }
  }

  render() {
    if (!this.item) return nothing;
    const { key, url, size } = this.item;
    const name = key.split("/").at(-1);
    const type = mediaType(key);
    const thumbnail = firstThumbnail(this.item);
    let preview: TemplateResult | typeof nothing = nothing;
    if (this.preview && type && (thumbnail || !["image/heic", "image/heif"].includes(type))) {
      preview = type.startsWith("audio/") ? html`<audio class="monthly-preview" src=${url} controls preload="none"></audio>` :
        type.startsWith("video/") ? html`<video class="monthly-preview" src=${url} poster=${thumbnail?.url ?? nothing} controls preload="none"></video>` :
          html`<img class="monthly-preview" src=${thumbnail?.url ?? url} alt=${name} loading="lazy">`;
    }
    return html`
      <wa-card class="monthly-asset-card">
        ${preview !== nothing ? html`<div slot="media" class="monthly-media-preview">${preview}</div>` : nothing}
        <div class="monthly-asset-meta">
          <wa-badge variant="neutral" appearance="outlined" pill>${type?.split("/")[0] || "Media"}</wa-badge>
          <span class="monthly-size">${formatBytes(size)}</span>
        </div>
        <a class="monthly-title" href=${url} title=${name} target="_blank" rel="noopener noreferrer">${name}</a>
        <label for=${this.inputId}>Public media URL</label>
        <div class="monthly-url-row">
          <input id=${this.inputId} type="url" readonly .value=${url}>
          <wa-button class="monthly-button monthly-icon" type="button" title="Copy URL" @click=${this.copy}>
            ${copyIcon}<span class="monthly-sr-only">Copy URL</span>
          </wa-button>
        </div>
        <span class="monthly-sr-only" role="status">${this.message}</span>
        ${this.error ? html`<wa-callout class="monthly-error" variant="danger" role="alert">${this.error}</wa-callout>` : nothing}
      </wa-card>
    `;
  }
}
