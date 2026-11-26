import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { fixture } from "../device-fixture.mjs";

const attribute = (tag, name) => new RegExp("\\s" + name + '="([^"]*)"').exec(tag)?.[1];
const numbers = (value) => (value ?? "").match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];

export function state(xml) {
  const screen = /<topscreen\b[^>]*>([\s\S]*?)<\/topscreen>/.exec(xml)?.[1] ?? "";
  const parents = [],
    cards = [],
    focus = [];
  let title, clipY;
  for (const [tag] of screen.matchAll(/<\/?[A-Za-z][^<>]*>/g)) {
    if (tag.startsWith("</")) {
      parents.pop();
      continue;
    }
    const id = attribute(tag, "name");
    const bounds = numbers(attribute(tag, "bounds"));
    const [, dy = 0] = numbers(attribute(tag, "translation"));
    const parent = parents.at(-1);
    const node = { y: (parent?.y ?? 0) + dy, card: parent?.card };
    if (id === "holdout-window") clipY = node.y;
    if (/^route-\d+$/.test(id ?? "")) {
      node.card = { id, y: node.y, image: false };
      cards.push(node.card);
    }
    if (node.card && /^<poster\b/i.test(tag) && attribute(tag, "uri")) node.card.image = true;
    if (id === "holdout-title") {
      title = {
        width: bounds[2],
        height: bounds[3],
        text: attribute(tag, "text")?.replace(/(?:&#xA;|&#10;|\s)+/gi, " "),
      };
    }
    if (
      (/^route-\d+$/.test(id ?? "") || ["holdout-resize", "holdout-remove"].includes(id)) &&
      attribute(tag, "focused") === "true" &&
      attribute(tag, "focusable") === "true"
    )
      focus.push(id);
    if (!tag.endsWith("/>")) parents.push(node);
  }
  return { developer: /<plugin\b[^>]*\bid="dev"/.test(screen), cards, focus, title, clipY };
}

async function run(zip, receipt, output) {
  mkdirSync(output, { mode: 0o700 });
  const timed = process.env.ROKU_HOLDOUT_TIMED === "1";
  const result = { steps: [], firstVisibleHighlight: "UNMEASURED", timed };
  try {
    const { client, sha256 } = await fixture(zip, receipt, process.env.ROKU_BENCHMARK_HOST);
    result.sha256 = sha256;
    async function step(key, id, accept = () => true) {
      const observed = { key, id, pass: false };
      result.steps.push(observed);
      if (key) {
        if (timed) await wait(240);
        await client.keypress(key);
      }
      // An image-backed React launch may show the native Scene before the
      // packed consumer is ready. Keep per-input deadlines tight after mount.
      const deadline = performance.now() + (key ? 5000 : 30000);
      let xml;
      do {
        xml = await client.query("app-ui");
        const s = state(xml);
        if (s.developer && s.focus.length === 1 && s.focus[0] === id && accept(s)) {
          Object.assign(observed, {
            pass: true,
            card: s.cards.find((c) => c.id === id),
            mounted: s.cards.length,
            title: s.title,
          });
          writeFileSync(join(output, result.steps.length + ".xml"), xml);
          return s;
        }
        await wait(70);
      } while (performance.now() < deadline);
      writeFileSync(join(output, "failure.xml"), xml);
      throw Error("No matching native state for " + id);
    }
    const inWindow = (s, id) => {
      const card = s.cards.find((c) => c.id === id);
      return (
        card?.image && card.y >= s.clipY && card.y + 96 <= s.clipY + 288 && s.cards.length < 48
      );
    };
    await step(null, "route-1", (s) => inWindow(s, "route-1"));
    for (let i = 2; i <= 8; i++) await step("Down", "route-" + i, (s) => inWindow(s, "route-" + i));
    const y = result.steps.at(-1).card.y;
    const expectedText = "Route 8 — Long ridge walk past the lakes and back to the valley";
    const detail = (width) => (s) => s.title?.width === width && s.title.text === expectedText;
    await step("Select", "holdout-resize", detail(720));
    await step("Select", "holdout-resize", detail(320));
    await step(
      "Back",
      "route-8",
      (s) => inWindow(s, "route-8") && s.cards.find((c) => c.id === "route-8").y === y,
    );
    await step("Select", "holdout-resize", detail(720));
    await step("Down", "holdout-remove");
    await step(
      "Select",
      "route-9",
      (s) => inWindow(s, "route-9") && !s.cards.some((c) => c.id === "route-8"),
    );
    await step("Select", "holdout-resize", (s) => s.title?.text === "Route 9 — Valley walk");
    await step("Back", "route-9", (s) => inWindow(s, "route-9"));
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
