import { createElement, createRef, StrictMode } from "react";
import { describe, expect, it } from "vitest";
import { createNativeRoot } from "../react-native/createNativeRoot";
import { View } from "../react-native/primitives";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { SceneGraphVideo, type SceneGraphVideoRef } from "./SceneGraphVideo";
import { createVideoSession, type VideoObservation } from "./videoSession";

const text = {
  prepare() {},
  metrics: () => ({
    lineHeight: 20,
    width: (value: string) => value.length * 7,
  }),
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
describe("native media mechanics (host observations, no decoder qualification)", () => {
  it("observes late bounded error fields once per failure and excludes retired source callbacks", async () => {
    const scene = new RecordingSceneGraph(),
      events: VideoObservation[] = [];
    const root = createNativeRoot(scene, { viewport: { width: 640, height: 360 }, text });
    const render = async (path: string) => {
      root.render(
        createElement(SceneGraphVideo, {
          source: { uri: `https://fixture.invalid/${path}`, format: "hls" },
          onObservation: (event) => events.push(event),
        }),
      );
      await root.whenCommitted();
      await tick();
      return [...scene.nodes.values()].find((node) => node.type === "video")!;
    };
    try {
      const old = await render("one.m3u8");
      scene.emit(old, "state", "error");
      scene.emit(old, "errorCode", -3);
      scene.emit(old, "errorInfo", {
        category: "http",
        errcode: 503,
        dbgmsg: "private-token",
        source: "private-url",
      });
      scene.emit(old, "state", "error");
      expect(events.map((event) => event.kind)).toEqual([
        "error",
        "error-details",
        "error-details",
      ]);
      expect(events.at(-1)?.snapshot).toMatchObject({
        error: { nativeCode: -3, internalCode: 503, category: "http" },
      });
      expect(JSON.stringify(events)).not.toMatch(/private-token|private-url/);
      const current = await render("two.m3u8"),
        count = events.length;
      scene.emit(old, "errorCode", -9);
      scene.emit(old, "errorInfo", { errcode: 401 });
      scene.emit(old, "state", "error");
      expect(events).toHaveLength(count);
      scene.emit(current, "state", "error");
      expect(events.at(-1)).toEqual({ kind: "error", snapshot: { state: "error" } });
    } finally {
      root.unmount();
    }
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  });
  it("does not publish progress or presentation when a command is submitted", async () => {
    const events: VideoObservation[] = [],
      session = createVideoSession((event) => events.push(event));
    await expect(session.position()).rejects.toThrow("No current native position");
    session.seek(40);
    expect(events).toEqual([]);
    session.observe("state", "playing");
    expect(events.map((event) => event.kind)).toEqual(["state"]);
    session.observe("position", 40);
    expect(events.at(-1)?.kind).toBe("progress");
    session.observe("positionInfo", { epoch: 1, video: 40 });
    expect(events.map((event) => event.kind)).not.toContain("frame");
    session.observe("positionInfo", { epoch: 0, video: 8 });
    expect(events.map((event) => event.kind)).toContain("frame");
    expect(events.map((event) => event.kind)).not.toContain("seek");
    session.seek(10);
    session.observe("positionInfo", { epoch: 0, video: 40 });
    expect(events.map((event) => event.kind)).not.toContain("seek");
    session.observe("positionInfo", { epoch: 0, video: 10.1 });
    expect(events.at(-1)).toMatchObject({ kind: "seek", seekTime: 10 });
    expect(await session.position()).toBe(10.1);
    session.retire();
    session.observe("position", 100);
    await expect(session.position()).rejects.toThrow("No current native position");
    expect(session.snapshot.position).toBe(10.1);
  });
  it("links native content, observes state, fences replaced content, and stops before ancestor retirement", async () => {
    const scene = new RecordingSceneGraph(),
      ref = createRef<SceneGraphVideoRef>(),
      events: VideoObservation[] = [],
      errors: Error[] = [];
    const root = createNativeRoot(scene, {
      viewport: { width: 1920, height: 1080 },
      text,
    });
    const render = (uri: string) =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(
            View,
            { style: { flex: 1 } },
            createElement(SceneGraphVideo, {
              ref,
              source: {
                uri,
                format: "hls",
                headers: { Authorization: "fixture" },
              },
              style: { width: 960, height: 540 },
              onObservation: (event) => events.push(event),
              onError: (error) => errors.push(error),
            }),
          ),
        ),
      );
    render("https://fixture.invalid/one.m3u8");
    await root.whenCommitted();
    await tick();
    const first = [...scene.nodes.values()].find((node) => node.type === "video")!;
    const content = [...scene.nodes.values()].find((node) => node.type === "contentNode")!;
    expect(first.fields).toMatchObject({
      content,
      width: 960,
      height: 540,
      enableUI: false,
      suppressCaptions: true,
      control: "play",
    });
    expect(content.fields).toMatchObject({
      url: "https://fixture.invalid/one.m3u8",
      streamFormat: "hls",
      httpHeaders: ["Authorization: fixture"],
    });
    expect(events).toEqual([]);
    ref.current!.pause();
    expect(first.fields.control).toBe("pause");
    expect(events).toEqual([]);
    scene.emit(first, "position", 5);
    expect(await ref.current!.getCurrentPosition()).toBe(5);
    ref.current!.seek(20);
    await tick();
    expect(first.fields.seek).toBe(20);
    expect(events.map((event) => event.kind)).not.toContain("seek");
    render("https://fixture.invalid/two.m3u8");
    await root.whenCommitted();
    await tick();
    expect(scene.nodes.has(first.id)).toBe(false);
    expect(
      scene.operations.some(
        (op) => op.node === first.id && op.field === "control" && op.value === "stop",
      ),
    ).toBe(true);
    const previous = events.length;
    scene.emit(first, "position", 100);
    expect(events).toHaveLength(previous);
    await expect(ref.current!.getCurrentPosition()).rejects.toThrow("No current native position");
    root.unmount();
    await tick();
    expect(errors).toEqual([]);
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  });
});
