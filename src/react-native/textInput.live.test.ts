import { createElement, createRef, useState } from "react";
import { expect, it } from "vitest";
import { TextInput, type NativeTextInputHandle } from "./textInput";
import { createNativeRoot } from "./createNativeRoot";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import type { TextEntryPort } from "../services/DeviceServices";

function fixture(replay?: string) {
  const scene = new RecordingSceneGraph(),
    ref = createRef<NativeTextInputHandle>();
  const editors: {
    text: string;
    listeners: Set<(text: string) => void>;
    writes: string[];
    closes: number;
    finish(text: string | null): void;
    emit(text: string): void;
  }[] = [];
  const port: TextEntryPort = {
    open(request) {
      let finish!: (text: string | null) => void;
      const result = new Promise<string | null>((resolve) => {
        finish = resolve;
      });
      const editor = {
        text: request.text,
        listeners: new Set<(text: string) => void>(),
        writes: [] as string[],
        closes: 0,
        finish,
        emit(text: string) {
          editor.text = text;
          for (const listener of [...editor.listeners])
            if (editor.listeners.has(listener)) listener(text);
        },
      };
      editors.push(editor);
      return {
        result,
        setText(text) {
          editor.text = text;
          editor.writes.push(text);
          return true;
        },
        subscribeText(listener) {
          editor.listeners.add(listener);
          if (replay !== undefined) {
            editor.text = replay;
            listener(replay);
          }
          return () => {
            editor.listeners.delete(listener);
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

for (const mode of ["format", "reject"] as const) {
  it(`reconciles a controlled ${mode} after each observed draft without fabricating programmatic changes`, async () => {
    const f = fixture(),
      changes: string[] = [],
      submits: string[] = [];
    let blurs = 0;
    function App() {
      const [value, setValue] = useState("seed");
      return createElement(TextInput, {
        ref: f.ref,
        value,
        onChangeText(text) {
          changes.push(text);
          if (mode === "format") setValue(text.toUpperCase());
        },
        onSubmitEditing: (event) => submits.push(event.nativeEvent.text),
        onBlur: () => {
          blurs++;
        },
      });
    }
    try {
      f.root.render(createElement(App));
      await f.root.whenCommitted();
      f.ref.current!.focus();
      f.editors[0].emit("changed");
      await f.root.whenCommitted();
      const controlled = mode === "format" ? "CHANGED" : "seed";
      expect(f.editors[0].text).toBe(controlled);
      expect(changes).toEqual(["changed"]);
      expect(submits).toEqual([]);
      expect(f.ref.current!.isFocused()).toBe(true);
      f.editors[0].finish(controlled);
      await Promise.resolve();
      await f.root.whenCommitted();
      expect(changes).toEqual(["changed"]);
      expect(submits).toEqual([controlled]);
      expect(blurs).toBe(1);
      expect(f.editors[0].listeners.size).toBe(0);
    } finally {
      f.root.unmount();
    }
    expect(f.scene.listenerCount).toBe(0);
    expect(f.scene.nodes.size).toBe(1);
  });
}

it("publishes uncontrolled edits before Cancel, keeps edited text, and fences replaced sessions", async () => {
  const f = fixture(),
    changes: string[] = [],
    submits: string[] = [];
  const render = (key: string) =>
    f.root.render(
      createElement(TextInput, {
        key,
        ref: f.ref,
        defaultValue: "seed",
        onChangeText: (text) => changes.push(text),
        onSubmitEditing: (event) => submits.push(event.nativeEvent.text),
      }),
    );
  try {
    render("first");
    await f.root.whenCommitted();
    f.ref.current!.focus();
    f.editors[0].emit("draft");
    await f.root.whenCommitted();
    expect(changes).toEqual(["draft"]);
    expect([...f.scene.nodes.values()].some((node) => node.fields.text === "draft")).toBe(true);
    f.editors[0].finish(null);
    await Promise.resolve();
    await f.root.whenCommitted();
    expect(submits).toEqual([]);
    expect(f.editors[0].listeners.size).toBe(0);
    f.ref.current!.focus();
    expect(f.editors[1].text).toBe("draft");
    render("replacement");
    await f.root.whenCommitted();
    f.editors[1].emit("retired");
    f.editors[1].finish("retired");
    await Promise.resolve();
    expect(changes).toEqual(["draft"]);
    expect(f.editors[1].listeners.size).toBe(0);
    expect(f.editors[1].closes).toBe(1);
  } finally {
    f.root.unmount();
  }
});

it("cleans a synchronous draft replay that retires its input before subscription returns", async () => {
  const f = fixture("observed early"),
    changes: string[] = [],
    submits: string[] = [];
  try {
    f.root.render(
      createElement(TextInput, {
        ref: f.ref,
        onChangeText(text) {
          changes.push(text);
          f.root.unmount();
        },
        onSubmitEditing: (event) => submits.push(event.nativeEvent.text),
      }),
    );
    await f.root.whenCommitted();
    f.ref.current!.focus();
    expect(changes).toEqual(["observed early"]);
    expect(f.editors[0].listeners.size).toBe(0);
    expect(f.editors[0].closes).toBe(1);
    f.editors[0].emit("late");
    f.editors[0].finish("late");
    await Promise.resolve();
    expect(changes).toEqual(["observed early"]);
    expect(submits).toEqual([]);
    expect(f.scene.nodes.size).toBe(1);
    expect(f.scene.listenerCount).toBe(0);
  } finally {
    f.root.unmount();
  }
});
