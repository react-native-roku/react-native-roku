import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ActivityIndicator } from "./activityIndicator";
import { createNativeRoot } from "./createNativeRoot";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
afterEach(() => vi.useRealTimers());
it("renders and advances one spinner animation and releases all owned frames", async () => {
  vi.useFakeTimers();
  const scene = new RecordingSceneGraph(),
    root = createNativeRoot(scene, {
      viewport: { width: 200, height: 200 },
      text: {
        prepare() {},
        metrics: () => ({ lineHeight: 20, width: () => 10 }),
      },
    });
  root.render(createElement(ActivityIndicator, { size: 36, color: "white" }));
  await root.whenCommitted();
  expect([...scene.nodes.values()].filter((node) => node.type === "rectangle")).toHaveLength(12);
  await vi.advanceTimersByTimeAsync(80);
  root.flush();
  await root.whenCommitted();
  expect(Number(scene.root.children[0].children[0].fields.rotation)).toBeGreaterThan(0);
  root.render(createElement(ActivityIndicator, { animating: false }));
  await root.whenCommitted();
  expect([...scene.nodes.values()].filter((node) => node.type === "rectangle")).toHaveLength(0);
  root.unmount();
  expect(vi.getTimerCount()).toBe(0);
  expect(scene.nodes.size).toBe(1);
});
