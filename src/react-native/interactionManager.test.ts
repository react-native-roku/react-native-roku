import { afterEach, expect, it, vi } from "vitest";
import { InteractionManager as manager } from "./interactionManager";
afterEach(() => vi.useRealTimers());
it("defers work through interaction leases, awaits nested async work and cancels retired work", async () => {
  vi.useFakeTimers();
  const handle = manager.createInteractionHandle(),
    events: string[] = [];
  const first = manager.runAfterInteractions({
    gen: async () => {
      events.push("start");
      await Promise.resolve();
      events.push("finish");
    },
  });
  const cancelled = manager.runAfterInteractions(() => events.push("cancelled"));
  const last = manager.runAfterInteractions(() => events.push("last"));
  cancelled.cancel();
  await vi.runAllTimersAsync();
  expect(events).toEqual([]);
  manager.clearInteractionHandle(handle);
  await vi.runAllTimersAsync();
  await first;
  await last;
  expect(events).toEqual(["start", "finish", "last"]);
  expect(vi.getTimerCount()).toBe(0);
});
