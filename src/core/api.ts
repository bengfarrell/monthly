import { MediaAuth } from "./auth.js";
import { PART_SIZE, httpsUrl, isRecord, mediaType, validateConnection, validateFile, validateMonth } from "../shared/media-types.js";
import type { MediaFile, MediaItem } from "../shared/media-types.js";

export interface MediaApiOptions {
  apiUrl: string;
  bucket: string;
  auth?: MediaAuth;
  fetch?: typeof globalThis.fetch;
  onUnauthorized?: (error: MediaApiError) => void;
}
export interface ListOptions { month?: string; cursor?: string | null; signal?: AbortSignal }
export interface MediaPage { items: MediaItem[]; cursor: string | null; bucket?: string }
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
      return { key: item.key, size: item.size, url: item.url, ...(typeof item.modified === "string" && { modified: item.modified }) };
    });
    return { bucket: this.config.bucket, items, cursor: page.cursor };
  }

  async prepare(file: MediaFile, month: string): Promise<UploadGrant> {
    validateFile(file);
    validateMonth(month);
    const grant = await this.request("/uploads", { name: file.name, size: file.size, type: mediaType(file.name), month });
    if (typeof grant.key !== "string" || typeof grant.ticket !== "string" || typeof grant.url !== "string" || grant.partSize !== PART_SIZE) {
      throw new Error("Invalid upload grant or incompatible API part size.");
    }
    httpsUrl(grant.url);
    return { bucket: this.config.bucket, key: grant.key, ticket: grant.ticket, url: grant.url, partSize: grant.partSize };
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
