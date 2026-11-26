import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openTestBrowser, pause, until } from "./browserHarness.mjs";

const [url, output] = process.argv.slice(2);
if (!url || !output) throw Error("Usage: qualify-catalog-preview.mjs PREVIEW_URL NEW_OUTPUT");
mkdirSync(output);
const browser = await openTestBrowser(url);
const steps = [];
const snapshot = () =>
  browser.evaluate("({texts: __ROKU_DEV__.snapshot().texts, trace: [...__CATALOG_TRACE__]})");
async function expectText(text) {
  return until(
    async () => {
      const result = await snapshot();
      return result.texts.includes(text) && result;
    },
    { timeout: 5000, interval: 10 },
  );
}
async function expectFocus(generation, item, after = 0) {
  const event = `row:${generation}:${item}:focus`;
  return until(
    async () => {
      const result = await snapshot();
      const mounted = result.trace.indexOf(`list:${generation}:mount`);
      const focus = result.trace.lastIndexOf(event);
      return mounted >= 0 && focus > mounted && focus >= after && result;
    },
    { timeout: 5000, interval: 10 },
  );
}
async function key(key, phases = ["down", "up"]) {
  const result = await browser.evaluate(
    `(${JSON.stringify(phases)}).map(phase => {
      const before = __CATALOG_TRACE__.length;
      const handled = __ROKU_DEV__.remote({key:${JSON.stringify(key)},phase});
      return {key:${JSON.stringify(key)}, phase, handled, trace:__CATALOG_TRACE__.slice(before)};
    })`,
  );
  steps.push(...result);
  return result;
}
async function capture(name) {
  const { data } = await browser.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(output, name + ".png"), Buffer.from(data, "base64"));
}
function assertActivation(steps, generation, item) {
  const prefix = `row:${generation}:${item}:`;
  assert.deepEqual(
    steps.map(({ handled, trace }) => [handled, trace.filter((event) => event.startsWith(prefix))]),
    [
      [true, [prefix + "press-in"]],
      [true, [prefix + "press-out", prefix + "activate"]],
    ],
  );
}

let status = "failed";
try {
  await expectFocus(1, "atlas");
  await key("down");
  await expectFocus(1, "orchard");
  assertActivation(await key("select"), 1, "orchard");
  await expectText("Orchard details");
  await pause(150);
  await key("select");
  await expectText("Note editor");
  await capture("modal");
  await key("back");
  await until(async () => !(await snapshot()).texts.includes("Note editor"), {
    timeout: 5000,
    interval: 10,
  });
  await key("back");
  steps.push({ observation: "fresh-list-focus", ...(await expectFocus(2, "orchard")) });
  assertActivation(await key("select"), 2, "orchard");
  await expectText("Orchard details");

  await key("back");
  await expectFocus(3, "orchard");
  await pause(200);
  await key("select", ["down", "repeat"]);
  await key("back");
  assert.equal((await key("select", ["up"]))[0].handled, true);
  await expectText("Orchard details");
  await key("back");
  await expectFocus(4, "orchard");
  for (const [keyName, item] of [
    ["up", "atlas"],
    ["down", "orchard"],
    ["up", "atlas"],
  ]) {
    const before = (await snapshot()).trace.length;
    assert.equal((await key(keyName))[0].handled, true);
    await expectFocus(4, item, before);
  }
  assertActivation(await key("select"), 4, "atlas");
  await expectText("Atlas details");
  await capture("return");
  status = "passed";
} catch (error) {
  steps.push({ error: String(error), final: await snapshot().catch(() => null) });
  await capture("failure").catch(() => {});
  throw error;
} finally {
  writeFileSync(resolve(output, "journey.json"), JSON.stringify({ status, steps }, null, 2));
  await browser.close();
}
