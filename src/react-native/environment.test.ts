import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { createNativeRoot } from "./createNativeRoot";
import { NativeInput } from "./NativeInput";
import {
  BackHandler,
  Dimensions,
  PixelRatio,
  Platform,
  TVEventHandler,
  useTVEventHandler,
  useWindowDimensions,
} from "./environment";
import { Text } from "./primitives";

const text = {
  prepare() {},
  metrics: () => ({
    lineHeight: 20,
    width: (value: string) => value.length * 8,
  }),
};
describe("native environment facts and subscriptions", () => {
  it("publishes logical viewport facts and retires the environment with its root", () => {
    const scene = new RecordingSceneGraph(),
      input = new NativeInput();
    let exits = 0;
    const root = createNativeRoot(scene, {
      viewport: { width: 1280, height: 720 },
      text,
      input,
      platformVersion: "16.0",
      requestExit: () => {
        exits++;
      },
    });
    expect(Platform.OS).toBe("roku");
    expect(Platform.isTV).toBe(true);
    expect(Platform.Version).toBe("16.0");
    expect(Platform.select({ roku: "roku", native: "native", default: "fallback" })).toBe("roku");
    expect(Platform.select({ native: "native", default: "fallback" })).toBe("native");
    expect(Dimensions.get("window")).toEqual({
      width: 1280,
      height: 720,
      scale: 1,
      fontScale: 1,
    });
    expect(Dimensions.get("window")).toBe(Dimensions.get("window"));
    expect(PixelRatio.roundToNearestPixel(3.6)).toBe(4);
    BackHandler.exitApp();
    expect(exits).toBe(1);
    root.unmount();
    input.dispose();
    expect(() => Dimensions.get("window")).toThrow(/mounted Roku root/);
  });
  it("subscribes shared hooks and module listeners to the actual input port and cleans up", () => {
    const scene = new RecordingSceneGraph(),
      input = new NativeInput(),
      events: string[] = [];
    const root = createNativeRoot(scene, {
      viewport: { width: 1920, height: 1080 },
      text,
      input,
    });
    function Consumer() {
      const size = useWindowDimensions();
      useTVEventHandler((event) => events.push(event.eventType));
      return createElement(Text, {}, `viewport ${size.width}`);
    }
    root.render(createElement(Consumer));
    const module = TVEventHandler.addListener((event) => events.push(`module:${event.eventType}`));
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      events.push("back-owner");
      return true;
    });
    expect(input.dispatch({ key: "back", phase: "down" })).toBe(true);
    expect(events).toEqual(["back", "module:back", "back-owner"]);
    module.remove();
    back.remove();
    root.unmount();
    expect(input.observerCount).toBe(0);
    input.dispose();
  });
  it("requires a real exit/version capability and does not leak a failed root binding", () => {
    const input = new NativeInput();
    input.dispose();
    expect(() =>
      createNativeRoot(new RecordingSceneGraph(), {
        viewport: { width: 800, height: 600 },
        input,
        text,
      }),
    ).toThrow(/disposed/);
    expect(() => Dimensions.get("window")).toThrow(/mounted Roku root/);
    const root = createNativeRoot(new RecordingSceneGraph(), {
      viewport: { width: 800, height: 600 },
      text,
    });
    expect(() => Platform.Version).toThrow(/not been supplied/);
    expect(() => BackHandler.exitApp()).toThrow(/exit capability/);
    root.unmount();
  });
});
