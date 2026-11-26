let resolveComponent: ((component: unknown) => unknown) | undefined;
/** Installed by the pinned style engine after its environment is mounted. */
export function installStyleInterop(resolve: (component: unknown) => unknown): void {
  resolveComponent = resolve;
}
export function styleComponent<T>(component: T): T {
  return (resolveComponent?.(component) as T) ?? component;
}
