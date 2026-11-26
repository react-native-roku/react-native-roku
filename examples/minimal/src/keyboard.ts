import { createElement, createRef, Fragment, type ElementRef } from "react";
import { createNativeRoot } from "react-native-roku";
import { RecordingSceneGraph } from "react-native-roku/testing";
import { Keyboard, TextInput } from "react-native";
import type { TextEntryRequest } from "react-native-roku/services";

/** Explicit IO fixtures qualify public React ordering, never firmware closure. */
export async function qualifyKeyboard() {
  const scene = new RecordingSceneGraph();
  const sessions: {
    request: TextEntryRequest;
    result(value: string | null): void;
    observed(value: boolean): void;
    closes: number;
    draft: string;
  }[] = [];
  const root = createNativeRoot(scene, {
    viewport: { width: 640, height: 360 },
    text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: (s) => s.length * 8 }) },
    textEntry: {
      open(request) {
        let result!: (value: string | null) => void, observed!: (value: boolean) => void;
        const item = {
          request,
          result: (value: string | null) => result(value),
          observed: (value: boolean) => observed(value),
          closes: 0,
          draft: request.text,
        };
        sessions.push(item);
        return {
          result: new Promise<string | null>((resolve) => {
            result = resolve;
          }),
          closed: new Promise<boolean>((resolve) => {
            observed = resolve;
          }),
          setText(text: string) {
            item.draft = text.slice(0, request.maxLength);
            return true;
          },
          close() {
            item.closes++;
            result(null);
          },
        };
      },
    },
  });
  const first = createRef<ElementRef<typeof TextInput>>(),
    second = createRef<ElementRef<typeof TextInput>>();
  const events: string[] = [];
  const subscription = Keyboard.addListener("keyboardDidHide", () => {
    events.push("hide");
    if (first.current?.isFocused()) first.current.blur();
  });
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  try {
    const render = (value?: string) =>
      root.render(
        createElement(
          Fragment,
          {},
          createElement(TextInput, {
            ref: first,
            defaultValue: "seed",
            value,
            secureTextEntry: true,
            maxLength: 4,
            onChangeText: (text) => events.push(text),
            onSubmitEditing: () => events.push("submit"),
            onBlur: () => events.push("blur"),
          }),
          createElement(TextInput, { ref: second }),
        ),
      );
    render();
    await root.whenCommitted();
    first.current!.focus();
    if (!sessions[0].request.secure || sessions[0].request.domain !== "password")
      throw Error("Packed input lost secure keyboard domain");
    first.current!.clear();
    if (String(sessions[0].draft) !== "" || sessions[0].closes || events.length)
      throw Error("Packed clear did not update the active draft without events");
    first.current!.setNativeProps({ text: "seed" });
    if (String(sessions[0].draft) !== "seed")
      throw Error("Packed imperative text did not update the editor");
    Keyboard.dismiss();
    Keyboard.dismiss();
    await settle();
    if (sessions[0].closes !== 1 || events.join() !== "blur")
      throw Error("Packed dismiss did not cancel exactly once without inventing hide");
    sessions[0].observed(true);
    await settle();
    if (events.join() !== "blur,hide") throw Error("Packed keyboard lost observed dismissal");
    events.length = 0;
    first.current!.focus();
    sessions[1].observed(true);
    await settle();
    if (events.length) throw Error("Packed close overtook accepted text");
    sessions[1].result("accepted");
    await settle();
    if (events.join() !== "acce,submit,blur,hide")
      throw Error("Packed keyboard submission ordering or length failed");
    events.length = 0;
    first.current!.focus();
    render("Rset");
    await root.whenCommitted();
    if (String(sessions[2].draft) !== "Rset" || sessions[2].closes || events.length)
      throw Error("Packed controlled value did not update its existing editor");
    sessions[2].draft = "user";
    render("Rset");
    await root.whenCommitted();
    if (String(sessions[2].draft) !== "user")
      throw Error("Packed unrelated render overwrote the draft");
    second.current!.focus();
    sessions[2].observed(true);
    await settle();
    if (!second.current!.isFocused() || events.join() !== "blur")
      throw Error("Packed stale keyboard close disturbed successor");
    root.unmount();
    sessions[3].observed(true);
    await settle();
    if (sessions[3].closes !== 1 || events.includes("hide"))
      throw Error("Packed retired root received a hide callback");
  } finally {
    subscription.remove();
    root.unmount();
  }
  if (scene.nodes.size !== 1 || scene.listenerCount !== 0)
    throw Error("Packed keyboard resources leaked");
  return {
    dismissal: true,
    observedClose: true,
    submissionOrder: true,
    replacement: true,
    activeControlledUpdate: true,
    activeImperativeUpdate: true,
    retirement: true,
  };
}
