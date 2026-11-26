import { describe, expect, it, vi } from "vitest";
import { RokuKeySession } from "./RokuKeySession";
import { NativeInput } from "../react-native/NativeInput";

describe("firmware key lifecycle", () => {
  it("translates actual SDK strings and repeated presses into one canonical held-key stream", () => {
    const keys = new RokuKeySession(),
      events: unknown[] = [];
    const dispatch = (event: unknown) => {
      events.push(event);
      return true;
    };
    keys.handle("OK", true, dispatch);
    keys.handle("OK", true, dispatch);
    keys.handle("OK", false, dispatch);
    keys.handle("play", true, dispatch);
    keys.handle("fastforward", true, dispatch);
    expect(keys.handle("unknown-partner-key", true, dispatch)).toBe(false);
    keys.reset();
    keys.handle("OK", true, dispatch);
    expect(events).toEqual([
      { key: "select", phase: "down" },
      { key: "select", phase: "repeat" },
      { key: "select", phase: "up" },
      { key: "playPause", phase: "down" },
      { key: "fastForward", phase: "down" },
      { key: "select", phase: "down" },
    ]);
  });
  it("retires an in-progress activation when the app becomes inactive and ignores its late release", async () => {
    vi.useFakeTimers();
    try {
      const input = new NativeInput(),
        target = {
          enabled: () => true,
          focus: vi.fn(),
          pressed: vi.fn(),
          activate: vi.fn(),
          longPress: vi.fn(),
        };
      input.register("button", target);
      input.observeFocus("button", true);
      input.dispatch({ key: "select", phase: "down" });
      input.setActive(false);
      await vi.advanceTimersByTimeAsync(1000);
      input.dispatch({ key: "select", phase: "up" });
      input.setActive(true);
      input.dispatch({ key: "select", phase: "up" });
      expect(target.activate).not.toHaveBeenCalled();
      expect(target.longPress).not.toHaveBeenCalled();
      expect(target.pressed.mock.calls).toEqual([[true], [false]]);
      expect(vi.getTimerCount()).toBe(0);
      input.dispatch({ key: "select", phase: "down" });
      input.dispatch({ key: "select", phase: "up" });
      expect(target.activate).toHaveBeenCalledTimes(1);
      input.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
