import { createElement as h, createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { View, Text } from "./primitives";
import type { NativeViewHandle } from "./nativeViewHandle";
import type { NativeRootOptions } from "./nativeRoot.types";
import type { TextRasterLease } from "../graphics/textRaster.types";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import * as layout from "../layout/flexLayout";

const text = {
  prepare() {},
  metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 10 }),
};
function fixture(extra: Partial<NativeRootOptions> = {}) {
  const scene = new RecordingSceneGraph();
  const ref = createRef<NativeViewHandle>();
  const root = createNativeRoot(scene, {
    viewport: { width: 400, height: 300 },
    text,
    ...extra,
  });
  const target = () => [...scene.nodes.values()].find((node) => node.fields.id === "target")!;
  const writes = () => scene.operations.filter((op) => op.field === "opacity");
  return { scene, ref, root, target, writes };
}
afterEach(() => vi.restoreAllMocks());

it("changes, repeats and restores opacity with coherent fields and no layout", async () => {
  const f = fixture();
  const onLayout = vi.fn();
  try {
    f.root.render(
      h(View, {
        ref: f.ref,
        nativeID: "target",
        onLayout,
        style: {
          width: 80,
          height: 30,
          opacity: 0.6,
        },
      }),
    );
    await f.root.whenCommitted();
    const calculate = vi.spyOn(layout, "calculateFlexLayout");
    for (const [value, expectedWrites] of [
      [0.2, 1],
      [0.2, 0],
      [0.6, 1],
    ]) {
      f.scene.operations.length = 0;
      f.ref.current!.setNativeProps({ style: [{ opacity: 0.1 }, { opacity: value }] });
      expect(f.target().fields.opacity).toBe(value);
      await f.root.whenCommitted();
      expect(f.writes()).toHaveLength(expectedWrites);
      expect(f.target().fields.translation).toEqual([0, 0]);
    }
    expect(calculate).not.toHaveBeenCalled();
    expect(onLayout).toHaveBeenCalledTimes(1);
    const measured = vi.fn();
    f.ref.current!.measure(measured);
    expect(measured).toHaveBeenCalledWith(0, 0, 80, 30, 0, 0);
  } finally {
    f.root.unmount();
  }
  expect(f.scene.nodes.size).toBe(1);
  expect(f.scene.listenerCount).toBe(0);
});

it("retains ownership through unrelated commits and yields to declarative changes or removal", async () => {
  const f = fixture();
  const render = (opacity: number | undefined, label: string) =>
    f.root.render(
      h(
        View,
        {},
        h(View, { ref: f.ref, nativeID: "target", style: { width: 80, height: 30, opacity } }),
        h(Text, {}, label),
      ),
    );
  try {
    render(0.6, "before");
    await f.root.whenCommitted();
    f.ref.current!.setNativeProps({ style: { opacity: 0.2 } });
    f.scene.operations.length = 0;
    render(0.6, "unrelated");
    await f.root.whenCommitted();
    expect(f.target().fields.opacity).toBe(0.2);
    expect(f.writes()).toEqual([]);
    render(0.8, "declarative");
    await f.root.whenCommitted();
    expect(f.target().fields.opacity).toBe(0.8);
    render(0.8, "retained");
    await f.root.whenCommitted();
    expect(f.target().fields.opacity).toBe(0.8);
    f.ref.current!.setNativeProps({ style: { opacity: 0.4 } });
    render(undefined, "removed");
    await f.root.whenCommitted();
    expect(f.target().fields.opacity).toBeNull();
    render(undefined, "still removed");
    await f.root.whenCommitted();
    expect(f.target().fields.opacity).toBeNull();
    f.ref.current!.setNativeProps({ style: { opacity: 0.3 } });
    render(undefined, "absent baseline");
    await f.root.whenCommitted();
    expect(f.target().fields.opacity).toBe(0.3);
  } finally {
    f.root.unmount();
  }
});

it("keeps geometry overrides and uses full layout for mixed updates", async () => {
  const f = fixture();
  try {
    f.root.render(
      h(
        View,
        { style: { flexDirection: "row" } },
        h(View, { ref: f.ref, nativeID: "target", style: { width: 80, height: 30, opacity: 0.6 } }),
        h(View, { nativeID: "sibling", style: { width: 20, height: 30 } }),
      ),
    );
    await f.root.whenCommitted();
    const calculate = vi.spyOn(layout, "calculateFlexLayout");
    f.ref.current!.setNativeProps({ style: { opacity: 0.2 } });
    f.ref.current!.setNativeProps({ style: { width: 100, opacity: 0.4 } });
    await f.root.whenCommitted();
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(f.target().fields.opacity).toBe(0.4);
    expect(
      [...f.scene.nodes.values()].find((n) => n.fields.id === "sibling")!.fields.translation,
    ).toEqual([100, 0]);
    calculate.mockClear();
    f.ref.current!.setNativeProps({ style: { opacity: 0.7 } });
    await f.root.whenCommitted();
    expect(calculate).not.toHaveBeenCalled();
    f.root.refreshNative();
    await f.root.whenCommitted();
    expect(f.target().fields.opacity).toBe(0.7);
    const measured = vi.fn();
    f.ref.current!.measure(measured);
    expect(measured).toHaveBeenCalledWith(0, 0, 100, 30, 0, 0);
  } finally {
    f.root.unmount();
  }
});

it("falls back during retained-target font preparation and keeps whenCommitted pending", async () => {
  let blocked = false;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = () => {
      blocked = false;
      resolve();
    };
  });
  const f = fixture({ text: { ...text, prepare: () => (blocked ? ready : undefined) } });
  const render = (label: string) =>
    f.root.render(
      h(
        View,
        {},
        h(View, { ref: f.ref, nativeID: "target", style: { width: 80, height: 30, opacity: 0.6 } }),
        h(Text, {}, label),
      ),
    );
  try {
    render("old");
    await f.root.whenCommitted();
    blocked = true;
    render("new");
    f.ref.current!.setNativeProps({ style: { opacity: 0.25 } });
    expect(f.target().fields.opacity).toBe(0.25);
    let committed = false;
    const waiting = f.root.whenCommitted().then(() => {
      committed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(committed).toBe(false);
    release();
    await waiting;
    expect(f.target().fields.opacity).toBe(0.25);
    expect([...f.scene.nodes.values()].some((n) => n.fields.text === "new")).toBe(true);
    render("later");
    await f.root.whenCommitted();
    expect(f.target().fields.opacity).toBe(0.25);
  } finally {
    release();
    f.root.unmount();
  }
});

it("retains raster leases on the stable path and retires superseded asynchronous preparation", async () => {
  const pending: Array<(lease: TextRasterLease) => void> = [];
  const disposed = vi.fn();
  const f = fixture({
    textRaster: {
      acquire: () => new Promise((resolve) => pending.push(resolve)),
      dispose: disposed,
    },
  });
  const render = (label: string) =>
    f.root.render(
      h(
        Text,
        {
          ref: f.ref,
          nativeID: "target",
          style: { width: 80, height: 30, opacity: 0.6, letterSpacing: 1 },
        },
        label,
      ),
    );
  const lease = (name: string) => ({
    image: { uri: `fixture:/${name}`, width: 80, height: 30, inset: 0 },
    release: vi.fn(),
  });
  const first = lease("first"),
    superseded = lease("superseded"),
    current = lease("current");
  try {
    render("first");
    pending[0](first);
    await f.root.whenCommitted();
    f.ref.current!.setNativeProps({ style: { opacity: 0.2 } });
    await f.root.whenCommitted();
    expect(pending).toHaveLength(1);
    expect(first.release).not.toHaveBeenCalled();
    expect(f.target().fields).toMatchObject({ opacity: 0.2, uri: "fixture:/first" });
    render("next");
    f.ref.current!.setNativeProps({ style: { opacity: 0.3 } });
    expect(pending).toHaveLength(3);
    let committed = false;
    const waiting = f.root.whenCommitted().then(() => {
      committed = true;
    });
    pending[1](superseded);
    await Promise.resolve();
    await Promise.resolve();
    expect(superseded.release).toHaveBeenCalledTimes(1);
    expect(committed).toBe(false);
    pending[2](current);
    await waiting;
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(current.release).not.toHaveBeenCalled();
    expect(f.target().fields).toMatchObject({ opacity: 0.3, uri: "fixture:/current" });
  } finally {
    f.root.unmount();
  }
  expect(current.release).toHaveBeenCalledTimes(1);
  expect(disposed).toHaveBeenCalledTimes(1);
  expect(f.scene.nodes.size).toBe(1);
});

it("rejects stale handles after removal, replacement and unmount", async () => {
  const f = fixture();
  const render = (key: string) =>
    f.root.render(h(View, { key, ref: f.ref, nativeID: "target", style: { opacity: 0.6 } }));
  render("first");
  await f.root.whenCommitted();
  const old = f.ref.current!;
  old.setNativeProps({ style: { opacity: 0.2 } });
  f.root.render(null);
  await f.root.whenCommitted();
  expect(() => old.setNativeProps({ style: { opacity: 0.9 } })).toThrow("RETIRED_VIEW");
  render("replacement");
  await f.root.whenCommitted();
  expect(f.target().fields.opacity).toBe(0.6);
  expect(() => old.setNativeProps({ style: { opacity: 0.9 } })).toThrow("RETIRED_VIEW");
  const current = f.ref.current!;
  f.root.unmount();
  expect(() => current.setNativeProps({ style: { opacity: 0.9 } })).toThrow("RETIRED_VIEW");
  expect(f.scene.nodes.size).toBe(1);
  expect(f.scene.listenerCount).toBe(0);
});

it("changes the semantic group only, preserving rounded clip masks and their readiness lifetime", async () => {
  const f = fixture({ graphics: { effects: true, cornerMasks: ["tl", "tr", "br", "bl"] } });
  try {
    f.root.render(
      h(
        View,
        {
          ref: f.ref,
          nativeID: "target",
          style: {
            width: 80,
            height: 30,
            opacity: 0.6,
            overflow: "hidden",
            borderRadius: 5,
            backgroundColor: "red",
          },
        },
        h(View, { nativeID: "child", style: { width: 100, height: 50 } }),
      ),
    );
    await f.root.whenCommitted();
    const masks = [...f.scene.nodes.values()].filter((n) => n.type === "maskGroup");
    expect(masks).toHaveLength(4);
    const before = masks.map((n) => ({ ...n.fields }));
    f.scene.operations.length = 0;
    f.ref.current!.setNativeProps({ style: { opacity: 0.2 } });
    await f.root.whenCommitted();
    expect(f.writes()).toHaveLength(1);
    expect(f.writes()[0].node).toBe(f.target().id);
    expect(f.target().fields).toMatchObject({ opacity: 0.2, clippingRect: [0, 0, 80, 30] });
    expect(masks.map((n) => n.fields)).toEqual(before);
    for (const mask of masks) {
      f.scene.emit(mask, "maskBitmapWidth", 10);
      f.scene.emit(mask, "maskBitmapHeight", 10);
    }
    f.root.flush();
    await f.root.whenCommitted();
    expect(f.target().fields.opacity).toBe(0.2);
    expect(masks.map((n) => n.fields)).toEqual(before);
    expect(f.scene.listenerCount).toBe(8);
  } finally {
    f.root.unmount();
  }
  expect(f.scene.nodes.size).toBe(1);
  expect(f.scene.listenerCount).toBe(0);
});

it("keeps inline paragraph line nodes and fields while updating the composite's opacity", async () => {
  const f = fixture({ text: { ...text, fontAsset: () => "fixture:/font.ttf" } });
  const render = (width: number) =>
    f.root.render(
      h(
        Text,
        {
          ref: f.ref,
          nativeID: "target",
          style: { width, opacity: 0.6, fontSize: 20 },
        },
        "aa",
        h(Text, { style: { color: "red" } }, "bb"),
        " cc",
      ),
    );
  try {
    render(50);
    await f.root.whenCommitted();
    const group = f.target(),
      lines = [...group.children];
    const before = lines.map((line) => ({ ...line.fields }));
    expect(lines.length).toBeGreaterThan(1);
    f.scene.operations.length = 0;
    f.ref.current!.setNativeProps({ style: { opacity: 0.2 } });
    await f.root.whenCommitted();
    expect(group.fields.opacity).toBe(0.2);
    expect(group.children).toEqual(lines);
    expect(lines.map((line) => line.fields)).toEqual(before);
    expect(f.scene.operations).toEqual([
      { operation: "set", node: group.id, field: "opacity", value: 0.2 },
    ]);
    render(150);
    await f.root.whenCommitted();
    expect(group.fields.opacity).toBe(0.2);
    expect(group.children).toHaveLength(1);
    expect(String(group.children[0].fields.text).replace(/<[^>]*>/g, "")).toBe("aabb cc");
    expect(f.scene.nodes.has(lines[1].id)).toBe(false);
  } finally {
    f.root.unmount();
  }
  expect(f.scene.nodes.size).toBe(1);
});

it("preserves synchronous native-write errors and retries without caching a failed write", async () => {
  const onError = vi.fn();
  const f = fixture({ onError });
  try {
    f.root.render(h(View, { ref: f.ref, nativeID: "target", style: { opacity: 0.6 } }));
    await f.root.whenCommitted();
    const originalSet = f.scene.set.bind(f.scene);
    const set = vi.spyOn(f.scene, "set").mockImplementationOnce(() => {
      throw new Error("native write failed");
    });
    expect(() => f.ref.current!.setNativeProps({ style: { opacity: 0.2 } })).toThrow(
      "native write failed",
    );
    expect(f.target().fields.opacity).toBe(0.6);
    expect(onError).not.toHaveBeenCalled();
    set.mockImplementation(originalSet);
    f.ref.current!.setNativeProps({ style: { opacity: 0.2 } });
    await f.root.whenCommitted();
    expect(f.target().fields.opacity).toBe(0.2);
    expect(set).toHaveBeenCalledTimes(2);
    expect(() => f.ref.current!.setNativeProps({ style: { opacity: -1 } })).toThrow(
      "C03_IMPERATIVE_PROPS",
    );
    f.root.refreshNative();
    await f.root.whenCommitted();
    expect(f.target().fields.opacity).toBe(0.2);
  } finally {
    f.root.unmount();
  }
});
