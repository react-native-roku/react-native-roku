import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot } from "../build/index.mjs";
import { ensureQualificationStorage } from "./qualificationStorage.mjs";

await ensureQualificationStorage({ projectRoot: packageRoot });

// Keep one browser journey owner. This lane supplies a real freshly installed
// Metro app and its actual public CLI SDK proof to qualify-development.mjs.
const evidence = resolve(process.env.ROKU_QUALIFY_EVIDENCE_DIR ?? resolve(packageRoot, ".local"));
mkdirSync(evidence, { recursive: true });
const directory = mkdtempSync(resolve(evidence, "metro-development-"));
const report = {
  status: "running",
  directory,
  deviceQualified: false,
  limits: [
    "Independent generated app and browser Canvas host; native execution requires device evidence.",
    "This is the existing full-reload journey; state-preserving Fast Refresh remains unqualified.",
  ],
};
const sha = (value) => createHash("sha256").update(value).digest("hex");
const save = () =>
  writeFileSync(resolve(directory, "proof.json"), JSON.stringify(report, null, 2) + "\n");
let sequence = 0;
function run(program, args, cwd, environment = {}) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CI: "1", ...environment },
  });
  const log = `command-${++sequence}.log`;
  writeFileSync(resolve(directory, log), (result.stdout ?? "") + "\n" + (result.stderr ?? ""));
  assert.equal(
    result.status,
    0,
    result.error?.stack ?? `Command failed: ${program} ${args.join(" ")}; inspect ${log}`,
  );
  return result.stdout;
}
save();
try {
  const inputs = resolve(directory, "inputs");
  mkdirSync(inputs);
  const helperFiles = [
    "scripts/qualify-metro-development.mjs",
    "scripts/qualify-development.mjs",
    "scripts/browserHarness.mjs",
  ];
  const helpers = helperFiles.map((path) => {
    const contents = readFileSync(resolve(packageRoot, path));
    const target = resolve(inputs, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
    return { path, sha256: sha(contents) };
  });
  writeFileSync(resolve(inputs, "files.json"), JSON.stringify(helpers, null, 2));
  const archive = resolve(process.env.ROKU_QUALIFY_ARCHIVE ?? resolve(directory, "platform.tgz"));
  if (!process.env.ROKU_QUALIFY_ARCHIVE) run("pnpm", ["pack", "--out", archive], packageRoot);
  copyFileSync(archive, resolve(directory, "selected-platform.tgz"));
  report.archiveSha256 = sha(readFileSync(archive));
  const unpacked = resolve(directory, "unpacked");
  mkdirSync(unpacked);
  run("tar", ["-xzf", archive, "-C", unpacked], directory);
  const consumer = resolve(directory, "consumer");
  run(
    process.execPath,
    [
      resolve(unpacked, "package/bin/react-native-roku.mjs"),
      "init",
      consumer,
      "--bundler=metro",
      `--package=file:${resolve(directory, "selected-platform.tgz")}`,
    ],
    directory,
  );
  report.consumer = consumer;
  run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], consumer);
  const require = createRequire(resolve(consumer, "package.json"));
  const installed = await import(pathToFileURL(require.resolve("react-native-roku/build")));
  const original = await import(pathToFileURL(resolve(unpacked, "package/build/index.mjs")));
  assert.ok(
    installed.packageRoot.startsWith(consumer + "/"),
    "Platform must be independently installed",
  );
  const implementation = installed.runtimeInputs().filter((file) => file.path !== "package.json");
  assert.deepEqual(
    implementation,
    original.runtimeInputs().filter((file) => file.path !== "package.json"),
  );
  report.installedFilesVerified = implementation.length;
  writeFileSync(resolve(inputs, "installed-files.json"), JSON.stringify(implementation, null, 2));
  for (const file of implementation) {
    const target = resolve(inputs, "installed", file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(installed.packageRoot, file.path), target);
  }
  for (const name of ["package.json", "pnpm-lock.yaml", "roku.config.json", "babel.config.cjs"])
    copyFileSync(resolve(consumer, name), resolve(inputs, name));
  cpSync(resolve(consumer, "src"), resolve(inputs, "app-before"), { recursive: true });
  run("pnpm", ["run", "typecheck"], consumer);
  const cli = resolve(consumer, "node_modules/react-native-roku/bin/react-native-roku.mjs");
  const doctor = JSON.parse(run(process.execPath, [cli, "doctor"], consumer));
  assert.equal(doctor.status, "passed");
  report.doctor = doctor;
  const output = run(process.execPath, [cli, "build"], consumer);
  const built = JSON.parse(output.trim().split("\n").at(-1));
  assert.equal(built.profile, "production");
  const frontend = JSON.parse(
    readFileSync(resolve(consumer, ".roku/src/generated/frontend.metro.json")),
  );
  assert.equal(frontend.bundler, "metro");
  assert.ok(
    frontend.files
      .filter((file) => file.path.endsWith(".mjs"))
      .every((file) => file.bytes <= 2 * 1024 * 1024),
  );
  run("unzip", ["-tqq", built.zip], consumer);
  copyFileSync(built.zip, resolve(directory, "metro-app.zip"));
  const sdk = {
    status: "passed",
    consumer,
    archiveSha256: report.archiveSha256,
    bundler: "metro",
    profile: built.profile,
    zipSha256: sha(readFileSync(built.zip)),
    programSha256: sha(readFileSync(resolve(built.bundle, "source/compiled/index.js"))),
    scope: "Actual public CLI SDK build of the generated app before the browser edit journey",
    deviceQualified: false,
  };
  writeFileSync(resolve(directory, "sdk-consumer-proof.json"), JSON.stringify(sdk, null, 2) + "\n");
  report.sdk = sdk;
  save();
  run(process.execPath, [resolve(packageRoot, "scripts/qualify-development.mjs")], packageRoot, {
    ROKU_QUALIFY_EVIDENCE_DIR: directory,
  });
  const browser = JSON.parse(readFileSync(resolve(directory, "development-proof.json")));
  assert.equal(browser.status, "passed");
  assert.equal(browser.archiveSha256, report.archiveSha256);
  report.browser = browser;
  cpSync(resolve(consumer, ".roku"), resolve(directory, "generated-projects"), { recursive: true });
  cpSync(resolve(consumer, "src"), resolve(inputs, "app-after"), { recursive: true });
  assert.equal(
    readFileSync(resolve(consumer, "src/App.tsx"), "utf8"),
    readFileSync(resolve(inputs, "app-before/App.tsx"), "utf8"),
  );
  for (const helper of helpers)
    assert.equal(
      sha(readFileSync(resolve(packageRoot, helper.path))),
      helper.sha256,
      `Qualification helper changed: ${helper.path}`,
    );
  assert.deepEqual(
    installed.runtimeInputs().filter((file) => file.path !== "package.json"),
    implementation,
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  save();
  writeFileSync(
    resolve(evidence, "metro-development-proof.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
