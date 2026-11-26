import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { catalogState, isSelection, shelfState } from "../shelf/score.mjs";
import { detailTitle } from "../shelf/shared/shelf.ts";
import { fixture } from "./device-fixture.mjs";

// A down can reach the device even if its acknowledgement times out.
export async function holdRight(edge, durationMs, delay = wait, injectedRepeats = 0) {
  try {
    await edge("keydown");
    let elapsed = 0;
    for (let repeat = 1; repeat <= injectedRepeats; repeat++) {
      const at = Math.round((repeat * durationMs) / (injectedRepeats + 1));
      await delay(at - elapsed);
      await edge("keydown");
      elapsed = at;
    }
    await delay(durationMs - elapsed);
  } finally {
    await edge("keyup");
  }
}

async function run(zip, receipt, output) {
  assert.equal(process.env.ROKU_SHELF_WORKLOAD, "catalog");
  const host = process.env.ROKU_BENCHMARK_HOST;
  const durationMs = Number(process.env.ROKU_HOLD_MS ?? 550);
  const injectedRepeats = Number(process.env.ROKU_HOLD_INJECT_REPEATS ?? 0);
  assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 200 && durationMs <= 2000);
  assert.ok(Number.isSafeInteger(injectedRepeats) && injectedRepeats >= 0 && injectedRepeats <= 4);
  mkdirSync(output, { mode: 0o700 });
  const result = {
    durationMs,
    injectedRepeats,
    events: [],
    samples: [],
    firstVisibleHighlight: "UNMEASURED",
  };
  try {
    const { client, sha256 } = await fixture(zip, receipt, host);
    result.sha256 = sha256;
    const read = async () => {
      const xml = await client.query("app-ui");
      const state = shelfState(xml);
      const id = /^shelf-(\d+)$/.exec(state.focused[0] ?? "");
      const card = id ? Number(id[1]) : null;
      const { detail, backFocused, offset } = catalogState(xml);
      const sample = {
        hostMs: performance.now(),
        card,
        correct: id && isSelection(state, card),
        detail,
        backFocused,
        offset,
      };
      result.samples.push(sample);
      return sample;
    };
    const settle = async (test) => {
      const until = performance.now() + 5000;
      do {
        const state = await read();
        if (test(state)) return state;
        await wait(60);
      } while (performance.now() < until);
      throw Error("Expected catalog state did not settle");
    };
    await settle((s) => s.correct && s.card === 0);
    const edge = async (action) => {
      const sentMs = performance.now();
      result.events.push({ action, key: "Right", sentMs });
      const response = await fetch("http://" + host + ":8060/" + action + "/Right", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      assert.ok(response.ok, action + " HTTP " + response.status);
    };
    const interruption = new AbortController();
    const stop = () => interruption.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await holdRight(
        edge,
        durationMs,
        (ms) => wait(ms, undefined, { signal: interruption.signal }),
        injectedRepeats,
      );
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    // Allow already received input to settle. A row edge would mask repeats after release.
    await wait(160);
    const at = await settle((s) => s.correct && s.card >= 2 && s.card <= 7 && !s.detail);
    assert.ok(at.card < 7, "Reached the row boundary: rerun with a shorter hold");
    if (injectedRepeats) assert.equal(at.card, 1 + injectedRepeats, "Incorrect repeat count");
    for (let i = 0; i < 4; i++) {
      await wait(100);
      const now = await read();
      assert.ok(now.correct && now.card === at.card && !now.detail, "Focus moved after release");
    }
    result.restingCard = at.card;
    await client.keypress("Select");
    await settle((s) => s.detail === detailTitle(at.card) && s.backFocused);
    await client.keypress("Back");
    await settle((s) => s.card === at.card && s.correct && !s.detail && s.offset === at.offset);
    result.pass = true;
  } catch (error) {
    result.pass = false;
    result.error = String(error);
    process.exitCode = 1;
  } finally {
    writeFileSync(join(output, "summary.json"), JSON.stringify(result, null, 2) + "\n");
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await run(...process.argv.slice(2));
