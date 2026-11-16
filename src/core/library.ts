import { Store } from "./store.js";
import { currentMonth, validateMonth } from "../shared/media-types.js";
import type { MediaItem } from "../shared/media-types.js";
import type { MediaApi } from "./api.js";
import { asError } from "../shared/errors.js";

export interface LibraryState {
  month: string;
  items: MediaItem[];
  cursor: string | null;
  loading: boolean;
  loaded: boolean;
  error: Error | null;
}

export class MediaLibrary extends Store<LibraryState> {
  #revision = 0;
  #abort?: AbortController;
  api: Pick<MediaApi, "list">;

  constructor(api: Pick<MediaApi, "list">, { month = currentMonth() } = {}) {
    super({ month, items: [], cursor: null, loading: false, loaded: false, error: null });
    this.api = api;
  }

  async load(month = this.state.month, append = false) {
    if (append && (this.state.loading || !this.state.cursor)) return false;
    try { validateMonth(month, true); }
    catch (error) { this.setState({ error: asError(error) }); return false; }
    const revision = ++this.#revision;
    this.#abort?.abort();
    this.#abort = new AbortController();
    const cursor = append ? this.state.cursor : null;
    this.setState({ month, loading: true, error: null });
    try {
      const page = await this.api.list({ month, cursor, signal: this.#abort.signal });
      if (revision !== this.#revision) return false;
      this.setState({
        items: append ? [...this.state.items, ...page.items] : [...page.items],
        cursor: page.cursor, loaded: true, loading: false,
      });
      return true;
    } catch (error) {
      if (revision === this.#revision) this.setState({ loading: false, error: asError(error) });
      return false;
    }
  }

  more() { return this.load(this.state.month, true); }
  refresh() { return this.load(); }

  reset() {
    this.#revision++;
    this.#abort?.abort();
    this.setState({ items: [], cursor: null, loading: false, loaded: false, error: null });
  }
}
