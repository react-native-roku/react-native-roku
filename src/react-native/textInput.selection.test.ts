import { createElement, createRef } from "react";
import { expect, it } from "vitest";
import { TextInput, type NativeTextInputHandle } from "./textInput";
import { createNativeRoot } from "./createNativeRoot";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import type { TextEntryPort } from "../services/DeviceServices";

type Selection = { start: number; end: number };
function fixture({
  replay,
  failRemoval = false,
}: { replay?: Selection; failRemoval?: boolean } = {}) {
  const scene = new RecordingSceneGraph(),
    ref = createRef<NativeTextInputHandle>();
  const editors: {
    textListeners: Set<(text: string) => void>;
    selectionListeners: Set<(selection: Selection) => void>;
    lateSelection?: (selection: Selection) => void;
    closes: number;
    emit(selection: Selection): void;
  }[] = [];
  const port: TextEntryPort = {
    open() {
      let finish!: (text: string | null) => void;
      const result = new Promise<string | null>((resolve) => {
        finish = resolve;
      });
      const editor: (typeof editors)[number] = {
        textListeners: new Set(),
        selectionListeners: new Set(),
        closes: 0,
        emit(selection) {
          for (const listener of [...editor.selectionListeners])
            if (editor.selectionListeners.has(listener)) listener(selection);
        },
      };
      editors.push(editor);
      return {
        result,
        setText: () => true,
        subscribeText(listener) {
          editor.textListeners.add(listener);
          return () => {
            editor.textListeners.delete(listener);
            if (failRemoval) throw Error("text removal failed");
          };
        },
        subscribeSelection(listener) {
          editor.selectionListeners.add(listener);
          editor.lateSelection = listener;
          if (replay) listener(replay);
          return () => {
            editor.selectionListeners.delete(listener);
          };
        },
        close() {
          editor.closes++;
          finish(null);
        },
      };
    },
  };
  const root = createNativeRoot(scene, {
    strictMode: true,
    viewport: { width: 800, height: 600 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (text: string) => text.length * 7 }),
    },
    textEntry: port,
  });
  return { scene, ref, root, editors };
}

it("delivers observed ranges to the current RN handler without inferring a position or emitting text changes", async () => {
  const f = fixture(),
    first: Selection[] = [],
    second: Selection[] = [],
    changes: string[] = [];
  const render = (target: Selection[]) =>
    f.root.render(
      createElement(TextInput, {
        ref: f.ref,
        defaultValue: "ABCD",
        onChangeText: (text) => changes.push(text),
        onSelectionChange: (event) => target.push(event.nativeEvent.selection),
      }),
    );
  try {
    render(first);
    await f.root.whenCommitted();
    f.ref.current!.focus();
    expect(first).toEqual([]);
    for (const selection of [
      { start: -1, end: 0 },
      { start: 3, end: 2 },
      { start: 0, end: 5 },
      { start: 0.5, end: 2 },
    ])
      f.editors[0].emit(selection);
    f.editors[0].emit({ start: 1, end: 3 });
    f.editors[0].emit({ start: 1, end: 3 });
    expect(first).toEqual([{ start: 1, end: 3 }]);
    render(second);
    await f.root.whenCommitted();
    f.editors[0].emit({ start: 2, end: 2 });
    expect(second).toEqual([{ start: 2, end: 2 }]);
    expect(changes).toEqual([]);
    expect(f.ref.current!.isFocused()).toBe(true);
  } finally {
    f.root.unmount();
    await f.root.whenCommitted();
  }
  expect(f.editors[0].selectionListeners.size).toBe(0);
  expect(f.editors[0].textListeners.size).toBe(0);
  expect(f.editors[0].closes).toBe(1);
  expect(f.scene.listenerCount).toBe(0);
});

it("retires both subscriptions when a synchronous selection replay blurs before registration returns", async () => {
  const f = fixture({ replay: { start: 2, end: 2 } }),
    positions: Selection[] = [];
  try {
    f.root.render(
      createElement(TextInput, {
        ref: f.ref,
        defaultValue: "ABCD",
        onSelectionChange: (event) => {
          positions.push(event.nativeEvent.selection);
          f.ref.current!.blur();
        },
      }),
    );
    await f.root.whenCommitted();
    f.ref.current!.focus();
    expect(positions).toEqual([{ start: 2, end: 2 }]);
    expect(f.ref.current!.isFocused()).toBe(false);
    expect(f.editors[0].selectionListeners.size).toBe(0);
    expect(f.editors[0].textListeners.size).toBe(0);
    expect(f.editors[0].closes).toBe(1);
    f.editors[0].lateSelection!({ start: 1, end: 1 });
    expect(positions).toHaveLength(1);
  } finally {
    f.root.unmount();
    await f.root.whenCommitted();
  }
});

it("fences stale callbacks after blur, replacement and unmount", async () => {
  const f = fixture(),
    positions: Selection[] = [];
  f.root.render(
    createElement(TextInput, {
      ref: f.ref,
      defaultValue: "ABCD",
      onSelectionChange: (event) => positions.push(event.nativeEvent.selection),
    }),
  );
  await f.root.whenCommitted();
  f.ref.current!.focus();
  const old = f.editors[0];
  old.emit({ start: 1, end: 1 });
  f.ref.current!.blur();
  f.ref.current!.focus();
  old.lateSelection!({ start: 2, end: 2 });
  f.editors[1].emit({ start: 3, end: 3 });
  f.root.unmount();
  await f.root.whenCommitted();
  f.editors[1].lateSelection!({ start: 4, end: 4 });
  expect(positions).toEqual([
    { start: 1, end: 1 },
    { start: 3, end: 3 },
  ]);
  expect(f.editors.map((editor) => editor.selectionListeners.size)).toEqual([0, 0]);
  expect(f.editors.map((editor) => editor.closes)).toEqual([1, 1]);
  expect(f.scene.listenerCount).toBe(0);
});

it("drains every observation remover and closes the editor when one remover throws", async () => {
  const f = fixture({ failRemoval: true });
  try {
    f.root.render(createElement(TextInput, { ref: f.ref, defaultValue: "ABCD" }));
    await f.root.whenCommitted();
    f.ref.current!.focus();
    expect(() => f.ref.current!.blur()).toThrow("text removal failed");
    expect(f.editors[0].textListeners.size).toBe(0);
    expect(f.editors[0].selectionListeners.size).toBe(0);
    expect(f.editors[0].closes).toBe(1);
  } finally {
    f.root.unmount();
    await f.root.whenCommitted();
  }
});
