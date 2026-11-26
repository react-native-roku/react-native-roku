import { describe, expect, it, vi } from "vitest";
import type { DomNode } from "@roku-sdk/interfaces";

const boundary = vi.hoisted(() => {
  let id = 0;
  const fields = new WeakMap<object, Record<string, unknown>>();
  return {
    fields,
    start: vi.fn(),
    transaction: {
      createElement: (t: string) => ({
        t,
        r: ++id,
        c: [] as object[],
        parent: undefined as object | undefined,
      }),
      setProperty(node: object, key: string, value: unknown) {
        const record = fields.get(node) ?? {};
        record[key] = value;
        fields.set(node, record);
      },
      // Mirrors the SDK 2.19.1 bookkeeping boundary: insertion updates only the new parent's children.
      insertNode(parent: { c: object[] }, child: { parent?: object }, before?: object) {
        const previous = parent.c.indexOf(child);
        if (previous >= 0) parent.c.splice(previous, 1);
        const index = before ? parent.c.indexOf(before) : parent.c.length;
        parent.c.splice(index, 0, child);
        child.parent = parent;
      },
      removeNode(parent: { c: object[] }, child: object) {
        const index = parent.c.indexOf(child);
        if (index >= 0) parent.c.splice(index, 1);
      },
    },
  };
});
vi.mock("@roku-sdk/solid", () => ({ tmTransaction: boundary.transaction }));
vi.mock("@roku-sdk/common/transaction", () => ({
  transactionManager: { startTransaction: boundary.start },
}));
import { SdkSceneGraph } from "./SdkSceneGraph";

describe("SDK bridge conformance (host boundary fixture)", () => {
  it("restores visible opacity when a translucent or hidden style is removed", () => {
    const scene = new SdkSceneGraph(
      boundary.transaction.createElement("group") as unknown as DomNode,
    );
    const node = scene.create("group");
    scene.set(node, "opacity", 0);
    expect(boundary.fields.get(scene.native(node))?.opacity).toBe(0);
    scene.set(node, "opacity", null);
    expect(boundary.fields.get(scene.native(node))?.opacity).toBe(1);
  });
  it("preserves a moved subtree when its old parent is retired", () => {
    const scene = new SdkSceneGraph(
      boundary.transaction.createElement("group") as unknown as DomNode,
    );
    const first = scene.create("group"),
      second = scene.create("group"),
      label = scene.create("label");
    scene.batch(() => {
      scene.insert(scene.root, first);
      scene.insert(scene.root, second);
      scene.insert(first, label);
      scene.insert(second, label);
      scene.remove(scene.root, first);
    });
    expect(scene.native(second).c).toEqual([scene.native(label)]);
    expect(() => scene.native(first)).toThrow(/retired/);
    scene.batch(() => scene.remove(scene.root, second));
    expect(() => scene.native(label)).toThrow(/retired/);
  });
  it("translates live node capabilities and rejects retired capabilities in nested fields", () => {
    const scene = new SdkSceneGraph(
      boundary.transaction.createElement("group") as unknown as DomNode,
    );
    const label = scene.create("label"),
      font = scene.create("font");
    scene.insert(scene.root, font);
    scene.set(label, "font", font);
    expect(boundary.fields.get(scene.native(label))?.font).toBe(scene.native(font));
    scene.remove(scene.root, font);
    expect(() => scene.set(label, "content", { nested: [font] })).toThrow(/retired/);
  });
  it("registers field observations and removes the exact SDK event property", () => {
    const scene = new SdkSceneGraph(
      boundary.transaction.createElement("group") as unknown as DomNode,
    );
    const poster = scene.create("poster"),
      listener = vi.fn();
    const unsubscribe = scene.subscribe(poster, "loadStatus", listener);
    const fields = boundary.fields.get(scene.native(poster))!;
    expect(fields.onLoadStatus).toBe(listener);
    unsubscribe();
    expect(fields.onLoadStatus).toBeNull();
  });
});
