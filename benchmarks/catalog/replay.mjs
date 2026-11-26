import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createRokuDeviceClient, parseActiveApp, parseMediaPlayer } from "../../build/device.mjs";
import { statistics } from "../shelf/score.mjs";
import { cardID, focused, state } from "./scene.mjs";

const [zip, receipt, output, repeats = "1"] = process.argv.slice(2);
const host = process.env.ROKU_BENCHMARK_HOST;
const rounds = Number(repeats);
const checkpointEvery = Number(process.env.ROKU_CATALOG_CHECKPOINT_EVERY ?? 25);
const idleSampleMs = Number(process.env.ROKU_CATALOG_IDLE_SAMPLE_MS ?? 0);
const verifyFocusRetention = process.env.ROKU_CATALOG_VERIFY_FOCUS_RETENTION === "1";
assert.ok(
  zip && receipt && output && host && Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 2000,
  "Usage: ROKU_BENCHMARK_HOST=... node replay.mjs EXACT.zip INSTALL_RECEIPT.txt NEW_OUTPUT [1..2000]",
);
assert.ok(Number.isSafeInteger(checkpointEvery) && checkpointEvery >= 1);
assert.ok(Number.isSafeInteger(idleSampleMs) && idleSampleMs >= 0 && idleSampleMs <= 300000);
assert.ok(!verifyFocusRetention || rounds >= 2, "Focus retention requires two or more rounds");
mkdirSync(output, { mode: 0o700 });
const save = (name, data) =>
  writeFileSync(
    join(output, name),
    typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n",
    {
      flag: "wx",
    },
  );
const bytes = readFileSync(zip);
const hash = (algorithm) => createHash(algorithm).update(bytes).digest("hex");
const install = readFileSync(receipt, "utf8");
const matched =
  /Currently Installed Application:\s*([\da-f]{32})\s+zip file[^\r\n(]*\(([\d,]+) bytes\)/i.exec(
    install,
  );
assert.equal(matched?.[1].toLowerCase(), hash("md5"), "Installer checksum disagrees with ZIP");
assert.equal(
  Number(matched?.[2].replaceAll(",", "")),
  bytes.length,
  "Installer byte count disagrees with ZIP",
);
save("install-receipt.txt", install);
const client = createRokuDeviceClient({ host, timeoutMs: 4000 });

const startup = performance.now();
const rows = [];
const captures = [];
const checkpoints = [];
const focusRetentionChecks = [];
const hasCard = (scene, card) => scene.xml.includes(' name="catalog-card-' + card + '"');
let completedRounds = 0;
let interrupted;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    interrupted ??= signal;
  });
let phase = "preflight";
let initialTreeMs;
async function observe(condition, timeout = 5000) {
  const deadline = performance.now() + timeout;
  let last;
  let lastError;
  do {
    try {
      const xml = await client.query("app-ui");
      last = { xml, ...state(xml) };
    } catch (error) {
      lastError = String(error);
      await wait(65);
      continue;
    }
    if (condition(last)) return last;
    await wait(65);
  } while (performance.now() < deadline);
  save("failed-scene.xml", last?.xml ?? "<unobserved />");
  if (lastError) save("failed-scene-transport.json", { lastError });
  throw Error(
    "Expected state did not settle. Last observed focus was " + JSON.stringify(last?.focused),
  );
}
const firstCard = "catalog-card-0";
let selection;
async function step(key, expectedId, extra = () => true) {
  if (interrupted) throw Error(`Catalog replay stopped on ${interrupted}`);
  const start = performance.now();
  const previous = selection?.focused[0]?.name;
  phase = `${rows.length + 1} ${key} ${previous} to ${expectedId}`;
  await client.keypress(key);
  const ackMs = performance.now() - start;
  const position = cardID(expectedId) ? Number(expectedId.split("-").at(-1)) + 1 : undefined;
  selection = await observe(
    (sample) =>
      focused(sample, expectedId) &&
      (position === undefined || sample.position === position + " of 72") &&
      extra(sample),
  );
  rows.push({
    key,
    from: previous ?? null,
    to: expectedId,
    ackMs,
    observedMs: performance.now() - start,
    mountedCards: selection.mountedCards,
    observedNodes: selection.observedNodes,
    bounds: selection.focused[0].bounds,
    scenePosition: [selection.focused[0].x, selection.focused[0].y],
  });
}
function capture(name) {
  save(name + ".xml", selection.xml);
  captures.push(name);
}
async function checkpoint(round, afterIdle = false) {
  phase = `checkpoint after ${round} rounds`;
  const stem = `round-${round}${afterIdle ? "-idle" : ""}`;
  capture(stem);
  const block = rows.slice(checkpoints.at(-1)?.inputs ?? 0);
  const sample = {
    completedRounds: round,
    inputs: rows.length,
    elapsedMs: performance.now() - startup,
    mountedCards: selection.mountedCards,
    observedNodes: selection.observedNodes,
    hostToObserved: statistics(block.map(({ observedMs }) => observedMs)),
    ...(afterIdle && { idleSampleMs }),
  };
  try {
    const xml = await client.query("chanperf");
    save(stem + "-chanperf.xml", xml);
    const profile = [...xml.matchAll(/<plugin>([\s\S]*?)<\/plugin>/g)]
      .map((match) => match[1])
      .find((plugin) => plugin.includes("<id>dev</id>"));
    const memory = /<memory>([\s\S]*?)<\/memory>/.exec(profile ?? "")?.[1];
    const rss = /<res>(\d+)<\/res>/.exec(memory ?? "")?.[1];
    if (rss !== undefined) sample.channelResidentBytes = Number(rss);
    else sample.metricsUnavailable = "The development channel did not report its resident bytes";
  } catch (error) {
    sample.metricsUnavailable = String(error);
  }
  for (const kind of ["all", "roots"]) {
    try {
      const xml = await client.query(`sgnodes/${kind}?count_only=true&sizes=true`);
      save(`${stem}-sgnodes-${kind}.xml`, xml);
      const count = /<(?:All|Root)_Nodes node-count="(\d+)">/.exec(xml)?.[1];
      if (count !== undefined && xml.includes("<channel-id>dev</channel-id>"))
        sample[kind === "all" ? "sceneGraphNodes" : "unparentedSceneGraphNodes"] = Number(count);
    } catch (error) {
      save(`${stem}-sgnodes-${kind}-unavailable.json`, { error: String(error) });
    }
  }
  checkpoints.push(sample);
  save(stem + ".json", sample);
  console.log(JSON.stringify(sample));
}
async function setup() {
  phase = "verify foreground";
  const active = parseActiveApp(await client.query("active-app"));
  assert.equal(active.id, "dev", "The developer channel must be foreground");
  phase = "verify idle playback";
  assert.ok(["close", "none"].includes(parseMediaPlayer(await client.query("media-player")).state));
  phase = "observe the first focused card";
  selection = await observe((sample) => focused(sample, firstCard), 45000);
  initialTreeMs = performance.now() - startup;
  assert.ok(selection.mountedCards > 0 && selection.mountedCards < 72);
  capture("initial");
}
async function journey(index) {
  await step("Up", firstCard);
  await step("Left", firstCard);
  await step("Right", "catalog-card-2");
  await step("Right", "catalog-card-3");
  const deep = [7, 11, 15, 19, 23, 27, 31];
  for (const card of deep) {
    await step("Down", `catalog-card-${card}`);
    if (verifyFocusRetention && index > 0 && card === 15) {
      phase = "original preferred target remounts without stealing focus";
      await observe((sample) => hasCard(sample, 31), 10000);
      await wait(1000);
      selection = await observe(
        (sample) =>
          hasCard(sample, 31) &&
          focused(sample, "catalog-card-15") &&
          sample.position === "16 of 72",
      );
      capture(`round-${index + 1}-focus-retained`);
      focusRetentionChecks.push(index + 1);
    }
  }
  const target = "catalog-card-" + deep.at(-1);
  selection = await observe((sample) => {
    const card = sample.focused[0];
    return (
      focused(sample, target) &&
      sample.position === "32 of 72" &&
      sample.gridY !== null &&
      card.y >= sample.gridY &&
      card.y + 188 <= sample.gridY + 680
    );
  });
  const before = selection.focused[0];
  assert.ok(before.bounds, "Missing native geometry for selected card");
  assert.match(selection.position, /^32 of 72$/);
  if (index === 0) capture("scrolled");
  await step("Select", "catalog-info", (sample) => sample.details === "Mountain route 32");
  if (index === 0) capture("detail");
  await step("Select", "catalog-modal-close", (sample) => sample.modal === "Route 32");
  if (index === 0) capture("modal");
  await step("Back", "catalog-info", (sample) => sample.modal === null);
  await step("Back", target, (sample) => {
    const restored = sample.focused[0];
    return sample.details === null && restored.x === before.x && restored.y === before.y;
  });
  assert.equal(
    selection.focused[0].bounds,
    before.bounds,
    "Restored card has different native bounds",
  );
  if (index === 0) capture("restored");
  for (const card of [...deep.slice(0, -1).reverse(), 3]) await step("Up", `catalog-card-${card}`);
  await step("Left", "catalog-card-2");
  await step("Left", firstCard);
  if (verifyFocusRetention && index + 1 < rounds) {
    phase = "original preferred target retires outside the virtual window";
    selection = await observe(
      (sample) => focused(sample, firstCard) && !hasCard(sample, 31),
      10000,
    );
    capture(`round-${index + 1}-preferred-target-retired`);
  }
}

try {
  await setup();
  if (rounds > 1) await checkpoint(0);
  for (; completedRounds < rounds;) {
    await journey(completedRounds);
    completedRounds++;
    if (completedRounds % checkpointEvery === 0 || (rounds > 1 && completedRounds === rounds))
      await checkpoint(completedRounds);
  }
  if (idleSampleMs) {
    const last = selection.focused[0];
    await wait(idleSampleMs);
    selection = await observe((sample) => focused(sample, firstCard));
    assert.equal(selection.focused[0].bounds, last.bounds, "Settled bounds changed during idle");
    await checkpoint(completedRounds, true);
  }
} catch (error) {
  save("failure.json", { phase, error: String(error) });
  if (selection) save("last-settled-scene.xml", selection.xml);
  throw error;
} finally {
  save("summary.json", {
    zipSha256: hash("sha256"),
    rounds,
    completedRounds,
    checkpoints,
    completedInputs: rows.length,
    initialTreeMs,
    ...(verifyFocusRetention && { focusRetentionChecks }),
    captures,
    totalMs: performance.now() - startup,
    hostToObserved: statistics(rows.map(({ observedMs }) => observedMs)),
    maximumMountedCards: Math.max(0, ...rows.map(({ mountedCards }) => mountedCards)),
    rows,
  });
}
