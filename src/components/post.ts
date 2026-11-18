import { LitElement, html, nothing, type PropertyValues } from "lit";
import type { PostComposer } from "../core/composer.js";
import type { Unsubscribe } from "../core/store.js";
import { MAX_POST_LENGTH } from "../shared/posts.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";

export class MonthlyPost extends LitElement {
  declare model?: PostComposer;
  observed?: PostComposer;
  unsubscribe?: Unsubscribe;
  static properties = { model: { attribute: false } };
  createRenderRoot() { return this; }
  connectedCallback() { super.connectedCallback(); this.observe(); }
  willUpdate(changed: PropertyValues<this>) { if (changed.has("model")) this.observe(); }
  disconnectedCallback() { this.unsubscribe?.(); this.observed = undefined; super.disconnectedCallback(); }
  observe() {
    if (this.observed === this.model) return;
    this.unsubscribe?.();
    this.observed = this.model;
    this.unsubscribe = this.model?.subscribe(() => this.requestUpdate());
  }
  async publish(event: SubmitEvent) {
    event.preventDefault();
    const model = this.model;
    if (model && await model.publish()) {
      this.dispatchEvent(new CustomEvent("monthly-posted", { detail: model.state.posted, bubbles: true, composed: true }));
    }
  }
  render() {
    const model = this.model;
    if (!model) return nothing;
    const state = model.state;
    const disabled = state.publishing || state.pending;
    return html`
      <div class="monthly-section-heading"><div><h2>New post</h2>
        <p class="monthly-description">Share a short update, with optional images, video, or audio.</p></div></div>
      <form class="monthly-compose" @submit=${this.publish}>
        <label>Message<textarea name="message" rows="5" maxlength=${MAX_POST_LENGTH} .value=${state.text}
          ?disabled=${disabled} @input=${(event: Event) => model.setText((event.target as HTMLTextAreaElement).value)}></textarea></label>
        <label>Tags (comma-separated)<input name="tags" type="text" .value=${state.tags} ?disabled=${disabled}
          @input=${(event: Event) => model.setTags((event.target as HTMLInputElement).value)}></label>
        <p class="monthly-description">Hashtags in your message are added to the tags automatically.</p>
        <monthly-upload .model=${model.uploader} posting .disabled=${disabled}></monthly-upload>
        ${state.error ? html`<wa-callout class="monthly-error" variant="danger" role="alert">${state.error.message}</wa-callout>` : nothing}
        ${state.pending && !state.publishing ? html`<p class="monthly-description">Retry sends the same post without re-uploading media or creating a duplicate.</p>` : nothing}
        <div class="monthly-upload-actions">
          <wa-button class="monthly-button" variant="brand" type="submit" ?disabled=${state.publishing} ?loading=${state.publishing}>${state.pending ? "Retry post" : "Publish post"}</wa-button>
          <wa-button class="monthly-button" type="button" ?disabled=${state.publishing} @click=${() => model.reset()}>New post</wa-button>
        </div>
      </form>
      ${state.posted ? html`<wa-callout variant="success" role="status">Post published.</wa-callout>` : nothing}
    `;
  }
}
