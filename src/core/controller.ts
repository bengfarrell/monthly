import { Store } from "./store.js";
import { MediaAuth } from "./auth.js";
import { MediaApi } from "./api.js";
import { MediaLibrary } from "./library.js";
import { MediaUploader } from "./uploader.js";
import { PostComposer } from "./composer.js";
import { PostsEditor } from "./posts-editor.js";
import type { MediaApiOptions } from "./api.js";
import type { Unsubscribe } from "./store.js";
import { asError } from "../shared/errors.js";

export type MediaTab = "browse" | "upload" | "post";
export interface ControllerState {
  authenticated: boolean;
  signingIn: boolean;
  uploading: boolean;
  postsDirty: boolean;
  tab: MediaTab;
  error: Error | null;
}
export interface MediaControllerOptions extends Omit<MediaApiOptions, "auth" | "onUnauthorized"> {
  uploaderFactory?: (api: MediaApi) => MediaUploader;
}

export class MediaController extends Store<ControllerState> {
  #attempt = 0;
  #unsubscribeUploader: Unsubscribe | null = null;
  #unsubscribeComposer: Unsubscribe | null = null;
  #unsubscribeEditor: Unsubscribe | null = null;
  auth: MediaAuth;
  api: MediaApi;
  library: MediaLibrary;
  uploaderFactory: (api: MediaApi) => MediaUploader;
  uploader: MediaUploader | null;
  composer: PostComposer | null = null;
  postsEditor: PostsEditor | null = null;

  constructor({ uploaderFactory = api => new MediaUploader(api), ...options }: MediaControllerOptions) {
    super({ authenticated: false, signingIn: false, uploading: false, postsDirty: false, tab: "browse", error: null });
    this.auth = new MediaAuth();
    this.api = new MediaApi({
      ...options, auth: this.auth,
      onUnauthorized: error => {
        this.signOut(true);
        this.setState({ error });
      },
    });
    this.library = new MediaLibrary(this.api);
    this.uploaderFactory = uploaderFactory;
    this.uploader = null;
  }

  async signIn(username: string, password: string) {
    if (this.state.signingIn) return false;
    if (this.state.authenticated) {
      this.setState({ error: new Error("Sign out before signing in with another account.") });
      return false;
    }
    const attempt = ++this.#attempt;
    this.setState({ signingIn: true, error: null });
    try {
      this.auth.login(username, password);
      const loaded = await this.library.refresh();
      if (attempt !== this.#attempt) return false;
      if (!loaded) throw this.library.state.error || new Error("Could not load the media library.");
      this.uploader = this.uploaderFactory(this.api);
      const updateBusy = () => this.setState({
        uploading: !!(this.uploader?.state.uploading || this.composer?.state.publishing || this.postsEditor?.state.saving),
        postsDirty: !!this.postsEditor?.state.dirty,
      });
      this.#unsubscribeUploader = this.uploader.subscribe(updateBusy);
      this.composer = new PostComposer(this.api);
      this.#unsubscribeComposer = this.composer.subscribe(updateBusy);
      this.postsEditor = new PostsEditor(this.api, { month: this.library.state.month });
      this.#unsubscribeEditor = this.postsEditor.subscribe(updateBusy);
      this.setState({ authenticated: true, tab: "browse" });
      return true;
    } catch (error) {
      if (attempt === this.#attempt) {
        this.auth.clear();
        this.setState({ authenticated: false, error: asError(error) });
      }
      return false;
    } finally {
      if (attempt === this.#attempt) this.setState({ signingIn: false });
    }
  }

  selectTab(tab: MediaTab) {
    if (!["browse", "upload", "post"].includes(tab)) throw new Error("Unknown media tab.");
    if (this.state.authenticated) this.setState({ tab });
  }

  signOut(force = false) {
    if (this.state.uploading && !force) {
      this.setState({ error: new Error("Finish or cancel uploads and wait for post saves before signing out.") });
      return false;
    }
    if (this.postsEditor?.state.dirty && !force) {
      this.setState({ error: new Error("Save or discard JSON changes before signing out.") });
      return false;
    }
    this.#attempt++;
    this.#unsubscribeUploader?.();
    this.#unsubscribeUploader = null;
    this.#unsubscribeComposer?.();
    this.#unsubscribeComposer = null;
    this.#unsubscribeEditor?.();
    this.#unsubscribeEditor = null;
    this.postsEditor?.destroy();
    this.postsEditor = null;
    this.composer?.destroy();
    this.composer = null;
    this.uploader?.destroy();
    this.uploader = null;
    this.auth.clear();
    this.library.reset();
    this.setState({ authenticated: false, signingIn: false, uploading: false, postsDirty: false, tab: "browse", error: null });
    return true;
  }

  destroy() { this.signOut(true); }
}
