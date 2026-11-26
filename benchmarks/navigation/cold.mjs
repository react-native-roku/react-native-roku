import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseActiveApp } from "../../build/device.mjs";
import { focused, state } from "../catalog/scene.mjs";
import { isSelection, shelfState } from "../shelf/score.mjs";
import { fixture } from "./device-fixture.mjs";

function publicSelection(xml, card) {
  const scene = state(xml);
  return (
    focused(scene, "catalog-card-" + card) &&
    scene.position === card + 1 + " of 72" &&
    !scene.details &&
    !scene.modal
  );
}

export async function restartDevChannel(client, save, delay = wait) {
  const lifecycle = { terminationPolls: [] };
  let origin;
  try {
    try {
      lifecycle.terminationResponse = await client.terminate();
    } catch (error) {
      lifecycle.terminationError = String(error);
    }
    const until = performance.now() + 12000;
    let inactive = false;
    do {
      try {
        const xml = await client.query("app-state/dev");
        lifecycle.terminationPolls.push(xml);
        if (/<(state|channel-state)>\s*inactive\s*<\/\1>/.test(xml)) {
          const foreground = await client.query("active-app");
          lifecycle.terminationPolls.push(foreground);
          const active = parseActiveApp(foreground);
          // Roku Home can be reported as <app>Roku</app> without an ID.
          if ((active.id || active.name) && active.id !== "dev") {
            inactive = true;
            break;
          }
        }
      } catch (error) {
        lifecycle.terminationPolls.push(String(error));
      }
      await delay(80);
    } while (performance.now() < until);
    assert.ok(inactive, "Dev channel did not become inactive before cold launch");
    origin = performance.now();
    try {
      await client.launch();
      lifecycle.launchAcknowledged = true;
    } catch (error) {
      lifecycle.launchError = String(error);
    }
  } finally {
    save("lifecycle", JSON.stringify(lifecycle));
  }
  return origin;
}

export async function coldLaunch(client, save, delay = wait, publicCatalog = false) {
  const origin = await restartDevChannel(client, save, delay);
  const samples = [];
  async function observe(card) {
    const deadline = performance.now() + 25000;
    do {
      const start = performance.now() - origin;
      let xml;
      try {
        xml = await client.query("app-ui");
      } catch (error) {
        samples.push({ start, error: String(error) });
      }
      if (xml) {
        const end = performance.now() - origin;
        const match = publicCatalog
          ? publicSelection(xml, card)
          : isSelection(shelfState(xml), card);
        samples.push({ start, end, match, card });
        if (match) {
          save(card, xml);
          return end;
        }
      }
      await delay(75);
    } while (performance.now() < deadline);
    throw Error("Cold launch did not reach expected Card " + (card + 1));
  }
  try {
    const initialTreeMs = await observe(0);
    const sent = performance.now() - origin;
    await client.keypress("Right");
    // The next public card is disabled. The first Right must skip it.
    const responsiveTreeMs = await observe(publicCatalog ? 2 : 1);
    return {
      initialTreeMs,
      responsiveTreeMs,
      firstInputToObservedMs: responsiveTreeMs - sent,
      samples,
    };
  } finally {
    save("polls", JSON.stringify(samples));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [zip, receipt, output, workload] = process.argv.slice(2);
  assert.ok(workload === undefined || workload === "public-catalog");
  mkdirSync(output, { mode: 0o700 });
  const result = {
    workload: workload ?? "shelf",
    clock: "host monotonic, ECP tree polling",
    firstVisibleHighlight: "UNMEASURED",
  };
  try {
    const { client, sha256 } = await fixture(zip, receipt, process.env.ROKU_BENCHMARK_HOST);
    result.sha256 = sha256;
    Object.assign(
      result,
      await coldLaunch(
        client,
        (name, text) =>
          writeFileSync(
            join(output, typeof name === "string" ? name + ".json" : "card-" + (name + 1) + ".xml"),
            text,
          ),
        wait,
        workload === "public-catalog",
      ),
    );
    result.pass = true;
  } catch (error) {
    result.pass = false;
    result.error = String(error);
    process.exitCode = 1;
  } finally {
    writeFileSync(join(output, "summary.json"), JSON.stringify(result, null, 2) + "\n");
  }
}
