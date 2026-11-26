import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { score } from "./score.mjs";

const [directory] = process.argv.slice(2);
assert.ok(directory, "Usage: node rescore.mjs RUN_DIRECTORY");
const samples = readdirSync(directory)
  .filter((name) => /^step-\d\d\.json$/.test(name))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
const summary = JSON.parse(readFileSync(join(directory, "summary.json"), "utf8"));
assert.notEqual(summary.cohort, "cold", "Use cold-launch.json for a cold-only run");
const rescored = score(samples);
const result = {
  pass: !summary.failure && rescored.pass,
  samples: samples.length,
  failure: summary.failure,
  observed: rescored.observed,
  acknowledgement: rescored.acknowledgement,
  failedInputs: rescored.failedInputs,
  unattemptedInputs: rescored.unattemptedInputs,
};
console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exitCode = 1;
