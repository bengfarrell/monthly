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

export interface MediaFile { name: string; size: number }
export interface MediaItem { key: string; url: string; size: number; modified?: string }

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
