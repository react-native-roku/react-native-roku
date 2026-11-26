import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { captureRokuDiagnostics } from "../../build/device.mjs";
import { catalogState, isSelection, shelfState } from "../shelf/score.mjs";
import { detailTitle } from "../shelf/shared/shelf.ts";
import { fixture } from "./device-fixture.mjs";

const [zip, receipt, output] = process.argv.slice(2);
const host = process.env.ROKU_BENCHMARK_HOST;
mkdirSync(output, { mode: 0o700 });
const result = { observations: [] };
let debug;
try {
  const { client, sha256 } = await fixture(zip, receipt, host);
  result.sha256 = sha256;
  debug = captureRokuDiagnostics(host);
  assert.equal(await debug.ready, true, "Focus injection console is unavailable");
  const now = performance.now();
  async function observe(stage, match) {
    const deadline = performance.now() + 6500;
    let xml;
    do {
      xml = await client.query("app-ui");
      const shelf = shelfState(xml);
      const catalog = catalogState(xml);
      result.observations.push({
        stage,
        hostMs: performance.now() - now,
        focused: shelf.focused,
        titles: shelf.titles,
        offset: catalog.offset,
        detail: catalog.detail,
      });
      if (match(shelf, catalog)) {
        writeFileSync(join(output, stage + ".xml"), xml, { flag: "wx" });
        return;
      }
      await wait(45);
    } while (performance.now() < deadline);
    writeFileSync(join(output, "last-native-state.xml"), xml);
    throw Error("Focus recovery failed at " + stage);
  }

  await observe("ready", (shelf) => isSelection(shelf, 0));
  await client.keypress("Right");
  await observe("recovered", (shelf) => isSelection(shelf, 1));
  await client.keypress("Select");
  await observe("detail", (_, catalog) => catalog.detail === detailTitle(1) && catalog.backFocused);
  await client.keypress("Back");
  await observe("restored", (shelf, catalog) => isSelection(shelf, 1) && catalog.offset === 0);
  await client.keypress("Right");
  await observe("next", (shelf) => isSelection(shelf, 2));
  const diagnostics = debug.snapshot();
  assert.equal(diagnostics.droppedLines, 0);
  const withheld = diagnostics.lines.filter((line) => line.includes("RNR_WITHHELD_FOCUS|shelf-1"));
  assert.equal(withheld.length, 1, "Expected exactly one withheld native focus acknowledgement");
  result.withheld = withheld[0];
  result.pass = true;
} catch (error) {
  result.pass = false;
  result.error = String(error);
  process.exitCode = 1;
} finally {
  debug?.close();
  if (debug)
    writeFileSync(
      join(output, "native-probe.json"),
      JSON.stringify(debug.snapshot(), null, 2) + "\n",
    );
  writeFileSync(join(output, "summary.json"), JSON.stringify(result, null, 2) + "\n");
}
