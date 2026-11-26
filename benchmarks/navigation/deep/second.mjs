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
const rapidGap = Number(process.env.ROKU_SECOND_GAP ?? plan.frozenRapidDirectionalGapMs);
const repeats = Number(process.env.ROKU_SECOND_REPEATS ?? plan.exactRepeatsPerRoutePerLaunch);
assert([rapidGap, repeats].every((x) => Number.isInteger(x) && x > 0));
mkdirSync(output, { mode: 0o700 });
const save = (name, obj) =>
  writeFileSync(
    join(output, name),
    typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) + "\n",
    { flag: "wx" },
  );
const result = {
  rapidGap,
  repeats,
  timeOriginMs: performance.timeOrigin,
  commands: [],
  trials: [],
  complete: false,
};
let interrupted;
for (const sig of ["SIGINT", "SIGTERM"])
  process.once(sig, () => {
    interrupted = sig;
  });
const at = async (time) => {
  const left = time - performance.now();
  if (left > 0) await wait(Math.ceil(left));
  if (interrupted) throw Error("interrupted by " + interrupted);
};
try {
  const { client, sha256 } = await fixture(zip, receipt, process.env.ROKU_BENCHMARK_HOST);
  result.sha256 = sha256;
  async function send(key, phase, trial, target = performance.now()) {
    await at(target);
    const command = {
      index: result.commands.length,
      key,
      phase,
      trial,
      targetHostMs: target,
      sentHostMs: performance.now(),
      sentHostUtc: new Date().toISOString(),
    };
    result.commands.push(command);
    try {
      await client.keypress(key);
      command.ok = true;
    } catch (err) {
      command.ok = false;
      command.error = String(err);
      if (err.cause) command.cause = String(err.cause);
    } finally {
      command.responseHostMs = performance.now();
    }
    return command.index;
  }
  function gridCheck(sample, goal) {
    const offset = verify(sample, goal.id);
    const { x, y, bounds, name } = sample.focused[0];
    assert.equal(offset, goal.offset);
    if (goal.x !== undefined) {
      assert.deepEqual([x, y], [goal.x, goal.y]);
      assert.equal(bounds, `{${goal.x - 80}, 0, 366, 188}`);
    }
    if (goal.rows) assert.deepEqual(sample.rows, goal.rows);
    return { offset, x, y, bounds, name, rows: sample.rows };
  }
  async function snapshot(stem, validator, { timeout = 0 } = {}) {
    const until = performance.now() + timeout;
    let last, observed, error;
    do {
      const startedHostMs = performance.now();
      try {
        last = await client.query("app-ui");
        const gotHostMs = performance.now();
        observed = { ...validator(inspect(last)), startedHostMs, gotHostMs };
        break;
      } catch (e) {
        error = String(e);
        if (performance.now() < until) await wait(180);
      }
    } while (performance.now() < until);
    save(stem + ".xml", last ?? "<unobserved/>");
    return observed ?? { error };
  }
  const initial = await snapshot("initial", (s) => gridCheck(s, { id: 0, offset: 0 }), {
    timeout: 25000,
  });
  assert(!initial.error, initial.error);
  const stepsToSeed = ["Right", "Right", ...Array(6).fill("Down")];
  let fromRow = null;
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const route of plan.routeOrder) {
      const number = result.trials.length + 1;
      const tag = String(number).padStart(2, "0") + "-" + route;
      const expected = plan.routes[route];
      const gap = route === "paced" ? plan.pacedDirectionalGapMs : rapidGap;
      const trial = { number, repeat, route, gap, expected };
      result.trials.push(trial);
      // Row 3 clips upward at 600. Three more Down steps always establish the
      // starting offset of 720 at row 6, including after a deep restored offset.
      const approach =
        fromRow === null ? stepsToSeed : [...Array(fromRow - 3).fill("Up"), "Down", "Down", "Down"];
      for (const [index, key] of approach.entries()) {
        const n = await send(key, "approach", number);
        if (!result.commands[n].ok) trial.approachTransportFailure = true;
        await at(result.commands[n].sentHostMs + (fromRow === null && index < 4 ? 360 : 1025));
      }
      trial.seed = await snapshot(tag + "-seed", (s) =>
        gridCheck(s, { ...plan.start, rows: plan.first.rowsBefore }),
      );
      if (trial.seed.error) {
        trial.error = "approach did not reach the frozen seed";
        break;
      }
      const base = performance.now() + 120;
      const when = { first: base, second: base + gap, select: base + gap + plan.secondToSelectMs };
      when.back = when.select + plan.selectToBackMs;
      const [first, second, select, detail, back] = await Promise.all([
        send(plan.first.key, "first", number, when.first),
        send(expected.key, "second", number, when.second),
        send("Select", "select", number, when.select),
        (async () => {
          await at(when.select + plan.selectToDetailQueryMs);
          return snapshot(tag + "-detail", (s) => {
            assert(focused(s, "catalog-info"), "expected route information focus");
            assert.equal(s.details, expected.title);
            assert.equal(s.modal, null);
            return { title: s.details, focus: s.focused[0].name, modal: s.modal };
          });
        })(),
        send("Back", "back", number, when.back),
      ]);
      trial.burst = { first, second, select, back };
      trial.detail = detail;
      await at(when.back + plan.backToRestoreQueryMs);
      trial.restoration = await snapshot(
        tag + "-restore",
        (s) => {
          assert.equal(s.details, null);
          assert.equal(s.modal, null);
          return gridCheck(s, expected);
        },
        { timeout: 2500 },
      );
      save(tag + ".json", trial);
      console.log(
        JSON.stringify({
          number,
          route,
          detail: !detail.error,
          restored: !trial.restoration.error,
        }),
      );
      if (trial.restoration.error) break;
      fromRow = Math.floor(expected.id / 4);
    }
    const last = result.trials.at(-1);
    if (last.error || last.restoration?.error) break;
  }
  result.complete =
    result.trials.length === repeats * plan.routeOrder.length &&
    result.trials.every(
      (t) =>
        t.burst &&
        t.detail &&
        !t.detail.error &&
        t.restoration &&
        !t.restoration.error &&
        !t.transportFailure &&
        !t.error,
    );
  if (!result.complete) process.exitCode = 1;
} catch (error) {
  process.exitCode = 1;
  result.error = String(error);
  console.error(error);
} finally {
  save("summary.json", result);
}
