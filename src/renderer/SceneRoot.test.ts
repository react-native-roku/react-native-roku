import {
  Component,
  createContext,
  createElement,
  createRef,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { describe, expect, it } from "vitest";
import { createSceneRoot, type SceneHandle } from "./SceneRoot";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

describe("P01 React to SceneGraph host contracts (host evidence)", () => {
  it("executes actual hooks/context, committed refs, field events and effect cleanup", () => {
    const port = new RecordingSceneGraph(),
      root = createSceneRoot(port);
    const Theme = createContext("default");
    const ref = createRef<SceneHandle>();
    const effects: string[] = [];
    function Counter() {
      const [count, setCount] = useState(0);
      const theme = useContext(Theme);
      useEffect(() => {
        effects.push("mounted");
        return () => {
          effects.push("disposed");
        };
      }, []);
      return createElement(
        "label",
        {
          ref,
          fields: { color: theme },
          events: { selected: () => setCount((value) => value + 1) },
        },
        String(count),
      );
    }
    root.render(createElement(Theme.Provider, { value: "white" }, createElement(Counter)));
    const node = port.root.children[0];
    expect(ref.current?.nativeRef).toBe(node);
    expect(node.fields).toMatchObject({ text: "0", color: "white" });
    root.runSync(() => port.emit(node, "selected", true));
    expect(node.fields.text).toBe("1");
    expect(port.nodes.size).toBe(2);
    expect(port.listenerCount).toBe(1);
    root.unmount();
    expect(effects).toEqual(["mounted", "disposed"]);
    expect(ref.current).toBeNull();
    expect(port.nodes.size).toBe(1);
    expect(port.listenerCount).toBe(0);
    expect(() => root.render(createElement(Counter))).toThrow(/RETIRED_ROOT/);
  });

  it("preserves keyed node identity while reordering and removing a subscribed subtree", () => {
    const port = new RecordingSceneGraph(),
      root = createSceneRoot(port);
    const render = (ids: string[]) =>
      createElement(
        "group",
        null,
        ...ids.map((id) =>
          createElement("label", {
            key: id,
            fields: { text: id },
            events: { selected: () => undefined },
          }),
        ),
      );
    root.render(render(["a", "b", "c"]));
    const group = port.root.children[0],
      [a, b, c] = group.children;
    root.render(render(["c", "a"]));
    expect(group.children).toEqual([c, a]);
    expect(port.nodes.has(b.id)).toBe(false);
    expect(port.listenerCount).toBe(2);
    root.unmount();
    expect(port.listenerCount).toBe(0);
    expect(port.nodes.size).toBe(1);
  });

  it("updates external-store state without rebuilding host nodes or subscriptions", () => {
    const port = new RecordingSceneGraph(),
      root = createSceneRoot(port);
    let value = "initial";
    const subscribers = new Set<() => void>();
    const subscribe = (callback: () => void) => {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    };
    function StoreView() {
      const snapshot = useSyncExternalStore(subscribe, () => value);
      return createElement("label", { fields: { text: snapshot } });
    }
    root.render(createElement(StoreView));
    const node = port.root.children[0];
    const operationCount = port.operations.length;
    root.runSync(() => {
      value = "next";
      for (const callback of subscribers) callback();
    });
    expect(port.root.children[0]).toBe(node);
    expect(node.fields.text).toBe("next");
    expect(port.operations.slice(operationCount).map((operation) => operation.operation)).toEqual([
      "set",
    ]);
    root.unmount();
    expect(subscribers.size).toBe(0);
  });

  it("allows React error boundaries to catch unsupported nodes without allocating abandoned host nodes", () => {
    const port = new RecordingSceneGraph();
    const errors: string[] = [];
    const root = createSceneRoot(port, (error, kind) => {
      errors.push(`${kind}:${error.message}`);
    });
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        return this.state.failed
          ? createElement("label", { fields: { text: "failed visibly" } })
          : this.props.children;
      }
    }
    root.render(
      createElement(
        Boundary,
        null,
        createElement("group", null, createElement("unsupported-native-widget")),
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("UNSUPPORTED_NODE");
    expect(port.snapshot()).toMatchObject({
      children: [{ type: "label", fields: { text: "failed visibly" } }],
    });
    expect(port.operations.filter((operation) => operation.operation === "create")).toHaveLength(1);
    root.unmount();
  });

  it("orders sibling native paint by authored zIndex without changing React identities", () => {
    const scene = new RecordingSceneGraph(),
      root = createSceneRoot(scene);
    const elements = (railZ: number) =>
      createElement(
        "group",
        null,
        createElement("group", {
          key: "rail",
          fields: { id: "rail" },
          layout: { style: { zIndex: railZ } },
        }),
        createElement("group", { key: "content", fields: { id: "content" } }),
      );
    root.render(elements(40));
    const [content, rail] = scene.root.children[0].children;
    expect([content.fields.id, rail.fields.id]).toEqual(["content", "rail"]);
    root.render(elements(-1));
    expect(scene.root.children[0].children).toEqual([rail, content]);
    root.unmount();
    expect(scene.nodes.size).toBe(1);
  });
  it("discards superseded asynchronous layout and prevents stale work from rebuilding an unmounted root", async () => {
    const port = new RecordingSceneGraph();
    const releases: Array<() => void> = [];
    const root = createSceneRoot(port, undefined, {
      prepareFields(tree) {
        if (tree.length === 0) return new Map();
        return new Promise((resolve) => {
          releases.push(() => resolve(new Map()));
        });
      },
    });
    root.render(createElement("label", { fields: { text: "outdated" } }));
    root.render(createElement("label", { fields: { text: "current" } }));
    expect(port.nodes.size).toBe(1);
    releases[0]();
    await Promise.resolve();
    expect(port.nodes.size).toBe(1);
    releases[1]();
    await root.whenCommitted();
    expect(port.root.children[0].fields.text).toBe("current");
    root.render(createElement("label", { fields: { text: "late" } }));
    root.unmount();
    releases[2]();
    await Promise.resolve();
    expect(port.nodes.size).toBe(1);
  });
});
