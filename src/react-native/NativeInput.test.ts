import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeInput } from "./NativeInput";

afterEach(() => vi.useRealTimers());
function target() {
  return {
    enabled: () => true,
    focus: vi.fn(),
    pressed: vi.fn(),
    activate: vi.fn(),
    longPress: vi.fn(),
  };
}
describe("observed native focus and activation", () => {
  it("keeps queued directions through an SDK timer that fires before the observation deadline", async () => {
    vi.useFakeTimers();
    const realSchedule = globalThis.setTimeout;
    const schedule = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementationOnce((callback, _delay, ...args) => realSchedule(callback, 1, ...args));
    const input = new NativeInput();
    const destinations: string[] = [];
    for (const id of ["first", "second", "third"]) input.register(id, target());
    input.bindNavigation(() => {
      const next = input.focusedID === "first" ? "second" : "third";
      destinations.push(next);
      input.requestFocus(next, "directional");
      return true;
    });
    try {
      input.observeFocus("first", true);
      input.dispatch({ key: "down", phase: "down" });
      input.dispatch({ key: "down", phase: "down" });
      await vi.advanceTimersByTimeAsync(1);
      expect(input.focusedID).toBe("first");
      expect(destinations).toEqual(["second"]);
      input.observeFocus("second", true);
      expect(destinations).toEqual(["second", "third"]);
      input.observeFocus("third", true);
      expect(input.focusedID).toBe("third");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      input.dispose();
      schedule.mockRestore();
    }
  });

  it("requires an observed owner and activates once after key release", () => {
    const input = new NativeInput(),
      button = target();
    input.register("button", button);
    expect(input.dispatch({ key: "select", phase: "down" })).toBe(false);
    input.observeFocus("button", true);
    input.dispatch({ key: "select", phase: "down" });
    input.dispatch({ key: "select", phase: "repeat" });
    input.dispatch({ key: "select", phase: "up" });
    input.dispatch({ key: "select", phase: "up" });
    expect(button.focus).toHaveBeenCalledExactlyOnceWith(true);
    expect(button.activate).toHaveBeenCalledTimes(1);
    expect(button.pressed.mock.calls).toEqual([[true], [false]]);
    input.dispose();
  });
  it("cancels a held key on observed focus loss and ignores late observations for retired targets", () => {
    const input = new NativeInput(),
      first = target(),
      second = target();
    const remove = input.register("first", first);
    input.register("second", second);
    input.observeFocus("first", true);
    input.dispatch({ key: "select", phase: "down" });
    input.observeFocus("second", true);
    input.dispatch({ key: "select", phase: "up" });
    expect(first.activate).not.toHaveBeenCalled();
    expect(second.activate).not.toHaveBeenCalled();
    expect(first.focus.mock.calls).toEqual([[true], [false]]);
    remove();
    input.observeFocus("first", true);
    expect(input.focusedID).toBe("second");
    input.dispose();
  });
  it("keeps a long press distinct from a short activation and clears its timer", async () => {
    vi.useFakeTimers();
    const input = new NativeInput(),
      button = target();
    input.register("button", button);
    input.observeFocus("button", true);
    input.dispatch({ key: "select", phase: "down" });
    await vi.advanceTimersByTimeAsync(500);
    input.dispatch({ key: "select", phase: "up" });
    expect(button.longPress).toHaveBeenCalledTimes(1);
    expect(button.activate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    input.dispose();
  });
  it("does not activate a target disabled while its key is held", () => {
    const input = new NativeInput(),
      button = target();
    let enabled = true;
    button.enabled = () => enabled;
    input.register("button", button);
    input.observeFocus("button", true);
    input.dispatch({ key: "select", phase: "down" });
    enabled = false;
    input.dispatch({ key: "select", phase: "up" });
    expect(button.activate).not.toHaveBeenCalled();
    expect(button.pressed.mock.calls).toEqual([[true], [false]]);
    input.dispose();
  });
  it("orders back handlers by ownership and releases all observers", () => {
    const input = new NativeInput(),
      events: unknown[] = [],
      called: string[] = [];
    input.subscribe((event) => events.push(event));
    input.addBackHandler(() => {
      called.push("outer");
      return true;
    });
    const remove = input.addBackHandler(() => {
      called.push("inner");
      return true;
    });
    expect(input.dispatch({ key: "back", phase: "down" })).toBe(true);
    expect(called).toEqual(["inner"]);
    remove();
    input.dispatch({ key: "back", phase: "down" });
    expect(called).toEqual(["inner", "outer"]);
    expect(events).toHaveLength(2);
    input.dispose();
    expect(input.observerCount).toBe(0);
    expect(input.targetCount).toBe(0);
  });
  it("ignores a release/repeat carried across a route and preserves an unrelated held owner", () => {
    const input = new NativeInput(),
      first = target(),
      second = target();
    const remove = input.register("first", first);
    input.register("second", second);
    input.observeFocus("second", true);
    input.dispatch({ key: "select", phase: "repeat" });
    input.dispatch({ key: "select", phase: "up" });
    expect(second.activate).not.toHaveBeenCalled();
    input.dispatch({ key: "select", phase: "down" });
    remove();
    input.dispatch({ key: "select", phase: "up" });
    expect(second.activate).toHaveBeenCalledTimes(1);
    input.dispose();
  });
  it("does not leave a long-press timer behind when press-in retires its target", () => {
    vi.useFakeTimers();
    const input = new NativeInput(),
      button = target();
    const remove = input.register("button", button);
    button.pressed.mockImplementation((pressed) => {
      if (pressed) remove();
    });
    input.observeFocus("button", true);
    input.dispatch({ key: "select", phase: "down" });
    expect(vi.getTimerCount()).toBe(0);
    input.dispose();
  });
});

it("keeps direction observers in the renderer batch before handing input to navigation", () => {
  const input = new NativeInput();
  const events: string[] = [];
  let batching = false;
  input.bindRenderer((work) => {
    batching = true;
    try {
      work();
    } finally {
      batching = false;
    }
  });
  input.register("left", { ...target(), tag: 7 });
  input.observeFocus("left", true);
  input.bindNavigation((key) => {
    expect(batching).toBe(true);
    events.push("navigation " + key);
    return true;
  });
  input.subscribe(({ eventType, eventKeyAction, tag }) => {
    expect(batching).toBe(true);
    expect(tag).toBe(7);
    events.push("observer " + eventType + " " + eventKeyAction);
    return eventType === "left";
  });
  try {
    expect(input.dispatch({ key: "left", phase: "down" })).toBe(true);
    expect(input.dispatch({ key: "right", phase: "down" })).toBe(true);
    expect(input.dispatch({ key: "right", phase: "up" })).toBe(false);
    expect(events).toEqual([
      "observer left 0",
      "observer right 0",
      "navigation right",
      "observer right 1",
    ]);
  } finally {
    input.dispose();
  }
});
