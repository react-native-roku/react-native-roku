import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fixture } from "../device-fixture.mjs";
import { focused } from "../../catalog/scene.mjs";
import { inspect, verify } from "./replay.mjs";

const [zip, receipt, output] = process.argv.slice(2);
const plan = JSON.parse(
  readFileSync(process.env.ROKU_SECOND_PLAN ?? new URL("./plan.json", import.meta.url)),
);
const route = process.env.ROKU_YIELD_STRESS;
assert(["triple", "long"].includes(route));
const count = route === "triple" ? 3 : 9;
const gap = plan.frozenRapidDirectionalGapMs;
mkdirSync(output, { mode: 0o700 });
const save = (name, obj) =>
  writeFileSync(
    join(output, name),
    typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) + "\n",
    { flag: "wx" },
  );
const steps = Array.from({ length: count }, (_, index) => ({
  key: "Down",
  id: plan.first.id + index * 4,
  offset: plan.first.offset + index * 200,
  x: 1226,
  y: 669,
}));
const expected = steps.at(-1);
const expectedWindowFirst = Math.max(0, Math.ceil((expected.offset - 680) / 200) - 1);
const expectedWindowLast = Math.min(18, Math.floor((expected.offset + 1360) / 200) + 1);
const expectedRows = Array.from(
  { length: expectedWindowLast - expectedWindowFirst },
  (_, i) => expectedWindowFirst + i,
);
const result = {
  route,
  gap,
  expectedRows,
  steps,
  timeOriginMs: performance.timeOrigin,
  commands: [],
  complete: false,
};
const at = async (time) => {
  const delay = time - performance.now();
  if (delay > 0) await wait(Math.ceil(delay));
};

try {
  const { client, sha256 } = await fixture(zip, receipt, process.env.ROKU_BENCHMARK_HOST);
  result.sha256 = sha256;
  async function send(key, phase, target = performance.now()) {
    await at(target);
    const command = {
      index: result.commands.length,
      key,
      phase,
      targetHostMs: target,
      sentHostMs: performance.now(),
      sentHostUtc: new Date().toISOString(),
    };
    result.commands.push(command);
    try {
      await client.keypress(key);
      command.ok = true;
    } catch (error) {
      command.ok = false;
      command.error = String(error);
      if (error.cause) command.cause = String(error.cause);
    } finally {
      command.responseHostMs = performance.now();
    }
    return command.index;
  }
  function gridCheck(sample, goal) {
    assert.equal(verify(sample, goal.id), goal.offset);
    assert.equal(sample.modal, null);
    assert.equal(sample.details, null);
    const [{ x, y, bounds, name }] = sample.focused;
    if (goal.x !== undefined) {
      assert.deepEqual([x, y], [goal.x, goal.y]);
      assert.equal(bounds, "{1146, 0, 366, 188}");
    }
    if (goal.rows) assert.deepEqual(sample.rows, goal.rows);
    return { offset: goal.offset, rows: sample.rows, x, y, name, bounds };
  }
  async function snapshot(stem, validator, timeout = 0) {
    const end = performance.now() + timeout;
    let last, error;
    do {
      try {
        last = await client.query("app-ui");
        const observed = validator(inspect(last));
        save(stem + ".xml", last);
        return { ...observed, checkedHostMs: performance.now() };
      } catch (cause) {
        error = String(cause);
        if (performance.now() < end) await wait(150);
      }
    } while (performance.now() < end);
    save(stem + ".xml", last ?? "<unobserved/>");
    return { error };
  }

  const initial = await snapshot("initial", (s) => gridCheck(s, { id: 0, offset: 0 }), 25000);
  assert(!initial.error, initial.error);
  for (const [index, key] of ["Right", "Right", ...Array(6).fill("Down")].entries()) {
    const n = await send(key, "approach");
    assert(result.commands[n].ok);
    await at(result.commands[n].sentHostMs + (index < 4 ? 360 : 1025));
  }
  result.seed = await snapshot("seed", (s) =>
    gridCheck(s, { ...plan.start, rows: plan.first.rowsBefore }),
  );
  assert(!result.seed.error, result.seed.error);
  const base = performance.now() + 120;
  result.directions = await Promise.all(
    steps.map((step, index) => send(step.key, "direction", base + index * gap)),
  );
  const lastDirection = base + (count - 1) * gap;

  // The triple also exercises the rapid Select. Give the longer run time on
  // the catalog to verify the window catches up without a subsequent gesture.
  const atSelect = lastDirection + (route === "triple" ? plan.secondToSelectMs : 5000);
  if (route === "long") {
    await at(lastDirection + 3200);
    result.settled = await snapshot(
      "settled-before-select",
      (s) => gridCheck(s, { ...expected, rows: expectedRows }),
      1300,
    );
  }
  result.select = await send("Select", "select", atSelect);
  await at(atSelect + plan.selectToDetailQueryMs);
  result.detail = await snapshot("detail", (s) => {
    assert(focused(s, "catalog-info"));
    assert.equal(s.details, "Mountain route " + (expected.id + 1));
    assert.equal(s.modal, null);
    return { title: s.details, focus: s.focused[0].name };
  });
  const atBack = atSelect + plan.selectToBackMs;
  result.back = await send("Back", "back", atBack);
  await at(atBack + plan.backToRestoreQueryMs);
  result.restoration = await snapshot("restored", (s) => gridCheck(s, expected), 2400);
  result.finalWindow = await snapshot(
    "final-window",
    (s) => gridCheck(s, { ...expected, rows: expectedRows }),
    2000,
  );
  result.complete =
    [
      result.detail,
      result.restoration,
      result.finalWindow,
      ...(route === "long" ? [result.settled] : []),
    ].every((s) => s && !s.error) && result.commands.every((c) => c.ok);
  if (!result.complete) process.exitCode = 1;
} catch (error) {
  process.exitCode = 1;
  result.error = String(error);
  console.error(error);
} finally {
  save("summary.json", result);
  console.log(
    JSON.stringify({
      route,
      complete: result.complete,
      detail: result.detail,
      restoration: result.restoration,
      finalWindow: result.finalWindow,
      settled: result.settled,
      error: result.error,
    }),
  );
}
