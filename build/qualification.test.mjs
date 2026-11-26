import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  existsSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  qualificationLanes,
  verifyPackedQualification,
  prepareQualificationInputs,
  sealPackedQualification,
  qualifyPackage,
} from "../scripts/qualify-package.mjs";

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "roku-qualified-reuse-")),
    output = resolve(root, "evidence"),
    sourceRoot = resolve(root, "source"),
    archive = resolve(root, "platform.tgz");
  const write = (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  write(archive, "exact archived bytes");
  const hash = digest(archive);
  const consumers = {
    react: resolve(root, "react-native-roku-consumer-fixture/consumer"),
    sdk: resolve(root, "react-native-roku-sdk-fixture/hello"),
  };
  for (const consumer of Object.values(consumers)) {
    write(resolve(consumer, "package.json"), JSON.stringify({ private: true }));
    write(resolve(consumer, "files.json"), '{"consumerData":true}');
  }
  write(resolve(consumers.react, "src/qualify.ts"), "original contract");
  write(resolve(consumers.sdk, "src/App.tsx"), "SDK application");
  write(
    resolve(consumers.sdk, ".roku/dist/sdk/bundle/source/compiled/index.js"),
    "compiled SDK program",
  );
  for (const [script, proof] of qualificationLanes) {
    write(resolve(sourceRoot, "scripts", script), script);
    write(resolve(output, "orchestration-inputs/scripts", script), script);
    const consumer =
      script === "qualify-consumer.mjs"
        ? consumers.react
        : script === "qualify-sdk-consumer.mjs"
          ? consumers.sdk
          : undefined;
    write(
      resolve(output, proof),
      JSON.stringify({ status: "passed", archiveSha256: hash, consumer }),
    );
  }
  write(resolve(sourceRoot, "scripts/browserHarness.mjs"), "browser driver");
  write(resolve(output, "orchestration-inputs/scripts/browserHarness.mjs"), "browser driver");
  for (const name of [
    "qualificationStorage.mjs",
    "qualification_storage.py",
    "checked-commands.mjs",
  ]) {
    write(resolve(sourceRoot, "scripts", name), "storage input " + name);
    write(resolve(output, "orchestration-inputs/scripts", name), "storage input " + name);
  }
  write(resolve(sourceRoot, "examples/minimal/src/qualify.ts"), "original contract");
  for (const [name, consumer] of Object.entries(consumers))
    cpSync(consumer, resolve(output, "retained-default-consumers", name), { recursive: true });
  write(
    resolve(output, "qualification.json"),
    JSON.stringify({
      schema: "react-native-roku-packed-qualification/v1",
      status: "passed",
      sha256: hash,
    }),
  );
  const seal = () => {
    const walk = (directory, prefix = "") =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.name === "files.json"
          ? []
          : entry.isDirectory()
            ? walk(resolve(directory, entry.name), prefix + entry.name + "/")
            : [{ path: prefix + entry.name, sha256: digest(resolve(directory, entry.name)) }],
      );
    write(resolve(output, "files.json"), JSON.stringify(walk(output)));
    return digest(resolve(output, "files.json"));
  };
  return {
    root,
    output,
    sourceRoot,
    archive,
    consumers,
    write,
    seal,
    verify: (manifestSha256) =>
      verifyPackedQualification({ archive, output, sourceRoot, manifestSha256 }),
  };
}

test("qualification reuse verifies the anchored inventory, all six proofs and unchanged conformance inputs", () => {
  const f = fixture();
  try {
    const seal = f.seal();
    assert.equal(f.verify(seal).lanes, 6);
    assert.throws(() => f.verify(), /previously recorded/);
    f.write(resolve(f.output, "consumer-proof.json"), "changed evidence");
    assert.throws(() => f.verify(seal), /Qualification file changed/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a passed summary cannot conceal failed or missing lanes, changed archives or changed contracts", () => {
  for (const mutation of [
    "failed-lane",
    "missing-lane",
    "archive",
    "helper",
    "example",
    "removed-example",
  ]) {
    const f = fixture();
    try {
      if (mutation === "failed-lane")
        f.write(
          resolve(f.output, "fast-refresh-proof.json"),
          JSON.stringify({ status: "failed", archiveSha256: digest(f.archive) }),
        );
      if (mutation === "missing-lane") rmSync(resolve(f.output, "fast-refresh-proof.json"));
      const seal = f.seal();
      if (mutation === "archive") f.write(f.archive, "different archive");
      if (mutation === "helper")
        f.write(resolve(f.sourceRoot, "scripts/qualify-sdk-consumer.mjs"), "changed requirement");
      if (mutation === "example")
        f.write(resolve(f.sourceRoot, "examples/minimal/src/qualify.ts"), "changed behavior");
      if (mutation === "removed-example")
        rmSync(resolve(f.sourceRoot, "examples/minimal/src/qualify.ts"));
      assert.throws(() => f.verify(seal), /does not attest|omits|changed/, mutation);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("qualification inventories reject traversal, duplicate entries and symbolic-link payloads", () => {
  for (const mutation of ["traversal", "duplicate", "link"]) {
    const f = fixture();
    try {
      f.seal();
      const path = resolve(f.output, "files.json"),
        records = JSON.parse(readFileSync(path));
      if (mutation === "traversal")
        records.push({ path: "../platform.tgz", sha256: digest(f.archive) });
      if (mutation === "duplicate") records.push(records[0]);
      if (mutation === "link") {
        symlinkSync(f.archive, resolve(f.output, "linked.tgz"));
        records.push({ path: "linked.tgz", sha256: digest(f.archive) });
      }
      f.write(path, JSON.stringify(records));
      assert.throws(() => f.verify(digest(path)), /Invalid qualification|symbolic link/, mutation);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("separately executed lanes receive the same anchored verification and cannot overwrite a frozen cohort", () => {
  const f = fixture();
  try {
    rmSync(resolve(f.output, "qualification.json"));
    const result = sealPackedQualification(f);
    assert.equal(result.execution, "separately-executed-lanes");
    assert.equal(result.inputCapture, "existing-conformance-captures");
    assert.equal(f.verify(result.manifestSha256).lanes, 6);
    assert.equal(
      digest(resolve(f.output, "finalization-inputs/qualify-package.mjs")),
      result.finalizerSha256,
    );
    assert.throws(() => sealPackedQualification(f), /Preserve previous/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a seal cannot certify missing, failed or mismatched individual lane results", () => {
  for (const mutation of ["missing", "failed", "archive"]) {
    const f = fixture();
    try {
      rmSync(resolve(f.output, "qualification.json"));
      const proof = resolve(f.output, "fast-refresh-proof.json");
      if (mutation === "missing") rmSync(proof);
      else
        f.write(
          proof,
          JSON.stringify({
            status: mutation === "failed" ? "failed" : "passed",
            archiveSha256: mutation === "archive" ? "a".repeat(64) : digest(f.archive),
          }),
        );
      assert.throws(() => sealPackedQualification(f), /ENOENT|does not attest/);
      assert.equal(existsSync(resolve(f.output, "qualification.json")), false);
      assert.equal(existsSync(resolve(f.output, "files.json")), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("preparation captures conformance inputs and refuses archive, source, capture and example inventory drift", () => {
  for (const mutation of ["none", "archive", "source", "capture", "new-example", "data"]) {
    const f = fixture();
    try {
      f.write(resolve(f.sourceRoot, "scripts/qualify-package.mjs"), "orchestration owner");
      f.write(resolve(f.sourceRoot, "examples/minimal/src/files.json"), '{"fixture":true}');
      f.write(resolve(f.consumers.react, "src/files.json"), '{"fixture":true}');
      const output = resolve(f.root, "prepared");
      prepareQualificationInputs({ ...f, output });
      assert.throws(() => prepareQualificationInputs({ ...f, output }), /Preserve previous/);
      for (const [, proof] of qualificationLanes)
        f.write(resolve(output, proof), readFileSync(resolve(f.output, proof)));
      if (mutation === "archive") f.write(f.archive, "different bytes");
      if (mutation === "source")
        f.write(resolve(f.sourceRoot, "examples/minimal/src/qualify.ts"), "changed contract");
      if (mutation === "capture")
        f.write(
          resolve(output, "orchestration-inputs/examples/minimal/src/qualify.ts"),
          "changed capture",
        );
      if (mutation === "new-example")
        f.write(resolve(f.sourceRoot, "examples/minimal/src/required.ts"), "new contract");
      if (mutation === "data")
        f.write(resolve(f.sourceRoot, "examples/minimal/src/files.json"), '{"fixture":false}');
      if (mutation === "none") {
        const result = sealPackedQualification({ ...f, output });
        assert.equal(result.inputCapture, "prepared-before-lanes");
        assert.equal(
          verifyPackedQualification({ ...f, output, manifestSha256: result.manifestSha256 }).lanes,
          6,
        );
      } else {
        assert.throws(() => sealPackedQualification({ ...f, output }), /does not attest|Prepared/);
        assert.equal(existsSync(resolve(output, "qualification.json")), false);
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("qualification operation flags are mutually exclusive and seals cannot be applied to another operation", () => {
  assert.throws(
    () => qualifyPackage(["--archive=unused", "--prepare-only", "--seal-only"]),
    /only one/,
  );
  assert.throws(
    () =>
      qualifyPackage(["--archive=unused", "--seal-only", "--manifest-sha256=" + "a".repeat(64)]),
    /only accepted with/,
  );
});

test("seal-only retains both terminal consumers without dependencies and keeps their snapshots independent", () => {
  const f = fixture();
  try {
    f.write(
      resolve(f.output, "orchestration-inputs/examples/minimal/src/qualify.ts"),
      "original contract",
    );
    rmSync(resolve(f.output, "qualification.json"));
    rmSync(resolve(f.output, "retained-default-consumers"), { recursive: true });
    for (const consumer of Object.values(f.consumers))
      symlinkSync(f.sourceRoot, resolve(consumer, "node_modules"), "dir");
    const result = sealPackedQualification(f);
    assert.equal(result.defaultConsumersRetained, true);
    for (const name of ["react", "sdk"])
      assert.equal(
        existsSync(resolve(f.output, "retained-default-consumers", name, "node_modules")),
        false,
      );
    const program = ".roku/dist/sdk/bundle/source/compiled/index.js";
    f.write(resolve(f.consumers.sdk, program), "later source change");
    assert.equal(
      readFileSync(resolve(f.output, "retained-default-consumers/sdk", program), "utf8"),
      "compiled SDK program",
    );
    assert.equal(f.verify(result.manifestSha256).lanes, 6);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("sealing refuses partial captures, unowned sources and missing compiled SDK programs", () => {
  for (const mutation of ["partial", "root-data", "unowned", "missing-program"]) {
    const f = fixture();
    try {
      rmSync(resolve(f.output, "qualification.json"));
      if (mutation === "partial")
        rmSync(resolve(f.output, "retained-default-consumers/sdk/src/App.tsx"));
      if (mutation === "root-data")
        f.write(resolve(f.consumers.sdk, "files.json"), '{"consumerData":"changed"}');
      if (mutation === "unowned")
        f.write(
          resolve(f.output, "sdk-consumer-proof.json"),
          JSON.stringify({
            status: "passed",
            archiveSha256: digest(f.archive),
            consumer: f.sourceRoot,
          }),
        );
      if (mutation === "missing-program") {
        rmSync(resolve(f.output, "retained-default-consumers/sdk"), { recursive: true });
        rmSync(resolve(f.consumers.sdk, ".roku/dist/sdk/bundle/source/compiled/index.js"));
      }
      assert.throws(() => sealPackedQualification(f), /Retained|owned private|retained default/);
      assert.equal(existsSync(resolve(f.output, "qualification.json")), false);
      assert.equal(existsSync(resolve(f.output, "files.json")), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("a newly anchored passed summary cannot conceal omitted retained consumer programs", () => {
  const f = fixture();
  try {
    rmSync(
      resolve(
        f.output,
        "retained-default-consumers/sdk/.roku/dist/sdk/bundle/source/compiled/index.js",
      ),
    );
    assert.throws(() => f.verify(f.seal()), /retained default consumer/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
