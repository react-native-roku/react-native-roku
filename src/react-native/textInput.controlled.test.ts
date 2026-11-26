import { createElement, createRef } from "react";
import { expect, it } from "vitest";
import { TextInput, type NativeTextInputHandle } from "./textInput";
import { createNativeRoot } from "./createNativeRoot";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

for (const operation of ["controlled reset", "imperative clear"] as const) {
  it(`synchronizes ${operation} to the active editor without closing it`, async () => {
    const scene = new RecordingSceneGraph(),
      ref = createRef<NativeTextInputHandle>();
    let editor = "",
      closes = 0,
      opens = 0;
    const changes: string[] = [];
    const root = createNativeRoot(scene, {
      viewport: { width: 800, height: 600 },
      text: {
        prepare() {},
        metrics: () => ({ lineHeight: 20, width: (s: string) => s.length * 7 }),
      },
      textEntry: {
        open(request) {
          editor = request.text;
          opens++;
          return {
            result: new Promise<string | null>(() => {}),
            setText(text: string) {
              editor = text;
              return true;
            },
            close() {
              closes++;
            },
          };
        },
      },
    });
    try {
      const render = (value: string) =>
        root.render(
          createElement(TextInput, {
            ref,
            ...(operation === "controlled reset" ? { value } : { defaultValue: value }),
            onChangeText: (s) => changes.push(s),
          }),
        );
      render("Original");
      await root.whenCommitted();
      ref.current!.focus();
      expect(editor).toBe("Original");
      if (operation === "controlled reset") render("Reset");
      else ref.current!.clear();
      await root.whenCommitted();
      expect(editor).toBe(operation === "controlled reset" ? "Reset" : "");
      expect(opens).toBe(1);
      expect(closes).toBe(0);
      expect(ref.current!.isFocused()).toBe(true);
      expect(changes).toEqual([]);
    } finally {
      root.unmount();
    }
  });
}

it("fences a result whose editor closed before the new controlled value arrived", async () => {
  const scene = new RecordingSceneGraph(),
    ref = createRef<NativeTextInputHandle>();
  let finish!: (text: string | null) => void,
    closes = 0;
  const changes: string[] = [];
  const root = createNativeRoot(scene, {
    viewport: { width: 800, height: 600 },
    text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: (s: string) => s.length * 7 }) },
    textEntry: {
      open() {
        return {
          result: new Promise<string | null>((resolve) => {
            finish = resolve;
          }),
          setText: () => false,
          close() {
            closes++;
          },
        };
      },
    },
  });
  const render = (value: string) =>
    root.render(
      createElement(TextInput, { ref, value, onChangeText: (text) => changes.push(text) }),
    );
  try {
    render("Original");
    await root.whenCommitted();
    ref.current!.focus();
    render("Reset");
    await root.whenCommitted();
    finish("old submission");
    await Promise.resolve();
    await root.whenCommitted();
    expect(changes).toEqual([]);
    expect(closes).toBe(1);
    expect(ref.current!.isFocused()).toBe(false);
    expect([...scene.nodes.values()].some((node) => node.fields.text === "Reset")).toBe(true);
  } finally {
    root.unmount();
  }
});

it("updates an imperative draft and retains it across unrelated renders, without fabricating input events", async () => {
  const scene = new RecordingSceneGraph(),
    ref = createRef<NativeTextInputHandle>();
  const updates: string[] = [],
    changes: string[] = [];
  const root = createNativeRoot(scene, {
    viewport: { width: 800, height: 600 },
    text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: (s: string) => s.length * 7 }) },
    textEntry: {
      open() {
        return {
          result: new Promise<string | null>(() => {}),
          setText(text) {
            updates.push(text);
            return true;
          },
          close() {},
        };
      },
    },
  });
  const render = () =>
    root.render(
      createElement(TextInput, {
        ref,
        value: "Controlled",
        onChangeText: (text) => changes.push(text),
      }),
    );
  try {
    render();
    await root.whenCommitted();
    ref.current!.focus();
    ref.current!.setNativeProps({ text: "imperative draft" });
    await root.whenCommitted();
    render();
    await root.whenCommitted();
    expect(updates).toEqual(["imperative draft"]);
    expect(changes).toEqual([]);
    expect(ref.current!.isFocused()).toBe(true);
  } finally {
    root.unmount();
  }
});

for (const failure of ["unsupported", "transport"] as const) {
  it(`retires an editor after an ${failure} update rather than submitting its previous draft`, async () => {
    const scene = new RecordingSceneGraph(),
      ref = createRef<NativeTextInputHandle>();
    let finish!: (text: string | null) => void,
      closes = 0;
    const changes: string[] = [];
    const root = createNativeRoot(scene, {
      viewport: { width: 800, height: 600 },
      text: {
        prepare() {},
        metrics: () => ({ lineHeight: 20, width: (s: string) => s.length * 7 }),
      },
      textEntry: {
        open() {
          return {
            result: new Promise<string | null>((resolve) => {
              finish = resolve;
            }),
            ...(failure === "transport"
              ? {
                  setText: () => {
                    throw Error("update failed");
                  },
                }
              : {}),
            close() {
              closes++;
            },
          };
        },
      },
    });
    try {
      root.render(
        createElement(TextInput, {
          ref,
          defaultValue: "Original",
          onChangeText: (text) => changes.push(text),
        }),
      );
      await root.whenCommitted();
      ref.current!.focus();
      expect(() => ref.current!.clear()).toThrow(
        failure === "transport" ? "update failed" : "cannot update",
      );
      finish("late previous draft");
      await Promise.resolve();
      await root.whenCommitted();
      expect(changes).toEqual([]);
      expect(closes).toBe(1);
      expect(ref.current!.isFocused()).toBe(false);
    } finally {
      root.unmount();
    }
  });
}
