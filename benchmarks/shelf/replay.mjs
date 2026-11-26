import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import {
  createRokuDeviceClient,
  parseActiveApp,
  parseDeviceFacts,
  parseMediaPlayer,
} from "../../build/device.mjs";
import { burstPlan, sendBurst } from "./burst.mjs";
import { detailTitle } from "./shared/shelf.ts";
import {
  catalogState,
  isSelection,
  schedule,
  score,
  shelfPress,
  shelfState,
  warmup,
} from "./score.mjs";

const [mode, zip, receipt, output] = process.argv.slice(2);
const host = process.env.ROKU_BENCHMARK_HOST;
const outputMode = process.env.ROKU_BENCHMARK_OUTPUT_MODE;
const cohort = process.env.ROKU_BENCHMARK_COHORT ?? "warm";
const verifyActivation = process.env.ROKU_SHELF_VERIFY_ACTIVATION === "1";
const appNames = {
  solid: "Native Shelf Diagnostics",
  react: "React Shelf Diagnostics",
};
assert.ok(
  Object.hasOwn(appNames, mode) &&
    zip &&
    receipt &&
    output &&
    host &&
    outputMode &&
    ["warm", "trace", "cold", "burst", "journey"].includes(cohort),
  "Usage: ROKU_BENCHMARK_HOST=... ROKU_BENCHMARK_OUTPUT_MODE=... node replay.mjs solid|react EXACT.zip INSTALL_RECEIPT.txt NEW_OUTPUT",
);
mkdirSync(output, { mode: 0o700 });
const write = (name, contents) => writeFileSync(join(output, name), contents, { flag: "wx" });
const json = (name, value) => write(name, JSON.stringify(value, null, 2) + "\n");
const pollMs = 75;
const deadlineMs = 6000;
const spacingMs = 200;
const startAt = new Date().toISOString();
const clock = {
  utcAtStart: startAt,
  hostMonotonicMsAtStart: performance.now(),
};
const capture = { visibleLatency: "UNMEASURED" };
const samples = [];
const warmupSamples = [];
const settle = [];
const bursts = [];
let phase = "installer identity",
  failure,
  artifact,
  facts,
  coldLaunch;
const client = createRokuDeviceClient({ host, timeoutMs: 3500 });
async function foreground(stage) {
  const active = await client.query("active-app");
  write(stage + "-active-app.xml", active);
  assert.deepEqual(parseActiveApp(active), { id: "dev", name: appNames[mode] });
  assert.ok(!/<screensaver\b/.test(active), "Screensaver is active");
  const media = await client.query("media-player");
  write(stage + "-media-player.xml", media);
  assert.ok(["close", "none"].includes(parseMediaPlayer(media).state), "Playback must be closed");
}
async function poll(origin) {
  const startMs = performance.now() - origin;
  try {
    const xml = await client.query("app-ui");
    return { startMs, endMs: performance.now() - origin, xml };
  } catch (error) {
    return { startMs, endMs: performance.now() - origin, error: String(error) };
  }
}
const selected = (poll, index) => isSelection(shelfState(poll.xml ?? ""), index);
async function observe(
  origin,
  observations,
  index,
  limit,
  matches = (value) => selected(value, index),
) {
  while (performance.now() - origin < limit) {
    const observation = await poll(origin);
    observations.push(observation);
    if (observation.endMs <= limit && matches(observation)) return observation;
    await wait(pollMs);
  }
}
async function move(step, rows, before) {
  const row = { ...step, before, deadlineMs, polls: [] };
  rows.push(row);
  try {
    assert.ok(selected(before, step.from), "Pre-key snapshot has unexpected card focus or title");
    const start = performance.now();
    row.hostSendMs = start;
    await client.keypress(step.key);
    row.ackMs = performance.now() - start;
    const match = await observe(start, row.polls, step.to, deadlineMs);
    assert.ok(match, "No matching card focus and title before deadline");
    await wait(spacingMs);
    return match;
  } catch (error) {
    row.error = String(error);
    throw error;
  } finally {
    json(
      `${rows === samples ? "step" : "warmup"}-${String(rows.length).padStart(2, "0")}.json`,
      row,
    );
  }
}

try {
  const bytes = readFileSync(zip);
  const hash = (algorithm) => createHash(algorithm).update(bytes).digest("hex");
  artifact = { sha256: hash("sha256"), md5: hash("md5"), bytes: bytes.length };
  const installerText = readFileSync(receipt, "utf8");
  write("install-receipt.txt", installerText);
  // The installer UI renders a checksum and byte count together. An upload
  // acknowledgement alone is insufficient.
  const installed =
    /Currently Installed Application:\s*([\da-f]{32})\s+zip file[^\r\n(]*\(([\d,]+) bytes\)/i.exec(
      installerText,
    );
  assert.ok(
    installed &&
      installed[1].toLowerCase() === artifact.md5 &&
      Number(installed[2].replaceAll(",", "")) === artifact.bytes,
    "Installer identity disagrees with the frozen ZIP",
  );
  phase = "device facts";
  const deviceInfo = await client.query("device-info");
  facts = parseDeviceFacts(deviceInfo);
  facts.firmwareBuild = /<software-build>([^<]+)<\/software-build>/.exec(deviceInfo)?.[1] ?? null;
  assert.ok(facts.model && facts.firmware && facts.firmwareBuild);
  facts.uiResolution = /<ui-resolution>([^<]+)<\/ui-resolution>/.exec(deviceInfo)?.[1] ?? null;
  facts.outputMode = outputMode;
  phase = "install preflight";
  await foreground("before");
  let ready;
  if (cohort === "cold") {
    phase = "cold launch";
    await client.terminate();
    const launch = performance.now();
    coldLaunch = { hostSendMs: launch, polls: [] };
    await client.launch();
    coldLaunch.ackMs = performance.now() - launch;
    ready = await observe(launch, coldLaunch.polls, 0, 30000);
    coldLaunch.observedMs = ready?.endMs ?? null;
    assert.ok(ready, "Cold launch did not reach Card 1");
  } else {
    phase = "starting selection";
    ready = await observe(performance.now(), settle, 0, deadlineMs);
    assert.ok(ready, "Shelf must start on Card 1");
  }
  if (cohort === "journey") {
    phase = "scroll catalog";
    assert.equal(process.env.ROKU_SHELF_WORKLOAD, "catalog");
    const steps = [];
    ready = await move({ key: "Down", from: 0, to: 8 }, steps, ready);
    ready = await move({ key: "Down", from: 8, to: 16 }, steps, ready);
    const scrolled = catalogState(ready.xml).offset;
    assert.ok(scrolled > 0, "Catalog did not scroll to the third row");
    phase = "rapid navigation and immediate Select";
    const start = performance.now();
    const inputs = [];
    for (const key of ["Right", "Left", "Right", "Select"]) {
      const sent = performance.now() - start;
      await client.keypress(key);
      inputs.push({ key, sent, acknowledged: performance.now() - start });
    }
    json("catalog-inputs.json", inputs);
    const detail = [];
    const opened = await observe(start, detail, 17, deadlineMs, ({ xml }) => {
      const state = catalogState(xml ?? "");
      return state.detail === detailTitle(17) && state.backFocused;
    });
    json("catalog-detail.json", detail);
    assert.ok(opened, "Immediate Select did not open the observed destination");
    phase = "Back restoration";
    const back = performance.now();
    await client.keypress("Back");
    const restored = [];
    const match = await observe(back, restored, 17, deadlineMs, (value) => {
      const state = catalogState(value.xml ?? "");
      return selected(value, 17) && !state.detail && state.offset === scrolled;
    });
    json("catalog-restoration.json", {
      observations: restored,
      scrolled,
      restored: Boolean(match),
    });
    assert.ok(match, "Back did not restore the card and scroll offset");
  } else if (cohort === "burst") {
    for (const [index, burst] of burstPlan.entries()) {
      phase = burst.name;
      const before = await poll(performance.now());
      assert.ok(selected(before, 0), "Burst must start on shelf-0");
      if (verifyActivation)
        assert.deepEqual(
          shelfPress(before.xml),
          index === 0 ? null : { id: "shelf-2", count: index },
        );
      await wait(750);
      const inputs = await sendBurst(client, burst.spacingMs);
      await wait(700);
      const final = await poll(performance.now());
      const press = shelfPress(final.xml ?? "");
      bursts.push({ ...burst, before, inputs, final, press });
      json(burst.name + ".json", bursts.at(-1));
      assert.ok(!inputs.some((input) => input.error), "ECP transport failed");
      assert.ok(selected(final, 2), "Burst did not settle on shelf-2");
      if (verifyActivation) assert.deepEqual(press, { id: "shelf-2", count: index + 1 });
      if (index < burstPlan.length - 1) {
        for (const to of [1, 0]) {
          await client.keypress("Left");
          assert.ok(
            await observe(performance.now(), [], to, deadlineMs),
            "Burst reset was incomplete",
          );
          await wait(spacingMs);
        }
      }
    }
  } else if (cohort !== "cold") {
    phase = "warmup";
    await wait(1000);
    ready = await poll(performance.now());
    for (const step of warmup) ready = await move(step, warmupSamples, ready);
    await wait(1000);
    for (const [index, step] of schedule.entries()) {
      phase = `scored step ${index + 1}`;
      ready = await move(step, samples, await poll(performance.now()));
    }
    phase = "final selection";
    const terminal = await poll(performance.now());
    json("terminal.json", terminal);
    assert.ok(selected(terminal, schedule.at(-1).to), "Unexpected terminal selection");
  }
  await foreground("after");
} catch (error) {
  failure = { phase, error: String(error) };
} finally {
  if (coldLaunch) json("cold-launch.json", coldLaunch);
  if (settle.length) json("ready.json", settle);
  const scored = ["cold", "burst", "journey"].includes(cohort) ? null : score(samples);
  const passed = !failure && (scored?.pass ?? true);
  json("summary.json", {
    mode,
    cohort,
    artifact,
    facts,
    clock,
    pollMs,
    deadlineMs,
    spacingMs,
    capture,
    warmup,
    schedule,
    bursts: bursts.map(({ name, spacingMs, press }) => ({
      name,
      spacingMs,
      press,
    })),
    failure: failure ?? null,
    ...scored,
    pass: passed,
  });
  console.log({ mode, cohort, passed, observed: scored?.observed, failure });
  if (!passed) process.exitCode = 1;
}
