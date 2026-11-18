import { LitElement, html, nothing, type PropertyValues } from "lit";
import { MediaController } from "../core/controller.js";
import type { MediaTab } from "../core/controller.js";
import type { Unsubscribe } from "../core/store.js";
import { asError } from "../shared/errors.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/card/card.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";
import "@awesome.me/webawesome/dist/components/badge/badge.js";

let nextId = 0;

export class MonthlyMedia extends LitElement {
  declare apiUrl?: string;
  declare bucket?: string;
  declare controller?: MediaController;
  declare configurationError?: Error | null;
  idPrefix: string;
  unsubscribe?: Unsubscribe;
  observed?: MediaController | null;
  owned?: MediaController | null;
  static properties = { apiUrl: { attribute: "api-url" }, bucket: {}, controller: { attribute: false }, configurationError: { state: true } };
  constructor() {
    super();
    this.idPrefix = `monthly-${++nextId}`;
  }
  createRenderRoot() { return this; }
  connectedCallback() { super.connectedCallback(); this.syncController(); }
  disconnectedCallback() {
    this.unsubscribe?.();
    this.observed = null;
    this.owned?.destroy();
    this.owned = null;
    super.disconnectedCallback();
  }
  willUpdate(changed: PropertyValues<this>) {
    if (changed.has("apiUrl") || changed.has("bucket") || changed.has("controller")) this.syncController();
  }
  syncController() {
    if (this.controller) this.configurationError = null;
    if (this.controller && this.owned) {
      this.owned.destroy();
      this.owned = null;
    }
    if (!this.controller && (!this.owned || this.owned.api.config.apiUrl !== this.apiUrl || this.owned.api.config.bucket !== this.bucket)) {
      this.owned?.destroy();
      try {
        this.owned = new MediaController({ apiUrl: this.apiUrl ?? "", bucket: this.bucket ?? "" });
        this.configurationError = null;
      } catch (error) {
        this.owned = null;
        this.configurationError = asError(error);
      }
    }
    const active = this.controller || this.owned;
    if (this.observed === active) return;
    this.unsubscribe?.();
    this.observed = active;
    this.unsubscribe = active?.subscribe(() => this.requestUpdate());
  }
  async signIn(event: SubmitEvent) {
    event.preventDefault();
    const form = this.querySelector<HTMLFormElement>("form.monthly-login")!;
    const username = form.elements.namedItem("username") as HTMLInputElement;
    const password = form.elements.namedItem("password") as HTMLInputElement;
    try { await this.observed!.signIn(username.value, password.value); }
    finally { username.value = ""; password.value = ""; }
  }
  submitOnEnter(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.isComposing && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      if (!this.observed?.state.signingIn) (event.currentTarget as HTMLFormElement).requestSubmit();
    }
  }
  navigate(event: KeyboardEvent, tab: MediaTab) {
    const tabs: MediaTab[] = ["browse", "upload", "post"];
    const index = tabs.indexOf(tab);
    const keys: Record<string, MediaTab> = { Home: "browse", End: "post", ArrowLeft: tabs[(index + 2) % 3], ArrowRight: tabs[(index + 1) % 3] };
    if (!keys[event.key]) return;
    event.preventDefault();
    this.observed!.selectTab(keys[event.key]);
    this.querySelector<HTMLButtonElement>(`#${this.idPrefix}-${keys[event.key]}-tab`)!.focus();
  }
  render() {
    if (this.configurationError) return html`<wa-callout class="monthly-error" variant="danger" role="alert">${this.configurationError.message}</wa-callout>`;
    const controller = this.observed;
    if (!controller) return nothing;
    const state = controller.state;
    const formId = `${this.idPrefix}-login`;
    return html`
      <header class="monthly-heading">
        <div>
          <p class="monthly-eyebrow">Monthly</p>
          <h1>Media library</h1>
          <p class="monthly-description">A home for your images, video, and audio.</p>
        </div>
        <wa-badge variant=${state.authenticated ? "success" : "neutral"} appearance="filled" pill>
          ${state.authenticated ? "Signed in" : "Private workspace"}
        </wa-badge>
      </header>
      <div class="monthly-toolbar">
        <div class="monthly-tabs" role="tablist" aria-label="Media">
          ${(["browse", "upload", "post"] as const).map(tab => html`<button class="monthly-tab" id=${`${this.idPrefix}-${tab}-tab`}
            role="tab" type="button" aria-controls=${`${this.idPrefix}-${tab}-panel`}
            aria-selected=${String(state.tab === tab)} tabindex=${state.tab === tab ? "0" : "-1"}
            ?disabled=${!state.authenticated} @click=${() => controller.selectTab(tab)}
            @keydown=${(event: KeyboardEvent) => this.navigate(event, tab)}>${{ browse: "Browse", upload: "Upload", post: "Post" }[tab]}</button>`)}
        </div>
        <div class="monthly-auth-actions">
          ${state.authenticated ? html`<wa-button class="monthly-button" size="s" type="button" ?disabled=${state.uploading} @click=${() => controller.signOut()}>Sign out</wa-button>` :
            html`<wa-button class="monthly-button" variant="brand" size="s" type="submit" form=${formId} ?disabled=${state.signingIn} ?loading=${state.signingIn}>Sign in</wa-button>`}
        </div>
      </div>
      ${state.error ? html`<wa-callout class="monthly-error" variant="danger" role="alert">${state.error.message}</wa-callout>` : nothing}
      <wa-card class="monthly-signin-card" ?hidden=${state.authenticated}>
        <div slot="header">
          <h2>Sign in to your media</h2>
          <p class="monthly-description">Your credentials stay in this browser session.</p>
        </div>
        <form id=${formId} class="monthly-login" method="post" autocomplete="on" @submit=${this.signIn} @keydown=${this.submitOnEnter}>
          <label>Username<input name="username" type="text" maxlength="128" required autocomplete="username"></label>
          <label>Password<input name="password" type="password" maxlength="1024" required autocomplete="current-password"></label>
        </form>
      </wa-card>
      <div ?hidden=${!state.authenticated}>
        <div id=${`${this.idPrefix}-browse-panel`} role="tabpanel" aria-labelledby=${`${this.idPrefix}-browse-tab`} tabindex="0" ?hidden=${state.tab !== "browse"}>
          <monthly-library .model=${controller.library}></monthly-library>
        </div>
        <div id=${`${this.idPrefix}-upload-panel`} role="tabpanel" aria-labelledby=${`${this.idPrefix}-upload-tab`} tabindex="0" ?hidden=${state.tab !== "upload"}>
          <monthly-upload .model=${controller.uploader}></monthly-upload>
        </div>
        <div id=${`${this.idPrefix}-post-panel`} role="tabpanel" aria-labelledby=${`${this.idPrefix}-post-tab`} tabindex="0" ?hidden=${state.tab !== "post"}>
          <monthly-post .model=${controller.composer}></monthly-post>
        </div>
      </div>
    `;
  }
}
