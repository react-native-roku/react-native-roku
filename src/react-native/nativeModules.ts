import { RokuHostError } from "../scene/sceneGraph.types";
type Listener = (...values: unknown[]) => void;
/** JavaScript event delivery; native capabilities still require an explicit installed port. */
export class EventEmitter {
  private readonly listeners = new Map<string, Set<Listener>>();
  addListener(name: string, listener: Listener) {
    const entries = this.listeners.get(name) ?? new Set();
    entries.add(listener);
    this.listeners.set(name, entries);
    let active = true;
    return {
      remove: () => {
        if (!active) return;
        active = false;
        entries.delete(listener);
        if (!entries.size) this.listeners.delete(name);
      },
    };
  }
  emit(name: string, ...values: unknown[]): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(...values);
  }
  removeAllListeners(name?: string): void {
    if (name == null) this.listeners.clear();
    else this.listeners.delete(name);
  }
  listenerCount(name: string): number {
    return this.listeners.get(name)?.size ?? 0;
  }
}
export const DeviceEventEmitter = new EventEmitter();
export class NativeEventEmitter {
  constructor(
    private readonly native?: {
      addListener?(name: string): void;
      removeListeners?(count: number): void;
    } | null,
  ) {}
  addListener(name: string, listener: Listener) {
    this.native?.addListener?.(name);
    const subscription = DeviceEventEmitter.addListener(name, listener);
    let active = true;
    return {
      remove: () => {
        if (!active) return;
        active = false;
        subscription.remove();
        this.native?.removeListeners?.(1);
      },
    };
  }
  emit(name: string, ...values: unknown[]): void {
    DeviceEventEmitter.emit(name, ...values);
  }
}
export const UIManager = Object.freeze({
  // This host has no Fabric view-manager registry. Renderer capabilities are separate ports.
  getViewManagerConfig: (_name: string): null => null,
  dispatchViewManagerCommand(): never {
    throw new RokuHostError(
      "C03_NATIVE_MANAGER",
      "No Fabric view manager is installed in the Roku host",
    );
  },
});
export function requireNativeComponent(name: string): never {
  throw new RokuHostError(
    "C03_NATIVE_COMPONENT",
    `Native component ${name} has no installed Roku view manager`,
  );
}
export const TurboModuleRegistry = Object.freeze({
  get: (_name: string): null => null,
  getEnforcing(name: string): never {
    throw new RokuHostError(
      "C03_NATIVE_MODULE",
      `No TurboModule ${name} is installed in the Roku host`,
    );
  },
});
export const Share = Object.freeze({
  share: async (): Promise<never> => {
    throw new RokuHostError("C21_SHARE", "The Roku host has no external share destination");
  },
});
export { Keyboard } from "./keyboard";
