/** SceneGraph and React share one JS runtime; these calls execute on that runtime. */
export function runOnUISync<TArgs extends unknown[], TResult>(
  work: (...args: TArgs) => TResult,
  ...args: TArgs
): TResult {
  return work(...args);
}
export function scheduleOnRN<TArgs extends unknown[]>(
  work: (...args: TArgs) => void,
  ...args: TArgs
): void {
  work(...args);
}
export function runOnJS<TArgs extends unknown[], TResult>(
  work: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return work;
}
export function runOnUI<TArgs extends unknown[]>(
  work: (...args: TArgs) => void,
): (...args: TArgs) => void {
  return work;
}
