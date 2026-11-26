import { createElement, createRef, StrictMode } from "react";
import { describe, expect, it } from "vitest";
import { createNativeRoot } from "../react-native/createNativeRoot";
import { View } from "../react-native/primitives";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { SceneGraphAudio, type SceneGraphAudioRef } from "./SceneGraphAudio";
import { createAudioSession, type AudioObservation } from "./audioSession";

const text = {
  prepare() {},
  metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 7 }),
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("audio resources (host protocol, no decoder qualification)", () => {
  it("publishes only valid native observations and fences retirement", async () => {
    const events: AudioObservation[] = [],
      session = createAudioSession((event) => events.push(event));
    await expect(session.position()).rejects.toThrow("No current native audio position");
    session.seek(25);
    expect(events).toEqual([]);
    for (const [field, value] of [
      ["position", -1],
      ["duration", NaN],
      ["state", "imaginary"],
      ["audioFormat", {}],
      ["errorCode", Infinity],
    ])
      session.observe(String(field), value);
    expect(events).toEqual([]);
    session.observe("duration", 80);
    session.observe("state", "playing");
    session.observe("position", 4);
    expect(await session.position()).toBe(4);
    expect(session.snapshot.format).toBeUndefined();
    session.observe("audioFormat", "mp3");
    const old = session.snapshot;
    session.seek(25);
    expect(session.snapshot).toBe(old);
    session.observe("position", 25);
    expect(old.position).toBe(4);
    expect(Object.isFrozen(old)).toBe(true);
    session.observe("state", "error");
    session.observe("errorCode", -4);
    session.observe("errorMsg", "fixture decode failure");
    expect(events.at(-1)).toMatchObject({
      kind: "error",
      snapshot: { errorCode: -4, errorMessage: "fixture decode failure" },
    });
    const count = events.length;
    session.retire();
    session.observe("position", 50);
    expect(events).toHaveLength(count);
    expect(() => session.seek(1)).toThrow("retired");
    await expect(session.position()).rejects.toThrow("No current native audio position");
  });

  it("keeps Audio out of visual layout, links content and preserves paused seeks", async () => {
    const scene = new RecordingSceneGraph(),
      ref = createRef<SceneGraphAudioRef>(),
      events: AudioObservation[] = [];
    const root = createNativeRoot(scene, { viewport: { width: 640, height: 360 }, text });
    const render = (uri: string, paused = true) =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(
            View,
            { style: { width: 300, height: 80, flexDirection: "row" } },
            createElement(SceneGraphAudio, {
              ref,
              source: { uri, format: "mp3", headers: { Authorization: "fixture" } },
              paused,
              onObservation: (event) => events.push(event),
            }),
            createElement(View, { nativeID: "visible-sibling", style: { width: 100, height: 30 } }),
          ),
        ),
      );
    render("https://fixture.invalid/one");
    await root.whenCommitted();
    await tick();
    const first = [...scene.nodes.values()].find((node) => node.type === "audio")!;
    const content = [...scene.nodes.values()].find((node) => node.type === "contentNode")!;
    expect(first.fields).toMatchObject({
      content,
      control: "prebuffer",
      autoplayAfterSeek: false,
      notificationInterval: 0.25,
      loop: false,
    });
    for (const field of ["visible", "translation", "width", "height", "enableUI", "rate", "volume"])
      expect(first.fields).not.toHaveProperty(field);
    expect(content.fields).toMatchObject({
      url: "https://fixture.invalid/one",
      streamFormat: "mp3",
      httpHeaders: ["Authorization: fixture"],
    });
    const sibling = [...scene.nodes.values()].find((node) => node.fields.id === "visible-sibling")!;
    expect(sibling.fields.translation).toEqual([0, 0]);
    expect(events).toEqual([]);
    ref.current!.seek(30);
    expect(first.fields).toMatchObject({ seek: 30, autoplayAfterSeek: false });
    expect(events).toEqual([]);
    scene.emit(first, "state", "paused");
    ref.current!.resume();
    expect(first.fields).toMatchObject({ control: "resume", autoplayAfterSeek: true });
    ref.current!.pause();
    expect(first.fields).toMatchObject({ control: "pause", autoplayAfterSeek: false });
    ref.current!.setMuted(true);
    expect(first.fields.mute).toBe(true);
    expect(() => ref.current!.seek(NaN)).toThrow("finite nonnegative");
    scene.emit(first, "position", 30);
    expect(await ref.current!.getCurrentPosition()).toBe(30);
    const stale = ref.current!;
    render("https://fixture.invalid/two", false);
    await root.whenCommitted();
    await tick();
    expect(scene.nodes.has(first.id)).toBe(false);
    const count = events.length;
    scene.emit(first, "position", 90);
    stale.pause();
    await tick();
    expect(events).toHaveLength(count);
    await expect(ref.current!.getCurrentPosition()).rejects.toThrow(
      "No current native audio position",
    );
    const second = [...scene.nodes.values()].find((node) => node.type === "audio")!;
    expect(second.fields.control).toBe("play");
    root.unmount();
    await tick();
    const stop = scene.operations
      .map((op) => op.node === second.id && op.field === "control" && op.value === "stop")
      .lastIndexOf(true);
    const ancestorRemoval = scene.operations
      .map((op) => op.operation === "remove")
      .lastIndexOf(true);
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(ancestorRemoval);
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  });

  it.each([
    { source: { uri: "file:/private/audio", format: "mp3" }, code: "C31_AUDIO_URI" },
    {
      source: { uri: "https://fixture.invalid/audio", format: "automatic" },
      code: "C31_AUDIO_FORMAT",
    },
    {
      source: {
        uri: "https://fixture.invalid/audio",
        format: "mp3",
        headers: { Host: "bad\r\nInjected: yes" },
      },
      code: "C31_AUDIO_HEADER",
    },
  ])("rejects malformed media before native allocation ($code)", async ({ source, code }) => {
    const scene = new RecordingSceneGraph(),
      errors: Error[] = [];
    const root = createNativeRoot(scene, {
      viewport: { width: 640, height: 360 },
      text,
      onError: (error) => errors.push(error),
    });
    expect(() =>
      root.render(
        createElement(SceneGraphAudio, {
          source: source as Parameters<typeof SceneGraphAudio>[0]["source"],
        }),
      ),
    ).toThrow(code);
    await root.whenCommitted().catch(() => {});
    await tick();
    expect(errors.some((error) => error.message.includes(code))).toBe(true);
    expect([...scene.nodes.values()].some((node) => node.type === "audio")).toBe(false);
    root.unmount();
    await tick();
    expect(scene.listenerCount).toBe(0);
  });
});
