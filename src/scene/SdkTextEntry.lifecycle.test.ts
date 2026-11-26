import { createElement as h, createRef, Fragment, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { DomNode } from "@roku-sdk/interfaces";
const bridge = vi.hoisted(() => ({ fields: new Map<string, unknown>() }));
vi.mock("@roku-sdk/common/transaction", () => ({ transactionManager: { startTransaction() {} } }));
vi.mock("@roku-sdk/solid", () => ({
  tmTransaction: {
    setProperty(_node: unknown, field: string, value: unknown) {
      bridge.fields.set(field, value);
    },
  },
}));
import { SdkTextEntry } from "./SdkTextEntry";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { createNativeRoot } from "../react-native/createNativeRoot";
import { TextInput, type NativeTextInputHandle } from "../react-native/textInput";
import { Keyboard } from "../react-native/keyboard";
import { NativeInput } from "../react-native/NativeInput";
import { Pressable, Text } from "../react-native/primitives";
import type { NativeViewHandle } from "../react-native/nativeViewHandle";

afterEach(() => {
  bridge.fields.clear();
  vi.useRealTimers();
});
const request = () => JSON.parse(bridge.fields.get("textEntryRequest") as string);
function fixture() {
  const port = new SdkTextEntry({} as DomNode),
    scene = new RecordingSceneGraph();
  const reply = bridge.fields.get("onTextEntryReply") as (packet: string) => void;
  const root = createNativeRoot(scene, {
    strictMode: true,
    viewport: { width: 640, height: 360 },
    textEntry: port,
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 7 }),
    },
  });
  return {
    root,
    scene,
    port,
    reply(value: object) {
      reply(JSON.stringify({ version: 2, ...value }));
    },
    async settle() {
      await Promise.resolve();
      await root.whenCommitted();
      await Promise.resolve();
    },
    dispose() {
      root.unmount();
      port.dispose();
      expect(scene.nodes.size).toBe(1);
      expect(scene.listenerCount).toBe(0);
    },
  };
}

it("reconciles actual SDK revisions through controlled React edits and fences a canceled predecessor's close", async () => {
  const f = fixture(),
    first = createRef<NativeTextInputHandle>(),
    second = createRef<NativeTextInputHandle>();
  const edits: string[] = [],
    submissions: string[] = [],
    selections: unknown[] = [],
    hides: string[] = [];
  const subscription = Keyboard.addListener("keyboardDidHide", () => hides.push("hide"));
  function App() {
    const [value, setValue] = useState("seed");
    return h(
      Fragment,
      null,
      h(TextInput, {
        ref: first,
        value,
        onChangeText(text) {
          edits.push(text);
          setValue(text.toUpperCase());
        },
        onSubmitEditing: (event) => submissions.push(event.nativeEvent.text),
        onSelectionChange: (event) => selections.push(event.nativeEvent.selection),
      }),
      h(TextInput, {
        ref: second,
        defaultValue: "successor",
        onSubmitEditing: (event) => submissions.push(event.nativeEvent.text),
      }),
    );
  }
  try {
    f.root.render(h(App));
    await f.settle();
    first.current!.focus();
    const firstId = request().id;
    f.reply({ id: firstId, draft: true, text: "draft", prefix: "dra", revision: 0, sequence: 1 });
    await f.settle();
    const update = request();
    expect(update).toMatchObject({ id: firstId, update: true, text: "DRAFT", revision: 1 });
    expect(edits).toEqual(["draft"]);
    expect(selections).toEqual([]);
    f.reply({ id: firstId, caret: true, text: "draft", prefix: "dra", revision: 0, sequence: 2 });
    expect(selections).toEqual([]);
    second.current!.focus();
    const secondId = request().id;
    expect(secondId).toBeGreaterThan(firstId);
    expect(first.current!.isFocused()).toBe(false);
    expect(second.current!.isFocused()).toBe(true);
    // A native acknowledgement closes the old dialog but cannot hide the new one
    // or submit the old, pre-correction draft.
    f.reply({ id: firstId, text: "draft", closed: true, revision: 0 });
    await f.settle();
    expect(submissions).toEqual([]);
    expect(hides).toEqual([]);
    expect(second.current!.isFocused()).toBe(true);
    f.reply({ id: firstId, draft: true, text: "late", revision: 1, sequence: 3 });
    expect(edits).toEqual(["draft"]);
    f.reply({ id: secondId, text: "accepted", closed: true, revision: 0 });
    await f.settle();
    expect(submissions).toEqual(["accepted"]);
    expect(hides).toEqual(["hide"]);
    expect(second.current!.isFocused()).toBe(false);
  } finally {
    subscription.remove();
    f.dispose();
  }
});

it("retires queued React editors on missing SDK close acknowledgement and restores admission only after both acknowledgements", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture(),
    first = createRef<NativeTextInputHandle>(),
    second = createRef<NativeTextInputHandle>();
  const hides: string[] = [],
    submissions: string[] = [];
  const subscription = Keyboard.addListener("keyboardDidHide", () => hides.push("hide"));
  try {
    f.root.render(
      h(
        Fragment,
        null,
        h(TextInput, { ref: first }),
        h(TextInput, {
          ref: second,
          onSubmitEditing: (event) => submissions.push(event.nativeEvent.text),
        }),
      ),
    );
    await f.settle();
    first.current!.focus();
    const firstId = request().id;
    second.current!.focus();
    const secondId = request().id;
    expect(second.current!.isFocused()).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    await f.settle();
    expect(second.current!.isFocused()).toBe(false);
    expect(hides).toEqual([]);
    expect(() => second.current!.focus()).toThrow("unavailable");
    f.reply({ id: firstId, text: null, closed: true });
    await vi.advanceTimersByTimeAsync(10000);
    await f.settle();
    expect(() => second.current!.focus()).toThrow("unavailable");
    f.reply({ id: secondId, text: null, closed: true });
    await f.settle();
    expect(hides).toEqual([]);
    second.current!.focus();
    expect(request().id).toBeGreaterThan(secondId);
    expect(second.current!.isFocused()).toBe(true);
    expect(submissions).toEqual([]);
  } finally {
    subscription.remove();
    f.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["press-in", "remote-observer"] as const)(
  "cancels an activation before SDK editor handoff from %s instead of firing background long-press work",
  async (origin) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const port = new SdkTextEntry({} as DomNode),
      scene = new RecordingSceneGraph(),
      input = new NativeInput();
    const editor = createRef<NativeTextInputHandle>(),
      longPress = vi.fn(),
      release = vi.fn();
    const root = createNativeRoot(scene, {
      viewport: { width: 640, height: 360 },
      input,
      textEntry: port,
      text: {
        prepare() {},
        metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 7 }),
      },
    });
    try {
      root.render(
        h(
          Fragment,
          null,
          h(Pressable, {
            nativeID: "open-editor",
            onPressIn: origin === "press-in" ? () => editor.current!.focus() : undefined,
            onPressOut: release,
            onLongPress: longPress,
            delayLongPress: 500,
            style: { width: 100, height: 40 },
          }),
          h(TextInput, { ref: editor }),
        ),
      );
      await root.whenCommitted();
      const button = [...scene.nodes.values()].find((node) => node.fields.id === "open-editor")!;
      if (origin === "remote-observer")
        input.subscribe((event) => {
          if (event.eventType === "select" && event.eventKeyAction === 0) editor.current!.focus();
        });
      const laterEvents: string[] = [];
      if (origin === "remote-observer")
        input.subscribe((event) => laterEvents.push(event.eventType));
      scene.emit(button, "focusedChild", "open-editor");
      input.dispatch({ key: "select", phase: "down" });
      expect(editor.current!.isFocused()).toBe(true);
      expect(request().title).toBe("Enter text");
      // No native key-up or focus-loss acknowledgement has arrived yet.
      await vi.advanceTimersByTimeAsync(600);
      expect(longPress).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(origin === "press-in" ? 1 : 0);
      if (origin === "remote-observer") expect(laterEvents).toEqual(["cancel"]);
    } finally {
      root.unmount();
      port.dispose();
      input.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  },
);

it("keeps an editor admitted reentrantly by press-out ahead of the older focus attempt", async () => {
  const port = new SdkTextEntry({} as DomNode),
    scene = new RecordingSceneGraph(),
    input = new NativeInput();
  const first = createRef<NativeTextInputHandle>(),
    newer = createRef<NativeTextInputHandle>();
  const root = createNativeRoot(scene, {
    viewport: { width: 640, height: 360 },
    input,
    textEntry: port,
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 7 }),
    },
  });
  try {
    root.render(
      h(
        Fragment,
        null,
        h(Pressable, {
          nativeID: "open",
          onPressIn: () => first.current!.focus(),
          onPressOut: () => newer.current!.focus(),
        }),
        h(TextInput, { ref: first, accessibilityLabel: "Older" }),
        h(TextInput, { ref: newer, accessibilityLabel: "Newer" }),
      ),
    );
    await root.whenCommitted();
    const button = [...scene.nodes.values()].find((node) => node.fields.id === "open")!;
    scene.emit(button, "focusedChild", "open");
    input.dispatch({ key: "select", phase: "down" });
    expect(request()).toMatchObject({ title: "Newer", id: 1 });
    expect(first.current!.isFocused()).toBe(false);
    expect(newer.current!.isFocused()).toBe(true);
  } finally {
    root.unmount();
    port.dispose();
    input.dispose();
  }
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
});

it("fences a pending background focus request when an editor opens before font completion", async () => {
  const port = new SdkTextEntry({} as DomNode),
    scene = new RecordingSceneGraph(),
    input = new NativeInput();
  const target = createRef<NativeViewHandle>(),
    editor = createRef<NativeTextInputHandle>();
  let pending: Promise<void> | undefined, finish!: () => void;
  const root = createNativeRoot(scene, {
    viewport: { width: 640, height: 360 },
    input,
    textEntry: port,
    text: {
      prepare: () => pending,
      metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 7 }),
    },
  });
  const render = () =>
    root.render(
      h(
        Fragment,
        null,
        h(Pressable, { nativeID: "background", ref: target }, h(Text, null, "Background")),
        h(TextInput, { ref: editor }),
      ),
    );
  try {
    render();
    await root.whenCommitted();
    pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    render();
    target.current!.requestTVFocus();
    editor.current!.focus();
    expect(editor.current!.isFocused()).toBe(true);
    finish();
    await root.whenCommitted();
    await Promise.resolve();
    expect(scene.operations.filter((operation) => operation.field === "gainFocus")).toEqual([]);
  } finally {
    root.unmount();
    port.dispose();
    input.dispose();
  }
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
});
