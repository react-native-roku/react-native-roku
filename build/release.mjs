import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { toolchain } from "./environment.mjs";
export function inspectPublicApi(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"))),
    catalog = JSON.parse(readFileSync(resolve(root, "compatibility/public-api.json")));
  const failures = [];
  for (const name of new Set([...Object.keys(manifest.exports), ...Object.keys(catalog.exports)])) {
    const entry = catalog.exports[name];
    if (!manifest.exports[name] || !entry) failures.push(`Classify public export ${name}`);
    else if (
      !["application", "advanced-host", "build", "testing", "types", "metadata"].includes(
        entry.audience,
      ) ||
      !entry.contract ||
      !existsSync(resolve(root, entry.contract))
    )
      failures.push(`Document public export ${name}`);
  }
  for (const [name, version] of ["dependencies", "devDependencies", "peerDependencies"].flatMap(
    (group) => Object.entries(manifest[group] ?? {}),
  )) {
    const expected =
      toolchain.packages[name] ??
      (name.startsWith("@roku-sdk/") ? toolchain.packages["@roku-sdk/runtime"] : null);
    if (expected && version !== expected)
      failures.push(`Upgrade coordinated cohort ${name}: expected ${expected}, found ${version}`);
  }
  return {
    status: failures.length ? "failed" : "passed",
    exports: Object.keys(catalog.exports).length,
    failures,
  };
}
export function inspectRelease(root, { git, tag, workflowRepository } = {}) {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"))),
    policy = JSON.parse(readFileSync(resolve(root, "config/release.json"))),
    api = inspectPublicApi(root),
    blockers = [...api.failures];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version))
    blockers.push("Use an explicit semantic release version");
  if (manifest.private)
    blockers.push(
      "Package is private; publishing is disabled until an explicit public release decision",
    );
  if (manifest.license === "UNLICENSED" || !existsSync(resolve(root, "LICENSE")))
    blockers.push("Public license selection is pending; publishing is disabled");
  const repository = policy.trustedPublisher.repository;
  if (manifest.repository?.url !== `https://github.com/${repository}.git`)
    blockers.push("Package repository must match the configured npm trusted publisher");
  if (workflowRepository !== undefined && workflowRepository !== repository)
    blockers.push("Release workflow must run in the configured npm trusted publisher repository");
  if (policy.distTag && manifest.publishConfig?.tag !== policy.distTag)
    blockers.push(`Release must use the ${policy.distTag} npm dist-tag`);
  if (!readFileSync(resolve(root, "CHANGELOG.md"), "utf8").includes(`## [${manifest.version}]`))
    blockers.push(`Add changelog entry ${manifest.version}`);
  if (!git) {
    const run = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    const head = run(["rev-parse", "HEAD"]),
      status = run(["status", "--porcelain"]),
      tags = run(["tag", "--points-at", "HEAD"]);
    git = {
      head: head.status === 0 ? head.stdout.trim() : null,
      clean: status.status === 0 && !status.stdout.trim(),
      tags: tags.status === 0 ? tags.stdout.trim().split("\n") : [],
    };
  }
  if (!git.head) blockers.push("Release requires an existing source commit");
  if (Number.parseInt(manifest.version, 10) >= 1 && policy.deviceRequiredForStable) {
    let device;
    try {
      device = JSON.parse(readFileSync(resolve(root, "release-evidence/device.json")));
    } catch {}
    if (
      policy.phase !== "qualified" ||
      device?.deviceQualified !== true ||
      device?.sourceCommit !== git.head ||
      !/^[a-f0-9]{64}$/.test(device?.artifactSha256 ?? "")
    )
      blockers.push(
        "Stable release requires explicit qualified policy and source/artifact-attested device evidence",
      );
  }
  if (!git.clean) blockers.push("Release requires a clean source tree");
  if (!git.tags.includes(`v${manifest.version}`) || (tag && tag !== `v${manifest.version}`))
    blockers.push(`Release must use tag v${manifest.version} at the source commit`);
  return {
    schema: "react-native-roku-release-readiness/v1",
    ready: !blockers.length,
    publishPerformed: false,
    version: manifest.version,
    license: manifest.license,
    phase: policy.phase,
    blockers,
    api,
    sourceCommit: git.head,
  };
}
