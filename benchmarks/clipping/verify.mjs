import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchesState } from "./replay.mjs";
import { compare, decode, inspect, measure, roles, samplesPerState } from "./score.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const hex = /^[a-f0-9]{64}$/;

export function verifyReceipt(receipt, archiveSha256) {
  assert.equal(receipt.schema, "roku-preview-clipping/v1");
  assert.ok(hex.test(archiveSha256) && receipt.archiveSha256 === archiveSha256, "Archive mismatch");
  assert.ok(hex.test(receipt.fixtureSha256));
  assert.ok(
    [receipt.model, receipt.firmware].every((v) => typeof v === "string" && v.trim().length > 0),
    "Missing physical device identity",
  );
  const group = 3 * samplesPerState;
  assert.equal(receipt.frames.length, 2 * group);
  const seen = new Map();
  const frames = receipt.frames.map(({ role, state, sample, sha256, patches, corners }, i) => {
    assert.equal(role, roles[Math.floor(i / group)]);
    assert.equal(state, Math.floor(i / samplesPerState) % 3);
    assert.equal(sample, i % samplesPerState);
    assert.ok(hex.test(sha256));
    const key = role + state;
    assert.ok(
      !seen.has(sha256) || seen.get(sha256) === key,
      "Capture repeated across different states",
    );
    seen.set(sha256, key);
    return inspect(role, state, patches, corners);
  });
  for (let i = 0; i < group; i++)
    for (const c of compare(frames[i], frames[group + i]))
      assert.equal(
        c.status,
        "passed",
        `State ${frames[i].state}, sample ${i % samplesPerState}, corner ${c.corner}: ${c.status}`,
      );
}

export function verifyRun(archive, build, run) {
  const archiveSha256 = digest(readFileSync(archive));
  const inputs = json(join(build, "inputs.json")),
    id = json(join(run, "identity.json")),
    restoration = json(join(run, "restoration.json"));
  const fixtureSha256 = digest(readFileSync(join(build, "fixture.zip")));
  assert.equal(inputs.screen, "clipping");
  assert.equal(inputs.archiveSha256, archiveSha256);
  assert.equal(inputs.zipSha256, fixtureSha256);
  assert.equal(id.sha256, fixtureSha256);
  assert.ok(
    restoration.installed === true &&
      restoration.playbackClosed === true &&
      hex.test(id.rollbackSha256) &&
      restoration.sha256 === id.rollbackSha256,
    "Unverified device restoration",
  );
  const dir = join(run, "journey"),
    result = json(join(dir, "clipping.json"));
  assert.equal(result.schema, "roku-installer-clipping/v1");
  assert.equal(result.fixtureSha256, fixtureSha256);
  assert.equal(result.status, "passed");
  const frames = [];
  for (const role of roles)
    for (let state = 0; state < 3; state++)
      for (let sample = 0; sample < samplesPerState; sample++) {
        const prefix = `${role}-${state}-${sample}`;
        const recorded = result.frames[frames.length];
        assert.ok([prefix + ".jpg", prefix + ".png"].includes(recorded.filename));
        for (const phase of ["before", "after"])
          assert.ok(
            matchesState(
              readFileSync(join(dir, prefix + "-" + phase + ".xml"), "utf8"),
              role,
              state,
            ),
            "Native tree differs from the required state",
          );
        const bytes = readFileSync(join(dir, recorded.filename)),
          sha256 = digest(bytes);
        assert.equal(sha256, recorded.sha256, "Screenshot changed");
        const f = measure(decode(bytes), role, state);
        assert.deepEqual(recorded, { filename: recorded.filename, sha256, sample, ...f });
        frames.push({
          role,
          state,
          sample,
          sha256,
          patches: f.checks.map((c) => c.actual),
          corners: f.corners,
        });
      }
  assert.equal(result.frames.length, frames.length);
  const receipt = {
    schema: "roku-preview-clipping/v1",
    archiveSha256,
    fixtureSha256,
    model: id.model,
    firmware: id.firmware,
    frames,
  };
  verifyReceipt(receipt, archiveSha256);
  return receipt;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--receipt") {
    verifyReceipt(JSON.parse(readFileSync(0, "utf8")), args[1]);
    console.log("Clipping measurements match the release archive and passed every control");
  } else {
    assert.equal(args.length, 3, "Usage: verify.mjs ARCHIVE BUILD_DIRECTORY DEVICE_RUN");
    console.log(JSON.stringify(verifyRun(...args)));
  }
}
