import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDemoConfig } from "../scripts/config.js";

test("demo configuration loads env files and allows shell overrides", t => {
  const directory = mkdtempSync(join(tmpdir(), "monthly-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, ".env.local");
  writeFileSync(filename, '# Local demo\nMONTHLY_API_URL="https://local.example.com"\nMONTHLY_BUCKET=local-bucket\n');
  assert.deepEqual(loadDemoConfig(filename, {}), { apiUrl: "https://local.example.com", bucket: "local-bucket" });
  assert.deepEqual(loadDemoConfig(filename, { MONTHLY_BUCKET: "shell-bucket" }), {
    apiUrl: "https://local.example.com", bucket: "shell-bucket",
  });
  const missing = join(directory, "missing.env");
  assert.deepEqual(loadDemoConfig(missing, {
    MONTHLY_API_URL: "https://ci.example.com", MONTHLY_BUCKET: "ci-bucket",
  }), { apiUrl: "https://ci.example.com", bucket: "ci-bucket" });
  assert.throws(() => loadDemoConfig(missing, {}), /MONTHLY_API_URL and MONTHLY_BUCKET/);
  assert.throws(() => loadDemoConfig(filename, { MONTHLY_API_URL: "http://unsafe.example.com" }), /HTTPS/);
  assert.throws(() => loadDemoConfig(filename, { MONTHLY_BUCKET: "INVALID" }), /S3 bucket/);
  assert.throws(() => loadDemoConfig(directory, {}), { code: "EISDIR" });
});
