import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { packageRoot, resolveAdapter } from "./index.mjs";

test("public React Native core UI fixture commits layout, style removal and discrete input", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "rnr-core-ui-"));
  try {
    const outfile = resolve(directory, "fixture.cjs");
    await build({
      stdin: {
        contents: `
          export {createElement} from "react";
          export {CoreUiFixture} from "./examples/minimal/src/coreUiFixture";
          export {createNativeRoot} from "./src/react-native/createNativeRoot";
          export {NativeInput} from "./src/react-native/NativeInput";
          export {RecordingSceneGraph} from "./src/testing/RecordingSceneGraph";
        `,
        resolveDir: packageRoot,
      },
      outfile,
      bundle: true,
      platform: "node",
      jsx: "automatic",
      alias: { "react-native": resolveAdapter("react-native") },
    });
    const { createElement, CoreUiFixture, createNativeRoot, NativeInput, RecordingSceneGraph } =
      await import(pathToFileURL(outfile).href);
    const scene = new RecordingSceneGraph();
    const input = new NativeInput();
    const root = createNativeRoot(scene, {
      input,
      viewport: { width: 184, height: 160 },
      text: {
        prepare() {},
        metrics: () => ({ lineHeight: 24, width: (value) => value.length * 8 }),
      },
      graphics: {
        effects: true,
        cornerMasks: [0, 1, 2, 3].map((corner) => `fixture:/corner-${corner}.png`),
      },
    });
    const node = (id) => {
      const value = [...scene.nodes.values()].find((node) => node.fields.id === id);
      assert.ok(value, `core-ui/recording has no node for ${id}`);
      return value;
    };
    const eventTrace = [];
    const checkTrace = (events, expected) =>
      assert.deepEqual(events, expected, "core-ui/Pressable recording event order");
    try {
      root.render(createElement(CoreUiFixture, { onEvent: (event) => eventTrace.push(event) }));
      await root.whenCommitted();
      const alpha = node("core-alpha");
      const third = node("core-cell-c");
      const button = node("core-next");
      assert.deepEqual(third.fields.translation, [0, 14], "core-ui/View initial wrapping");
      assert.equal(alpha.fields.opacity, 0.5, "core-ui/View initial opacity");
      const masks = () => [...scene.nodes.values()].filter((node) => node.type === "maskGroup");
      assert.deepEqual(
        masks()
          .map((node) => node.fields.maskUri)
          .sort(),
        [0, 1, 2, 3].map((corner) => `fixture:/corner-${corner}.png`),
        "core-ui/View rounded overflow masks",
      );
      const poster = [...scene.nodes.values()].find((node) => node.type === "poster");
      assert.equal(poster?.fields.loadDisplayMode, "scaleToZoom", "core-ui/Image cover crop");
      scene.emit(button, "focusedChild", "core-next");
      for (const [translation, opacity] of [
        [[104, 0], 0.25],
        [[0, 14], null],
      ]) {
        input.dispatch({ key: "select", phase: "down" });
        input.dispatch({ key: "select", phase: "up" });
        await root.whenCommitted();
        assert.deepEqual(third.fields.translation, translation, "core-ui/View updated wrapping");
        assert.equal(alpha.fields.opacity, opacity, "core-ui/View updated/removed opacity");
      }
      const expected = ["mount", "commit:0", "press:0", "commit:1", "press:1", "commit:2"];
      checkTrace(eventTrace, expected);
      // These controls use the same scorer as the live trace.
      assert.throws(
        () =>
          checkTrace(
            eventTrace.filter((event) => event !== "press:1"),
            expected,
          ),
        /event order/,
      );
      assert.throws(() => checkTrace([...eventTrace, "press:1"], expected), /event order/);
      checkTrace(eventTrace, expected);
      input.dispatch({ key: "select", phase: "down" });
    } finally {
      root.unmount();
      input.dispatch({ key: "select", phase: "up" });
      input.dispose();
    }
    assert.equal(eventTrace.at(-1), "unmount", "core-ui retired Select did not activate");
    assert.equal(scene.nodes.size, 1);
    assert.equal(scene.listenerCount, 0);
    assert.equal(input.targetCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
