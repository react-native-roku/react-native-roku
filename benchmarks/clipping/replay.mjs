import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fixture } from "../navigation/device-fixture.mjs";
import { decode, measure, compare, roles, samplesPerState } from "./score.mjs";

export function matchesState(xml, role, step) {
  const tags = xml.match(/<[A-Za-z][^<>]*>/g) ?? [];
  const stateLabel = new RegExp(
    '\\stext="' + (role === "rounded" ? "Rounded test" : "Square control") + " " + step + '"',
  );
  return (
    tags.some((tag) => /\sname="core-next"/.test(tag) && /\sfocused="true"/.test(tag)) &&
    tags.some((tag) => stateLabel.test(tag))
  );
}

async function run() {
  const [zip, receipt, output] = process.argv.slice(2);
  const { client, sha256 } = await fixture(zip, receipt, process.env.ROKU_BENCHMARK_HOST, {
    timeoutMs: 10000,
  });
  mkdirSync(output, { mode: 0o700 });
  const save = (name, bytes) =>
    writeFileSync(join(output, name), bytes, { flag: "wx", mode: 0o600 });
  const report = {
    schema: "roku-installer-clipping/v1",
    fixtureSha256: sha256,
    status: "inconclusive",
    transportErrors: [],
    frames: [],
    comparisons: [],
  };
  try {
    for (const role of roles)
      for (let state = 0; state < 3; state++) {
        if (role !== "rounded" || state !== 0) {
          // A lost acknowledgement can follow a delivered press. Observe the state before deciding.
          try {
            await client.keypress("Select");
          } catch (error) {
            report.transportErrors.push({ role, state, operation: "Select", error: error.message });
          }
        }
        const deadline = Date.now() + 15000;
        let observed = false;
        do {
          try {
            if (matchesState(await client.query("app-ui"), role, state)) {
              observed = true;
              break;
            }
          } catch (error) {
            report.transportErrors.push({ role, state, operation: "app-ui", error: error.message });
          }
          await wait(150);
        } while (Date.now() < deadline);
        assert.ok(observed, `Missing focused native state ${role} ${state}`);
        for (let sample = 0; sample < samplesPerState; sample++) {
          await wait(300);
          const prefix = `${role}-${state}-${sample}`;
          const before = await client.query("app-ui");
          save(prefix + "-before.xml", before);
          assert.ok(matchesState(before, role, state), "Native state changed before capture");
          const { data, format } = await client.screenshot(process.env.ROKU_DEV_PASSWORD);
          const filename = prefix + "." + format;
          save(filename, data);
          const after = await client.query("app-ui");
          save(prefix + "-after.xml", after);
          assert.ok(matchesState(after, role, state), "Native state changed during capture");
          report.frames.push({
            filename,
            sha256: createHash("sha256").update(data).digest("hex"),
            sample,
            ...measure(decode(data), role, state),
          });
        }
      }
    const half = report.frames.length / 2;
    report.comparisons = report.frames.slice(0, half).flatMap((f, i) =>
      compare(f, report.frames[half + i]).map((c) => ({
        ...c,
        state: f.state,
        sample: f.sample,
      })),
    );
    report.status = report.comparisons.every((c) => c.status === "passed")
      ? "passed"
      : report.comparisons.some((c) => c.status === "failed")
        ? "failed"
        : "inconclusive";
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    save("clipping.json", JSON.stringify(report, null, 2) + "\n");
  }
  assert.equal(
    report.status,
    "passed",
    "Inspect the retained frames, references and per-corner results",
  );
}
if (import.meta.main) await run();
