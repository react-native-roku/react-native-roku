import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fixture } from "../navigation/device-fixture.mjs";

import { verifySavedLayout } from "./settings-storage.mjs";

const [mode, zip, receipt, output] = process.argv.slice(2);
assert.ok(["images", "settings", "settings-storage"].includes(mode));
mkdirSync(output, { mode: 0o700 });
const { client, sha256 } = await fixture(zip, receipt, process.env.ROKU_BENCHMARK_HOST);
const steps = [];
async function expect(name, predicate) {
  const deadline = Date.now() + 12000;
  let xml = "";
  do {
    try {
      xml = await client.query("app-ui");
    } catch (error) {
      // A cold launch can temporarily lose the ECP tree. Preserve the last error.
      xml = "";
      if (Date.now() >= deadline) throw error;
      await wait(100);
      continue;
    }
    if (predicate(xml)) {
      writeFileSync(join(output, name + ".xml"), xml, { flag: "wx" });
      steps.push(name);
      return xml;
    }
    await wait(100);
  } while (Date.now() < deadline);
  writeFileSync(join(output, name + "-failed.xml"), xml, { flag: "wx" });
  throw Error("Expected native state: " + name);
}
const text = (xml, value) => xml.includes('text="' + value + '"');
const focus = (xml, name) =>
  [...xml.matchAll(/<[A-Za-z][^<>]*>/g)].some(
    ([tag]) => tag.includes('name="' + name + '"') && tag.includes('focused="true"'),
  );
try {
  if (mode === "images") {
    const image = (label, status) => (xml) =>
      text(xml, label) && text(xml, status) && focus(xml, "gallery-next");
    await expect("loaded", image("Packaged image", "loaded"));
    for (const [name, label, status] of [
      ["missing", "Missing image", "failed"],
      ["unmounted", "Unmounted image", "removed"],
      ["reloaded", "Packaged image", "loaded"],
    ]) {
      await client.keypress("Select");
      await expect(name, image(label, status));
    }
  } else if (mode === "settings-storage") {
    await verifySavedLayout(client, expect, (name, value) =>
      writeFileSync(join(output, name + ".json"), value, { flag: "wx" }),
    );
  } else {
    const closed = (xml) =>
      focus(xml, "settings-edit") && text(xml, "Guest") && !text(xml, "Profile name");
    await expect("initial", closed);
    for (const key of ["Back", "Select"]) {
      await client.keypress("Select");
      await expect(
        "opened-" + key,
        (xml) => text(xml, "Profile name") && focus(xml, "settings-done"),
      );
      await client.keypress(key);
      await expect("restored-" + key, closed);
    }
  }
  writeFileSync(join(output, "summary.json"), JSON.stringify({ sha256, steps, passed: true }), {
    flag: "wx",
  });
} catch (error) {
  writeFileSync(
    join(output, "summary.json"),
    JSON.stringify({ sha256, steps, passed: false, error: error.message }),
    { flag: "wx" },
  );
  throw error;
}
