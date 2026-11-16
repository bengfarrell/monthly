import { LitElement, html, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { formatBytes } from "../shared/media-types.js";
import type { MediaUploader } from "../core/uploader.js";
import type { Unsubscribe } from "../core/store.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";
import "@awesome.me/webawesome/dist/components/badge/badge.js";
import "@awesome.me/webawesome/dist/components/progress-bar/progress-bar.js";

export class MonthlyUpload extends LitElement {
  declare model?: MediaUploader;
  observed?: MediaUploader | null;
  unsubscribe?: Unsubscribe;
  static properties = { model: { attribute: false } };
  createRenderRoot() { return this; }
  connectedCallback() { super.connectedCallback(); this.observe(); }
  willUpdate(changed: PropertyValues<this>) { if (changed.has("model")) this.observe(); }
  disconnectedCallback() { this.unsubscribe?.(); this.observed = null; super.disconnectedCallback(); }
  observe() {
    if (this.observed === this.model) return;
    this.unsubscribe?.();
    this.observed = this.model;
    this.unsubscribe = this.model?.subscribe(() => this.requestUpdate());
  }
  render() {
    if (!this.model) return nothing;
    const model = this.model;
    const state = model.state;
    return html`
      <div class="monthly-section-heading">
        <div><h2>Upload media</h2><p class="monthly-description">Add originals directly to your library, ready to share.</p></div>
        <wa-badge variant="neutral" pill>${state.files.length} / 20 queued</wa-badge>
      </div>
      <label>Upload month (UTC)
        <input type="month" aria-label="Upload month" .value=${state.month} ?disabled=${state.uploading} @change=${(event: Event) => model.setMonth((event.target as HTMLInputElement).value)}>
      </label>
      <div class="monthly-dropzone" @dragover=${(event: DragEvent) => event.preventDefault()} @drop=${(event: DragEvent) => {
        event.preventDefault();
        if (event.dataTransfer) model.addFiles(event.dataTransfer.files);
      }}>
        <strong>Drop your media here</strong>
        <p class="monthly-description">Images, video, and audio. Up to 20 files, 2 GiB each.</p>
        <label>Choose files or drop them here
          <input type="file" multiple aria-label="Choose files" ?disabled=${state.uploading} @change=${(event: Event) => {
            const input = event.target as HTMLInputElement;
            if (input.files) model.addFiles(input.files);
            input.value = "";
          }}>
        </label>
      </div>
      ${state.error ? html`<wa-callout class="monthly-error" variant="danger" role="alert">${state.error.message}</wa-callout>` : nothing}
      <ul class="monthly-queue">
        ${repeat(state.files, file => file.id, file => html`<li>
          <div class="monthly-queued-file"><strong>${file.name}</strong><span>${formatBytes(file.size)}</span></div>
          <wa-progress-bar .value=${file.progress} label=${`Upload progress for ${file.name}`}></wa-progress-bar>
          ${file.error ? html`<span class="monthly-error">${file.error}</span>` : nothing}
          ${file.complete ? html`<wa-badge variant="success" pill>Uploaded</wa-badge>` : nothing}
          <wa-button class="monthly-button" size="s" type="button" ?disabled=${state.uploading} @click=${() => model.removeFile(file.id)}>
            Remove<span class="monthly-sr-only"> ${file.name}</span>
          </wa-button>
        </li>`)}
      </ul>
      <div class="monthly-upload-actions">
        <wa-button class="monthly-button" variant="brand" type="button" ?disabled=${state.uploading || !state.files.some(file => !file.complete)} ?loading=${state.uploading} @click=${() => model.upload()}>Upload files</wa-button>
        <wa-button class="monthly-button" type="button" ?disabled=${!state.files.length} @click=${() => model.cancel()}>Cancel uploads</wa-button>
      </div>
      <wa-callout class="monthly-upload-status" variant=${state.uploading ? "brand" : "neutral"} role="status">
        ${state.uploading ? "Uploading. Keep this page open." : state.summary || "Choose files to start uploading."}
      </wa-callout>
      ${state.uploaded.length ? html`<h3>Uploaded URLs</h3><ul class="monthly-grid">
        ${repeat(state.uploaded, (item, index) => `${item.key}-${index}`, item => html`<li><monthly-asset .item=${item} .preview=${false}></monthly-asset></li>`)}
      </ul>` : nothing}
    `;
  }
}
