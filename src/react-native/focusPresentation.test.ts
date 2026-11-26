import { createElement as h, useState } from "react";
import { expect, it, vi } from "vitest";
import { RokuKeySession } from "../services/RokuKeySession";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { createNativeRoot } from "./createNativeRoot";
import { NativeInput } from "./NativeInput";
import { Pressable, Text, View } from "./primitives";

const normal = "0x1C2A38FF";
const highlight = "0x87CEFAFF";

async function mountShelf({ intrinsic = false, keepTitle = false, optIn = true } = {}) {
  const scene = new RecordingSceneGraph() as RecordingSceneGraph & {
    sampleFocus?: import("../scene/sceneGraph.types").SceneGraphPort["sampleFocus"];
  };
  const input = new NativeInput();
  const font = scene.create("font");
  const text = {
    prepare() {},
    font: () => font,
    preparedFieldFont: () => font,
    readRetainedFontLineHeight: () => 20,
    metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 7 }),
  };
  const root = createNativeRoot(scene, { viewport: { width: 600, height: 300 }, input, text });
  const focused: number[] = [];
  const pressed: number[] = [];
  const titleFor = (index: number) =>
    `Card ${index + 1}${intrinsic && index ? " with longer text".repeat(8) : ""}`;
  function Shelf() {
    const [selected, select] = useState(0);
    return h(
      View,
      { style: { width: 600, height: 300 } },
      h(
        Text,
        { nativeID: "title", style: { width: 200, ...(intrinsic ? {} : { height: 32 }) } },
        titleFor(selected),
      ),
      ...[0, 1, 2, 3].map((index) =>
        h(Pressable, {
          key: index,
          nativeID: `card-${index}`,
          style: ({ focused }) => ({
            position: "absolute",
            width: 120,
            height: 70,
            left: 140 * index,
            top: 150,
            backgroundColor: focused ? highlight : normal,
          }),
          unstable_tvFocusPresentation: optIn
            ? {
                restingColor: normal,
                focusedColor: highlight,
                label: { nativeID: "title", text: titleFor(index) },
              }
            : undefined,
          onFocus: () => {
            focused.push(index);
            if (!keepTitle) select(index);
          },
          onPress: () => pressed.push(index),
        }),
      ),
    );
  }
  const node = (id: string) => [...scene.nodes.values()].find((native) => native.fields.id === id)!;
  const observe = (index: number) =>
    scene.emit(node(`card-${index}`), "focusedChild", `card-${index}`);
  const keys = new RokuKeySession();
  const send = (key: "right" | "left" | "OK" | "back", down: boolean) =>
    keys.handle(key, down, (event) => input.dispatch(event));
  const press = (key: "right" | "left" | "select") => {
    const nativeKey = key === "select" ? "OK" : key;
    expect(send(nativeKey, true)).toBe(true);
    send(nativeKey, false);
  };
  root.render(h(Shelf));
  await root.whenCommitted();
  observe(0);
  await root.whenCommitted();
  focused.length = 0;
  scene.operations.length = 0;
  return {
    scene,
    input,
    focused,
    pressed,
    press,
    send,
    requests: () =>
      scene.operations
        .filter(({ field, value }) => field === "gainFocus" && value === true)
        .map(({ node }) => scene.nodes.get(node)?.fields.id),
    node,
    observe,
    titleFor,
    dispose() {
      root.unmount();
      input.dispose();
    },
    committed: root.whenCommitted,
    render: root.render,
  };
}

it("presents stable native fields in the focus batch and avoids duplicate writes after observation", async () => {
  const shelf = await mountShelf();
  try {
    const { scene, input, node } = shelf;
    const before = scene.hostCommits;
    shelf.press("right");
    expect(scene.hostCommits - before).toBe(1);
    expect(scene.operations.map(({ node, field, value }) => [node, field, value])).toEqual([
      [node("card-0").children[0].id, "color", normal],
      [node("card-1").children[0].id, "color", highlight],
      [node("title").id, "text", "Card 2"],
      [node("card-1").id, "gainFocus", true],
    ]);
    expect(input.focusedID).toBe("card-0");
    expect(shelf.focused).toEqual([]);
    scene.operations.length = 0;
    shelf.observe(1);
    await shelf.committed();
    expect(shelf.focused).toEqual([1]);
    expect(scene.operations).toEqual([]);
    expect(scene.hostCommits - before).toBe(1);
  } finally {
    shelf.dispose();
  }
});

it("uses ordinary measured layout when a projected title is intrinsic", async () => {
  const shelf = await mountShelf({ intrinsic: true });
  try {
    const title = shelf.node("title");
    const short = Number(title.fields.height);
    shelf.press("right");
    expect(shelf.scene.operations.map((op) => op.field)).toEqual(["gainFocus"]);
    expect(title.fields.text).toBe("Card 1");
    shelf.observe(1);
    await shelf.committed();
    expect(Number(title.fields.height)).toBeGreaterThan(short);
    expect(String(title.fields.text).replaceAll("\n", " ")).toBe(shelf.titleFor(1));
    expect(Number(title.fields.numLines)).toBeGreaterThan(1);
  } finally {
    shelf.dispose();
  }
});

it("reconciles a projected label even when React leaves its text unchanged", async () => {
  const shelf = await mountShelf({ keepTitle: true });
  try {
    shelf.press("right");
    expect(shelf.node("title").fields.text).toBe("Card 2");
    shelf.observe(1);
    await shelf.committed();
    expect(shelf.node("title").fields.text).toBe("Card 1");
  } finally {
    shelf.dispose();
  }
});

it("restores a presentation when no native focus observation arrives", async () => {
  const shelf = await mountShelf();
  vi.useFakeTimers();
  try {
    shelf.press("right");
    expect(shelf.node("title").fields.text).toBe("Card 2");
    await vi.advanceTimersByTimeAsync(300);
    await shelf.committed();
    expect(shelf.node("title").fields.text).toBe("Card 1");
    expect(shelf.node("card-0").children[0].fields.color).toBe(highlight);
    expect(shelf.node("card-1").children[0].fields.color).toBe(normal);
    expect(shelf.focused).toEqual([]);
  } finally {
    shelf.dispose();
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "retries the same native ID after a missed observation (opt-in %s)",
  async (optIn) => {
    const shelf = await mountShelf({ optIn });
    vi.useFakeTimers();
    try {
      shelf.press("right");
      shelf.press("select");
      expect(shelf.requests()).toEqual(["card-1"]);
      await vi.advanceTimersByTimeAsync(300);
      await shelf.committed();
      expect(shelf.node("title").fields.text).toBe("Card 1");
      expect(shelf.pressed).toEqual([]);

      shelf.press("right");
      expect(shelf.requests()).toEqual(["card-1", "card-1"]);
      // The acknowledgement could belong to either of the same-ID requests.
      // An OK down delivered before this observation cannot activate on release.
      shelf.send("OK", true);
      shelf.observe(1);
      shelf.observe(1);
      shelf.send("OK", false);
      expect(shelf.focused).toEqual([1]);
      expect(shelf.pressed).toEqual([]);

      shelf.press("select");
      shelf.send("OK", false);
      expect(shelf.pressed).toEqual([1]);
      shelf.press("left");
      shelf.observe(0);
      expect(shelf.requests()).toEqual(["card-1", "card-1", "card-0"]);
      expect(shelf.focused).toEqual([1, 0]);
    } finally {
      shelf.dispose();
      vi.useRealTimers();
    }
  },
);

it.each([false, true])(
  "accepts a late observation after fallback from a lost gain and observed blur (opt-in %s)",
  async (optIn) => {
    const shelf = await mountShelf({ optIn });
    vi.useFakeTimers();
    try {
      shelf.press("right");
      shelf.scene.emit(shelf.node("card-0"), "focusedChild", null);
      expect(shelf.input.focusedID).toBeNull();
      await vi.advanceTimersByTimeAsync(300);
      shelf.press("right");
      expect(shelf.requests()).toEqual(["card-1", "card-1"]);
      await vi.advanceTimersByTimeAsync(300);
      shelf.send("OK", true);
      shelf.observe(1);
      shelf.observe(1);
      shelf.send("OK", false);
      expect(shelf.pressed).toEqual([]);
      shelf.press("select");
      expect(shelf.pressed).toEqual([1]);
    } finally {
      shelf.dispose();
      vi.useRealTimers();
    }
  },
);

it.each([false, true])(
  "keeps reversal and Select ordered after recovery (opt-in %s)",
  async (optIn) => {
    const shelf = await mountShelf({ optIn });
    vi.useFakeTimers();
    try {
      shelf.press("right");
      shelf.press("select");
      await vi.advanceTimersByTimeAsync(300);
      shelf.observe(1);
      shelf.press("right");
      shelf.press("left");
      shelf.press("select");
      shelf.observe(1); // Duplicate source observation while waiting for card 2.
      expect(shelf.pressed).toEqual([]);
      shelf.observe(2);
      shelf.observe(2);
      expect(shelf.requests()).toEqual(["card-1", "card-2", "card-1"]);
      expect(shelf.pressed).toEqual([]);
      shelf.observe(1);
      shelf.observe(1);
      expect(shelf.focused).toEqual([1, 2, 1]);
      expect(shelf.pressed).toEqual([1]);
    } finally {
      shelf.dispose();
      vi.useRealTimers();
    }
  },
);

it("keeps Select fenced when an earlier destination is observed during a different retry", async () => {
  const shelf = await mountShelf({ optIn: false });
  vi.useFakeTimers();
  try {
    shelf.observe(1);
    shelf.press("right");
    await vi.advanceTimersByTimeAsync(300);
    shelf.press("left");
    expect(shelf.requests()).toEqual(["card-2", "card-0"]);
    shelf.observe(2);
    shelf.send("OK", true);
    shelf.observe(0);
    shelf.send("OK", false);
    expect(shelf.pressed).toEqual([]);
    shelf.press("select");
    expect(shelf.pressed).toEqual([0]);
  } finally {
    shelf.dispose();
    vi.useRealTimers();
  }
});

it("uses native readback after a lost event and rejects a reply superseded by a new request", async () => {
  const shelf = await mountShelf({ optIn: false });
  vi.useFakeTimers();
  const replies: (() => void)[] = [];
  shelf.scene.sampleFocus = (candidates, reply) => {
    expect(candidates.map(({ id }) => shelf.scene.nodes.get(id)?.fields.id)).toEqual([
      "card-1",
      "card-0",
    ]);
    replies.push(() => reply(candidates[0]));
  };
  try {
    shelf.press("right");
    shelf.press("select");
    await vi.advanceTimersByTimeAsync(300);
    shelf.press("right");
    await vi.advanceTimersByTimeAsync(300);
    replies[0]();
    expect(shelf.input.focusedID).toBe("card-0");
    replies[1]();
    expect(shelf.input.focusedID).toBe("card-1");
    expect(shelf.pressed).toEqual([]);
    shelf.press("select");
    expect(shelf.pressed).toEqual([1]);
  } finally {
    shelf.dispose();
    vi.useRealTimers();
  }
});

it("preserves the latest title and highlight through queued reversal and Select", async () => {
  const shelf = await mountShelf();
  try {
    for (const key of ["right", "right", "right", "left", "select"] as const) shelf.press(key);
    expect(shelf.pressed).toEqual([]);
    for (const [observed, requested] of [
      [1, 2],
      [2, 3],
      [3, 2],
      [2, 2],
    ]) {
      shelf.observe(observed);
      await shelf.committed();
      expect(shelf.node("title").fields.text).toBe(shelf.titleFor(requested));
      expect(
        [0, 1, 2, 3].filter(
          (index) => shelf.node(`card-${index}`).children[0].fields.color === highlight,
        ),
      ).toEqual([requested]);
    }
    expect(shelf.focused).toEqual([1, 2, 3, 2]);
    expect(shelf.pressed).toEqual([2]);
  } finally {
    shelf.dispose();
  }
});

it("repairs native fields when a port throws after enqueueing a presentation write", async () => {
  const shelf = await mountShelf();
  const title = shelf.node("title");
  const write = shelf.scene.set.bind(shelf.scene);
  vi.useFakeTimers();
  const set = vi.spyOn(shelf.scene, "set").mockImplementation((ref, name, value) => {
    write(ref, name, value);
    if (ref === title && name === "text" && value === "Card 2")
      throw Error("write outcome uncertain");
  });
  try {
    expect(() => shelf.press("right")).toThrow("write outcome uncertain");
    expect(title.fields.text).toBe("Card 2");
    set.mockRestore();
    await vi.advanceTimersByTimeAsync(300);
    await shelf.committed();
    expect(title.fields.text).toBe("Card 1");
    expect(shelf.node("card-0").children[0].fields.color).toBe(highlight);
    expect(shelf.node("card-1").children[0].fields.color).toBe(normal);
    expect(shelf.focused).toEqual([]);
  } finally {
    set.mockRestore();
    shelf.dispose();
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "retires a pending focus request when Back replaces its route (opt-in %s)",
  async (optIn) => {
    const shelf = await mountShelf({ optIn });
    vi.useFakeTimers();
    const removeBack = shelf.input.addBackHandler(() => {
      shelf.render(h(Pressable, { nativeID: "restored", style: { width: 120, height: 68 } }));
      return true;
    });
    try {
      const oldTitle = shelf.node("title");
      shelf.press("right");
      expect(oldTitle.fields.text).toBe(optIn ? "Card 2" : "Card 1");
      shelf.press("select");
      expect(shelf.input.dispatch({ key: "back", phase: "down" })).toBe(true);
      await shelf.committed();
      expect(shelf.scene.nodes.has(oldTitle.id)).toBe(false);
      const restored = shelf.node("restored");
      shelf.scene.emit(restored, "focusedChild", "restored");
      expect(shelf.input.focusedID).toBe("restored");
      const beforeDeadline = shelf.scene.snapshot();
      await vi.advanceTimersByTimeAsync(300);
      expect(shelf.scene.snapshot()).toEqual(beforeDeadline);
      expect(shelf.focused).toEqual([]);
      expect(shelf.pressed).toEqual([]);
    } finally {
      removeBack();
      shelf.dispose();
      vi.useRealTimers();
    }
  },
);

it.each([false, true])(
  "expires neither input nor native work after unmount (opt-in %s)",
  async (optIn) => {
    const shelf = await mountShelf({ optIn });
    vi.useFakeTimers();
    const destination = shelf.node("card-1");
    const probe = vi.fn();
    shelf.scene.sampleFocus = probe;
    try {
      shelf.press("right");
      shelf.send("OK", true);
      shelf.dispose();
      const retired = shelf.scene.snapshot();
      await vi.advanceTimersByTimeAsync(300);
      expect(shelf.scene.nodes.has(destination.id)).toBe(false);
      expect(probe).not.toHaveBeenCalled();
      expect(shelf.scene.snapshot()).toEqual(retired);
      expect(shelf.focused).toEqual([]);
      expect(shelf.pressed).toEqual([]);
    } finally {
      shelf.dispose();
      vi.useRealTimers();
    }
  },
);
