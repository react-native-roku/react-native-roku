type Task = (() => void) | { gen(): Promise<unknown> };
let sequence = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  flushing = false;
const interactions = new Set<number>();
const queue: Array<{
  task?: Task;
  resolve(): void;
  reject(error: unknown): void;
  cancelled: boolean;
}> = [];
function schedule() {
  if (timer != null || flushing || interactions.size || !queue.length) return;
  timer = setTimeout(() => {
    timer = undefined;
    void flush();
  }, 0);
}
async function flush() {
  if (interactions.size) return;
  flushing = true;
  try {
    while (!interactions.size && queue.length) {
      const next = queue.shift()!;
      if (next.cancelled) continue;
      try {
        if (typeof next.task === "function") next.task();
        else if (next.task) await next.task.gen();
        next.resolve();
      } catch (error) {
        next.reject(error);
      }
    }
  } finally {
    flushing = false;
    schedule();
  }
}
/** Real deferred JS work with explicit interaction leases and cancellation. */
export const InteractionManager = Object.freeze({
  createInteractionHandle(): number {
    const handle = ++sequence;
    interactions.add(handle);
    return handle;
  },
  clearInteractionHandle(handle: number): void {
    interactions.delete(handle);
    schedule();
  },
  runAfterInteractions(task?: Task) {
    let entry: (typeof queue)[number];
    const promise = new Promise<void>((resolve, reject) => {
      entry = { task, resolve, reject, cancelled: false };
      queue.push(entry);
      schedule();
    });
    return {
      then: promise.then.bind(promise),
      done: (resolve?: () => void, reject?: (error: unknown) => void) => {
        void promise.then(resolve, reject);
      },
      cancel() {
        if (!entry.cancelled) {
          entry.cancelled = true;
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          entry.resolve();
        }
        if (!queue.length && timer != null) {
          clearTimeout(timer);
          timer = undefined;
        }
      },
    };
  },
});
