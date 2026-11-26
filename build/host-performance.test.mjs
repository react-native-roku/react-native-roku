import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/host-performance.mjs", import.meta.url));
test("host benchmark requires an explicit archive", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose an explicit --archive/);
  assert.ok(!result.stdout.includes("launching"));
});
test("host benchmark rejects a directory in place of an archive", () => {
  const root = mkdtempSync(resolve(tmpdir(), "host-performance-input-"));
  try {
    writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "foreign-workspace" }));
    const result = spawnSync(process.execPath, [script, "--archive=" + root], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--archive=FILE/);
    assert.ok(!result.stdout.includes("launching"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
