import { afterEach, expect, it, vi } from "vitest";
import { installNativeAnimationFrames } from "./nativeTimers";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("settles every promise and rejects iterator failures when Hermes lacks allSettled", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Promise, "allSettled")!;
  Object.defineProperty(Promise, "allSettled", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  try {
    installNativeAnimationFrames();
    expect(await Promise.allSettled([1, Promise.resolve(2), Promise.reject("offline")])).toEqual([
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: 2 },
      { status: "rejected", reason: "offline" },
    ]);
    const invalid = {
      [Symbol.iterator]() {
        throw Error("invalid iterator");
      },
    };
    await expect(Promise.allSettled(invalid as unknown as Iterable<unknown>)).rejects.toThrow(
      "invalid iterator",
    );
  } finally {
    Object.defineProperty(Promise, "allSettled", descriptor);
  }
});

it("normalizes optional timer disposal for strict Hermes bindings without wrapping repeatedly", () => {
  const handles: unknown[] = [];
  const strict = (handle: unknown) => {
    if (typeof handle !== "number") throw new TypeError("Numeric timer expected");
    handles.push(handle);
  };
  vi.stubGlobal("clearTimeout", strict);
  vi.stubGlobal("clearInterval", strict);
  installNativeAnimationFrames();
  const first = globalThis.clearTimeout;
  clearTimeout(undefined);
  clearInterval(undefined);
  clearTimeout(12);
  clearInterval(13);
  installNativeAnimationFrames();
  expect(globalThis.clearTimeout).toBe(first);
  expect(handles).toEqual([12, 13]);
});
it("supplies missing interval/microtask APIs and cancels an interval from inside its callback", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("setInterval", undefined);
  vi.stubGlobal("clearInterval", undefined);
  vi.stubGlobal("queueMicrotask", undefined);
  vi.stubGlobal("performance", undefined);
  installNativeAnimationFrames();
  const order: string[] = [];
  queueMicrotask(() => order.push("microtask"));
  order.push("sync");
  await Promise.resolve();
  expect(order).toEqual(["sync", "microtask"]);
  let ticks = 0;
  const interval = setInterval(() => {
    if (++ticks === 3) clearTimeout(interval);
  }, 10);
  await vi.advanceTimersByTimeAsync(100);
  expect(ticks).toBe(3);
  expect(vi.getTimerCount()).toBe(0);
  expect(performance.now()).toBe(100);
});
