import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { inspectRelease, inspectPublicApi } from "./release.mjs";
test("release preparation blocks unlicensed, uncommitted and unclassified packages", () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-release-gate-"));
  try {
    for (const path of ["package.json", "compatibility", "config", "CHANGELOG.md", "docs"])
      cpSync(new URL("../" + path, import.meta.url), resolve(root, path), { recursive: true });
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json")));
    manifest.license = "UNLICENSED";
    manifest.private = true;
    writeFileSync(resolve(root, "package.json"), JSON.stringify(manifest));
    const result = inspectRelease(root, { git: { head: null, clean: false, tags: [] } });
    assert.equal(result.ready, false);
    assert.equal(result.publishPerformed, false);
    assert.ok(result.blockers.some((value) => value.includes("license")));
    manifest.exports["./unreviewed"] = "./src/unknown.ts";
    writeFileSync(resolve(root, "package.json"), JSON.stringify(manifest));
    assert.ok(inspectPublicApi(root).failures.some((value) => value.includes("unreviewed")));
    delete manifest.exports["./unreviewed"];
    manifest.license = "MIT";
    manifest.private = false;
    writeFileSync(resolve(root, "package.json"), JSON.stringify(manifest));
    writeFileSync(resolve(root, "LICENSE"), "Fixture only, not a license grant");
    assert.equal(
      inspectRelease(root, {
        git: { head: "fixture", clean: true, tags: [`v${manifest.version}`] },
      }).ready,
      true,
    );
    const git = { head: "fixture", clean: true, tags: [`v${manifest.version}`] };
    const repository = JSON.parse(readFileSync(resolve(root, "config/release.json")))
      .trustedPublisher.repository;
    assert.equal(inspectRelease(root, { git, workflowRepository: repository }).ready, true);
    assert.equal(inspectRelease(root, { git, workflowRepository: "fork/example" }).ready, false);
    const originalUrl = manifest.repository.url;
    manifest.repository.url = "https://github.com/fork/example.git";
    writeFileSync(resolve(root, "package.json"), JSON.stringify(manifest));
    assert.ok(
      inspectRelease(root, { git }).blockers.some((value) => value.includes("Package repository")),
    );
    manifest.repository.url = originalUrl;
    manifest.publishConfig.tag = "preview";
    writeFileSync(resolve(root, "package.json"), JSON.stringify(manifest));
    assert.ok(
      inspectRelease(root, {
        git: { head: "fixture", clean: true, tags: [`v${manifest.version}`] },
      }).blockers.some((value) => value.includes("latest npm dist-tag")),
    );
    manifest.dependencies["react-reconciler"] = "0.34.0";
    writeFileSync(resolve(root, "package.json"), JSON.stringify(manifest));
    assert.ok(inspectPublicApi(root).failures.some((value) => value.includes("cohort")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
