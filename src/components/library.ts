import { LitElement, html, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { refreshIcon } from "./icons.js";
import type { MediaLibrary } from "../core/library.js";
import type { PostsEditor } from "../core/posts-editor.js";
import type { Unsubscribe } from "../core/store.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";
import "@awesome.me/webawesome/dist/components/badge/badge.js";

let nextId = 0;

export class MonthlyLibrary extends LitElement {
  declare model?: MediaLibrary;
  declare editor?: PostsEditor | null;
  inputId: string;
  observed?: MediaLibrary | null;
  observedEditor?: PostsEditor | null;
  unsubscribe?: Unsubscribe;
  unsubscribeEditor?: Unsubscribe;
  static properties = { model: { attribute: false }, editor: { attribute: false } };
  constructor() { super(); this.inputId = `monthly-month-${++nextId}`; }
  createRenderRoot() { return this; }
  connectedCallback() { super.connectedCallback(); this.observe(); }
  willUpdate(changed: PropertyValues<this>) { if (changed.has("model") || changed.has("editor")) this.observe(); }
  disconnectedCallback() {
    this.unsubscribe?.(); this.unsubscribeEditor?.();
    this.observed = this.observedEditor = null;
    super.disconnectedCallback();
  }
  observe() {
    if (this.observed === this.model && this.observedEditor === this.editor) return;
    this.unsubscribe?.();
    this.unsubscribeEditor?.();
    this.observed = this.model;
    this.observedEditor = this.editor;
    this.unsubscribe = this.model?.subscribe(() => {
      this.syncMonth();
      this.requestUpdate();
    });
    this.unsubscribeEditor = this.editor?.subscribe(() => this.requestUpdate());
    this.syncMonth();
  }
  syncMonth() {
    if (this.model && this.editor) this.editor.setMonth(this.model.state.month);
  }
  render() {
    if (!this.model) return nothing;
    const model = this.model;
    const state = model.state;
    return html`
      <div class="monthly-section-heading">
        <div><h2>Your library</h2><p class="monthly-description">Find a month, pick an asset, and copy its link.</p></div>
        <wa-badge variant="neutral" pill>${state.items.length} loaded</wa-badge>
      </div>
      <form @submit=${(event: SubmitEvent) => { event.preventDefault(); model.refresh(); }}>
        <label for=${this.inputId}>Browse month (leave blank for all months)</label>
          <div class="monthly-month-row">
            <input id=${this.inputId} type="month" aria-label="Browse month" .value=${state.month}
              ?disabled=${this.editor?.state.dirty || this.editor?.state.saving}
              @change=${(event: Event) => model.load((event.target as HTMLInputElement).value)}>
            <wa-button class="monthly-button monthly-icon" type="submit" title="Refresh library" ?disabled=${state.loading} ?loading=${state.loading}>
              ${refreshIcon}<span class="monthly-sr-only">Refresh library</span>
            </wa-button>
          </div>
      </form>
      ${this.editor ? html`<monthly-posts-editor .model=${this.editor}></monthly-posts-editor>` : nothing}
      ${state.error ? html`<wa-callout class="monthly-error" variant="danger" role="alert">${state.error.message}</wa-callout>` : nothing}
      <span class="monthly-sr-only" role="status">${state.loading ? "Loading media library." : state.loaded ? "Media library loaded." : ""}</span>
      ${state.loaded && !state.items.length ? html`<wa-callout class="monthly-empty" variant="neutral">
        <strong>No media found for this month.</strong>
        <p>Choose another month or clear the filter to browse everything.</p>
      </wa-callout>` : nothing}
      <ul class="monthly-grid">
        ${repeat(state.items, item => item.key, item => html`<li><monthly-asset .item=${item}></monthly-asset></li>`)}
      </ul>
      ${state.cursor ? html`<wa-button class="monthly-button" type="button" ?disabled=${state.loading} @click=${() => model.more()}>Load more</wa-button>` : nothing}
    `;
  }
}
