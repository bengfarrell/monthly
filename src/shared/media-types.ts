export const MEDIA_TYPES = new Map([
  ["image/jpeg", ["jpg", "jpeg"]], ["image/png", ["png"]],
  ["image/gif", ["gif"]], ["image/webp", ["webp"]], ["image/avif", ["avif"]],
  ["image/heic", ["heic"]], ["image/heif", ["heif"]],
  ["video/mp4", ["mp4", "m4v"]], ["video/webm", ["webm"]],
  ["video/quicktime", ["mov"]],
  ["audio/mpeg", ["mp3"]], ["audio/wav", ["wav"]],
  ["audio/mp4", ["m4a"]], ["audio/aac", ["aac"]],
  ["audio/ogg", ["ogg", "oga", "opus"]], ["audio/flac", ["flac"]],
  ["audio/aiff", ["aif", "aiff"]], ["audio/webm", ["weba"]],
]);

export const MAX_FILE_SIZE = 2 * 1024 ** 3;
export const PART_SIZE = 10 * 1024 ** 2;
export const MULTIPART_THRESHOLD = 100 * 1024 ** 2;

export const IMAGE_THUMBNAIL_THRESHOLD = 1024 ** 2;
export const DEFAULT_THUMBNAIL_DIMENSION = 960;
export const MAX_THUMBNAIL_SIZE = 1024 ** 2;
export const MAX_THUMBNAILS = 20;
export const THUMBNAILS_FILE = "thumbnails.json";
export interface MediaFile { name: string; size: number; posterFor?: string; thumbnailFor?: string; dimensions?: string }
export interface MediaThumbnail { key: string; url: string; size: number; time?: number }
export type MediaPoster = MediaThumbnail;
export type Thumbnails = Record<string, MediaThumbnail>;
export type ThumbnailInputs = Record<string, Omit<MediaThumbnail, "url">>;
export interface MediaItem { key: string; url: string; size: number; modified?: string; thumbnails?: Thumbnails; poster?: MediaPoster }
export const POSTER_SUFFIX = ".poster.jpg";

export function uploadFilename(name: string) {
  return name.split(/[\\/]/).at(-1)!.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "").slice(-160);
}

export function posterKey(videoKey: string) { return `${videoKey}${POSTER_SUFFIX}`; }
export function thumbnailKey(mediaKey: string, dimensions: string) { return `${mediaKey}.thumb-${dimensions}.jpg`; }
export function validThumbnailDimensions(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(value) &&
    value.split("x").every(dimension => Number(dimension) <= 8192);
}
export function isMediaThumbnail(key: string) {
  const match = /^(.*)\.thumb-([1-9]\d{0,3}x[1-9]\d{0,3})\.jpg$/.exec(key);
  return !!match && validThumbnailDimensions(match[2]) && /^(image|video)\//.test(mediaType(match[1]) ?? "");
}
export function validateThumbnails(value: unknown, mediaKey: string): asserts value is ThumbnailInputs {
  const type = mediaType(mediaKey);
  if (!type || !/^(image|video)\//.test(type) || !isRecord(value) || Object.keys(value).length > MAX_THUMBNAILS) {
    throw new Error("Thumbnails must be a dimension-keyed object for an image or video, with at most 20 files.");
  }
  for (const [dimensions, file] of Object.entries(value)) {
    if (!validThumbnailDimensions(dimensions) || !isRecord(file) || file.key !== thumbnailKey(mediaKey, dimensions) ||
        typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_THUMBNAIL_SIZE ||
        (file.time !== undefined && (!type.startsWith("video/") || typeof file.time !== "number" || !Number.isFinite(file.time) || file.time < 0))) {
      throw new Error("Invalid thumbnail dimensions, file key, size (at most 1 MiB), or video frame time.");
    }
  }
}
export function readThumbnails(value: unknown, mediaKey: string): Thumbnails {
  validateThumbnails(value, mediaKey);
  return Object.fromEntries(Object.entries(value).map(([dimensions, file]) => {
    if (!("url" in file) || typeof file.url !== "string") throw new Error("Invalid thumbnail URL.");
    httpsUrl(file.url);
    return [dimensions, { key: file.key, size: file.size, url: file.url, ...(file.time !== undefined && { time: file.time }) }];
  }));
}
export function thumbnailInputs(thumbnails: Thumbnails | ThumbnailInputs): ThumbnailInputs {
  return Object.fromEntries(Object.entries(thumbnails).map(([dimensions, file]) =>
    [dimensions, { key: file.key, size: file.size, ...(file.time !== undefined && { time: file.time }) }]));
}
export function firstThumbnail(item: Pick<MediaItem, "thumbnails" | "poster">) {
  return Object.values(item.thumbnails ?? {})[0] ?? item.poster;
}
export function mediaUrl(base: string, key: string) { return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`; }
export function isVideoPoster(key: string) {
  return key.endsWith(POSTER_SUFFIX) && !!mediaType(key.slice(0, -POSTER_SUFFIX.length))?.startsWith("video/");
}

export function validatePoster(value: unknown, videoKey: string): asserts value is Omit<MediaPoster, "url"> {
  if (!mediaType(videoKey)?.startsWith("video/") || !isRecord(value) || value.key !== posterKey(videoKey) ||
      typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_FILE_SIZE ||
      (value.time !== undefined && (typeof value.time !== "number" || !Number.isFinite(value.time) || value.time < 0))) {
    throw new Error("Invalid video poster.");
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mediaType(name: unknown) {
  if (typeof name !== "string") return null;
  const filename = name.split(/[\\/]/).at(-1)!;
  const dot = filename.lastIndexOf(".");
  if (dot < 1) return null;
  const extension = filename.slice(dot + 1).toLowerCase();
  for (const [type, extensions] of MEDIA_TYPES) {
    if (extensions.includes(extension)) return type;
  }
  return null;
}

export function validateFile(file: unknown): asserts file is MediaFile {
  if (!isRecord(file) || typeof file.name !== "string" || !mediaType(file.name)) {
    throw new Error(`Unsupported file extension. Supported: ${[...MEDIA_TYPES.values()].flat().join(", ")}.`);
  }
  if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE_SIZE) {
    throw new Error("Files must be between 1 byte and 2 GiB.");
  }
  if (file.thumbnailFor !== undefined || file.dimensions !== undefined) {
    if (file.posterFor !== undefined || typeof file.thumbnailFor !== "string" ||
        !/^(image|video)\//.test(mediaType(file.thumbnailFor) ?? "") || !validThumbnailDimensions(file.dimensions) ||
        mediaType(file.name) !== "image/jpeg" || file.size > MAX_THUMBNAIL_SIZE) {
      throw new Error("A thumbnail must be a JPEG up to 1 MiB, associated with an image or video and valid dimensions.");
    }
  } else if (file.posterFor !== undefined) {
    if (typeof file.posterFor !== "string" || !mediaType(file.posterFor)?.startsWith("video/") || mediaType(file.name) !== "image/jpeg") {
      throw new Error("A video poster must be a JPEG associated with a video.");
    }
  } else if (isVideoPoster(file.name) || isMediaThumbnail(file.name)) {
    throw new Error("Thumbnail and .poster.jpg companion filenames are reserved. Rename this file.");
  }
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function currentMonth(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

export function validateMonth(month: unknown, allowEmpty = false): string {
  if (allowEmpty && month === "") return month;
  if (typeof month !== "string" || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("Month must use YYYY-MM.");
  }
  return month;
}

export function httpsUrl(value: unknown) {
  let url;
  try {
    if (typeof value !== "string") throw new Error("Expected an HTTPS URL.");
    url = new URL(value);
  }
  catch { throw new Error("Expected an HTTPS URL."); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Expected an HTTPS URL without credentials.");
  }
  return url;
}

export function validateConnection(apiUrl: unknown, bucket: unknown) {
  const url = httpsUrl(apiUrl);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("API URL must be an HTTPS origin without a path or query.");
  }
  if (typeof bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("Enter a valid S3 bucket name.");
  }
  return Object.freeze({ apiUrl: url.origin, bucket });
}
