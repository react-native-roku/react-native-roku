import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { packageRoot } from "./index.mjs";
const sdkRequire = createRequire(
  resolve(packageRoot, "node_modules/@roku-sdk/tooling/package.json"),
);
const yaml = sdkRequire("js-yaml");
test("CI qualifies both supported hosts and release workflow defaults to preparation", () => {
  const read = (path) => yaml.load(readFileSync(resolve(packageRoot, path), "utf8"));
  const ci = read(".github/workflows/ci.yml"),
    release = read(".github/workflows/release.yml");
  assert.deepEqual(ci.jobs.qualification.strategy.matrix.os, ["ubuntu-latest", "macos-latest"]);
  assert.equal(ci.jobs.qualification.needs, "fast");
  assert.ok(
    ci.jobs.qualification.steps.some((step) =>
      step.uses?.startsWith("browser-actions/setup-chrome@"),
    ),
  );
  assert.ok(
    ci.jobs.qualification.steps.some((step) =>
      step.run?.includes('pnpm check --archive="$PWD/.local/ci-qualification/runtime.tgz"'),
    ),
  );
  assert.ok(
    ci.jobs.qualification.steps.some(
      (step) =>
        step.uses?.startsWith("actions/upload-artifact@") &&
        step.with.path === ".local/ci-qualification/",
    ),
  );
  const { prepare, stage } = release.jobs;
  assert.equal(release.on.workflow_dispatch.inputs["preparation-run"].required, false);
  assert.equal(prepare.if, "inputs.preparation-run == ''");
  assert.equal(stage.if, "inputs.preparation-run != ''");
  assert.equal(stage.environment, "npm-release");
  assert.equal(stage.permissions["id-token"], "write");
  assert.equal(prepare.permissions?.["id-token"], undefined);
  assert.ok(stage.steps.some((step) => step.run === "node scripts/release.mjs --check"));
  assert.ok(
    stage.steps.some(
      (step) =>
        step.uses?.startsWith("actions/download-artifact@") &&
        step.with["run-id"] === "${{ inputs.preparation-run }}",
    ),
  );
  const command = stage.steps.at(-1).run;
  assert.match(command, /^npm stage publish \.local\/candidate\/react-native-roku\.tgz /);
  assert.match(command, /--tag preview/);
  assert.match(command, /--provenance/);
  assert.ok(stage.steps.every((step) => !/\b(?:npm|pnpm) pack\b/.test(step.run ?? "")));
});
