import { createElement, type ComponentType, type ReactElement } from "react";
import { RokuHostError } from "../scene/sceneGraph.types";
const applications = new Map<string, () => ComponentType<Record<string, unknown>>>();
/** Registration-compatible React Native entry API. Native roots remain host-owned. */
export const AppRegistry = Object.freeze({
  registerComponent<Props extends object>(
    key: string,
    provider: () => ComponentType<Props>,
  ): string {
    if (!key.trim() || typeof provider !== "function")
      throw new RokuHostError(
        "R01_APP_REGISTRY",
        "An application needs a name and component provider",
      );
    applications.set(key, provider as unknown as () => ComponentType<Record<string, unknown>>);
    return key;
  },
  getAppKeys: () => [...applications.keys()],
  getRunnable: (key: string) =>
    applications.has(key) ? { componentProvider: applications.get(key)! } : undefined,
  unregisterComponent: (key: string) => applications.delete(key),
});
export function registeredApplication(
  key: string,
  initialProps: Record<string, unknown> = {},
): ReactElement {
  const provider = applications.get(key);
  if (!provider)
    throw new RokuHostError("R01_APP_REGISTRY", `Application ${key} has not been registered`);
  return createElement(provider(), initialProps);
}
