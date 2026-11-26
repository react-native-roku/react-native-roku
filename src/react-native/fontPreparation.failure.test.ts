import { createElement, Fragment } from "react";
import { expect, it, vi } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { Text } from "./primitives";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

it("observes a started font wait when a later synchronous preparation prevents the join", async () => {
  const scene = new RecordingSceneGraph(),
    errors = vi.fn(),
    disposed = vi.fn();
  let rejectFirst!: (error: unknown) => void;
  const first = new Promise<void>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const root = createNativeRoot(scene, {
    onError: errors,
    viewport: { width: 300, height: 100 },
    text: {
      prepare: (style) => {
        if (style.fontSize === 20) return first;
        throw Error("later font preparation failed");
      },
      metrics: () => ({ lineHeight: 20, width: () => 8 }),
      dispose: disposed,
    },
  });
  try {
    root.render(
      createElement(
        Fragment,
        {},
        createElement(Text, { style: { fontSize: 20 } }, "first"),
        createElement(Text, { style: { fontSize: 30 } }, "second"),
      ),
    );
    await expect(root.whenCommitted()).rejects.toThrow("later font preparation failed");
    rejectFirst(Error("first font failed late"));
    for (let index = 0; index < 6; index++) await Promise.resolve();
    expect(errors).toHaveBeenCalledTimes(1);
    await expect(root.whenCommitted()).rejects.toThrow("later font preparation failed");
  } finally {
    expect(() => root.unmount()).toThrow("later font preparation failed");
  }
  expect(disposed).toHaveBeenCalledTimes(1);
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
});
