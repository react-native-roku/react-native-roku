import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { openTestBrowser, until } from "./browserHarness.mjs";

const args = process.argv.slice(2);
const nativeStills = args[0] === "--native-stills";
const output = nativeStills ? args[1] : args[2];
if (args.length !== (nativeStills ? 5 : 3))
  throw Error(
    "Usage: qualify-core-ui.mjs ROKU_URL RN_WEB_URL NEW_OUTPUT, or --native-stills NEW_OUTPUT STATE0.jpg STATE1.jpg STATE2.jpg",
  );
mkdirSync(output);

// Logical viewport coordinates, at scale 1. Single-pixel samples isolate the stroke and mask from
// one another. The other 3×3 regions stay clear of
// shape boundaries, glyphs, and antialiasing. Alpha permits 2 levels of rounding.
const base = [32, 32, 32, 255];
const cell = [128, 144, 128, 255];
const probes = [
  ["wrap:top", 107, 7, [base, cell, base]],
  ["wrap:bottom", 7, 21, [cell, base, cell]],
  ...[
    [13, 41],
    [74, 41],
    [74, 102],
    [13, 102],
  ].map(([x, y], index) => ["clip:corner-" + index, x, y, [base, base, base]]),
  ["image:cover-left", 14, 70, Array(3).fill([240, 40, 0, 255])],
  ["image:cover-right", 73, 70, Array(3).fill([0, 40, 240, 255])],
  ["overlay:z-index", 44, 88, Array(3).fill([255, 255, 255, 255])],
  ["overlay:lower-visible", 29, 81, Array(3).fill([0, 128, 0, 255])],
  ["focus:outside-stroke", 42, 37, Array(3).fill([255, 255, 0, 255])],
  [
    "opacity:mount-update-remove",
    105,
    52,
    [144, 88, 255].map((value) => [value, value, value, 255]),
  ],
];
const origin = { x: 96, y: 64 };
const width = 1920,
  height = 1080;
const events = (step) => {
  const result = ["mount", "commit:0"];
  for (let index = 0; index < step; index++) result.push(`press:${index}`, `commit:${index + 1}`);
  return result;
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function score(backend, step, capture) {
  const decoded = spawnSync(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "image2pipe",
      "-i",
      "pipe:0",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
    ],
    { input: capture, maxBuffer: width * height * 4 + 65536, timeout: 10000 },
  );
  assert.equal(decoded.status, 0, "Capture decode failed");
  const bytes = decoded.stdout;
  assert.equal(bytes.length, width * height * 4);
  return probes.map(([id, x, y, colors]) => {
    const expected = colors[step];
    const attempts = [];
    const radius =
      nativeStills || /^(focus|clip):/.test(id) || id === "overlay:lower-visible" ? 0 : 1;
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const start = ((origin.y + y + dy) * width + origin.x + x + dx) * 4;
        attempts.push([...bytes.subarray(start, start + 4)]);
      }
    const delta = Math.max(
      ...attempts.flatMap((actual) => actual.map((value, i) => Math.abs(value - expected[i]))),
    );
    const tolerance = nativeStills ? 12 : id.startsWith("opacity:") ? 2 : 0;
    return {
      backend,
      state: step,
      id,
      x,
      y,
      expected,
      attempts,
      tolerance,
      passed: delta <= tolerance,
    };
  });
}

async function observe(backend, url) {
  const browser = await openTestBrowser(url);
  const readEvents = () => browser.evaluate("globalThis.__CORE_UI_EVENTS__");
  try {
    await browser.call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const states = [];
    for (let step = 0; step < 3; step++) {
      if (step && backend === "react-native-web") {
        for (const type of ["mousePressed", "mouseReleased"])
          await browser.call("Input.dispatchMouseEvent", {
            type,
            x: origin.x + 32,
            y: origin.y + 130,
            button: "left",
            clickCount: 1,
          });
      } else if (step) {
        for (const type of ["keyDown", "keyUp"]) {
          await browser.call("Input.dispatchKeyEvent", {
            type,
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
          });
        }
      }
      let trace;
      try {
        trace = await until(
          async () => {
            const observed = await readEvents();
            return (
              observed?.includes("image:load") && observed.includes("commit:" + step) && observed
            );
          },
          { timeout: 5000 },
        );
      } catch {
        const observed = await browser.evaluate(
          "({ trace: globalThis.__CORE_UI_EVENTS__, status: document.querySelector('#status')?.textContent })",
        );
        throw Error(`${backend}/state ${step}/fixture did not commit: ${JSON.stringify(observed)}`);
      }
      assert.deepEqual(
        trace.filter((event) => event !== "image:load"),
        events(step),
        `${backend}/state ${step}/Pressable trace`,
      );
      assert.equal(
        trace.filter((event) => event === "image:load").length,
        1,
        `${backend}/state ${step}/Image load count`,
      );
      await browser.evaluate(
        "new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))",
      );
      const base64 =
        backend === "roku-canvas"
          ? await browser.evaluate(
              "document.querySelector('canvas').toDataURL('image/png').split(',')[1]",
            )
          : (await browser.call("Page.captureScreenshot", { format: "png" })).data;
      const capture = Buffer.from(base64, "base64");
      assert.equal(capture.readUInt32BE(16), width);
      assert.equal(capture.readUInt32BE(20), height);
      const filename = `${backend}-state-${step}.png`;
      writeFileSync(resolve(output, filename), capture, { flag: "wx" });
      states.push({
        filename,
        sha256: digest(capture),
        trace,
        probes: score(backend, step, capture),
      });
    }
    return { chromium: browser.version.product, states };
  } finally {
    await browser.close();
  }
}

function observeNative(paths) {
  const states = paths.map((path, step) => {
    const capture = readFileSync(path);
    assert.equal(capture.subarray(0, 3).toString("hex"), "ffd8ff", "Expected an installer JPEG");
    const ffprobe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", path],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(ffprobe.status, 0, "Capture dimensions could not be determined");
    assert.equal(ffprobe.stdout.trim(), `${width}x${height}`);
    return {
      filename: basename(path),
      sha256: digest(capture),
      probes: score("roku-installer-jpeg", step, capture),
    };
  });
  return { states };
}

const observations = nativeStills
  ? [Promise.resolve().then(() => observeNative(args.slice(2)))]
  : [observe("roku-canvas", args[0]), observe("react-native-web", args[1])];
const results = (await Promise.allSettled(observations)).map((result) =>
  result.status === "fulfilled" ? result.value : { error: String(result.reason) },
);
const passed = results.every(
  (result) =>
    result.states?.length === 3 &&
    result.states.every((state) => state.probes.every((probe) => probe.passed)),
);
const report = {
  status: passed ? "passed" : "failed",
  scope: nativeStills ? "installer still pixels" : "chromium comparison",
  viewport: { width, height, scale: 1 },
  results,
};
writeFileSync(resolve(output, "core-ui.json"), JSON.stringify(report, null, 2) + "\n", {
  flag: "wx",
});
for (const result of results) {
  if (result.error) console.error(result.error);
  for (const state of result.states ?? [])
    for (const probe of state.probes) {
      if (!probe.passed)
        console.error(
          `${probe.backend}/state ${probe.state}/${probe.id} (${probe.x}, ${probe.y}): ${probe.attempts[Math.floor(probe.attempts.length / 2)]} vs ${probe.expected}, ±${probe.tolerance}`,
        );
    }
}
if (!passed) process.exitCode = 1;
