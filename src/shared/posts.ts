import { httpsUrl, isRecord, MAX_FILE_SIZE, mediaType, mediaUrl, readThumbnails, validateThumbnails, validateMonth, validatePoster, type MediaItem, type MediaPoster, type ThumbnailInputs } from "./media-types.js";
import { asError } from "./errors.js";

export const POSTS_FILE = "posts.json";
export const MAX_POST_LENGTH = 4000;
export const MAX_POSTS_FILE_BYTES = 512 * 1024;
export interface PostMediaInput { key: string; size: number; thumbnails?: ThumbnailInputs; poster?: Omit<MediaPoster, "url"> }
export interface PostInput { id: string; text: string; tags: string[]; media: PostMediaInput[] }
export interface Post extends Omit<PostInput, "media"> { created: string; media: MediaItem[] }

export function validatePostsFileSize(content: string) {
  if (new TextEncoder().encode(content).byteLength > MAX_POSTS_FILE_BYTES) throw new Error("The JSON editor supports files up to 512 KiB.");
}

export function validatePostsEtag(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^"[\x21\x23-\x7e]{1,128}"$/.test(value)) throw new Error("A valid posts file version (ETag) is required.");
}

export function validatePostMediaKeys(media: readonly PostMediaInput[], folder: string) {
  for (const item of media) {
    if (!item.key.startsWith(folder) || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,159}$/.test(item.key.slice(folder.length))) {
      throw new Error("Post media must belong to the selected month.");
    }
  }
}

export function validatePostsJson(content: string, month: string, location?: { key: string; url: string }): Post[] {
  validateMonth(month);
  validatePostsFileSize(content);
  let value: unknown;
  try { value = JSON.parse(content); }
  catch (error) { throw new Error(`Invalid JSON: ${asError(error).message}`); }
  if (!Array.isArray(value)) throw new Error("The monthly posts JSON must be an array.");
  let folder: string | undefined;
  let base: string | undefined;
  if (location) {
    base = httpsUrl(location.url).origin;
    folder = location.key.slice(0, -POSTS_FILE.length);
    if (!location.key.endsWith(`/${month.replace("-", "/")}/${POSTS_FILE}`) || location.url !== mediaUrl(base, location.key)) {
      throw new Error("Invalid monthly posts file location.");
    }
  }
  const ids = new Set<string>();
  return value.map((entry: unknown, index) => {
    try {
      const post = readPosts([entry], month)[0];
      if (ids.has(post.id)) throw new Error("Duplicate post ID.");
      ids.add(post.id);
      if (folder && base) {
        validatePostMediaKeys(post.media, folder);
        for (const item of post.media) {
          if (item.url !== mediaUrl(base, item.key) || (item.poster && item.poster.url !== mediaUrl(base, item.poster.key))) {
            throw new Error("Media and poster URLs must match their keys on the configured CDN.");
          }
          if (Object.values(item.thumbnails ?? {}).some(file => file.url !== mediaUrl(base, file.key))) {
            throw new Error("Thumbnail URLs must match their keys on the configured CDN.");
          }
        }
      }
      return post;
    } catch (error) { throw new Error(`Post ${index + 1}: ${asError(error).message}`); }
  });
}

export function postTags(text: string, tags: readonly string[] = []) {
  const hashtags = [...text.matchAll(/(?:^|[^\p{L}\p{M}\p{N}_])#([\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*)/gu)].map(match => match[1]);
  return [...new Set([...tags, ...hashtags].map(tag => tag.trim().replace(/^#/, "").normalize("NFC").toLowerCase()).filter(Boolean))];
}

export function validatePostInput(value: unknown): asserts value is PostInput {
  if (!isRecord(value) || typeof value.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id) ||
      typeof value.text !== "string" || value.text.length > MAX_POST_LENGTH ||
      !Array.isArray(value.tags) || value.tags.length > 32 ||
      value.tags.some(tag => typeof tag !== "string" || !tag.trim() || tag.length > 64) ||
      !Array.isArray(value.media) || value.media.length > 20 ||
      (!value.text.trim() && !value.media.length)) {
    throw new Error("A post needs text or media, a UUID, at most 4000 characters, 32 tags (64 characters each), and 20 assets.");
  }
  for (const item of value.media) {
    if (!isRecord(item) || typeof item.key !== "string" || !mediaType(item.key) ||
        typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_FILE_SIZE) {
      throw new Error("Invalid post media.");
    }
    if (item.poster !== undefined) validatePoster(item.poster, item.key);
    if (item.thumbnails !== undefined) validateThumbnails(item.thumbnails, item.key);
  }
}

export function readPosts(value: unknown, month: string): Post[] {
  validateMonth(month);
  if (!Array.isArray(value)) throw new Error("Invalid monthly posts file.");
  return value.map((post: unknown) => {
    validatePostInput(post);
    if (!isRecord(post) || typeof post.created !== "string" || !Number.isFinite(Date.parse(post.created)) ||
        new Date(post.created).toISOString() !== post.created || !post.created.startsWith(month)) {
      throw new Error("Invalid post timestamp.");
    }
    const media = post.media.map(item => {
      if (!("url" in item) || typeof item.url !== "string") throw new Error("Invalid post media URL.");
      httpsUrl(item.url);
      let poster: MediaPoster | undefined;
      if (item.poster !== undefined) {
        if (!("url" in item.poster) || typeof item.poster.url !== "string") throw new Error("Invalid video poster URL.");
        httpsUrl(item.poster.url);
        poster = { key: item.poster.key, size: item.poster.size, url: item.poster.url,
          ...(item.poster.time !== undefined && { time: item.poster.time }) };
      }
      return { key: item.key, size: item.size, url: item.url, ...(poster && { poster }),
        ...(item.thumbnails !== undefined && { thumbnails: readThumbnails(item.thumbnails, item.key) }) };
    });
    return { id: post.id, text: post.text, tags: [...post.tags], media, created: post.created };
  });
}

export function feedMonths(date = new Date()) {
  return Array.from({ length: 3 }, (_, offset) =>
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - offset, 1)).toISOString().slice(0, 7));
}
