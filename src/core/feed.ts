import { Store } from "./store.js";
import { httpsUrl, validateMonth } from "../shared/media-types.js";
import { POSTS_FILE, feedMonths, readPosts, type Post } from "../shared/posts.js";
import { asError } from "../shared/errors.js";

export interface FeedState { posts: Post[]; loading: boolean; loaded: boolean; errors: Error[] }
export interface PostFeedOptions { baseUrl: string; fetch?: typeof globalThis.fetch; now?: () => Date }

export class PostFeed extends Store<FeedState> {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => Date;
  #request?: AbortController;
  #postRequests = new Set<AbortController>();
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
        const posts = await this.#loadMonth(month, request.signal);
        return posts ? { posts } : { posts: [], warning: new Error(`Posts for ${month}: No posts file (HTTP 404).`) };
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

  async #loadMonth(month: string, signal: AbortSignal): Promise<Post[] | undefined> {
    const response = await this.fetch(`${this.baseUrl}${month.replace("-", "/")}/${POSTS_FILE}`, {
      credentials: "omit", referrerPolicy: "no-referrer", cache: "no-cache",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    signal.throwIfAborted();
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Could not load posts for ${month} (HTTP ${response.status}).`);
    const posts = readPosts(await response.json(), month);
    signal.throwIfAborted();
    return posts;
  }

  async loadPost(id: string, month: string, signal?: AbortSignal): Promise<Post | undefined> {
    validateMonth(month);
    signal?.throwIfAborted();
    const existing = this.state.posts.find(post => post.id === id && post.created.startsWith(month));
    if (existing) return existing;
    if (this.state.loaded && !this.state.loading && feedMonths(this.now()).includes(month)) {
      if (this.state.errors.length) throw new Error("Recent posts could not be loaded.");
      return undefined;
    }
    const request = new AbortController();
    this.#postRequests.add(request);
    try {
      const posts = await this.#loadMonth(month, signal ? AbortSignal.any([signal, request.signal]) : request.signal);
      if (!posts) console.warn("Monthly feed:", `Posts for ${month}: No posts file (HTTP 404).`);
      return posts?.find(post => post.id === id);
    } finally {
      this.#postRequests.delete(request);
    }
  }

  destroy() {
    this.#request?.abort();
    for (const request of this.#postRequests) request.abort();
    this.#postRequests.clear();
  }
}
