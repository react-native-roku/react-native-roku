import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fixture } from "./device-fixture.mjs";
import { catalogState, isCatalogSettled } from "../shelf/score.mjs";
import { detailTitle, next, scrollFor } from "../shelf/shared/shelf.ts";

const [mode, zip, receiptPath, output] = process.argv.slice(2);
const host = process.env.ROKU_BENCHMARK_HOST;
const spacingMs = Number(process.env.ROKU_BURST_SPACING_MS ?? "42");
assert(Number.isFinite(spacingMs) && spacingMs >= 35 && spacingMs <= 100);
assert.equal(process.env.ROKU_SHELF_WORKLOAD, "catalog");
mkdirSync(output, { mode: 0o700 });
const { client: send, sha256 } = await fixture(zip, receiptPath, host);
const tree = () => send.query("app-ui");
const route = process.env.ROKU_CATALOG_BURST_ROUTE ?? "reversal";
assert(["reversal", "scrolling"].includes(route));
const preparation = route === "scrolling" ? [8] : [8, 16];
const directions =
  route === "scrolling"
    ? ["Right", "Down", "Right", "Up", "Left", "Up", "Right", "Down", "Right", "Down", "Up"]
    : [...Array(7).fill("Right"), ...Array(4).fill("Left")];
const originCard = preparation.at(-1);
let card = originCard;
let offset = preparation.reduce((before, step) => scrollFor(step, before), 0);
const originOffset = offset;
const expected = directions.map((key) => {
  const desired = next(card, key.toLowerCase());
  assert.notEqual(card, desired);
  card = desired;
  offset = scrollFor(card, offset);
  return { card, offset };
});
const result = {
  mode,
  route,
  spacingMs,
  sha256,
  origin: originCard,
  originOffset,
  intendedOrder: expected.map(({ card }) => card),
  intendedOffsets: expected.map(({ offset }) => offset),
  intendedSelection: card,
  intendedScrollOffset: offset,
  commands: [],
  observations: [],
};
const save = (name, data) =>
  writeFileSync(join(output, name), JSON.stringify(data, null, 2) + "\n");
const until = async (tag, predicate) => {
  const origin = performance.now();
  while (performance.now() - origin < 8000) {
    const startedMs = performance.now() - origin;
    const xml = await tree();
    result.observations.push({
      tag,
      startedMs,
      observedMs: performance.now() - origin,
      xml,
    });
    if (predicate(xml)) return xml;
    await wait(70);
  }
  throw Error("Timed out observing " + tag);
};
try {
  await until("initial Card 1", (xml) => isCatalogSettled(xml, 0, 0));
  let preparedOffset = 0;
  for (const card of preparation) {
    await send.keypress("Down");
    preparedOffset = scrollFor(card, preparedOffset);
    await until("settled Card " + (card + 1), (xml) => isCatalogSettled(xml, card, preparedOffset));
  }
  await wait(700);
  const keys = [...directions, "Select"];
  const origin = performance.now();
  result.commands = await Promise.all(
    keys.map(async (key, i) => {
      const scheduledMs = i * spacingMs;
      if (i) await wait(Math.max(1, origin + scheduledMs - performance.now()));
      const sentMs = performance.now() - origin;
      try {
        await send.keypress(key);
        return { key, scheduledMs, sentMs, ackMs: performance.now() - origin };
      } catch (error) {
        return { key, scheduledMs, sentMs, error: String(error) };
      }
    }),
  );
  assert(
    result.commands.every(({ error }) => !error),
    "Input transport failed",
  );
  const detail = await until("Detail after reversal and immediate Select", (xml) => {
    const state = catalogState(xml);
    return Boolean(state.detail && state.backFocused);
  });
  result.activatedTitle = catalogState(detail).detail;
  assert.equal(result.activatedTitle, detailTitle(result.intendedSelection));
  await send.keypress("Back");
  const restored = await until("original card and scroll after Back", (xml) =>
    isCatalogSettled(xml, result.intendedSelection, result.intendedScrollOffset),
  );
  result.restoredOffset = catalogState(restored).offset;
  result.pass = true;
} catch (error) {
  result.pass = false;
  result.error = String(error);
  process.exitCode = 1;
} finally {
  save("summary.json", result);
  console.log(
    JSON.stringify({
      pass: result.pass,
      title: result.activatedTitle,
      offset: result.restoredOffset,
      error: result.error,
    }),
  );
}
