import { Store } from "./store.js";
import { httpsUrl } from "../shared/media-types.js";
import { POSTS_FILE, feedMonths, readPosts, type Post } from "../shared/posts.js";
import { asError } from "../shared/errors.js";

export interface FeedState { posts: Post[]; loading: boolean; loaded: boolean; errors: Error[] }
export interface PostFeedOptions { baseUrl: string; fetch?: typeof globalThis.fetch; now?: () => Date }

export class PostFeed extends Store<FeedState> {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => Date;
  #request?: AbortController;
  constructor({ baseUrl, fetch: request = (...args) => globalThis.fetch(...args), now = () => new Date() }: PostFeedOptions) {
    super({ posts: [], loading: false, loaded: false, errors: [] });
    const url = httpsUrl(baseUrl);
    if (url.search || url.hash) throw new Error("Feed base URL must not include a query or fragment.");
    this.baseUrl = `${url.href.replace(/\/+$/, "")}/`;
    this.fetch = request;
    this.now = now;
  }

  async load() {
    this.#request?.abort();
    const request = this.#request = new AbortController();
    this.setState({ loading: true, errors: [] });
    const results = await Promise.all(feedMonths(this.now()).map(async month => {
      try {
        const url = `${this.baseUrl}${month.replace("-", "/")}/${POSTS_FILE}`;
        const response = await this.fetch(url, {
          credentials: "omit", referrerPolicy: "no-referrer", cache: "no-cache",
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
        });
        if (response.status === 404) return { posts: [], warning: new Error(`Posts for ${month}: No posts file (HTTP 404).`) };
        if (!response.ok) throw new Error(`Could not load posts for ${month} (HTTP ${response.status}).`);
        return { posts: readPosts(await response.json(), month) };
      } catch (error) {
        return { posts: [], error: new Error(`Posts for ${month}: ${asError(error).message}`) };
      }
    }));
    if (request.signal.aborted) return;
    for (const result of results) {
      const warning = result.error ?? result.warning;
      if (warning) console.warn("Monthly feed:", warning.message);
    }
    this.setState({
      posts: results.flatMap(result => result.posts).sort((a, b) => b.created.localeCompare(a.created)),
      errors: results.flatMap(result => result.error ? [result.error] : []),
      loading: false, loaded: true,
    });
  }

  destroy() { this.#request?.abort(); }
}
