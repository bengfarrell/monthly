import { LitElement, html, nothing, type PropertyValues } from "lit";
import type { PostsEditor } from "../core/posts-editor.js";
import type { Unsubscribe } from "../core/store.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";

let nextId = 0;

export class MonthlyPostsEditor extends LitElement {
  declare model?: PostsEditor;
  observed?: PostsEditor | null;
  unsubscribe?: Unsubscribe;
  validationId = `monthly-json-validation-${++nextId}`;
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
  async save() {
    const model = this.model;
    if (model && await model.save()) {
      this.dispatchEvent(new CustomEvent("monthly-posts-saved", { detail: { month: model.state.month, file: model.state.file },
        bubbles: true, composed: true }));
    }
  }
  render() {
    if (!this.model) return nothing;
    const model = this.model;
    const state = model.state;
    const busy = state.loading || state.saving;
    return html`<section class="monthly-json-editor" aria-label="Monthly posts file">
      <h3>${state.month ? `${state.month}/posts.json` : "Monthly posts JSON"}</h3>
      <p class="monthly-description">Edit the month's posts JSON in place. Saving replaces the whole file, not its media uploads.</p>
      ${!state.file ? html`<wa-button class="monthly-button" type="button" ?disabled=${!state.month || busy} ?loading=${state.loading}
        @click=${() => model.load()}>Edit posts.json</wa-button>` : nothing}
      ${!state.month ? html`<p class="monthly-description">Select a single month to edit its posts.json.</p>` : nothing}
      ${state.file ? html`
        <p class="monthly-json-key">${state.file.key}</p>
        <label>Monthly posts JSON<textarea rows="18" spellcheck="false" aria-describedby=${this.validationId}
          aria-invalid=${String(!!state.validationError)} .value=${state.content} ?disabled=${busy}
          @input=${(event: Event) => model.setContent((event.target as HTMLTextAreaElement).value)}></textarea></label>
        <div id=${this.validationId}>
          ${state.validationError ? html`<wa-callout class="monthly-error" variant="danger" role="alert">${state.validationError.message}</wa-callout>` :
            html`<p role="status">Valid JSON: ${state.postCount} ${state.postCount === 1 ? "post" : "posts"}.</p>`}
        </div>
        ${state.dirty ? html`<p class="monthly-description">Unsaved changes. Save or discard them before changing months or signing out.</p>` : nothing}
        <div class="monthly-upload-actions">
          <wa-button class="monthly-button" variant="brand" type="button" ?disabled=${busy || !state.dirty || !!state.validationError}
            ?loading=${state.saving} @click=${this.save}>Save posts.json</wa-button>
          <wa-button class="monthly-button" type="button" ?disabled=${busy || !state.dirty} @click=${() => model.discard()}>Discard JSON changes</wa-button>
          <wa-button class="monthly-button" type="button" ?disabled=${busy || state.dirty} ?loading=${state.loading}
            @click=${() => model.load()}>Reload posts.json</wa-button>
        </div>` : nothing}
      ${state.error ? html`<wa-callout class="monthly-error" variant="danger" role="alert">${state.error.message}</wa-callout>` : nothing}
      ${state.saved ? html`<wa-callout variant="success" role="status">Saved posts.json.</wa-callout>` : nothing}
    </section>`;
  }
}
