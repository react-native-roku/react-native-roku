import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { captureRokuDiagnostics } from "../../build/device.mjs";
import { setTimeout as wait } from "node:timers/promises";

const [rk, mode, zip, receipt, outputPath, scenario = "warm"] = process.argv.slice(2);
const deep = {
  "deep-window": "replay.mjs",
  "deep-second": "second.mjs",
  "deep-triple": "stress.mjs",
  "deep-long": "stress.mjs",
}[scenario.replace(/-fields$/, "")];
const host = process.env.ROKU_BENCHMARK_HOST;
assert.ok(
  rk && host && outputPath,
  "Usage: node trace.mjs /path/to/rk solid|react ZIP RECEIPT NEW_OUTPUT",
);
assert.ok(
  deep ||
    ["warm", "warm-fields", "navigation-burst", "holdout", "holdout-fields"].includes(scenario),
  "Unknown trace scenario",
);
const burst = scenario === "navigation-burst";
const output = resolve(outputPath);
mkdirSync(output, { mode: 0o700 });
const log = openSync(join(output, "recorder.log"), "wx");
const trace = join(output, "device.perfetto-trace");
const recorder = spawn(
  resolve(rk),
  ["perfetto", "start", "--local", "--host", host, "--channel-id", "dev", "--output", trace],
  { cwd: output, stdio: ["ignore", "pipe", "pipe"] },
);
const exited = new Promise((ready) => {
  recorder.once("error", (error) => ready({ error }));
  recorder.once("close", (code, signal) => ready({ code, signal }));
});
const ready = new Promise((ready) => {
  let tail = "";
  for (const stream of [recorder.stdout, recorder.stderr]) {
    stream.on("data", (chunk) => {
      tail = (tail + chunk.toString()).slice(-4096);
      if (tail.includes("Connected. Recording to")) ready(true);
    });
    stream.pipe(process.stdout, { end: false });
  }
});
const retain = (chunk) => writeSync(log, chunk);
recorder.stdout.on("data", retain);
recorder.stderr.on("data", retain);
function deadline(ms, value) {
  return new Promise((resolve) => setTimeout(resolve, ms, value).unref());
}
let diagnostics;
try {
  assert.equal(
    await Promise.race([ready, exited, deadline(12000, false)]),
    true,
    "Perfetto recorder did not become ready",
  );
  if (burst || scenario.endsWith("-fields")) {
    diagnostics = captureRokuDiagnostics(host);
    await diagnostics.ready;
  }
  const holdout = scenario.startsWith("holdout");
  const replayPath = deep
    ? "../navigation/deep/" + deep
    : holdout
      ? "../navigation/holdout/replay.mjs"
      : burst
        ? "../navigation/burst.mjs"
        : "replay.mjs";
  const replayArgs = [zip, receipt, join(output, "replay")];
  if (deep === "replay.mjs") replayArgs.push("1");
  if (!holdout && !deep) replayArgs.unshift(mode);
  const replay = spawn(process.execPath, [join(import.meta.dirname, replayPath), ...replayArgs], {
    env: {
      ...process.env,
      ...(deep === "stress.mjs" && {
        ROKU_YIELD_STRESS: scenario.startsWith("deep-long") ? "long" : "triple",
      }),
      ...(holdout ? { ROKU_HOLDOUT_TIMED: "1" } : {}),
      ROKU_BENCHMARK_COHORT: process.env.ROKU_BENCHMARK_COHORT === "burst" ? "burst" : "trace",
    },
    stdio: "inherit",
  });
  const result = await new Promise((resolve, reject) => {
    replay.once("error", reject);
    replay.once("close", resolve);
  });
  await wait(1200); // Let the recorder receive the last device packets.
  assert.equal(result, 0, "The traced replay failed");
} finally {
  if (diagnostics) {
    diagnostics.close();
    writeFileSync(join(output, "native-probe.json"), JSON.stringify(diagnostics.snapshot()));
  }
  recorder.kill("SIGINT");
  const result = await Promise.race([exited, deadline(12000, null)]);
  if (!result) {
    recorder.kill("SIGTERM");
    await Promise.race([exited, deadline(2000, null)]);
  }
  recorder.stdout.off("data", retain);
  recorder.stderr.off("data", retain);
  closeSync(log);
  assert.equal(result?.code, 0, "Perfetto recorder did not exit cleanly");
  assert.ok(statSync(trace).size > 0, "Perfetto trace was empty");
}
