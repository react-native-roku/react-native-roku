import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const width = 1920,
  height = 1080;
const dark = [32, 32, 32],
  red = [240, 40, 0],
  blue = [0, 40, 240],
  cell = [128, 144, 128];
const gray = (n) => [n, n, n];
const distance = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
export const roles = ["rounded", "square"];
export const samplesPerState = 2;

export function decode(bytes) {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height",
      "-of",
      "json",
      "pipe:0",
    ],
    { input: bytes, timeout: 10000 },
  );
  assert.equal(probe.status, 0, "Cannot read screenshot metadata");
  const [stream] = JSON.parse(probe.stdout).streams;
  assert.ok(
    stream &&
      ["mjpeg", "png"].includes(stream.codec_name) &&
      stream.width === width &&
      stream.height === height,
    "Expected an original 1920×1080 JPEG or PNG",
  );
  const result = spawnSync(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { input: bytes, maxBuffer: width * height * 3 + 65536, timeout: 10000 },
  );
  assert.equal(result.status, 0, "Cannot decode screenshot");
  assert.equal(result.stdout.length, width * height * 3);
  return result.stdout;
}

// Coordinates are relative to the shared fixture's origin. The four point probes
// avoid its adjacent yellow focus stroke. Flat reference patches use channel medians.
export function measure(rgb, role, state) {
  assert.ok(roles.includes(role) && [0, 1, 2].includes(state));
  assert.equal(rgb.length, width * height * 3);
  const pixel = (x, y) => {
    const offset = 3 * ((64 + y) * width + 96 + x);
    return [...rgb.subarray(offset, offset + 3)];
  };
  const patch = (x, y) => {
    const points = [];
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) points.push(pixel(x + dx, y + dy));
    return [0, 1, 2].map((i) => points.map((p) => p[i]).sort((a, b) => a - b)[12]);
  };
  const patches = [
    [165, 78],
    [22, 68],
    [66, 68],
    [30, 44],
    [59, 99],
    [44, 88],
    [130, 7],
    [25, 21],
    [106, 54],
    [224, 16],
  ].map(([x, y]) => patch(x, y));
  const corners = [
    [13, 41],
    [74, 41],
    [74, 102],
    [13, 102],
  ].map(([x, y]) => pixel(x, y));
  return inspect(role, state, patches, corners);
}

export function inspect(role, state, patches, corners) {
  assert.ok(roles.includes(role) && [0, 1, 2].includes(state));
  assert.equal(patches.length, 10);
  assert.equal(corners.length, 4);
  for (const color of [...patches, ...corners])
    assert.ok(
      Array.isArray(color) &&
        color.length === 3 &&
        color.every((v) => Number.isInteger(v) && v >= 0 && v <= 255),
      "Invalid RGB measurement",
    );
  const references = [
    ["background", dark],
    ["poster-left", red],
    ["poster-right", blue],
    ["poster-top", red],
    ["poster-bottom", blue],
    ["overlay", gray(255)],
    ["wrap-top", state === 1 ? cell : dark],
    ["wrap-bottom", state === 1 ? dark : cell],
    ["opacity", gray([144, 88, 255][state])],
    ["fixture-mode", gray(role === "rounded" ? 72 : 216)],
  ];
  const checks = references.map(([name, expected], i) => ({
    name,
    actual: patches[i],
    expected,
    passed: distance(patches[i], expected) <= 20,
  }));
  return {
    role,
    state,
    background: patches[0],
    left: patches[1],
    right: patches[2],
    checks,
    corners,
  };
}

export function compare(rounded, square) {
  assert.equal(rounded.role, "rounded");
  assert.equal(square.role, "square");
  assert.equal(rounded.state, square.state);
  const validFrames = [rounded, square].every((f) => f.checks.every((c) => c.passed));
  return rounded.corners.map((color, i) => {
    const control = square.corners[i],
      ink = i === 0 || i === 3 ? square.left : square.right;
    const separation = distance(control, square.background);
    const validControl =
      separation >= 110 && distance(control, ink) <= 0.45 * distance(ink, square.background);
    const backgroundDelta = distance(color, rounded.background);
    const paintDelta = distance(color, control);
    let status = "inconclusive";
    if (validFrames && validControl) {
      if (backgroundDelta <= Math.min(40, separation / 4)) status = "passed";
      else if (paintDelta <= separation / 4) status = "failed";
    }
    return {
      corner: i,
      status,
      rounded: color,
      square: control,
      backgroundDelta,
      paintDelta,
      separation,
    };
  });
}
