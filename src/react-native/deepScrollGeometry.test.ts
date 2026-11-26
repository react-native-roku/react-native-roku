import { createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import * as flex from "../layout/flexLayout";
import { layoutText } from "../layout/textLayout";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { createNativeRoot } from "./createNativeRoot";
import { NativeInput } from "./NativeInput";
import { Image } from "./image";
import { Pressable, ScrollViewLayer, Text, View } from "./primitives";

afterEach(() => vi.restoreAllMocks());

it("matches every full Yoga rectangle while replacing, resizing, removing and reordering rows", async () => {
  const scene = new RecordingSceneGraph();
  const input = new NativeInput();
  const viewport = { width: 640, height: 360 };
  const metrics = () => ({ lineHeight: 20, width: (value: string) => value.length * 7 });
  const text = {
    prepare() {},
    metrics,
    preparedFieldFont: () => scene.root,
    readRetainedFontLineHeight: () => 20,
  };
  const root = createNativeRoot(scene, { viewport, input, text });
  const fullSolve = flex.calculateFlexLayout;
  const observed: {
    expected: Map<flex.LayoutInput, flex.LayoutRect>;
    actual: Map<flex.LayoutInput, flex.LayoutRect>;
    boxes: number;
    initialNodes: number;
  }[] = [];
  vi.spyOn(flex, "calculateFlexLayout").mockImplementation((input, view, measure, boxes) => {
    const actual = fullSolve(input, view, measure, boxes);
    const expected = fullSolve(input, view, (label, width) =>
      layoutText(label.text!, label.style, metrics(), width, 2),
    );
    observed.push({ expected, actual, boxes: boxes?.size ?? 0, initialNodes: actual.size });
    return actual;
  });

  let rows = [0, 1, 2, 3, 4, 5, 6];
  let width = 100;
  let scrollWidth = 590;
  let offset = 0;
  let orderBaseline = false;
  let hidden = false;
  let titleRevision = false;
  const render = async (phase: string, minimumBoxes: number, maximumBoxes = Infinity) => {
    observed.length = 0;
    root.render(
      h(
        View,
        { style: { width: scrollWidth, height: 250, overflow: "hidden" } },
        h(
          ScrollViewLayer,
          {
            scrollTranslation: [0, -offset],
            style: { flexDirection: "column", display: hidden ? "none" : "flex" },
          },
          ...rows.map((row) =>
            h(
              View,
              { key: row, nativeID: `row-${row}` },
              h(
                View,
                {
                  style: { flexDirection: "row", ...(orderBaseline && { alignItems: "baseline" }) },
                },
                ...[0, 1, 2, 3].map((column) =>
                  h(
                    Pressable,
                    {
                      key: column,
                      nativeID: `card-${row}-${column}`,
                      style: {
                        width: row === 2 ? width : 100,
                        height: 85,
                        padding: 4,
                        marginRight: 4,
                        marginBottom: 3,
                        backgroundColor: row % 2 ? "#1267aa" : "#233344",
                      },
                    },
                    h(Image, {
                      nativeID: `poster-${row}-${column}`,
                      source: { uri: "pkg:/images/cover.png" },
                      style: { width: 80, height: 25 },
                    }),
                    h(
                      Text,
                      {
                        nativeID: `label-${row}-${column}`,
                        numberOfLines: 2,
                        style: { fontSize: 20 },
                      },
                      row === 2 && titleRevision
                        ? "Updated title"
                        : `A long route title ${row}-${column}`,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await root.whenCommitted();
    const last = observed.at(-1)!;
    expect(last.actual, phase).toEqual(last.expected);
    expect(last.boxes, phase).toBeGreaterThanOrEqual(minimumBoxes);
    expect(last.boxes, phase).toBeLessThanOrEqual(maximumBoxes);
    expect(last.actual.size - last.initialNodes, phase).toBe(last.boxes * 2);
  };
  try {
    await render("initial", 0, 0);
    rows = [1, 2, 3, 4, 5, 6, 7];
    offset = 88;
    await render("replace window", 24, 24);
    rows = [2, 3, 4, 5, 6, 7, 8];
    width = 122;
    scrollWidth = 523;
    await render("resize content and cards", 20, 20);
    rows = [2, 3, 5, 6, 7, 8];
    offset = 176;
    await render("remove row", 24, 24);
    rows = [8, 3, 5, 2, 7, 6];
    await render("reorder rows", 24, 24);
    rows = [9, 8, 3, 5, 2, 7, 6];
    titleRevision = true;
    await render("changed text in a retained row", 20, 20);
    rows = [10, 8, 3, 5, 2, 7, 6];
    viewport.width = 615;
    await render("resize viewport", 0, 0);
    rows = [11, 8, 3, 5, 2, 7, 6];
    orderBaseline = true;
    await render("baseline-aligned ancestor", 0, 0);
    rows = [12, 8, 3, 5, 2, 7, 6];
    orderBaseline = false;
    hidden = true;
    await render("hide mounted rows", 0, 0);
    expect(observed.some((solve) => solve.boxes > 0)).toBe(true);
  } finally {
    root.unmount();
    input.dispose();
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  }
});
