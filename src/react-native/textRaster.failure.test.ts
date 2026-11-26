import { createElement, Fragment } from "react";
import { expect, it, vi } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { Text, View } from "./primitives";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import type { TextRasterLease } from "../graphics/textRaster.types";

function fixture() {
  const pending: {
      text: string;
      resolve(lease: TextRasterLease): void;
      reject(error: unknown): void;
    }[] = [],
    scene = new RecordingSceneGraph(),
    errors = vi.fn(),
    dispose = vi.fn();
  const root = createNativeRoot(scene, {
    onError: errors,
    viewport: { width: 300, height: 100 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
    },
    textRaster: {
      acquire: (request) =>
        new Promise((resolve, reject) =>
          pending.push({ text: request.layout.text, resolve, reject }),
        ),
      dispose,
    },
  });
  const element = (text: string) =>
    createElement(Text, { key: text, style: { width: 100, height: 20, letterSpacing: 1 } }, text);
  const lease = (name: string) => ({
    image: { uri: "fixture:/" + name, width: 100, height: 20, inset: 0 },
    release: vi.fn(),
  });
  const tick = async () => {
    for (let index = 0; index < 6; index++) await Promise.resolve();
  };
  const cleanup = () => {
    try {
      root.unmount();
    } catch {
      /* The original failed generation remains observable during retirement. */
    }
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
    expect(dispose).toHaveBeenCalledTimes(1);
  };
  return { pending, scene, errors, root, element, lease, tick, cleanup };
}

it("releases already prepared sibling rasters when a preparation fails", async () => {
  const f = fixture(),
    first = f.lease("first");
  try {
    f.root.render(createElement(Fragment, {}, f.element("first"), f.element("second")));
    f.pending[0].resolve(first);
    await f.tick();
    expect(first.release).not.toHaveBeenCalled();
    f.pending[1].reject(Error("second preparation failed"));
    await expect(f.root.whenCommitted()).rejects.toThrow("second preparation failed");
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(f.errors).toHaveBeenCalledTimes(1);
    expect(f.scene.nodes.size).toBe(1);
  } finally {
    f.cleanup();
  }
  expect(first.release).toHaveBeenCalledTimes(1);
});

it("releases a late sibling lease after another raster has already failed", async () => {
  const f = fixture(),
    late = f.lease("late");
  try {
    f.root.render(createElement(Fragment, {}, f.element("first"), f.element("second")));
    f.pending[0].reject(Error("first preparation failed"));
    await expect(f.root.whenCommitted()).rejects.toThrow("first preparation failed");
    f.pending[1].resolve(late);
    await f.tick();
    expect(late.release).toHaveBeenCalledTimes(1);
    expect(f.scene.nodes.size).toBe(1);
  } finally {
    f.cleanup();
  }
  expect(late.release).toHaveBeenCalledTimes(1);
});

it("retires pending rasters when a later synchronous layout walk fails", async () => {
  const f = fixture(),
    late = f.lease("walk");
  try {
    f.root.render(
      createElement(
        Fragment,
        {},
        f.element("tracked"),
        createElement(View, { nativeID: "duplicate", style: { width: 20, height: 20 } }),
        createElement(View, { nativeID: "duplicate", style: { width: 20, height: 20 } }),
      ),
    );
    await expect(f.root.whenCommitted()).rejects.toThrow("Duplicate");
    expect(f.pending).toHaveLength(1);
    f.pending[0].resolve(late);
    await f.tick();
    expect(late.release).toHaveBeenCalledTimes(1);
  } finally {
    f.cleanup();
  }
});

it("observes a late rejected raster after a synchronous walk failure without a second error", async () => {
  const f = fixture();
  try {
    f.root.render(
      createElement(
        Fragment,
        {},
        f.element("tracked"),
        createElement(View, { nativeID: "duplicate", style: { width: 20, height: 20 } }),
        createElement(View, { nativeID: "duplicate", style: { width: 20, height: 20 } }),
      ),
    );
    await expect(f.root.whenCommitted()).rejects.toThrow("Duplicate");
    f.pending[0].reject(Error("late raster failure"));
    await f.tick();
    expect(f.errors).toHaveBeenCalledTimes(1);
    await expect(f.root.whenCommitted()).rejects.toThrow("Duplicate");
  } finally {
    f.cleanup();
  }
});

it("keeps obsolete failures from releasing a newer committed raster cohort", async () => {
  const f = fixture(),
    stale = f.lease("stale"),
    current = f.lease("current");
  try {
    f.root.render(createElement(Fragment, {}, f.element("old-a"), f.element("old-b")));
    f.root.render(f.element("new"));
    f.pending[2].resolve(current);
    await f.root.whenCommitted();
    f.pending[0].reject(Error("obsolete failure"));
    f.pending[1].resolve(stale);
    await f.tick();
    await f.root.whenCommitted();
    expect(f.errors).not.toHaveBeenCalled();
    expect(stale.release).toHaveBeenCalledTimes(1);
    expect(current.release).not.toHaveBeenCalled();
    expect(
      [...f.scene.nodes.values()]
        .filter((node) => node.type === "poster")
        .map((node) => node.fields.uri),
    ).toEqual(["fixture:/current"]);
  } finally {
    f.cleanup();
  }
  expect(current.release).toHaveBeenCalledTimes(1);
});

it("preserves the preceding visible cohort until a failed replacement is recovered", async () => {
  const f = fixture(),
    previous = f.lease("previous"),
    partial = f.lease("partial"),
    recovered = f.lease("recovered");
  try {
    f.root.render(f.element("previous"));
    f.pending[0].resolve(previous);
    await f.root.whenCommitted();
    const node = [...f.scene.nodes.values()].find((node) => node.type === "poster")!;
    f.root.render(createElement(Fragment, {}, f.element("partial"), f.element("failed")));
    f.pending[1].resolve(partial);
    await f.tick();
    f.pending[2].reject(Error("replacement failed"));
    await expect(f.root.whenCommitted()).rejects.toThrow("replacement failed");
    expect(partial.release).toHaveBeenCalledTimes(1);
    expect(previous.release).not.toHaveBeenCalled();
    expect(f.scene.nodes.get(node.id)).toBe(node);
    // Existing root contract: the next synchronous flush surfaces the latched
    // failure even though its new asynchronous preparation has been queued.
    expect(() => f.root.render(f.element("recovered"))).toThrow("replacement failed");
    f.pending[3].resolve(recovered);
    await f.root.whenCommitted();
    expect(previous.release).toHaveBeenCalledTimes(1);
    expect(recovered.release).not.toHaveBeenCalled();
    expect(f.errors).toHaveBeenCalledTimes(1);
  } finally {
    f.cleanup();
  }
  expect(previous.release).toHaveBeenCalledTimes(1);
  expect(partial.release).toHaveBeenCalledTimes(1);
  expect(recovered.release).toHaveBeenCalledTimes(1);
});
