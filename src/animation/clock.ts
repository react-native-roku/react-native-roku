export interface AnimationClock {
  now(): number;
  request(callback: () => void): unknown;
  cancel(handle: unknown): void;
}
export const animationClock: AnimationClock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  request: (callback) => setTimeout(callback, 16),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
