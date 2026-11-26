// Bundled inside the standalone consumer by host.mjs.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createElement as h } from "react";
import { createNativeRoot, NativeInput } from "react-native-roku";
import { RecordingSceneGraph } from "react-native-roku/testing";
import Shelf from "./src/App";
import { tiles, title, viewport } from "./src/shelf";
import { schedule, statistics, warmup } from "shelf-benchmark-score";

const diagnostic = process.env.HOST_PERF_DIAGNOSTIC === "1";
const workloads = ["static", "changing", "intrinsic"];
const results = [];
const focusColor = "0x87CEFAFF";

async function main() {
  for (const titleWorkload of workloads) {
    const scene = new RecordingSceneGraph();
    const input = new NativeInput();
    const root = createNativeRoot(scene, {
      viewport,
      input,
      text: {
        prepare() {},
        metrics(style) {
          const fontSize = Number(style.fontSize ?? 20);
          return {
            lineHeight: fontSize * 1.2,
            width: (value) => value.length * fontSize * 0.52,
          };
        },
      },
      onError(error) {
        throw error;
      },
    });
    const node = (id) => [...scene.nodes.values()].find(({ fields }) => fields.id === id);
    root.render(h(Shelf, { titleWorkload }));
    await root.whenCommitted();
    scene.emit(node("shelf-0"), "focusedChild", "shelf-0");
    await root.whenCommitted();
    assert.equal(input.focusedID, "shelf-0");

    async function move({ key, from, to }) {
      const before = node("selection").fields.height;
      scene.operations.length = 0;
      const structure = {
        dependencies: [],
        geometryMeasures: [],
        fieldMeasures: [],
        boundsChanges: [],
        rectangleReads: 0,
        geometrySolves: 0,
        placementVisits: 0,
      };
      if (diagnostic) globalThis.__SHELF_STRUCTURE__ = structure;
      const start = performance.now();
      assert.equal(input.dispatch({ key: key.toLowerCase(), phase: "down" }), true);
      const destination = node(tiles[to].id);
      assert.ok(
        scene.operations.some(
          ({ node, field, value }) =>
            node === destination.id && field === "gainFocus" && value === true,
        ),
      );
      scene.emit(destination, "focusedChild", tiles[to].id);
      input.dispatch({ key: key.toLowerCase(), phase: "up" });
      await root.whenCommitted();
      const ms = performance.now() - start;
      delete globalThis.__SHELF_STRUCTURE__;
      const selection = node("selection").fields;
      assert.ok(String(selection.text).startsWith(title(titleWorkload === "static" ? 0 : to)));
      assert.equal(input.focusedID, tiles[to].id);
      const color = (id) =>
        node(id).children.find((child) => child.type === "rectangle")?.fields.color;
      assert.equal(color(tiles[to].id), focusColor);
      assert.notEqual(color(tiles[from].id), focusColor);
      const writes = scene.operations
        .filter(({ operation }) => operation === "set")
        .map(({ node, field }) => ({ node, field }));
      return {
        key,
        from,
        to,
        ms,
        beforeHeight: before,
        height: selection.height,
        writes,
        ...(diagnostic ? { structure } : {}),
      };
    }

    for (const step of warmup) await move(step);
    const samples = [];
    for (const step of schedule) samples.push(await move(step));
    if (titleWorkload === "intrinsic")
      assert.ok(samples.some(({ beforeHeight, height }) => beforeHeight !== height));
    root.unmount();
    await root.whenCommitted();
    input.dispose();
    assert.deepEqual(
      [scene.nodes.size, scene.listenerCount, input.targetCount, input.observerCount],
      [1, 0, 0, 0],
    );
    results.push({
      titleWorkload,
      summary: statistics(samples.map(({ ms }) => ms)),
      samples,
    });
  }
  writeFileSync(process.argv[2], JSON.stringify({ diagnostic, results }, null, 2) + "\n");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
