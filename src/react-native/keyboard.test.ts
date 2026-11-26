import { createElement, createRef, Fragment } from "react";
import { expect, it } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { Keyboard, DeviceEventEmitter } from "./nativeModules";
import { TextInput, type NativeTextInputHandle } from "./textInput";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import type { TextEntryRequest } from "../services/DeviceServices";

function fixture() {
  const scene = new RecordingSceneGraph();
  const sessions: {
    request: TextEntryRequest;
    finish(value: string | null): void;
    observed(value: boolean): void;
    closes: number;
  }[] = [];
  const root = createNativeRoot(scene, {
    viewport: { width: 640, height: 360 },
    text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: (s: string) => s.length * 8 }) },
    services: {
      storage: { read: async () => null, write: async () => {} },
      randomUUID: () => "fixture",
      randomBytes: (n) => new Uint8Array(n),
      textEntry: {
        open(request) {
          let finish!: (value: string | null) => void, observed!: (value: boolean) => void;
          const result = new Promise<string | null>((resolve) => {
            finish = resolve;
          });
          const closed = new Promise<boolean>((resolve) => {
            observed = resolve;
          });
          const item = { request, finish, observed, closes: 0 };
          sessions.push(item);
          return {
            result,
            closed,
            close() {
              item.closes++;
              finish(null);
            },
          };
        },
      },
    },
  });
  return { root, scene, sessions };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

it("dismisses the focused editor but emits hide only after an observed close", async () => {
  const f = fixture(),
    ref = createRef<NativeTextInputHandle>();
  let hides = 0,
    blurs = 0;
  const subscription = Keyboard.addListener("keyboardDidHide", () => hides++);
  try {
    f.root.render(createElement(TextInput, { ref, onBlur: () => blurs++ }));
    await f.root.whenCommitted();
    ref.current!.focus();
    DeviceEventEmitter.emit("keyboardDidHide");
    expect(hides).toBe(0);
    Keyboard.dismiss();
    Keyboard.dismiss();
    expect(f.sessions[0].closes).toBe(1);
    expect(ref.current!.isFocused()).toBe(false);
    await settle();
    expect(hides).toBe(0);
    expect(blurs).toBe(1);
    f.sessions[0].observed(true);
    await settle();
    expect(hides).toBe(1);
    subscription.remove();
    subscription.remove();
    ref.current!.focus();
    f.sessions[1].finish(null);
    f.sessions[1].observed(true);
    await settle();
    expect(hides).toBe(1);
  } finally {
    subscription.remove();
    f.root.unmount();
  }
  expect(f.scene.listenerCount).toBe(0);
});

it("delivers accepted text before hide observers can blur the field", async () => {
  const f = fixture(),
    ref = createRef<NativeTextInputHandle>(),
    events: string[] = [];
  const subscription = Keyboard.addListener("keyboardDidHide", () => {
    events.push("hide");
    if (ref.current?.isFocused()) ref.current.blur();
  });
  try {
    f.root.render(
      createElement(TextInput, {
        ref,
        onChangeText: (text) => events.push(text),
        onSubmitEditing: () => events.push("submit"),
        onBlur: () => events.push("blur"),
      }),
    );
    await f.root.whenCommitted();
    ref.current!.focus();
    f.sessions[0].observed(true);
    await settle();
    expect(events).toEqual([]);
    f.sessions[0].finish("Accepted");
    await settle();
    expect(events).toEqual(["Accepted", "submit", "blur", "hide"]);
    expect(f.sessions[0].closes).toBe(0);
  } finally {
    subscription.remove();
    f.root.unmount();
  }
});

it("preserves a newer focus requested reentrantly while the previous editor blurs", async () => {
  const f = fixture(),
    first = createRef<NativeTextInputHandle>(),
    second = createRef<NativeTextInputHandle>(),
    third = createRef<NativeTextInputHandle>();
  try {
    f.root.render(
      createElement(
        Fragment,
        {},
        createElement(TextInput, { ref: first, onBlur: () => third.current?.focus() }),
        createElement(TextInput, { ref: second }),
        createElement(TextInput, { ref: third }),
      ),
    );
    await f.root.whenCommitted();
    first.current!.focus();
    second.current!.focus();
    expect(f.sessions).toHaveLength(2);
    expect(second.current!.isFocused()).toBe(false);
    expect(third.current!.isFocused()).toBe(true);
    Keyboard.dismiss();
    expect(f.sessions[1].closes).toBe(1);
  } finally {
    f.root.unmount();
  }
});

it("fences an old dialog's hide across replacement and retires keyboard ownership with its root", async () => {
  const f = fixture(),
    first = createRef<NativeTextInputHandle>(),
    second = createRef<NativeTextInputHandle>();
  let hides = 0;
  const subscription = Keyboard.addListener("keyboardDidHide", () => hides++);
  try {
    f.root.render(
      createElement(
        Fragment,
        {},
        createElement(TextInput, { ref: first }),
        createElement(TextInput, { ref: second }),
      ),
    );
    await f.root.whenCommitted();
    first.current!.focus();
    second.current!.focus();
    expect(f.sessions[0].closes).toBe(1);
    expect(first.current!.isFocused()).toBe(false);
    f.sessions[0].observed(true);
    await settle();
    expect(hides).toBe(0);
    expect(second.current!.isFocused()).toBe(true);
    Keyboard.dismiss();
    f.sessions[1].observed(false);
    await settle();
    expect(hides).toBe(0);
    second.current!.focus();
    f.root.unmount();
    expect(f.sessions[2].closes).toBe(1);
    f.sessions[2].observed(true);
    await settle();
    expect(hides).toBe(0);
    Keyboard.dismiss();
    expect(f.sessions[2].closes).toBe(1);
    expect(() => Keyboard.addListener("keyboardWillShow", () => {})).toThrow("keyboardDidHide");
  } finally {
    subscription.remove();
    f.root.unmount();
  }
  expect(f.scene.nodes.size).toBe(1);
});
