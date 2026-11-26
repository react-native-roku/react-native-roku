import { useSyncExternalStore } from "react";
import { RokuHostError } from "../scene/sceneGraph.types";
import type { NativeInput, TVEvent } from "./NativeInput";
import { useNativeHost } from "./nativeHostContext";
import { useEffect, useRef } from "react";
import {
  NativeSystemState,
  type AppStateStatus,
  type ColorSchemeName,
  type SystemEvent,
} from "./NativeSystemState";
import type { DeviceServices } from "../services/DeviceServices";
import {
  findNodeHandle,
  requestNativeAccessibilityFocus,
  type NativeViewHandle,
} from "./nativeViewHandle";

export interface ScaledSize {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly fontScale: number;
}
interface Environment {
  readonly services?: DeviceServices;
  readonly system?: NativeSystemState;
  readonly viewport: { width: number; height: number };
  readonly input?: NativeInput;
  readonly platformVersion?: string | number;
  readonly requestExit?: () => void;
}
const bindings: Environment[] = [],
  listeners = new Set<(event: { window: ScaledSize; screen: ScaledSize }) => void>();
const defaultSystem = new NativeSystemState();
const systemListeners = new Set<(event: SystemEvent) => void>();
let releaseSystem: (() => void) | undefined;
const system = () => current().system ?? defaultSystem;
let size: ScaledSize | undefined;
const current = () => {
  const environment = bindings[bindings.length - 1];
  if (!environment)
    throw new RokuHostError(
      "C01_ENVIRONMENT",
      "Native environment facts require a mounted Roku root",
    );
  return environment;
};
const input = () => {
  const port = current().input;
  if (!port) throw new RokuHostError("C07_INPUT_HOST", "The native environment has no input port");
  return port;
};
export function nativeDeviceServices(): DeviceServices {
  const services = current().services;
  if (!services)
    throw new RokuHostError(
      "C21_DEVICE_SERVICES",
      "The mounted host has no persistent device-services port",
    );
  return services;
}
export const NativeModules = Object.freeze({
  get RokuCapabilities() {
    return current().services?.nativeCapabilities;
  },
});

export function bindNativeEnvironment(environment: Environment): () => void {
  const { width, height } = environment.viewport;
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)))
    throw new RokuHostError("C03_VIEWPORT", "The logical viewport must be positive and finite");
  if (bindings.length && (size?.width !== width || size?.height !== height))
    throw new RokuHostError(
      "C01_ENVIRONMENT",
      "Mounted roots must share the same logical screen viewport",
    );
  const changed = !size || size.width !== width || size.height !== height;
  // SceneGraph logical coordinates, not a statement about HDMI pixels or decoder capabilities.
  if (changed) size = Object.freeze({ width, height, scale: 1, fontScale: 1 });
  const token = { ...environment };
  if (bindings.length && current().services !== token.services)
    throw new RokuHostError(
      "C21_DEVICE_SERVICES",
      "Mounted roots must share a device-services port",
    );
  if (bindings.length && system() !== (token.system ?? defaultSystem))
    throw new RokuHostError("C01_ENVIRONMENT", "Mounted roots must share a system-state port");
  bindings.push(token);
  if (!releaseSystem)
    releaseSystem = system().subscribe((event) => {
      for (const listener of [...systemListeners]) listener(event);
    });
  if (changed) for (const listener of [...listeners]) listener({ window: size!, screen: size! });
  return () => {
    const index = bindings.indexOf(token);
    if (index >= 0) bindings.splice(index, 1);
    if (!bindings.length) {
      size = undefined;
      releaseSystem?.();
      releaseSystem = undefined;
    }
  };
}

export const Appearance = Object.freeze({
  getColorScheme: () => system().getColorScheme(),
  setColorScheme: (scheme: ColorSchemeName | "unspecified") => system().setColorScheme(scheme),
  addChangeListener(listener: (event: { colorScheme: ColorSchemeName }) => void) {
    const callback = (event: SystemEvent) => {
      if (event.type === "appearance") listener({ colorScheme: event.value as ColorSchemeName });
    };
    systemListeners.add(callback);
    return {
      remove: () => {
        systemListeners.delete(callback);
      },
    };
  },
});
export const AppState = Object.freeze({
  get currentState(): AppStateStatus | null {
    return system().getSnapshot().appState;
  },
  addEventListener(type: "change" | "memoryWarning", listener: (state: AppStateStatus) => void) {
    const callback = (event: SystemEvent) => {
      if (type === "change" && event.type === "appState" && event.value != null)
        listener(event.value as AppStateStatus);
      else if (type === "memoryWarning" && event.type === "memoryWarning")
        listener(undefined as never);
    };
    systemListeners.add(callback);
    return {
      remove: () => {
        systemListeners.delete(callback);
      },
    };
  },
});
export const AccessibilityInfo = Object.freeze({
  setAccessibilityFocus(tag: number): void {
    if (!Number.isSafeInteger(tag) || tag <= 0)
      throw new RokuHostError(
        "C25_ACCESSIBILITY_FOCUS",
        "Accessibility focus requires a positive native tag",
      );
    requestNativeAccessibilityFocus(tag);
  },
  sendAccessibilityEvent(handle: NativeViewHandle, eventType: "focus"): void {
    if (eventType !== "focus")
      throw new RokuHostError(
        "C25_ACCESSIBILITY_EVENT",
        "Only the focus accessibility event is supported",
      );
    const tag = findNodeHandle(handle);
    if (tag !== null) requestNativeAccessibilityFocus(tag);
  },
  isReduceMotionEnabled: () => system().isReduceMotionEnabled(),
  isScreenReaderEnabled: () => system().isScreenReaderEnabled(),
  announceForAccessibility: (message: string) => system().announceForAccessibility(message),
  addEventListener(
    type: "reduceMotionChanged" | "screenReaderChanged",
    listener: (enabled: boolean) => void,
  ) {
    const callback = (event: SystemEvent) => {
      if (
        ((type === "reduceMotionChanged" && event.type === "reduceMotion") ||
          (type === "screenReaderChanged" && event.type === "screenReader")) &&
        typeof event.value === "boolean"
      )
        listener(event.value);
    };
    systemListeners.add(callback);
    return {
      remove: () => {
        systemListeners.delete(callback);
      },
    };
  },
});

export const Platform = Object.freeze({
  OS: "roku" as const,
  isTV: true,
  isPad: false,
  constants: Object.freeze({}),
  get Version() {
    const version = current().platformVersion;
    if (version == null)
      throw new RokuHostError(
        "C01_PLATFORM_VERSION",
        "Roku firmware version has not been supplied by the device adapter",
      );
    return version;
  },
  select<T>(specifics: { roku?: T; native?: T; default?: T }): T | undefined {
    if (Object.prototype.hasOwnProperty.call(specifics, "roku")) return specifics.roku;
    return Object.prototype.hasOwnProperty.call(specifics, "native")
      ? specifics.native
      : specifics.default;
  },
});

export const Dimensions = Object.freeze({
  get(name: "window" | "screen"): ScaledSize {
    if (name !== "window" && name !== "screen")
      throw new RokuHostError("C03_VIEWPORT", `Unknown dimension source ${String(name)}`);
    current();
    return size!;
  },
  addEventListener(
    type: "change",
    listener: (event: { window: ScaledSize; screen: ScaledSize }) => void,
  ) {
    if (type !== "change")
      throw new RokuHostError("C03_VIEWPORT", `Unknown dimension event ${String(type)}`);
    listeners.add(listener);
    return {
      remove: () => {
        listeners.delete(listener);
      },
    };
  },
});
export function useWindowDimensions(): ScaledSize {
  const host = useNativeHost();
  return useSyncExternalStore(
    (callback) => {
      const subscription = Dimensions.addEventListener("change", callback);
      return subscription.remove;
    },
    () => {
      const measured = Dimensions.get("window");
      if (measured.width !== host.viewport.width || measured.height !== host.viewport.height)
        throw new RokuHostError("C03_VIEWPORT", "Root and window dimensions differ");
      return measured;
    },
  );
}
export const PixelRatio = Object.freeze({
  get: () => Dimensions.get("window").scale,
  getFontScale: () => Dimensions.get("window").fontScale,
  getPixelSizeForLayoutSize: (size: number) => Math.round(size * Dimensions.get("window").scale),
  roundToNearestPixel: (size: number) => {
    const scale = Dimensions.get("window").scale;
    return Math.round(size * scale) / scale;
  },
});
export const BackHandler = Object.freeze({
  addEventListener(type: "hardwareBackPress", handler: () => boolean) {
    if (type !== "hardwareBackPress")
      throw new RokuHostError("C07_BACK_EVENT", `Unknown back event ${String(type)}`);
    return { remove: input().addBackHandler(handler) };
  },
  exitApp() {
    const exit = current().requestExit;
    if (!exit) throw new RokuHostError("C07_EXIT", "The host has no application exit capability");
    exit();
  },
});
export function useTVEventHandler(handler: (event: TVEvent) => void): void {
  const host = useNativeHost(),
    callback = useRef(handler);
  callback.current = handler;
  useEffect(() => {
    if (!host.input)
      throw new RokuHostError("C07_INPUT_HOST", "TV events require a native input port");
    return host.input.subscribe((event) => callback.current(event));
  }, [host]);
}
export const TVEventHandler = Object.freeze({
  addListener(handler: (event: TVEvent) => void) {
    return { remove: input().subscribe(handler) };
  },
});
