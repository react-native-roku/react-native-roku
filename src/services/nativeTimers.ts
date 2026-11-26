/** JS turn scheduling only; these callbacks never acknowledge native presentation. */
const normalizedDisposers = new WeakSet<Function>();
const intervals = new Map<number, { timer?: ReturnType<typeof setTimeout> }>();
let intervalSequence = 0;
export function installNativeAnimationFrames(): void {
  if (typeof Promise.allSettled !== "function")
    Object.defineProperty(Promise, "allSettled", {
      configurable: true,
      writable: true,
      value: async (values: Iterable<unknown>) =>
        Promise.all(
          Array.from(values, (value) =>
            Promise.resolve(value).then(
              (value) => ({ status: "fulfilled", value }),
              (reason) => ({ status: "rejected", reason }),
            ),
          ),
        ),
    });
  if (typeof globalThis.queueMicrotask !== "function")
    globalThis.queueMicrotask = (callback) => {
      if (typeof callback !== "function") throw new TypeError("A microtask requires a callback");
      void Promise.resolve()
        .then(callback)
        .catch((error) =>
          setTimeout(() => {
            throw error;
          }, 0),
        );
    };
  if (typeof globalThis.setInterval !== "function") {
    const nativeClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((
      callback: (...args: unknown[]) => void,
      milliseconds = 0,
      ...args: unknown[]
    ) => {
      if (typeof callback !== "function") throw new TypeError("Intervals require a callback");
      const id = --intervalSequence,
        entry: { timer?: ReturnType<typeof setTimeout> } = {};
      intervals.set(id, entry);
      const delay = Math.max(1, Math.min(2_147_483_647, Number(milliseconds) || 0));
      const tick = () => {
        if (intervals.get(id) !== entry) return;
        try {
          callback(...args);
        } finally {
          if (intervals.get(id) === entry) entry.timer = setTimeout(tick, delay);
        }
      };
      entry.timer = setTimeout(tick, delay);
      return id;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle) => {
      const entry = intervals.get(handle as number);
      if (entry) {
        intervals.delete(handle as number);
        clearTimeout(entry.timer);
      } else if (handle != null && typeof nativeClearInterval === "function")
        (nativeClearInterval as (value: unknown) => void)(handle);
      else if (handle != null) (clearTimeout as (value: unknown) => void)(handle);
    }) as typeof clearInterval;
  }
  if (typeof globalThis.performance === "undefined") {
    const origin = Date.now();
    let last = 0;
    // Elapsed JS scheduling clock only, not native frame or device timing.
    globalThis.performance = {
      timeOrigin: origin,
      now: () => (last = Math.max(last, Date.now() - origin)),
    } as Performance;
  }
  for (const name of ["clearTimeout", "clearInterval"] as const) {
    const native = globalThis[name];
    if (typeof native !== "function" || normalizedDisposers.has(native)) continue;
    // Browser/RN callers routinely clear an optional timer. Bare Hermes and
    // firmware bindings accept a numeric handle and may throw for undefined.
    const dispose = (handle: Parameters<typeof clearTimeout>[0]) => {
      const interval = intervals.get(handle as number);
      if (interval) {
        intervals.delete(handle as number);
        globalThis.clearTimeout(interval.timer);
      } else if (handle != null) native(handle);
    };
    normalizedDisposers.add(dispose);
    globalThis[name] = dispose as typeof native;
  }
  if (typeof globalThis.requestAnimationFrame !== "function") {
    globalThis.requestAnimationFrame = (callback) =>
      setTimeout(
        () => callback(typeof performance === "undefined" ? Date.now() : performance.now()),
        16,
      ) as unknown as number;
    globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
  }
}
