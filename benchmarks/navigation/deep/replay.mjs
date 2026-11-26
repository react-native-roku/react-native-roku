import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fixture } from "../device-fixture.mjs";
import { focused, state } from "../../catalog/scene.mjs";

const [zip, receipt, output, rounds] = process.argv.slice(2);
const save = (name, value) => writeFileSync(join(output, name), value, { flag: "wx" });
const bounds = (node, name) =>
  node
    .match(new RegExp(`\\s${name}="\\{([^}]*)\\}"`))?.[1]
    .split(", ")
    .map(Number);
const number = (name) => Number(name.split("-").at(-1));

export function inspect(xml) {
  const sample = state(xml);
  const clip = xml.match(/<RenderableNode [^>]*name="catalog-grid"[^>]*>/)?.[0];
  if (!clip) return { ...sample, rows: [], cards: [] };
  const cards = [];
  for (const match of xml.matchAll(
    /<RenderableNode [^>]*name="catalog-card-(\d+)"[^>]*>\s*(<Rectangle [^>]*\/>)\s*<RenderableNode [^>]*>\s*(<Poster [^>]*\/>)\s*<\/RenderableNode>\s*(<Label [^>]*\/>)/g,
  )) {
    const [, index, paint, poster, label] = match;
    const head = match[0].slice(0, match[0].indexOf(">") + 1);
    cards.push({
      id: Number(index),
      paint: paint.match(/color="([^"]*)"/)?.[1],
      bounds: bounds(head, "bounds"),
      poster: poster.match(/uri="([^"]*)"/)?.[1],
      posterBounds: bounds(poster, "bounds"),
      title: label.match(/text="([^"]*)"/)?.[1],
      titleBounds: bounds(label, "bounds"),
    });
  }
  const rows = [...new Set(cards.map(({ id }) => Math.floor(id / 4)))];
  return { ...sample, rows, cards, clip: bounds(clip, "clippingRect") };
}

export function verify(sample, id) {
  assert(focused(sample, "catalog-card-" + id), "one native focus owner");
  assert.equal(sample.position, `${id + 1} of 72`);
  assert.deepEqual(sample.clip, [0, 0, 1560, 680]);
  assert.equal(sample.cards.length, sample.mountedCards);
  assert(sample.cards.length >= 12 && sample.cards.length < 72);
  assert.deepEqual(
    sample.cards.map(({ id }) => id),
    sample.rows.flatMap((row) => [0, 1, 2, 3].map((col) => row * 4 + col)),
  );
  const current = sample.focused[0];
  const offset = sample.gridY + Math.floor(id / 4) * 200 - current.y;
  assert(Number.isInteger(offset) && offset >= 0);
  assert(current.y >= sample.gridY && current.y + 188 <= sample.gridY + 680);
  assert.equal(current.x, 80 + (id % 4) * 382);
  for (const card of sample.cards) {
    assert.deepEqual(card.bounds, [(card.id % 4) * 382, 0, 366, 188]);
    assert.deepEqual(card.posterBounds, [0, 0, 342, 93]);
    assert.match(card.poster, /^pkg:\/images\/asset-/);
    const long = card.id % 7 === 2;
    assert.deepEqual(card.titleBounds, [12, 105, 342, long ? 58 : 29]);
    if (long)
      assert.equal(card.title, "A field guide to the mountain&#10;passes, alpine lakes, and …");
    else assert.equal(card.title, "Mountain route " + (card.id + 1));
    assert.equal(
      card.paint,
      card.id === id ? "#3456c0ff" : card.id === 1 ? "#202027ff" : "#303040ff",
    );
  }
  for (let row = 0; row < 18; row++) {
    if (row * 200 < offset + 680 && row * 200 + 188 > offset) assert(sample.rows.includes(row));
  }
  return offset;
}

if (import.meta.main) {
  mkdirSync(output, { mode: 0o700 });
  const result = { steps: [], pass: false };
  try {
    assert([1, 2].includes(Number(rounds)));
    const { client, sha256 } = await fixture(zip, receipt, process.env.ROKU_BENCHMARK_HOST);
    result.sha256 = sha256;
    async function observe(id, detail, sent, stem) {
      const deadline = sent + 9000;
      let last, issue;
      while (performance.now() < deadline) {
        try {
          last = await client.query("app-ui");
          const sample = inspect(last);
          if (detail) {
            assert(focused(sample, "catalog-info"));
            assert.equal(sample.details, "Mountain route " + (id + 1));
            assert.equal(sample.modal, null);
          } else {
            assert.equal(sample.details, null);
            assert.equal(sample.modal, null);
            verify(sample, id);
          }
          return { xml: last, sample };
        } catch (error) {
          issue = error;
        }
        await wait(70);
      }
      save(stem + "-failed.xml", last ?? "<unobserved/>");
      throw Error(`Missing expected state at ${stem}: ${issue}`);
    }

    const ready = await observe(0, false, performance.now() + 20000, "ready");
    let current = ready.sample;
    save("ready.xml", ready.xml);
    result.ready = { rows: current.rows, offset: verify(current, 0) };
    async function step(key, id, phase, detail = false) {
      const stem = String(result.steps.length + 1).padStart(2, "0") + "-" + phase;
      const before = current;
      const sent = performance.now();
      await client.keypress(key);
      const visible = await observe(id, detail, sent, stem);
      const observedHostMs = performance.now() - sent;
      // Capture queued overscan changes after the focus and visible geometry settle.
      await wait(Math.max(140, 900 - observedHostMs));
      const { sample, xml } = await observe(id, detail, sent, stem);
      save(stem + ".xml", xml);
      const offset = detail ? null : verify(sample, id);
      const fromOffset =
        before.gridY === null
          ? null
          : before.gridY +
            Math.floor(number(before.focused[0].name) / 4) * 200 -
            before.focused[0].y;
      result.steps.push({
        key,
        id,
        phase,
        xml: stem + ".xml",
        offset,
        fromOffset,
        observedHostMs,
        bounds: sample.focused[0].bounds,
        xy: [sample.focused[0].x, sample.focused[0].y],
        rows: sample.rows,
        visibleRows: visible.sample.rows,
        enters: sample.rows.filter((row) => !before.rows.includes(row)),
        leaves: before.rows.filter((row) => !sample.rows.includes(row)),
        unchanged: sample.rows.filter((row) => before.rows.includes(row)),
        nodes: sample.observedNodes,
      });
      current = sample;
      return result.steps.at(-1);
    }
    for (let i = 0; i < Number(rounds); ++i) {
      await step("Right", 2, "approach");
      await step("Right", 3, "approach");
      for (const id of [7, 11, 15, 19, 23, 27, 31]) await step("Down", id, "down");
      for (const id of [27, 23, 19]) await step("Up", id, "reverse");
      const selected = await step("Up", 15, "reverse");
      assert(selected.offset > 0, "opening should exercise a deep position");
      await step("Select", 15, "open", true);
      const restored = await step("Back", 15, "return");
      assert.deepEqual(
        [restored.offset, restored.bounds, restored.xy],
        [selected.offset, selected.bounds, selected.xy],
      );
      for (const id of [11, 7, 3]) await step("Up", id, "reset");
      await step("Left", 2, "reset");
      await step("Left", 0, "fence");
    }
    result.pass = true;
  } catch (error) {
    result.error = String(error);
    console.error(error);
    process.exitCode = 1;
  } finally {
    save("summary.json", JSON.stringify(result, null, 2) + "\n");
  }
}
