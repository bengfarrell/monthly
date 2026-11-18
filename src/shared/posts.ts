import { httpsUrl, isRecord, MAX_FILE_SIZE, mediaType, validateMonth, type MediaItem } from "./media-types.js";

export const POSTS_FILE = "posts.json";
export const MAX_POST_LENGTH = 4000;
export interface PostInput { id: string; text: string; tags: string[]; media: Pick<MediaItem, "key" | "size">[] }
export interface Post extends Omit<PostInput, "media"> { created: string; media: MediaItem[] }

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
      return { key: item.key, size: item.size, url: item.url };
    });
    return { id: post.id, text: post.text, tags: [...post.tags], media, created: post.created };
  });
}

export function feedMonths(date = new Date()) {
  return Array.from({ length: 3 }, (_, offset) =>
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - offset, 1)).toISOString().slice(0, 7));
}
