import { Store } from "./store.js";
import { MediaUploader } from "./uploader.js";
import type { MediaApi } from "./api.js";
import { currentMonth } from "../shared/media-types.js";
import { postTags, validatePostInput, type Post, type PostInput } from "../shared/posts.js";
import { asError } from "../shared/errors.js";

export interface ComposerState {
  text: string;
  tags: string;
  publishing: boolean;
  pending: boolean;
  error: Error | null;
  posted: Post | null;
}

export class PostComposer extends Store<ComposerState> {
  uploader: MediaUploader;
  #pending?: PostInput;
  #destroyed = false;
  constructor(
    readonly api: Pick<MediaApi, "post" | "prepare" | "sign" | "setThumbnails">,
    uploader = new MediaUploader(api),
    readonly now = () => new Date(),
  ) {
    super({ text: "", tags: "", publishing: false, pending: false, error: null, posted: null });
    this.uploader = uploader;
  }

  setText(text: string) { if (!this.state.publishing && !this.state.pending) this.setState({ text }); }
  setTags(tags: string) { if (!this.state.publishing && !this.state.pending) this.setState({ tags }); }

  async publish() {
    if (this.state.publishing || this.#destroyed) return false;
    this.setState({ publishing: true, error: null, posted: null });
    try {
      const month = currentMonth(this.now());
      if (!this.#pending) {
        if (this.uploader.state.month !== month && this.uploader.state.files.some(file => file.complete)) {
          throw new Error("The month changed after uploading. Start a new post to upload into the current month.");
        }
        if (this.uploader.state.month !== month && !this.uploader.setMonth(month)) throw this.uploader.state.error;
        const draft = {
          id: crypto.randomUUID(), text: this.state.text,
          tags: postTags(this.state.text, this.state.tags.split(",")), media: [],
        };
        validatePostInput({ ...draft, media: this.uploader.state.files.map(file => ({ key: file.name, size: file.size })) });
        if (this.uploader.state.files.some(file => !file.complete)) {
          await this.uploader.upload();
          if (this.#destroyed) return false;
          if (this.uploader.state.error || this.uploader.state.files.some(file => !file.complete) || !this.uploader.state.files.length) {
            throw this.uploader.state.error || new Error("Finish all media uploads before posting. Retry to keep completed uploads.");
          }
        }
        this.#pending = { ...draft, media: this.uploader.completedMedia() };
        this.setState({ pending: true });
      }
      const posted = await this.api.post(this.#pending, this.uploader.state.month);
      if (this.#destroyed) return false;
      this.#pending = undefined;
      this.uploader.clear();
      this.setState({ text: "", tags: "", pending: false, posted });
      return true;
    } catch (error) {
      if (!this.#destroyed) this.setState({ error: asError(error) });
      return false;
    } finally {
      if (!this.#destroyed) this.setState({ publishing: false });
    }
  }

  reset() {
    if (this.state.publishing) return;
    this.#pending = undefined;
    this.uploader.clear();
    this.uploader.setMonth(currentMonth(this.now()));
    this.setState({ text: "", tags: "", pending: false, error: null, posted: null });
  }

  destroy() { this.#destroyed = true; this.uploader.destroy(); }
}
