import { spawnSync } from "node:child_process";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  realpathSync,
  readdirSync,
  constants,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { packageRoot } from "../build/index.mjs";
import { ensureQualificationStorage } from "./qualificationStorage.mjs";

export const qualificationLanes = [
  ["qualify-consumer.mjs", "consumer-proof.json"],
  ["qualify-sdk-consumer.mjs", "sdk-consumer-proof.json"],
  ["qualify-development.mjs", "development-proof.json"],
  ["qualify-metro-consumer.mjs", "metro-consumer-proof.json"],
  ["qualify-metro-development.mjs", "metro-development-proof.json"],
  ["qualify-fast-refresh.mjs", "fast-refresh-proof.json"],
];
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

function verifyLanes(archive, output) {
  const sha256 = digest(archive);
  for (const [, file] of qualificationLanes) {
    const proof = json(resolve(output, file));
    if (proof.status !== "passed" || proof.archiveSha256 !== sha256)
      throw Error(`Candidate proof does not attest these archive bytes: ${file}`);
  }
  return sha256;
}

function verifyConformanceInputs(files, sourceRoot) {
  for (const name of [
    ...qualificationLanes.map(([name]) => name),
    "browserHarness.mjs",
    "qualificationStorage.mjs",
    "qualification_storage.py",
  ]) {
    const captures = files.filter((file) => file.path.endsWith("/" + name));
    if (
      !captures.length ||
      captures.some((file) => file.sha256 !== digest(resolve(sourceRoot, "scripts", name)))
    )
      throw Error(`Qualification helper changed or is not captured: ${name}`);
  }
  const examples = resolve(sourceRoot, "examples/minimal/src");
  const currentNames = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name,
        path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path, name + "/");
      else {
        currentNames.push(name);
        const matches = files.filter(
          (file) =>
            file.path === "orchestration-inputs/examples/minimal/src/" + name ||
            file.path === "retained-default-consumers/react/src/" + name,
        );
        if (
          !entry.isFile() ||
          !matches.length ||
          matches.some((file) => file.sha256 !== digest(path))
        )
          throw Error(`Qualification example changed or is not captured: ${name}`);
      }
    }
  };
  visit(examples);
  for (const prefix of [
    "orchestration-inputs/examples/minimal/src/",
    "retained-default-consumers/react/src/",
  ]) {
    const names = files
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => file.path.slice(prefix.length))
      .sort();
    if (names.length && JSON.stringify(names) !== JSON.stringify([...currentNames].sort()))
      throw Error("Qualification example inventory changed");
  }
}

/** Reuse requires the exact previously recorded seal, all lane proofs, every
 * retained byte and unchanged conformance helpers. It never edits old evidence. */
export function verifyPackedQualification({
  archive,
  output,
  manifestSha256,
  sourceRoot = packageRoot,
}) {
  if (!/^[a-f0-9]{64}$/.test(manifestSha256 ?? ""))
    throw Error("Reusing qualification requires its previously recorded files.json SHA-256");
  const manifest = resolve(output, "files.json");
  if (digest(manifest) !== manifestSha256) throw Error("Qualification manifest changed");
  const files = json(manifest),
    seen = new Set(),
    canonical = realpathSync(output);
  if (!Array.isArray(files) || !files.length) throw Error("Qualification inventory is empty");
  for (const file of files) {
    if (
      typeof file.path !== "string" ||
      !file.path ||
      isAbsolute(file.path) ||
      file.path.split(/[\\/]/).includes("..") ||
      seen.has(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256 ?? "")
    )
      throw Error("Invalid qualification inventory path");
    seen.add(file.path);
    const path = resolve(output, file.path);
    if (
      !lstatSync(path).isFile() ||
      realpathSync(path) !== resolve(canonical, file.path) ||
      !path.startsWith(resolve(output) + sep)
    )
      throw Error("Qualification contains an unattested symbolic link");
    if (digest(path) !== file.sha256) throw Error(`Qualification file changed: ${file.path}`);
  }
  for (const name of ["qualification.json", ...qualificationLanes.map(([, name]) => name)])
    if (!seen.has(name)) throw Error(`Qualification inventory omits ${name}`);
  requireRetainedConsumers(files);
  const sha256 = verifyLanes(archive, output),
    proof = json(resolve(output, "qualification.json"));
  if (
    proof.schema !== "react-native-roku-packed-qualification/v1" ||
    proof.status !== "passed" ||
    proof.sha256 !== sha256
  )
    throw Error("Qualification does not attest this archive");
  verifyConformanceInputs(files, sourceRoot);
  return {
    ...proof,
    archive: resolve(archive),
    evidence: resolve(output),
    manifestSha256,
    lanes: qualificationLanes.length,
  };
}

function retainedFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || (!prefix && entry.name === "files.json")) return [];
    if (entry.isSymbolicLink()) throw Error("Qualification contains an unattested symbolic link");
    const path = prefix + entry.name,
      full = resolve(directory, entry.name);
    return entry.isDirectory() ? retainedFiles(full, path + "/") : [{ path, sha256: digest(full) }];
  });
}

function requireRetainedConsumers(files) {
  const names = new Set(files.map((file) => file.path));
  for (const name of [
    "retained-default-consumers/react/package.json",
    "retained-default-consumers/react/src/qualify.ts",
    "retained-default-consumers/sdk/package.json",
    "retained-default-consumers/sdk/.roku/dist/sdk/bundle/source/compiled/index.js",
  ])
    if (!names.has(name)) throw Error(`Qualification omits a retained default consumer: ${name}`);
}

/** Both orchestration modes retain the same terminal consumers. Keep originals
 * until sealing so a partial or changed previous copy cannot masquerade as a
 * complete generated tree. COPYFILE_FICLONE preserves independent snapshots
 * while sharing blocks where the filesystem supports it. */
function retainDefaultConsumer(output, name) {
  const proof = json(
    resolve(output, name === "react" ? "consumer-proof.json" : "sdk-consumer-proof.json"),
  );
  if (typeof proof.consumer !== "string") throw Error(`Missing ${name} consumer source`);
  const source = resolve(proof.consumer);
  const canonical = realpathSync(source);
  const prefix = name === "react" ? "react-native-roku-consumer-" : "react-native-roku-sdk-";
  if (
    lstatSync(source).isSymbolicLink() ||
    !canonical.startsWith(realpathSync(tmpdir()) + sep) ||
    !basename(dirname(canonical)).startsWith(prefix) ||
    basename(canonical) !== (name === "react" ? "consumer" : "hello") ||
    json(resolve(source, "package.json")).private !== true
  )
    throw Error(`Expected an owned private temporary ${name} consumer`);
  const inventory = (directory) =>
    retainedFiles(directory, "consumer/")
      .map(({ path, sha256 }) => ({ path: path.slice("consumer/".length), sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path));
  const expected = inventory(source);
  const target = resolve(output, "retained-default-consumers", name);
  if (!existsSync(target))
    cpSync(source, target, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => !path.split(/[\\/]/).includes("node_modules"),
    });
  const actual = inventory(target);
  if (
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    JSON.stringify(inventory(source)) !== JSON.stringify(expected)
  )
    throw Error(
      `Retained ${name} consumer is incomplete or changed; preserve it and choose a fresh cohort`,
    );
  return source;
}

function retireLaneCaches(root, proof, archive, output) {
  const result = spawnSync(
    "python3",
    [
      resolve(packageRoot, "scripts/qualification_storage.py"),
      "prune-caches",
      "--root=" + root,
      "--proof=" + proof,
      "--archive-sha256=" + digest(archive),
    ],
    { cwd: packageRoot, encoding: "utf8", env: process.env },
  );
  if (result.status !== 0)
    throw Error(
      "Completed lane cache retirement refused: " +
        (result.stderr || result.error || result.stdout),
    );
  const path = resolve(output, "cache-retirement.json");
  const records = existsSync(path) ? json(path) : [];
  records.push(JSON.parse(result.stdout));
  writeFileSync(path, JSON.stringify(records, null, 2) + "\n");
}

/** Prepare one owned cohort before separately invoking finite lane commands. */
export function prepareQualificationInputs({ archive, output, sourceRoot = packageRoot }) {
  if (
    ["qualification.json", "files.json", "orchestration-inputs"].some((name) =>
      existsSync(resolve(output, name)),
    )
  )
    throw Error("Preserve previous qualification; choose a fresh output directory");
  const inputs = resolve(output, "orchestration-inputs");
  mkdirSync(inputs, { recursive: true });
  const helpers = [];
  for (const name of [
    "qualify-package.mjs",
    "qualificationStorage.mjs",
    "qualification_storage.py",
    "checked-commands.mjs",
    ...qualificationLanes.map(([name]) => name),
    "browserHarness.mjs",
  ]) {
    const source = resolve(sourceRoot, "scripts", name),
      target = resolve(inputs, "scripts", name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    helpers.push({ source, target, sha256: digest(target) });
  }
  cpSync(resolve(sourceRoot, "examples/minimal/src"), resolve(inputs, "examples/minimal/src"), {
    recursive: true,
  });
  const files = retainedFiles(inputs).sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(
    resolve(output, "orchestration-inputs.json"),
    JSON.stringify({ archiveSha256: digest(archive), files }, null, 2) + "\n",
  );
  return helpers;
}

/** Finish only after every real lane attests the same archive. This supports
 * finite lanes without rerunning passed checks or overwriting frozen evidence. */
export function sealPackedQualification({
  archive,
  output,
  sourceRoot = packageRoot,
  execution = "separately-executed-lanes",
}) {
  if (["qualification.json", "files.json"].some((name) => existsSync(resolve(output, name))))
    throw Error("Preserve previous qualification; choose a fresh output directory");
  const sha256 = verifyLanes(archive, output);
  const preparedPath = resolve(output, "orchestration-inputs.json");
  if (existsSync(preparedPath)) {
    const prepared = json(preparedPath);
    if (prepared.archiveSha256 !== sha256) throw Error("Prepared archive changed");
    const captured = retainedFiles(resolve(output, "orchestration-inputs")).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    if (JSON.stringify(captured) !== JSON.stringify(prepared.files))
      throw Error("Prepared conformance capture changed");
    for (const file of prepared.files)
      if (digest(resolve(sourceRoot, file.path)) !== file.sha256)
        throw Error(`Prepared source changed: ${file.path}`);
    const currentExamples = retainedFiles(
      resolve(sourceRoot, "examples/minimal/src"),
      "examples/minimal/src/",
    )
      .map((file) => file.path)
      .sort();
    const capturedExamples = prepared.files
      .filter((file) => file.path.startsWith("examples/minimal/src/"))
      .map((file) => file.path)
      .sort();
    if (JSON.stringify(currentExamples) !== JSON.stringify(capturedExamples))
      throw Error("Prepared example inventory changed");
  }
  verifyConformanceInputs(retainedFiles(output), sourceRoot);
  for (const name of ["react", "sdk"]) retainDefaultConsumer(output, name);
  const retained = retainedFiles(output);
  requireRetainedConsumers(retained);
  verifyConformanceInputs(retained, sourceRoot);
  const finalizer = resolve(output, "finalization-inputs/qualify-package.mjs");
  mkdirSync(dirname(finalizer), { recursive: true });
  copyFileSync(fileURLToPath(import.meta.url), finalizer);
  const result = {
    schema: "react-native-roku-packed-qualification/v1",
    status: "passed",
    archive: resolve(archive),
    sha256,
    deviceQualified: false,
    evidence: resolve(output),
    execution,
    inputCapture: existsSync(preparedPath)
      ? "prepared-before-lanes"
      : "existing-conformance-captures",
    finalizerSha256: digest(finalizer),
    defaultConsumersRetained: true,
  };
  writeFileSync(resolve(output, "qualification.json"), JSON.stringify(result, null, 2) + "\n");
  const files = retainedFiles(output).sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(resolve(output, "files.json"), JSON.stringify(files, null, 2) + "\n");
  return { ...result, manifestSha256: digest(resolve(output, "files.json")) };
}

export function qualifyPackage(argv = process.argv.slice(2)) {
  const argument = argv.find((value) => value.startsWith("--archive="));
  if (
    !argument ||
    argv.some(
      (value) =>
        !["--verify-only", "--prepare-only", "--seal-only"].includes(value) &&
        !["--archive=", "--output=", "--manifest-sha256="].some((key) => value.startsWith(key)),
    )
  )
    throw Error(
      "Usage: qualify-package.mjs --archive=FILE --output=DIRECTORY [--prepare-only | --seal-only | --verify-only --manifest-sha256=SHA256]",
    );
  const archive = resolve(argument.slice(10)),
    output = resolve(
      argv.find((value) => value.startsWith("--output="))?.slice(9) ??
        ".local/package-qualification",
    );
  if (
    ["--verify-only", "--prepare-only", "--seal-only"].filter((flag) => argv.includes(flag))
      .length > 1
  )
    throw Error("Select only one qualification operation");
  if (argv.includes("--verify-only"))
    return verifyPackedQualification({
      archive,
      output,
      manifestSha256: argv.find((value) => value.startsWith("--manifest-sha256="))?.slice(18),
    });
  if (argv.some((value) => value.startsWith("--manifest-sha256=")))
    throw Error("An existing manifest seal is only accepted with --verify-only");
  if (argv.includes("--seal-only")) return sealPackedQualification({ archive, output });
  mkdirSync(output, { recursive: true });
  if (
    existsSync(resolve(output, "qualification.json")) ||
    existsSync(resolve(output, "files.json"))
  )
    throw Error("Preserve previous qualification; choose a fresh output directory");
  const helpers = prepareQualificationInputs({ archive, output });
  if (argv.includes("--prepare-only"))
    return {
      status: "prepared",
      archive: resolve(archive),
      sha256: digest(archive),
      evidence: output,
      lanes: qualificationLanes.map(([script, proof]) => ({ script: "scripts/" + script, proof })),
    };
  for (const [script, proofName] of qualificationLanes) {
    const result = spawnSync(process.execPath, [resolve(packageRoot, "scripts", script)], {
      cwd: packageRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ROKU_QUALIFY_ARCHIVE: archive, ROKU_QUALIFY_EVIDENCE_DIR: output },
    });
    writeFileSync(
      resolve(output, script + ".log"),
      (result.stdout ?? "") + "\n" + (result.stderr ?? ""),
    );
    if (result.status !== 0)
      throw Error(`Candidate ${script} failed; see ${resolve(output, script + ".log")}`);
    const proof = json(resolve(output, proofName));
    if (proof.status !== "passed" || proof.archiveSha256 !== digest(archive))
      throw Error(`Candidate ${script} did not produce a passed exact-archive proof`);
    if (script === "qualify-consumer.mjs" || script === "qualify-development.mjs") {
      const name = script === "qualify-consumer.mjs" ? "react" : "sdk";
      const source = retainDefaultConsumer(output, name);
      retireLaneCaches(
        source,
        resolve(output, name === "react" ? "consumer-proof.json" : "sdk-consumer-proof.json"),
        archive,
        output,
      );
    }
    // These independent consumers have no downstream lane. Retain all captured
    // inputs and generated trees; only their reinstallable dependencies retire.
    if (typeof proof.directory === "string")
      retireLaneCaches(proof.directory, resolve(output, proofName), archive, output);
  }
  for (const helper of helpers)
    if (digest(helper.source) !== helper.sha256)
      throw Error("Qualification helper changed during execution");
  return sealPackedQualification({ archive, output, execution: "serial-lanes" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--verify-only"))
    await ensureQualificationStorage({ projectRoot: packageRoot });
  console.log(JSON.stringify(qualifyPackage()));
}
