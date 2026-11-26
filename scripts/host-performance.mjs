import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { ensureQualificationStorage } from "./qualificationStorage.mjs";

const args = process.argv.slice(2);
const option = (key) =>
  args
    .find((arg) => arg.startsWith("--" + key + "="))
    ?.split("=")
    .slice(1)
    .join("=");
const archive = option("archive");
assert.ok(archive && statSync(archive).isFile(), "Choose an explicit --archive=FILE.tgz");
assert.ok(option("output"), "Choose an explicit --output=NEW_DIRECTORY");
const output = resolve(option("output"));
assert.ok(
  !existsSync(resolve(output, "consumer")) && !existsSync(resolve(output, "results")),
  "Choose a fresh output directory",
);
const shelf = resolve(import.meta.dirname, "../benchmarks/shelf");
const workspace = resolve(output, "consumer");
await ensureQualificationStorage({
  projectRoot: resolve(import.meta.dirname, ".."),
  evidence: output,
  kind: "host-performance",
  dynamic: [output],
  sourceInputs: [resolve(shelf, "host.mjs"), resolve(shelf, "prepare.mjs")],
});
mkdirSync(output, { recursive: true, mode: 0o700 });
execFileSync(
  process.execPath,
  [resolve(shelf, "prepare.mjs"), resolve(archive), workspace, "host"],
  { stdio: "inherit" },
);
execFileSync(
  process.execPath,
  [resolve(shelf, "host.mjs"), workspace, resolve(output, "results"), "catalog"],
  { stdio: "inherit" },
);
