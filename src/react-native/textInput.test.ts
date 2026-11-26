import { createElement, createRef } from "react";
import { expect, it } from "vitest";
import { TextInput, type NativeTextInputHandle } from "./textInput";
import { createNativeRoot } from "./createNativeRoot";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { NativeSystemState } from "./NativeSystemState";

it("updates an imperative read-only clock label and masks secure values", async () => {
  const scene = new RecordingSceneGraph(),
    ref = createRef<NativeTextInputHandle>();
  const root = createNativeRoot(scene, {
    viewport: { width: 800, height: 600 },
    text: {
      prepare() {},
      metrics: () => ({
        lineHeight: 20,
        width: (value: string) => value.length * 7,
      }),
    },
  });
  root.render(
    createElement(TextInput, {
      ref,
      editable: false,
      defaultValue: "0:00",
      style: { width: 100, height: 30 },
    }),
  );
  await root.whenCommitted();
  ref.current!.setNativeProps({ text: "1:20" });
  await root.whenCommitted();
  expect([...scene.nodes.values()].some((node) => node.fields.text === "1:20")).toBe(true);
  root.render(createElement(TextInput, { ref, secureTextEntry: true, value: "secret" }));
  await root.whenCommitted();
  expect([...scene.nodes.values()].some((node) => node.fields.text === "••••••")).toBe(true);
  expect(() => ref.current!.focus()).toThrow("native keyboard port");
  root.unmount();
  expect(scene.nodes.size).toBe(1);
});

it("uses the admitted keyboard and fences canceled or unmounted results", async () => {
  const scene = new RecordingSceneGraph(),
    ref = createRef<NativeTextInputHandle>();
  const changes: string[] = [],
    submitted: string[] = [],
    requests: unknown[] = [];
  let finish!: (value: string | null) => void;
  let closes = 0,
    blurs = 0;
  const root = createNativeRoot(scene, {
    viewport: { width: 800, height: 600 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 7 }),
    },
    services: {
      storage: { read: async () => null, write: async () => {} },
      randomUUID: () => "fixture",
      randomBytes: (length) => new Uint8Array(length),
      textEntry: {
        open(request) {
          requests.push(request);
          return {
            result: new Promise((resolve) => {
              finish = resolve;
            }),
            close() {
              closes++;
            },
          };
        },
      },
    },
  });
  try {
    root.render(
      createElement(TextInput, {
        ref,
        defaultValue: "before",
        accessibilityLabel: "Name",
        maxLength: 5,
        onChangeText: (text) => changes.push(text),
        onSubmitEditing: (event) => submitted.push(event.nativeEvent.text),
        onBlur: () => {
          blurs++;
        },
      }),
    );
    await root.whenCommitted();
    ref.current!.focus();
    ref.current!.focus();
    expect(requests).toHaveLength(1);
    expect(ref.current!.isFocused()).toBe(true);
    finish("Guest!");
    await Promise.resolve();
    await root.whenCommitted();
    expect(changes).toEqual(["Guest"]);
    expect(submitted).toEqual(["Guest"]);
    expect(blurs).toBe(1);
    expect(ref.current!.isFocused()).toBe(false);
    expect([...scene.nodes.values()].some((node) => node.fields.text === "Guest")).toBe(true);
    ref.current!.focus();
    ref.current!.blur();
    finish("canceled");
    await Promise.resolve();
    expect(changes).toEqual(["Guest"]);
    expect(closes).toBe(1);
    ref.current!.focus();
    root.unmount();
    finish("retired");
    await Promise.resolve();
    expect(changes).toEqual(["Guest"]);
    expect(closes).toBe(2);
    expect(scene.nodes.size).toBe(1);
  } finally {
    root.unmount();
  }
});

it("keeps one public ref, reads current text and retires keyboard requests on background/replacement", async () => {
  const scene = new RecordingSceneGraph(),
    ref = createRef<NativeTextInputHandle>();
  const system = new NativeSystemState({ appState: "active" });
  const requests: { text: string; title: string }[] = [];
  const replies: ((value: string | null) => void)[] = [];
  const changes: string[] = [];
  let closes = 0;
  const root = createNativeRoot(scene, {
    system,
    viewport: { width: 800, height: 600 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 7 }),
    },
    services: {
      storage: { read: async () => null, write: async () => {} },
      randomUUID: () => "fixture",
      randomBytes: (length) => new Uint8Array(length),
      textEntry: {
        open(request) {
          requests.push(request);
          return {
            result: new Promise((resolve) => replies.push(resolve)),
            close() {
              closes++;
            },
          };
        },
      },
    },
  });
  try {
    const render = (key: string) =>
      root.render(
        createElement(TextInput, {
          key,
          ref,
          nativeID: "same-entry",
          defaultValue: "Initial",
          "aria-label": "Current name",
          onChangeText: (value) => changes.push(value),
        }),
      );
    render("old");
    await root.whenCommitted();
    const old = ref.current!;
    old.focus();
    replies[0]("Updated");
    await Promise.resolve();
    await root.whenCommitted();
    expect(ref.current).toBe(old);
    old.focus();
    expect(requests[1]).toMatchObject({ text: "Updated", title: "Current name" });
    system.publish({ appState: "background" });
    expect(closes).toBe(1);
    expect(old.isFocused()).toBe(false);
    replies[1]("Late background edit");
    await Promise.resolve();
    old.focus();
    expect(requests).toHaveLength(2);
    expect(changes).toEqual(["Updated"]);
    system.publish({ appState: "active" });
    old.focus();
    expect(requests).toHaveLength(3);
    render("replacement");
    await root.whenCommitted();
    expect(closes).toBe(2);
    old.focus();
    old.clear();
    expect(old.isFocused()).toBe(false);
    expect(() => old.setNativeProps({ text: "stale" })).toThrow("retired input");
    replies[2]("Late replacement edit");
    await Promise.resolve();
    await root.whenCommitted();
    expect(requests).toHaveLength(3);
    expect(changes).toEqual(["Updated"]);
    ref.current!.focus();
    expect(requests.at(-1)?.text).toBe("Initial");
  } finally {
    root.unmount();
  }
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
  expect(system.listenerCount).toBe(0);
});
