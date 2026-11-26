import test from "node:test";
import assert from "node:assert/strict";
import { inspect, compare, decode, measure } from "../benchmarks/clipping/score.mjs";
import { matchesState } from "../benchmarks/clipping/replay.mjs";
import { verifyReceipt } from "../benchmarks/clipping/verify.mjs";

const gray = (n) => [n, n, n],
  bg = gray(32),
  art = [
    [240, 40, 0],
    [0, 40, 240],
  ],
  cell = [128, 144, 128],
  archive = "b".repeat(64);
function frame(role, state, sample = 0) {
  const patches = [
    bg,
    ...art,
    ...art,
    gray(255),
    state === 1 ? cell : bg,
    state === 1 ? bg : cell,
    gray([144, 88, 255][state]),
    gray(role === "rounded" ? 72 : 216),
  ];
  const corners = role === "rounded" ? Array(4).fill(gray(46)) : [art[0], art[1], art[1], art[0]];
  return {
    role,
    state,
    sample,
    sha256: String((role === "square" ? 3 : 0) + state).repeat(64),
    patches,
    corners,
  };
}
function receipt() {
  return {
    schema: "roku-preview-clipping/v1",
    model: "host fixture",
    firmware: "test",
    archiveSha256: archive,
    fixtureSha256: "a".repeat(64),
    frames: ["rounded", "square"].flatMap((role) =>
      [0, 1, 2].flatMap((state) => [0, 1].map((sample) => frame(role, state, sample))),
    ),
  };
}
const inspectFrame = (f) => inspect(f.role, f.state, f.patches, f.corners);
test("compression drift passes with valid artwork and a matched square control", () => {
  verifyReceipt(receipt(), archive);
  const a = frame("rounded", 1),
    b = frame("square", 1);
  a.corners[2] = art[1];
  assert.deepEqual(
    compare(inspectFrame(a), inspectFrame(b)).map((c) => c.status),
    ["passed", "passed", "failed", "passed"],
  );
  a.corners[2] = gray(90);
  assert.equal(compare(inspectFrame(a), inspectFrame(b))[2].status, "inconclusive");
});
test("a missing image, cropped edges, stale state, wrong marker or invalid control cannot pass", () => {
  for (const bad of [
    (r) => {
      r.frames[0].patches[1] = bg;
    },
    (r) => {
      r.frames[1].patches[3] = bg;
    },
    (r) => {
      r.frames[4].patches[8] = gray(144);
    },
    (r) => {
      r.frames[1].patches[9] = gray(216);
    },
    (r) => {
      r.frames[7].corners[1] = bg;
    },
    (r) => {
      r.frames[8].corners[2] = art[0];
    },
    (r) => {
      r.frames[2].sha256 = r.frames[0].sha256;
    },
    (r) => {
      r.frames.pop();
    },
    (r) => {
      r.frames.reverse();
    },
    (r) => {
      r.frames[0].corners[0] = [null, 32, 32];
    },
  ]) {
    const r = receipt();
    bad(r);
    assert.throws(() => verifyReceipt(r, archive));
  }
  assert.throws(() => verifyReceipt(receipt(), "d".repeat(64)), /Archive mismatch/);
  assert.throws(() => decode(Buffer.from("invalid image")));
});
test("native state requires both the current label and focus on the advancing control", () => {
  const xml =
    '<Scene><Group name="core-next" focused="true"/><Label text="Rounded test 2"/></Scene>';
  assert.ok(matchesState(xml, "rounded", 2));
  assert.ok(!matchesState(xml, "square", 2));
  assert.ok(!matchesState(xml, "rounded", 1));
  assert.ok(!matchesState(xml.replace('focused="true"', 'focused="false"'), "rounded", 2));
});

test("the sampler reads the fixed corner points beside the focus stroke and the flat reference patches", () => {
  const pixels = Buffer.alloc(1920 * 1080 * 3);
  const point = (x, y, c) => pixels.set(c, 3 * (1920 * y + x));
  const f = frame("rounded", 1);
  const centers = [
    [261, 142],
    [118, 132],
    [162, 132],
    [126, 108],
    [155, 163],
    [140, 152],
    [226, 71],
    [121, 85],
    [202, 118],
    [320, 80],
  ];
  centers.forEach(([x, y], i) => {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) point(x + dx, y + dy, f.patches[i]);
    point(x, y, [255, 200, 0]); // Single-pixel noise cannot move the patch median.
  });
  [
    [109, 105],
    [170, 105],
    [170, 166],
    [109, 166],
  ].forEach(([x, y], i) => point(x, y, f.corners[i]));
  assert.deepEqual(measure(pixels, "rounded", 1), inspectFrame(f));
});
