import {
  createElement as h,
  createRef,
  startTransition,
  Suspense,
  useEffect,
  useState,
} from "react";
import { afterEach, expect, it, vi } from "vitest";
import * as layout from "../layout/flexLayout";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { markPressableElement, markPressableStyle } from "./compilerPressable";
import { createNativeRoot } from "./createNativeRoot";
import { NativeInput } from "./NativeInput";
import { Image } from "./image";
import { Pressable, ScrollViewLayer, Text, View } from "./primitives";
import type { NativeViewHandle } from "./nativeViewHandle";
import { useNativeHost, type NativeHostContextValue } from "./nativeHostContext";

afterEach(() => vi.restoreAllMocks());
const metrics = () => ({ lineHeight: 20, width: (value: string) => value.length * 7 });
function fixture(stableFont = false) {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput();
  const root = createNativeRoot(scene, {
    viewport: { width: 640, height: 360 },
    input,
    text: {
      prepare() {},
      metrics,
      ...(stableFont
        ? { preparedFieldFont: () => scene.root, readRetainedFontLineHeight: () => 20 }
        : {}),
    },
  });
  return {
    scene,
    input,
    root,
    node: (id: string) => [...scene.nodes.values()].find((node) => node.fields.id === id)!,
    dispose() {
      root.unmount();
      input.dispose();
      expect(scene.nodes.size).toBe(1);
      expect(scene.listenerCount).toBe(0);
      expect(input.targetCount).toBe(0);
    },
  };
}

it("reuses layout for declarative opacity while committing effects and replacement handlers", async () => {
  const f = fixture(),
    ref = createRef<NativeViewHandle>(),
    effects: number[] = [],
    pressed: number[] = [];
  function App({ opacity, revision }: { opacity: number; revision: number }) {
    useEffect(() => {
      effects.push(revision);
    }, [revision]);
    return h(
      Pressable,
      {
        ref,
        nativeID: "target",
        onPress: () => pressed.push(revision),
        style: { width: 100, height: 40, opacity },
      },
      h(Text, null, "Unchanged layout"),
    );
  }
  try {
    f.root.render(h(App, { opacity: 1, revision: 0 }));
    await f.root.whenCommitted();
    const calculate = vi.spyOn(layout, "calculateFlexLayout"),
      before = f.scene.operations.length;
    f.root.render(h(App, { opacity: 0.4, revision: 1 }));
    await f.root.whenCommitted();
    expect(calculate).not.toHaveBeenCalled();
    expect(
      f.scene.operations.slice(before).filter((operation) => operation.operation === "set"),
    ).toEqual([{ operation: "set", node: f.node("target").id, field: "opacity", value: 0.4 }]);
    expect(effects).toEqual([0, 1]);
    ref.current!.focus();
    f.scene.emit(f.node("target"), "focusedChild", "target");
    f.input.dispatch({ key: "select", phase: "down" });
    f.input.dispatch({ key: "select", phase: "up" });
    expect(pressed).toEqual([1]);
    const writes = f.scene.operations.length;
    f.root.render(h(App, { opacity: 0.4, revision: 2 }));
    await f.root.whenCommitted();
    expect(calculate).not.toHaveBeenCalled();
    expect(
      f.scene.operations.slice(writes).filter((operation) => operation.operation === "set"),
    ).toEqual([]);
    expect(effects).toEqual([0, 1, 2]);
  } finally {
    f.dispose();
  }
});

it("recalculates structural, width, text and line-limit changes and delivers the new layout callback", async () => {
  const f = fixture(),
    measured: Array<{ revision: number; width: number }> = [];
  let revision = 0;
  const render = async (width: number, value: string, lines = 0, child = false) => {
    const current = ++revision;
    f.root.render(
      h(
        View,
        {
          nativeID: "parent",
          style: { width },
          onLayout: (event: unknown) => {
            const sample = event as { nativeEvent: { layout: { width: number } } };
            measured.push({ revision: current, width: sample.nativeEvent.layout.width });
          },
        },
        h(Text, { nativeID: "label", numberOfLines: lines }, value),
        child && h(View, { nativeID: "new", style: { height: 10 } }),
      ),
    );
    await f.root.whenCommitted();
  };
  try {
    await render(100, "first");
    const calculate = vi.spyOn(layout, "calculateFlexLayout");
    for (const [width, value, lines, child] of [
      [120, "first", 0, false],
      [120, "replacement text", 0, false],
      [120, "replacement text", 1, false],
      [120, "replacement text", 1, true],
    ] as const) {
      calculate.mockClear();
      await render(width, value, lines, child);
      expect(calculate).toHaveBeenCalledTimes(1);
      expect(measured.at(-1)?.width).toBe(width);
    }
    expect(measured[0]).toEqual({ revision: 1, width: 100 });
    expect(measured.at(-1)).toEqual({ revision: 5, width: 120 });
    expect(f.node("new")).toBeDefined();
  } finally {
    f.dispose();
  }
});

it("recalculates keyed structural reordering while retaining the same native nodes", async () => {
  const f = fixture();
  const render = async (reversed: boolean) => {
    f.root.render(
      h(
        View,
        { style: { flexDirection: "row" } },
        ...(reversed ? ["second", "first"] : ["first", "second"]).map((id) =>
          h(View, {
            key: id,
            nativeID: id,
            style: { width: id === "first" ? 20 : 30, height: 10 },
          }),
        ),
      ),
    );
    await f.root.whenCommitted();
  };
  try {
    await render(false);
    const first = f.node("first"),
      second = f.node("second");
    expect(first.fields.translation).toEqual([0, 0]);
    expect(second.fields.translation).toEqual([20, 0]);
    const calculate = vi.spyOn(layout, "calculateFlexLayout");
    await render(true);
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(f.node("first")).toBe(first);
    expect(f.node("second")).toBe(second);
    expect(first.fields.translation).toEqual([30, 0]);
    expect(second.fields.translation).toEqual([0, 0]);
  } finally {
    f.dispose();
  }
});

it("retains portal geometry and imperative/declarative opacity precedence with current measurements", async () => {
  const f = fixture(),
    ref = createRef<NativeViewHandle>(),
    portal = createRef<NativeViewHandle>();
  const render = async (opacity: number) => {
    f.root.render(
      h(
        View,
        { ref, nativeID: "target", style: { width: 100, height: 40, opacity } },
        f.root.portal(
          h(View, {
            ref: portal,
            nativeID: "portal",
            style: { position: "absolute", left: 25, top: 10, width: 50, height: 20, opacity },
          }),
          "portal",
        ),
      ),
    );
    await f.root.whenCommitted();
  };
  try {
    await render(1);
    ref.current!.setNativeProps({ style: { opacity: 0.2 } });
    const calculate = vi.spyOn(layout, "calculateFlexLayout");
    await render(1);
    expect(f.node("target").fields.opacity).toBe(0.2);
    await render(0.7);
    expect(f.node("target").fields.opacity).toBe(0.7);
    expect(f.node("portal").fields.opacity).toBe(0.7);
    expect(calculate).not.toHaveBeenCalled();
    const measurements: number[][] = [];
    portal.current!.measureInWindow((...values) => measurements.push(values));
    expect(measurements).toEqual([[25, 10, 50, 20]]);
  } finally {
    f.dispose();
  }
});

it("waits for asynchronous font work and forces explicit native refresh even with equal props", async () => {
  const scene = new RecordingSceneGraph();
  let pending: Promise<void> | undefined,
    complete!: () => void,
    glyph = 7;
  const widths: number[] = [];
  const root = createNativeRoot(scene, {
    viewport: { width: 640, height: 360 },
    text: {
      prepare: () => pending,
      metrics: () => ({ lineHeight: 20, width: (value) => value.length * glyph }),
    },
  });
  const render = (opacity: number) =>
    root.render(
      h(
        Text,
        {
          nativeID: "label",
          style: { opacity, alignSelf: "flex-start" },
          onLayout: (event: unknown) => {
            const sample = event as { nativeEvent: { layout: { width: number } } };
            widths.push(sample.nativeEvent.layout.width);
          },
        },
        "abcd",
      ),
    );
  const node = () => [...scene.nodes.values()].find((node) => node.fields.id === "label")!;
  try {
    render(1);
    await root.whenCommitted();
    const calculate = vi.spyOn(layout, "calculateFlexLayout");
    pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    render(0.5);
    expect(node().fields.opacity).toBe(1);
    expect(calculate).not.toHaveBeenCalled();
    glyph = 10;
    complete();
    await root.whenCommitted();
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(node().fields.opacity).toBe(0.5);
    expect(widths.at(-1)).toBe(40);
    pending = undefined;
    render(0.7);
    await root.whenCommitted();
    calculate.mockClear();
    glyph = 12;
    root.refreshNative();
    await root.whenCommitted();
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(widths.at(-1)).toBe(48);
    const before = scene.operations.length;
    root.unmount();
    await root.whenCommitted();
    expect(scene.nodes.size).toBe(1);
    expect(scene.operations.length).toBeGreaterThan(before);
    expect(scene.listenerCount).toBe(0);
  } finally {
    root.unmount();
  }
});

it("does not equate invalid numeric dimensions with null or hide in-place nested style changes", async () => {
  const f = fixture();
  const transform = [{ scale: 1 }];
  const render = (width: number | null) =>
    f.root.render(
      h(View, { nativeID: "target", style: { width: width as number, height: 30, transform } }),
    );
  try {
    render(null);
    await f.root.whenCommitted();
    const calculate = vi.spyOn(layout, "calculateFlexLayout");
    transform[0].scale = 2;
    render(null);
    await f.root.whenCommitted();
    expect(calculate).toHaveBeenCalledTimes(1);
    render(NaN);
    await expect(f.root.whenCommitted()).rejects.toThrow("supported dimension");
  } finally {
    try {
      f.dispose();
    } catch {
      f.root.unmount();
      f.input.dispose();
    }
  }
  expect(f.scene.nodes.size).toBe(1);
  expect(f.scene.listenerCount).toBe(0);
});

it("reuses fixed label geometry across text changes and solves after removing the height", async () => {
  const f = fixture();
  const render = async (text: string, height?: number) => {
    f.root.render(h(Text, { nativeID: "value", style: { width: 100, height } }, text));
    await f.root.whenCommitted();
  };
  try {
    await render("short", 50);
    const calculate = vi.spyOn(layout, "calculateFlexLayout");
    await render("longer", 50);
    expect(calculate).not.toHaveBeenCalled();
    expect(f.node("value").fields.text).toBe("longer");
    expect(f.node("value").fields.height).toBe(50);
    await render("longer");
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(f.node("value").fields.height).toBe(20);
  } finally {
    f.dispose();
  }
});

it("reuses view geometry for a recolor while still submitting paint and resizing on width changes", async () => {
  const f = fixture();
  const render = async (backgroundColor: string, width: number) => {
    f.root.render(h(View, { nativeID: "card", style: { width, height: 42, backgroundColor } }));
    await f.root.whenCommitted();
  };
  try {
    await render("#223344", 80);
    const calculate = vi.spyOn(layout, "calculateFlexLayout");
    const rectangle = f.node("card").children[0];
    await render("#445566", 80);
    expect(calculate).not.toHaveBeenCalled();
    expect(rectangle.fields.color).toBe("0x445566FF");
    await render("#445566", 85);
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(rectangle.fields.width).toBe(85);
  } finally {
    f.dispose();
  }
});

it.each([true, false])(
  "relayouts wrapping text with stable font identity %s",
  async (stableFont) => {
    const f = fixture(stableFont);
    const layouts: number[] = [];
    const render = async (title: string) => {
      f.root.render(
        h(
          View,
          { style: { width: 500, height: 300 } },
          h(
            View,
            { style: { position: "absolute", width: 100, height: 50, left: 20, top: 22 } },
            h(
              Text,
              {
                nativeID: "title",
                style: { width: 100 },
                onLayout: (event: unknown) => {
                  const { nativeEvent } = event as { nativeEvent: { layout: { height: number } } };
                  layouts.push(nativeEvent.layout.height);
                },
              },
              title,
            ),
          ),
          h(Pressable, { nativeID: "tile", style: { width: 80, height: 50 } }, h(Text, {}, "Tile")),
        ),
      );
      await f.root.whenCommitted();
    };
    try {
      await render("Short");
      const calculate = vi.spyOn(layout, "calculateFlexLayout");
      await render("A much longer wrapping title with several words");
      if (stableFont) expect(calculate).not.toHaveBeenCalled();
      else {
        expect(calculate).toHaveBeenCalledTimes(1);
        expect(calculate.mock.calls[0][0].children.map((child) => child.children.length)).toEqual([
          2,
        ]);
      }
      expect(layouts).toEqual([20, 80]);
      const independent = f.scene.snapshot();
      f.root.refreshNative();
      await f.root.whenCommitted();
      expect(f.scene.snapshot()).toEqual(independent);
    } finally {
      f.dispose();
    }
  },
);

it("retains sibling field plans during an isolated title solve and honors new geometry and handlers", async () => {
  const scene = new RecordingSceneGraph();
  const input = new NativeInput();
  const prepare = vi.fn();
  const glyphWidth = vi.fn((value: string) => value.length * 7);
  const text = {
    prepare,
    metrics: () => ({ lineHeight: 20, width: glyphWidth }),
    preparedFieldFont: () => scene.root,
    readRetainedFontLineHeight: () => 20,
  };
  const root = createNativeRoot(scene, { viewport: { width: 640, height: 360 }, input, text });
  const pressed: number[] = [];
  let current: NativeViewHandle | null = null;
  const render = async (revision: number, title: string, left: number, disabled = false) => {
    root.render(
      h(
        View,
        { onLayout() {} },
        h(
          View,
          { style: { position: "absolute", left: 0, top: 0, width: 120, height: 80 } },
          h(Text, { nativeID: "title", style: { width: 120 } }, title),
        ),
        h(
          Pressable,
          {
            nativeID: "card",
            ref: (handle) => {
              current = handle;
            },
            style: () => ({ position: "absolute", left, top: 90, width: 160, height: 80 }),
            onPress: () => pressed.push(revision),
            disabled,
          },
          h(Text, { style: { width: 140, height: 40 } }, "Stable card"),
        ),
      ),
    );
    await root.whenCommitted();
  };
  const node = (id: string) => [...scene.nodes.values()].find((item) => item.fields.id === id)!;
  const activate = () => {
    input.dispatch({ key: "select", phase: "down" });
    input.dispatch({ key: "select", phase: "up" });
  };
  try {
    await render(0, "Short", 0);
    expect(glyphWidth).toHaveBeenCalledWith("Stable card");
    expect(prepare).toHaveBeenCalled();
    const initialTitleHeight = node("title").fields.height;
    current!.focus();
    scene.emit(node("card"), "focusedChild", "card");
    await root.whenCommitted();
    glyphWidth.mockClear();
    prepare.mockClear();

    const wrappingTitle = "A longer title that wraps";
    await render(1, wrappingTitle, 0);
    expect(glyphWidth).not.toHaveBeenCalledWith("Stable card");
    expect(glyphWidth.mock.calls.filter(([value]) => value === wrappingTitle)).toHaveLength(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(Number(node("title").fields.height)).toBeGreaterThan(Number(initialTitleHeight));
    activate();
    expect(pressed).toEqual([1]);

    await render(2, "Short", 48, true);
    const measure = vi.fn();
    current!.measureInWindow(measure);
    expect(measure).toHaveBeenCalledWith(48, 90, 160, 80);
    expect(node("title").fields.height).toBe(initialTitleHeight);
    expect(node("card").fields.focusable).toBe(false);
    activate();
    expect(pressed).toEqual([1]);
  } finally {
    root.unmount();
    input.dispose();
  }
});

it("commits plain Pressable paint across recoloring, child reorder and paint removal", async () => {
  const f = fixture(true);
  async function render(color: string | undefined, order: string[], borderWidth?: number) {
    f.root.render(
      h(
        Pressable,
        {
          nativeID: "painted",
          style: { width: 100, height: 40, backgroundColor: color, borderWidth },
        },
        order.map((id) =>
          h(View, { key: id, nativeID: id, style: { zIndex: id === "behind" ? -1 : 0 } }),
        ),
      ),
    );
    await f.root.whenCommitted();
    return f.node("painted").children;
  }
  try {
    let children = await render("red", ["behind", "first", "second"]);
    expect(children.map((n) => n.fields.id ?? n.type)).toEqual([
      "behind",
      "rectangle",
      "first",
      "second",
    ]);
    const [behind, paint, first, second] = children;
    children = await render("blue", ["behind", "second", "first"]);
    expect(children).toEqual([behind, paint, second, first]);
    expect(paint.fields.color).toBe("0x0000FFFF");

    children = await render(undefined, ["behind", "second"]);
    expect(children).toEqual([behind, second]);
    expect(f.scene.nodes.has(paint.id)).toBe(false);
    expect(f.scene.nodes.has(first.id)).toBe(false);

    children = await render("red", ["behind", "second"], 1);
    expect(children.filter((n) => n.type === "rectangle")).toHaveLength(5);
    children = await render("red", ["behind", "second"]);
    expect(children.map((n) => n.fields.id ?? n.type)).toEqual(["behind", "rectangle", "second"]);
  } finally {
    f.dispose();
  }
});

it("commits replacement Pressable callbacks and refs with the same visual output", async () => {
  const f = fixture();
  const pressed: number[] = [];
  const refs: Array<[string, NativeViewHandle | null]> = [];
  const first = (handle: NativeViewHandle | null) => {
    refs.push(["first", handle]);
  };
  const next = (handle: NativeViewHandle | null) => {
    refs.push(["next", handle]);
  };
  const render = (ref: typeof first, revision: number) =>
    f.root.render(
      h(
        Pressable,
        {
          ref,
          nativeID: "target",
          onPress: () => pressed.push(revision),
          style: () => [{ width: 100, height: 40 }, { backgroundColor: "red" }],
        },
        h(Text, { style: { color: "white" } }, "Same"),
      ),
    );
  try {
    render(first, 1);
    await f.root.whenCommitted();
    f.input.observeFocus("target", true);
    await f.root.whenCommitted();
    const handle = refs[0]?.[1];
    expect(handle).toBeTruthy();

    render(next, 2);
    await f.root.whenCommitted();
    expect(refs).toEqual([
      ["first", handle],
      ["first", null],
      ["next", handle],
    ]);
    f.input.dispatch({ key: "select", phase: "down" });
    f.input.dispatch({ key: "select", phase: "up" });
    expect(pressed).toEqual([2]);
  } finally {
    f.dispose();
  }
});

it("commits accessibility, disabled state and changing wrapping children on the next render", async () => {
  const f = fixture(true);
  const press = vi.fn();
  let host!: NativeHostContextValue;
  function Probe() {
    host = useNativeHost();
    return null;
  }
  const render = async (disabled: boolean, selected: boolean, title: string, extra: boolean) => {
    f.root.render([
      h(Probe, { key: "probe" }),
      h(Pressable, {
        key: "target",
        nativeID: "target",
        disabled,
        accessibilityRole: "button",
        accessibilityState: { selected },
        "aria-disabled": !disabled,
        style: () => [{ width: 126 }, { backgroundColor: "red" }],
        onPress: press,
        children: () => [
          h(Text, { key: "label", nativeID: "title", style: { width: 84 } }, title),
          extra && h(View, { key: "extra", nativeID: "extra", style: { height: 5 } }),
        ],
      }),
    ]);
    await f.root.whenCommitted();
  };
  try {
    await render(false, false, "Short", false);
    f.input.observeFocus("target", true);
    await f.root.whenCommitted();
    const initialHeight = Number(f.node("title").fields.height);
    expect(host.placement("target")?.accessibility?.state).toMatchObject({
      disabled: false,
      selected: false,
    });

    const title = "A longer title that wraps across several lines";
    await render(true, true, title, true);
    expect(host.placement("target")?.accessibility?.state).toMatchObject({
      disabled: true,
      selected: true,
    });
    expect(f.node("target").fields.focusable).toBe(false);
    expect(f.node("title").fields.text).toBe("A longer\ntitle that\nwraps\nacross\nseveral\nlines");
    expect(f.node("title").fields.height).toBeGreaterThan(initialHeight);
    expect(f.node("extra")).toBeDefined();
    f.input.dispatch({ key: "select", phase: "down" });
    f.input.dispatch({ key: "select", phase: "up" });
    expect(press).not.toHaveBeenCalled();

    await render(false, false, "Short", false);
    expect(f.node("target").fields.focusable).toBe(true);
    expect(f.node("title").fields.height).toBe(initialHeight);
    expect(f.node("extra")).toBeUndefined();
    f.input.observeFocus("target", true);
    f.input.dispatch({ key: "select", phase: "down" });
    f.input.dispatch({ key: "select", phase: "up" });
    expect(press).toHaveBeenCalledTimes(1);
  } finally {
    f.dispose();
  }
});

it("matches full catalog layout across unseen titles and simultaneous React updates", async () => {
  const ids = ["frame", "box", "title", "cards", "first", "second", "third"];
  const scenarios = [
    { title: "Nacre", width: 350, left: 80, disabled: false, next: "second" },
    {
      title: "Quiet lanterns shine above the longest river crossing",
      width: 350,
      left: 80,
      disabled: false,
      next: "second",
    },
    { title: "Ibis", width: 350, left: 80, disabled: true, next: "third" },
    {
      title: "Silver thermometers record unusual temperatures",
      width: 350,
      left: 190,
      disabled: false,
      next: "third",
    },
    {
      title: "A brief walk beside a turbulent and unfamiliar ocean",
      width: 300,
      left: 190,
      disabled: false,
      next: "third",
    },
  ] as const;

  async function run(isolated: boolean) {
    const f = fixture(isolated);
    let host!: NativeHostContextValue;
    const refs: Array<[number, boolean]> = [];
    const presses: number[] = [];
    const callbacks: unknown[] = [];
    const calculate = vi.spyOn(layout, "calculateFlexLayout");
    const inputSizes: number[] = [];
    const snapshots: unknown[] = [];
    const focused: number[] = [];
    const measureNodes = (input: layout.LayoutInput): number =>
      1 + input.children.reduce((size, child) => size + measureNodes(child), 0);
    const Probe = () => {
      host = useNativeHost();
      return null;
    };
    try {
      for (const [revision, scenario] of scenarios.entries()) {
        const { title, width, left, disabled, next } = scenario;
        const oldSecond = host?.placement("second")?.global;
        const oldThird = host?.placement("third")?.global;
        calculate.mockClear();
        f.root.render(
          h(
            View,
            { nativeID: "frame", style: { width, height: 280 } },
            h(Probe),
            h(
              View,
              {
                nativeID: "box",
                style: { position: "absolute", left: 10, top: 8, width: 112, height: 98 },
              },
              h(
                Text,
                {
                  nativeID: "title",
                  style: { width: 112 },
                  onLayout: (event: unknown) => callbacks.push(event),
                },
                title,
              ),
            ),
            h(
              ScrollViewLayer,
              {
                nativeID: "cards",
                scrollTranslation: [0, 0],
                onLayout: (event: unknown) => callbacks.push(event),
                style: { top: 110, height: 70 },
              },
              h(Pressable, {
                nativeID: "first",
                ref: (handle) => {
                  refs.push([revision, handle !== null]);
                },
                onPress: () => presses.push(revision),
                onFocus: () => focused.push(revision),
                accessibilityLabel: "Choice " + revision,
                style: { position: "absolute", left: 0, width: 50, height: 50 },
              }),
              h(Pressable, {
                nativeID: "second",
                disabled,
                style: { position: "absolute", left, width: 50, height: 50 },
              }),
              h(Pressable, {
                nativeID: "third",
                style: { position: "absolute", right: 180, width: 50, height: 50 },
              }),
            ),
          ),
        );
        await f.root.whenCommitted();
        inputSizes.push(calculate.mock.calls.length ? measureNodes(calculate.mock.calls[0][0]) : 0);
        if (isolated && revision === 1) {
          expect(host.placement("second")?.global).toBe(oldSecond);
          expect(host.placement("third")?.global).toBe(oldThird);
        }
        f.input.observeFocus("first", true);
        f.input.dispatch({ key: "select", phase: "down" });
        f.input.dispatch({ key: "select", phase: "up" });
        const before = f.scene.operations.length;
        expect(f.input.dispatch({ key: "right", phase: "down" })).toBe(true);
        const requested = f.scene.operations
          .slice(before)
          .filter((operation) => operation.operation === "set" && operation.field === "gainFocus");
        expect(requested.at(-1)?.node).toBe(f.node(next).id);
        f.input.observeFocus(next, true);
        f.input.dispatch({ key: "right", phase: "up" });
        await f.root.whenCommitted();
        snapshots.push({
          native: f.scene.snapshot(),
          placements: ids.map((id) => {
            const { local, global, focusable, accessibilityLabel } = host.placement(id)!;
            return { local, global, focusable, accessibilityLabel };
          }),
          titleHeight: f.node("title").fields.height,
          focus: f.input.focusedID,
        });
      }
      expect(presses).toEqual([0, 1, 2, 3, 4]);
      expect(focused).toEqual([0, 1, 2, 3, 4]);
      expect(refs).toEqual([
        [0, true],
        [0, false],
        [1, true],
        [1, false],
        [2, true],
        [2, false],
        [3, true],
        [3, false],
        [4, true],
      ]);
      return { inputSizes, snapshots, callbacks };
    } finally {
      f.dispose();
    }
  }

  const full = await run(false);
  const result = await run(true);
  expect(full.inputSizes).toEqual([8, 8, 8, 8, 8]);
  expect(result.inputSizes).toEqual([8, 0, 0, 8, 8]);
  expect(result.snapshots).toEqual(full.snapshots);
  expect(result.callbacks).toEqual(full.callbacks);
});

it("combines a wrapping title with scroll placement and matches a full refresh across reversal", async () => {
  const f = fixture(true);
  const card = createRef<NativeViewHandle>();
  const label = createRef<NativeViewHandle>();
  const measure = vi.fn();
  const measuredLabel = vi.fn();
  const render = async (text: string, offset: number) => {
    f.root.render(
      h(
        View,
        { style: { width: 400, height: 300 } },
        h(
          View,
          { style: { position: "absolute", left: 0, top: 0, width: 100, height: 60 } },
          h(Text, { nativeID: "title", style: { width: 100 } }, text),
        ),
        h(
          ScrollViewLayer,
          { nativeID: "scroll", scrollTranslation: [0, -offset], style: { top: 70 } },
          h(
            Pressable,
            {
              ref: card,
              nativeID: "card",
              style: { position: "absolute", top: 80, width: 90, height: 40 },
            },
            h(
              Text,
              {
                ref: label,
                style: { width: 75, height: 25 },
              },
              "Stable Card",
            ),
          ),
        ),
      ),
    );
    await f.root.whenCommitted();
  };
  try {
    await render("Short", 0);
    const calculate = vi.spyOn(layout, "calculateFlexLayout");
    const verifyScroll = async (text: string, offset: number, height: number) => {
      calculate.mockClear();
      await render(text, offset);
      expect(calculate).not.toHaveBeenCalled();
      expect(f.node("title").fields.height).toBe(height);
      expect(f.node("scroll").fields.translation).toEqual([0, 70 - offset]);
      card.current!.measureInWindow(measure);
      expect(measure).toHaveBeenLastCalledWith(0, 150 - offset, 90, 40);
      label.current!.measureInWindow(measuredLabel);
      expect(measuredLabel).toHaveBeenLastCalledWith(0, 150 - offset, 75, 25);
      const labelBounds = measuredLabel.mock.lastCall;
      const incremental = f.scene.snapshot();
      f.root.refreshNative();
      await f.root.whenCommitted();
      expect(f.scene.snapshot()).toEqual(incremental);
      label.current!.measureInWindow(measuredLabel);
      expect(measuredLabel.mock.lastCall).toEqual(labelBounds);
    };
    await verifyScroll("An unseen description with wrapping lines", 40, 80);
    await verifyScroll("Short again", 0, 20);
  } finally {
    f.dispose();
  }
});

it("keeps an image mounted while scrolling and publishes the latest load callback", async () => {
  const f = fixture(true);
  const image = createRef<NativeViewHandle>();
  const measured = vi.fn(),
    loaded = vi.fn();
  async function render(offset: number, revision: number, source = "pkg:/images/cover.png") {
    f.root.render(
      h(
        ScrollViewLayer,
        { nativeID: "scroll", scrollTranslation: [0, -offset] },
        h(Image, {
          ref: image,
          nativeID: "cover",
          source,
          style: { width: 96, height: 96 },
          onLoad: () => loaded(revision),
        }),
      ),
    );
    await f.root.whenCommitted();
    return f.node("cover").children[0];
  }
  try {
    const poster = await render(0, 0);
    const calculate = vi.spyOn(layout, "calculateFlexLayout");
    const before = f.scene.operations.length;
    expect(await render(20, 1)).toBe(poster);
    expect(calculate).not.toHaveBeenCalled();
    expect(f.scene.operations.slice(before).some((op) => op.node === poster.id)).toBe(false);
    image.current!.measureInWindow(measured);
    expect(measured).toHaveBeenLastCalledWith(0, -20, 96, 96);
    f.scene.emit(poster, "bitmapWidth", 200);
    f.scene.emit(poster, "bitmapHeight", 200);
    f.scene.emit(poster, "loadStatus", "ready");
    expect(loaded.mock.calls).toEqual([[1]]);

    const next = await render(20, 2, "pkg:/images/second.png");
    expect(next).not.toBe(poster);
    expect(f.scene.nodes.has(poster.id)).toBe(false);
    expect(next.fields.uri).toBe("pkg:/images/second.png");
  } finally {
    f.dispose();
  }
});

it("keeps Yoga authoritative when an isolated label has layout constraints", async () => {
  const f = fixture(true);
  const render = (title: string) =>
    f.root.render(
      h(
        View,
        { style: { position: "absolute", left: 0, top: 0, width: 100, height: 60 } },
        h(Text, { nativeID: "title", style: { width: 90, marginLeft: 5, maxHeight: 35 } }, title),
      ),
    );
  try {
    render("Short");
    await f.root.whenCommitted();
    const calculate = vi.spyOn(layout, "calculateFlexLayout");
    render("A wrapping title remains constrained by its authored maximum height");
    await f.root.whenCommitted();
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(f.node("title").fields.translation).toEqual([5, 0]);
    expect(f.node("title").fields.height).toBe(35);
    const incremental = f.scene.snapshot();
    f.root.refreshNative();
    await f.root.whenCommitted();
    expect(f.scene.snapshot()).toEqual(incremental);
  } finally {
    f.dispose();
  }
});

it("renders equivalent new Text props after a previous style changed during native refresh", async () => {
  const f = fixture(true);
  const original = { width: 75, height: 30 };
  const label = (style: typeof original) => h(Text, { nativeID: "title", style }, "Same title");
  try {
    f.root.render(label(original));
    await f.root.whenCommitted();
    expect(f.node("title").fields.width).toBe(75);
    original.width = 125;
    f.root.refreshNative();
    await f.root.whenCommitted();
    expect(f.node("title").fields.width).toBe(125);
    f.root.render(label({ width: 75, height: 30 }));
    await f.root.whenCommitted();
    expect(f.node("title").fields.width).toBe(75);
  } finally {
    f.dispose();
  }
});

it("uses the latest equivalent Text style on an explicit native refresh", async () => {
  const f = fixture(true);
  const first = { width: 75, height: 30 };
  const latest = { ...first };
  const label = (style: typeof first) => h(Text, { nativeID: "title", style }, "Same title");
  try {
    f.root.render(label(first));
    await f.root.whenCommitted();
    f.root.render(label(latest));
    await f.root.whenCommitted();
    first.width = 98;
    f.root.refreshNative();
    await f.root.whenCommitted();
    expect(f.node("title").fields.width).toBe(75);
    latest.width = 125;
    f.root.refreshNative();
    await f.root.whenCommitted();
    expect(f.node("title").fields.width).toBe(125);
  } finally {
    f.dispose();
  }
});

it("rebinds a Text ref when its native output is equivalent", async () => {
  const f = fixture(true);
  const first = vi.fn();
  const latest = vi.fn();
  const label = (ref: (handle: NativeViewHandle | null) => void) =>
    h(Text, { nativeID: "title", style: { width: 75, height: 30 }, ref }, "Same title");
  try {
    f.root.render(label(first));
    await f.root.whenCommitted();
    const handle = first.mock.calls[0][0];
    expect(handle.nativeID).toBe("title");
    f.root.render(label(latest));
    await f.root.whenCommitted();
    expect(first).toHaveBeenLastCalledWith(null);
    expect(latest).toHaveBeenCalledExactlyOnceWith(handle);
  } finally {
    f.dispose();
  }
});

it("keeps committed focus and ref bindings current when Pressable retains native output", async () => {
  const f = fixture();
  const stableStyle = markPressableStyle({ width: 100, height: 40, backgroundColor: "blue" });
  const stableText = h(Text, null, "Same card");
  const refs: Array<[number, NativeViewHandle | null]> = [];
  const invoked: string[] = [];
  const refCleanups: number[] = [];
  const compiledKeys = ["nativeID", "accessibilityRole"] as const;
  let owner!: NativeHostContextValue;
  function Probe() {
    owner = useNativeHost();
    return null;
  }
  const render = async (revision: number) => {
    f.root.render([
      h(Probe, { key: "probe" }),
      markPressableElement(
        h(
          Pressable,
          {
            key: "card",
            nativeID: "card",
            ref(value: NativeViewHandle | null) {
              refs.push([revision, value]);
              if (value && revision === 1)
                return () => {
                  refCleanups.push(revision);
                };
            },
            style: () => stableStyle,
            accessibilityRole: "button",
            onFocusCapture: () => invoked.push("capture" + revision),
            onFocus(this: void) {
              expect(this).toBeUndefined();
              invoked.push("focus" + revision);
            },
            onPress: () => invoked.push("press" + revision),
          },
          stableText,
        ),
        compiledKeys,
      ),
    ]);
    await f.root.whenCommitted();
  };
  try {
    await render(1);
    const bindings = owner.placement("card")?.focusEvents;
    expect(bindings).toBeDefined();
    const original = refs[0][1];
    expect(original).toBeTruthy();
    await render(2);
    expect(owner.placement("card")?.focusEvents).toBe(bindings);
    expect(refs).toEqual([
      [1, original],
      [2, original],
    ]);
    expect(refCleanups).toEqual([1]);
    f.input.observeFocus("card", true);
    f.input.dispatch({ key: "select", phase: "down" });
    f.input.dispatch({ key: "select", phase: "up" });
    expect(invoked).toEqual(["capture2", "focus2", "press2"]);
  } finally {
    f.dispose();
  }
});

it.each([false, true])(
  "keeps an unfinished Pressable render from publishing its event binding with compiler tag %s",
  async (compiled) => {
    const f = fixture();
    const paint = markPressableStyle({ width: 100, height: 40, backgroundColor: "blue" });
    const content = h(Text, null, "Same card");
    const propsOrder = ["nativeID", "accessibilityRole"] as const;
    const pressed: number[] = [];
    let revise!: (revision: number) => void;
    let started!: () => void;
    const speculative = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<never>(() => {});
    function Barrier({ revision }: { revision: number }) {
      if (revision === 2) {
        started();
        throw blocked;
      }
      return null;
    }
    function Screen() {
      const [revision, update] = useState(1);
      revise = update;
      const card = h(
        Pressable,
        {
          nativeID: "catalog",
          style: () => paint,
          accessibilityRole: "button",
          onPress: () => pressed.push(revision),
        },
        content,
      );
      return h(
        Suspense,
        { fallback: null },
        compiled ? markPressableElement(card, propsOrder) : card,
        h(Barrier, { revision }),
      );
    }
    try {
      f.root.render(h(Screen));
      await f.root.whenCommitted();
      f.input.observeFocus("catalog", true);
      startTransition(() => revise(2));
      await speculative;

      f.input.dispatch({ key: "select", phase: "down" });
      f.input.dispatch({ key: "select", phase: "up" });
      expect(pressed).toEqual([1]);
    } finally {
      f.dispose();
    }
  },
);

it("reads current inherited accessibility fields before reusing compiled Pressable output", async () => {
  const f = fixture();
  const paint = markPressableStyle({ width: 100, height: 40 });
  const child = h(Text, null, "Selection");
  const keys = ["nativeID", "accessibilityRole"] as const;
  let owner!: NativeHostContextValue;
  function Probe() {
    owner = useNativeHost();
    return null;
  }
  const render = async () => {
    f.root.render([
      h(Probe, { key: "probe" }),
      markPressableElement(
        h(
          Pressable,
          {
            key: "card",
            nativeID: "card",
            accessibilityRole: "button",
            style: () => paint,
          },
          child,
        ),
        keys,
      ),
    ]);
    await f.root.whenCommitted();
    return owner.placement("card")?.accessibility?.state.selected;
  };
  const property = "aria-selected";
  try {
    expect(await render()).toBeUndefined();
    Object.defineProperty(Object.prototype, property, { configurable: true, value: true });
    expect(await render()).toBe(true);
    Reflect.deleteProperty(Object.prototype, property);
    expect(await render()).toBeUndefined();
  } finally {
    Reflect.deleteProperty(Object.prototype, property);
    f.dispose();
  }
});

it("retains a stretched status label's geometry while replacing text and remeasures dependent widths", async () => {
  const f = fixture(true);
  const sibling = h(View, { nativeID: "neighbor", style: { width: 300, height: 100 } });
  async function render(text: string, width: number, alignItems?: "flex-start") {
    f.root.render(
      h(
        View,
        { style: { width, height: 320, alignItems } },
        h(Text, { nativeID: "position", style: { height: 54 } }, text, " of ", 72),
        sibling,
      ),
    );
    await f.root.whenCommitted();
  }
  try {
    await render("1", 550);
    expect(f.node("position").fields).toMatchObject({ text: "1 of 72", width: 550, height: 54 });
    const calculate = vi.spyOn(layout, "calculateFlexLayout");
    await render("An updated wider position", 550);
    expect(calculate).not.toHaveBeenCalled();
    const retained = { ...f.node("position").fields };
    f.root.refreshNative();
    await f.root.whenCommitted();
    expect(f.node("position").fields).toEqual(retained);
    calculate.mockClear();
    await render("3", 320);
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(f.node("position").fields).toMatchObject({ text: "3 of 72", width: 320 });
    calculate.mockClear();
    Object.defineProperty(Object.prototype, "alignSelf", {
      configurable: true,
      value: "flex-start",
    });
    try {
      await render("Inherited alignment", 320);
      expect(calculate).toHaveBeenCalledTimes(1);
      expect(f.node("position").fields.width).toBeLessThan(320);
    } finally {
      Reflect.deleteProperty(Object.prototype, "alignSelf");
    }
    await render("3", 320, "flex-start");
    expect(f.node("position").fields.width).toBeLessThan(320);
    calculate.mockClear();
    await render("A wider position", 320, "flex-start");
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(f.node("position").fields.width).toBeGreaterThan(54);
  } finally {
    f.dispose();
  }
});
