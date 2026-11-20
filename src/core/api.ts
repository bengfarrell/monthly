import { MediaAuth } from "./auth.js";
import { PART_SIZE, httpsUrl, isRecord, mediaType, readThumbnails, thumbnailInputs, validateThumbnails, validateConnection, validateFile, validateMonth, validatePoster } from "../shared/media-types.js";
import type { MediaFile, MediaItem, Thumbnails } from "../shared/media-types.js";
import { POSTS_FILE, readPosts, validatePostsJson, validatePostsFileSize, validatePostsEtag, type PostInput } from "../shared/posts.js";

export interface MediaApiOptions {
  apiUrl: string;
  bucket: string;
  auth?: MediaAuth;
  fetch?: typeof globalThis.fetch;
  onUnauthorized?: (error: MediaApiError) => void;
}
export interface ListOptions { month?: string; cursor?: string | null; signal?: AbortSignal }
export interface MediaPage { items: MediaItem[]; cursor: string | null; bucket?: string }
export interface PostsFile { key: string; url: string; etag: string; content: string }
export interface UploadGrant { key: string; ticket: string; url: string; partSize: number; bucket?: string }
export interface SignRequest {
  key: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  uploadId?: string;
  partNumber?: number;
  expiresIn?: number;
  contentType?: string;
}
export interface SignedUpload { url: string; key: string; headers?: Record<string, string> }

export class MediaApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "MediaApiError";
    this.status = status;
  }
}

export class MediaApi {
  config: Readonly<{ apiUrl: string; bucket: string }>;
  auth: MediaAuth;
  fetch: typeof globalThis.fetch;
  onUnauthorized?: (error: MediaApiError) => void;

  constructor({ apiUrl, bucket, auth = new MediaAuth(), fetch: request = (...args) => globalThis.fetch(...args), onUnauthorized }: MediaApiOptions) {
    this.config = validateConnection(apiUrl, bucket);
    this.auth = auth;
    this.fetch = request;
    this.onUnauthorized = onUnauthorized;
  }

  async request(path: string, body?: object, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const version = this.auth.version;
    const url = new URL(`${this.config.apiUrl}${path}`);
    if (!body) url.searchParams.set("bucket", this.config.bucket);
    const response = await this.fetch(url.href, {
      method: body ? "POST" : "GET",
      headers: { Authorization: this.auth.authorization, ...(body && { "Content-Type": "application/json" }) },
      ...(body && { body: JSON.stringify({ ...body, bucket: this.config.bucket }) }),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new MediaApiError(`Invalid JSON response from the media API (HTTP ${response.status}).`, response.status); }
    if (version !== this.auth.version) throw new Error("Sign-in changed during the request.");
    if (!isRecord(data)) throw new Error("Invalid media API response.");
    if (!response.ok) {
      const error = new MediaApiError(
        response.status === 401 ? "Invalid username or password. Sign in again." :
          (typeof data.error === "string" && data.error) || (typeof data.message === "string" && data.message) || `Media API returned HTTP ${response.status}.`,
        response.status,
      );
      if (response.status === 401) this.onUnauthorized?.(error);
      throw error;
    }
    if (data.bucket !== this.config.bucket) throw new Error("The media API returned a different bucket.");
    return data;
  }

  async list({ month = "", cursor = null, signal }: ListOptions = {}): Promise<MediaPage> {
    validateMonth(month, true);
    const query = new URLSearchParams();
    if (month) query.set("month", month);
    if (cursor) query.set("cursor", cursor);
    const page = await this.request(`/media?${query}`, undefined, signal);
    if (!Array.isArray(page.items) || (page.cursor !== null && typeof page.cursor !== "string")) {
      throw new Error("Invalid media library response.");
    }
    const items = page.items.map((item: unknown): MediaItem => {
      if (!isRecord(item) || typeof item.key !== "string" || typeof item.url !== "string" ||
          typeof item.size !== "number" || !Number.isFinite(item.size) || item.size < 0) {
        throw new Error("Invalid media item.");
      }
      httpsUrl(item.url);
      let poster: MediaItem["poster"];
      if (item.poster !== undefined) {
        validatePoster(item.poster, item.key);
        if (!("url" in item.poster) || typeof item.poster.url !== "string") throw new Error("Invalid video poster URL.");
        httpsUrl(item.poster.url);
        poster = { key: item.poster.key, size: item.poster.size, url: item.poster.url,
          ...(item.poster.time !== undefined && { time: item.poster.time }) };
      }
      return { key: item.key, size: item.size, url: item.url, ...(typeof item.modified === "string" && { modified: item.modified }),
        ...(poster && { poster }), ...(item.thumbnails !== undefined && { thumbnails: readThumbnails(item.thumbnails, item.key) }) };
    });
    return { bucket: this.config.bucket, items, cursor: page.cursor };
  }

  async prepare(file: MediaFile, month: string): Promise<UploadGrant> {
    validateFile(file);
    validateMonth(month);
    const grant = await this.request("/uploads", { name: file.name, size: file.size, type: mediaType(file.name), month,
      ...(file.posterFor !== undefined && { posterFor: file.posterFor }),
      ...(file.thumbnailFor !== undefined && { thumbnailFor: file.thumbnailFor, dimensions: file.dimensions }) });
    if (typeof grant.key !== "string" || typeof grant.ticket !== "string" || typeof grant.url !== "string" || grant.partSize !== PART_SIZE) {
      throw new Error("Invalid upload grant or incompatible API part size.");
    }

    httpsUrl(grant.url);
    return { bucket: this.config.bucket, key: grant.key, ticket: grant.ticket, url: grant.url, partSize: grant.partSize };
  }

  async post(input: PostInput, month: string) {
    validateMonth(month);
    const data = await this.request("/posts", {
      ...input, month, media: input.media.map(({ key, size, poster, thumbnails }) => ({
        key, size, ...(poster && { poster: { key: poster.key, size: poster.size, ...(poster.time !== undefined && { time: poster.time }) } }),
        ...(thumbnails !== undefined && { thumbnails: thumbnailInputs(thumbnails) }),
      })),
    });
    const post = readPosts([data.post], month)[0];
    if (post.id !== input.id) throw new Error("The media API returned a different post.");
    return post;
  }

  async setThumbnails(item: Pick<MediaItem, "key" | "thumbnails">, month: string, signal?: AbortSignal): Promise<Thumbnails> {
    validateMonth(month);
    const thumbnails = thumbnailInputs(item.thumbnails ?? {});
    validateThumbnails(thumbnails, item.key);
    const data = await this.request("/thumbnails", { key: item.key, thumbnails, month }, signal);
    if (data.key !== item.key) throw new Error("The thumbnail index returned a different media key.");
    const saved = readThumbnails(data.thumbnails, item.key);
    if (JSON.stringify(thumbnailInputs(saved)) !== JSON.stringify(thumbnails)) {
      throw new Error("The saved thumbnail index does not match the uploaded thumbnails.");
    }
    return saved;
  }

  #readPostsFile(data: Record<string, unknown>, month: string): PostsFile {
    if (typeof data.key !== "string" || !data.key.endsWith(`/${month.replace("-", "/")}/${POSTS_FILE}`) ||
        typeof data.url !== "string" || typeof data.content !== "string") throw new Error("Invalid monthly posts file response.");
    httpsUrl(data.url);
    validatePostsEtag(data.etag);
    validatePostsFileSize(data.content);
    return { key: data.key, url: data.url, etag: data.etag, content: data.content };
  }

  async getPostsFile(month: string, signal?: AbortSignal): Promise<PostsFile> {
    validateMonth(month);
    return this.#readPostsFile(await this.request(`/posts?${new URLSearchParams({ month })}`, undefined, signal), month);
  }

  async savePostsFile(month: string, content: string, etag: string, signal?: AbortSignal): Promise<PostsFile> {
    validatePostsJson(content, month);
    validatePostsEtag(etag);
    const file = this.#readPostsFile(await this.request("/posts/edit", { month, content, etag }, signal), month);
    if (file.content !== content) throw new Error("The saved posts file differs from your edits. Reload it before editing again.");
    return file;
  }

  async sign(request: SignRequest, grant: UploadGrant): Promise<SignedUpload> {
    const signed = await this.request("/sign", { ...request, key: grant.key, ticket: grant.ticket });
    httpsUrl(signed.url);
    if (typeof signed.url !== "string" || typeof signed.key !== "string" ||
        (signed.headers !== undefined && (!isRecord(signed.headers) || Object.values(signed.headers).some(value => typeof value !== "string")))) {
      throw new Error("Invalid upload signing response.");
    }
    const headers = signed.headers === undefined ? undefined : Object.fromEntries(
      Object.entries(signed.headers as Record<string, string>),
    );
    return { url: signed.url, key: signed.key, ...(headers && { headers }) };
  }
}
