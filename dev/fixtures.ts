import { readFileSync } from "node:fs";
import { httpsUrl, isRecord, validateMonth } from "../src/shared/media-types.js";
import type { MediaItem } from "../src/shared/media-types.js";

export const FIXTURE_FILE = new URL("./assets.json", import.meta.url);
export const LOCAL_BUCKET = "monthly-local";
export const LOCAL_PREFIX = "mock-assets/";
export const LOCAL_USERNAME = "demo";
export const LOCAL_PASSWORD = "monthly-local-demo";

export function loadAssets(filename: URL = FIXTURE_FILE): MediaItem[] {
  const data: unknown = JSON.parse(readFileSync(filename, "utf8"));
  if (!isRecord(data) || !Array.isArray(data.months) || data.months.length !== 24) {
    throw new Error("Dev fixtures must contain exactly 24 months.");
  }
  const assets: MediaItem[] = [];
  const months = new Set<string>();
  const keys = new Set<string>();
  for (const entry of data.months) {
    if (!isRecord(entry) || !Array.isArray(entry.items) || entry.items.length > 30) {
      throw new Error("Each fixture month must contain 0-30 assets.");
    }
    const month = validateMonth(entry.month);
    if (months.has(month)) throw new Error(`Duplicate fixture month: ${month}.`);
    months.add(month);
    for (const item of entry.items) {
      if (!isRecord(item) || typeof item.key !== "string" ||
          !item.key.startsWith(`${LOCAL_PREFIX}${month.replace("-", "/")}/`) ||
          typeof item.url !== "string" || typeof item.size !== "number" ||
          !Number.isSafeInteger(item.size) || item.size < 1 ||
          typeof item.modified !== "string" || !item.modified.startsWith(month) ||
          !Number.isFinite(Date.parse(item.modified)) || keys.has(item.key)) {
        throw new Error(`Invalid or duplicate fixture asset in ${month}.`);
      }
      httpsUrl(item.url);
      keys.add(item.key);
      assets.push({ key: item.key, size: item.size, modified: item.modified, url: item.url });
    }
  }
  const sorted = [...months].sort();
  const start = new Date(`${sorted[0]}-01T00:00:00.000Z`);
  for (const [index, month] of sorted.entries()) {
    const expected = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1)).toISOString().slice(0, 7);
    if (month !== expected) throw new Error("Dev fixtures must span 24 consecutive months.");
  }
  return assets;
}
