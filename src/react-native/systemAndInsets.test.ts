import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { NativeSystemState } from "./NativeSystemState";
import { AccessibilityInfo, Appearance, AppState } from "./environment";
import { createNativeRoot } from "./createNativeRoot";
import { SafeAreaProvider, SafeAreaView, useSafeAreaFrame } from "./safeArea";
import { View } from "./primitives";

const text = {
  prepare() {},
  metrics: () => ({
    lineHeight: 20,
    width: (value: string) => value.length * 8,
  }),
};
describe("host system facts and safe-area geometry", () => {
  it("keeps unknown preferences pending and forwards actual system changes with cleanup", async () => {
    const announcements: string[] = [],
      events: unknown[] = [];
    const system = new NativeSystemState({}, (message) => announcements.push(message));
    const root = createNativeRoot(new RecordingSceneGraph(), {
      viewport: { width: 800, height: 600 },
      text,
      system,
    });
    expect(AppState.currentState).toBeNull();
    expect(Appearance.getColorScheme()).toBeNull();
    await expect(AccessibilityInfo.isReduceMotionEnabled()).rejects.toThrow(
      /C25_PREFERENCE_PENDING/,
    );
    await expect(AccessibilityInfo.isScreenReaderEnabled()).rejects.toThrow(
      /C25_PREFERENCE_PENDING/,
    );
    const subscriptions = [
      AppState.addEventListener("change", (value) => events.push(["state", value])),
      Appearance.addChangeListener((value) => events.push(["appearance", value.colorScheme])),
      AccessibilityInfo.addEventListener("reduceMotionChanged", (value) =>
        events.push(["motion", value]),
      ),
      AccessibilityInfo.addEventListener("screenReaderChanged", (value) =>
        events.push(["reader", value]),
      ),
    ];
    system.publish({
      appState: "active",
      colorScheme: "dark",
      reduceMotion: false,
      screenReader: true,
    });
    expect(await AccessibilityInfo.isReduceMotionEnabled()).toBe(false);
    expect(await AccessibilityInfo.isScreenReaderEnabled()).toBe(true);
    Appearance.setColorScheme("light");
    system.publish({ colorScheme: "light" }); // Override already light: no duplicate effective appearance.
    Appearance.setColorScheme("unspecified");
    system.publish({ appState: "background", colorScheme: "dark" });
    AccessibilityInfo.announceForAccessibility("Playback paused");
    expect(announcements).toEqual(["Playback paused"]);
    expect(events).toEqual([
      ["state", "active"],
      ["appearance", "dark"],
      ["motion", false],
      ["reader", true],
      ["appearance", "light"],
      ["state", "background"],
      ["appearance", "dark"],
    ]);
    subscriptions.forEach((subscription) => subscription.remove());
    root.unmount();
    expect(system.listenerCount).toBe(0);
    system.publish({ appState: "active" });
    expect(events).toHaveLength(7);
  });

  it("adds only selected safe-area edges to existing padding and keeps decoration bounds independent", async () => {
    const scene = new RecordingSceneGraph();
    const root = createNativeRoot(scene, {
      viewport: { width: 800, height: 600 },
      text,
    });
    let frame: unknown;
    function Consumer() {
      frame = useSafeAreaFrame();
      return createElement(View, { style: { width: 20, height: 10 } });
    }
    root.render(
      createElement(
        SafeAreaProvider,
        {
          initialMetrics: {
            insets: { top: 12, right: 4, bottom: 6, left: 8 },
            frame: { x: 0, y: 0, width: 800, height: 600 },
          },
        },
        createElement(
          SafeAreaView,
          {
            edges: ["top", "left"],
            style: {
              width: 200,
              height: 100,
              padding: 10,
              borderWidth: 2,
              borderLeftWidth: 5,
              borderLeftColor: "red",
              backgroundColor: "blue",
            },
          },
          createElement(Consumer),
        ),
      ),
    );
    await root.whenCommitted();
    expect(frame).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    const children = scene.root.children[0].children;
    expect(children[0].fields).toMatchObject({
      width: 200,
      height: 100,
      translation: [0, 0],
      color: "0x0000FFFF",
    });
    expect(children[1].fields).toMatchObject({
      width: 200,
      height: 2,
      translation: [0, 0],
    });
    expect(children[2].fields).toMatchObject({
      width: 200,
      height: 2,
      translation: [0, 98],
    });
    expect(children[3].fields).toMatchObject({
      width: 5,
      height: 100,
      translation: [0, 0],
      color: "0xFF0000FF",
    });
    expect(children[4].fields).toMatchObject({
      width: 2,
      height: 100,
      translation: [198, 0],
    });
    expect(children[5].fields.translation).toEqual([23, 24]);
    root.unmount();
    expect(scene.nodes.size).toBe(1);
  });
});
