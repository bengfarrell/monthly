import { Store } from "./store.js";
import { currentMonth, validateMonth } from "../shared/media-types.js";
import { validatePostsJson } from "../shared/posts.js";
import { asError } from "../shared/errors.js";
import type { MediaApi, PostsFile } from "./api.js";

export interface PostsEditorState {
  month: string;
  file: PostsFile | null;
  content: string;
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  saved: boolean;
  postCount: number | null;
  validationError: Error | null;
  error: Error | null;
}

export class PostsEditor extends Store<PostsEditorState> {
  #revision = 0;
  #abort?: AbortController;
  #destroyed = false;

  constructor(readonly api: Pick<MediaApi, "getPostsFile" | "savePostsFile">, { month = currentMonth() } = {}) {
    super({ month, file: null, content: "", dirty: false, loading: false, saving: false, saved: false,
      postCount: null, validationError: null, error: null });
  }

  setMonth(month: string) {
    if (month === this.state.month) return true;
    try {
      validateMonth(month, true);
      if (this.state.dirty || this.state.saving) throw new Error("Save or discard JSON changes before switching months.");
      this.reset();
      this.setState({ month });
      return true;
    } catch (error) { this.setState({ error: asError(error) }); return false; }
  }

  #validate(content: string, file: PostsFile) {
    try {
      const posts = validatePostsJson(content, this.state.month, file);
      this.setState({ validationError: null, postCount: posts.length });
      return true;
    } catch (error) {
      this.setState({ validationError: asError(error), postCount: null });
      return false;
    }
  }

  async load() {
    if (this.#destroyed || this.state.loading || this.state.saving) return false;
    if (this.state.dirty) {
      this.setState({ error: new Error("Discard JSON changes before reloading the file.") });
      return false;
    }
    const revision = ++this.#revision;
    const month = this.state.month;
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    this.setState({ loading: true, saved: false, error: null });
    if (revision !== this.#revision) return false;
    try {
      const file = await this.api.getPostsFile(month, abort.signal);
      if (revision !== this.#revision) return false;
      this.setState({ file, content: file.content, dirty: false, loading: false });
      this.#validate(file.content, file);
      return true;
    } catch (error) {
      if (revision === this.#revision) this.setState({ loading: false, error: asError(error) });
      return false;
    }
  }

  setContent(content: string) {
    const file = this.state.file;
    if (!file || this.state.loading || this.state.saving || this.#destroyed) return;
    this.setState({ content, dirty: content !== file.content, saved: false, error: null });
    this.#validate(content, file);
  }

  discard() {
    if (this.state.loading || this.state.saving) return;
    if (this.state.file) this.setContent(this.state.file.content);
  }

  async save() {
    const original = this.state.file;
    if (this.#destroyed || this.state.saving || this.state.loading) return false;
    if (!original) {
      this.setState({ error: new Error("Load a monthly posts file before saving.") });
      return false;
    }
    if (!this.#validate(this.state.content, original) || !this.state.dirty) return false;
    const revision = ++this.#revision;
    const month = this.state.month;
    const abort = new AbortController();
    this.#abort = abort;
    const content = this.state.content;
    this.setState({ saving: true, saved: false, error: null });
    if (revision !== this.#revision) return false;
    try {
      const file = await this.api.savePostsFile(month, content, original.etag, abort.signal);
      if (revision !== this.#revision) return false;
      if (file.key !== original.key || file.url !== original.url || file.content !== content) {
        throw new Error("The saved posts file differs from your edits. Reload it before editing again.");
      }
      this.setState({ file, dirty: false, saving: false, saved: true });
      return true;
    } catch (error) {
      if (revision === this.#revision) this.setState({ saving: false, error: asError(error) });
      return false;
    }
  }

  reset() {
    this.#revision++;
    this.#abort?.abort();
    this.setState({ file: null, content: "", dirty: false, loading: false, saving: false, saved: false,
      postCount: null, validationError: null, error: null });
  }

  destroy() { this.#destroyed = true; this.reset(); }
}
