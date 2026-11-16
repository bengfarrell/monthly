import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FIXTURE_FILE, loadAssets } from "../dev/fixtures.js";

test("mock JSON contains two consecutive years, 24 months and 0-30 online assets per month", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_FILE, "utf8"));
  const months: { month: string; items: unknown[] }[] = fixture.months;
  assert.equal(months.length, 24);
  assert.equal(new Set(months.map(entry => entry.month.slice(0, 4))).size, 2);
  assert.equal(Math.min(...months.map(entry => entry.items.length)), 0);
  assert.equal(Math.max(...months.map(entry => entry.items.length)), 30);
  const assets = loadAssets();
  assert.equal(assets.length, months.reduce((count, entry) => count + entry.items.length, 0));
  assert.equal(new Set(assets.map(asset => asset.key)).size, assets.length);
  assert.ok(assets.every(asset => new URL(asset.url).protocol === "https:"));
});

test("invalid mock fixture data fails explicitly", t => {
  const directory = mkdtempSync(join(tmpdir(), "monthly-fixtures-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = pathToFileURL(join(directory, "assets.json"));
  const fixture = JSON.parse(readFileSync(FIXTURE_FILE, "utf8"));
  fixture.months[0].items = Array(31).fill({});
  writeFileSync(filename, JSON.stringify(fixture));
  assert.throws(() => loadAssets(filename), /0-30 assets/);
  writeFileSync(filename, "{}");
  assert.throws(() => loadAssets(filename), /24 months/);
});
