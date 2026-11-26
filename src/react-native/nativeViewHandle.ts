import type { NativeHostContextValue, NativePlacement } from "./nativeHostContext";
import { RokuHostError } from "../scene/sceneGraph.types";
import { affineBounds, inverseAffine, multiplyAffine } from "../layout/affine";

export interface NativeViewHandle {
  readonly nativeID: string;
  measure(
    callback: (
      x: number,
      y: number,
      width: number,
      height: number,
      pageX: number,
      pageY: number,
    ) => void,
  ): void;
  measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void;
  measureLayout(
    relative: NativeViewHandle,
    success: (x: number, y: number, width: number, height: number) => void,
    failure?: () => void,
  ): void;
  requestTVFocus(): void;
  /** Submit native focus; only the host's observation acknowledges ownership. */
  focus(): void;
  setNativeProps(props: Readonly<Record<string, unknown>>): void;
}

let nextNativeTag = 0;
type NativeLifetime = {
  tag: number;
  host: NativeHostContextValue;
  active: boolean;
  generation: number;
};
const tags = new WeakMap<object, NativeLifetime>();
const aliases = new WeakMap<object, () => NativeViewHandle | null>();
const boundTags = new Map<
  number,
  { handle: NativeViewHandle; lifetime: NativeLifetime; generation: number }
>();

/** Numeric requests use the mounted binding's generation, including before
 * asynchronous native placement. Abandoned render handles never enter this map. */
export function nativeViewFocusRequest(tag: number, host: NativeHostContextValue) {
  const entry = boundTags.get(tag);
  if (!entry || entry.lifetime.host !== host) return undefined;
  return {
    id: entry.handle.nativeID,
    view: entry.handle,
    isCurrent: () =>
      entry.lifetime.active &&
      host.active &&
      entry.lifetime.generation === entry.generation &&
      boundTags.get(tag) === entry,
  };
}

/** Forward composite native refs without opening their editing/scroll APIs.
 * Resolve lazily: a stable TextInput ref can change its underlying native ID. */
export function aliasNativeViewHandle<T extends NativeViewHandle>(
  handle: T,
  target: () => NativeViewHandle | null,
): T {
  aliases.set(handle, target);
  return handle;
}

/** A native tag belongs to its mounted root, independently of global service
 * binding order. Accessibility requests also honor the committed reader fence. */
export function requestNativeAccessibilityFocus(tag: number): void {
  const binding = boundTags.get(tag);
  if (!binding) return;
  const host = binding.lifetime.host;
  const target = nativeViewFocusRequest(tag, host);
  if (!target) return;
  host.requestFocus(target.id, target.view, () => {
    const placement = host.placement(target.id);
    return (
      target.isCurrent() && (placement?.view !== target.view || !placement.accessibilityHidden)
    );
  });
}

/** React effect replay may rebind the same handle. Retired work keeps the old
 * generation and cannot target another mount with an identical authored ID. */
export function bindNativeViewHandle(handle: NativeViewHandle): () => void {
  const entry = tags.get(handle);
  if (!entry) throw new RokuHostError("C03_VIEW_HANDLE", "Unknown native view handle");
  const generation = entry.generation;
  entry.active = true;
  boundTags.set(entry.tag, { handle, lifetime: entry, generation });
  return () => {
    if (entry.generation !== generation) return;
    entry.active = false;
    entry.generation++;
    boundTags.delete(entry.tag);
  };
}

/** Stable shadow-node identity, available before asynchronous native placement. */
export function findNodeHandle(instance: unknown): number | null {
  if (typeof instance === "number")
    return Number.isSafeInteger(instance) && instance > 0 ? instance : null;
  let seen: Set<object> | undefined;
  while (instance && typeof instance === "object" && aliases.has(instance)) {
    seen ??= new Set<object>();
    if (seen.has(instance)) return null;
    seen.add(instance);
    instance = aliases.get(instance)!();
  }
  if (!instance || typeof instance !== "object") return null;
  const entry = tags.get(instance);
  return entry?.active && entry.host.active ? entry.tag : null;
}

export function createNativeViewHandle(id: string, host: NativeHostContextValue): NativeViewHandle {
  const lifetime = { tag: ++nextNativeTag, host, active: true, generation: 0 };
  const active = (generation = lifetime.generation) =>
    lifetime.active && host.active && generation === lifetime.generation;
  const read = (callback: (placement: NativePlacement) => void, failure?: () => void) => {
    const generation = lifetime.generation;
    if (!active(generation)) return;
    const placement = host.placement(id);
    if (placement?.view === handle) callback(placement);
    else
      void host.whenCommitted().then(
        () => {
          if (!active(generation)) return;
          const next = host.placement(id);
          if (next?.view === handle) callback(next);
          else failure?.();
        },
        () => {
          if (active(generation)) failure?.();
        },
      );
  };
  const handle: NativeViewHandle = {
    nativeID: id,
    measure(callback) {
      read(({ local, global }) =>
        callback(local.x, local.y, global.width, global.height, global.x, global.y),
      );
    },
    measureInWindow(callback) {
      read(({ global }) => callback(global.x, global.y, global.width, global.height));
    },
    measureLayout(relative, success, failure) {
      if (tags.get(relative)?.host !== host || !tags.get(relative)?.active) {
        failure?.();
        return;
      }
      read(({ global, local, world }) => {
        if (!tags.get(relative)?.active) {
          failure?.();
          return;
        }
        const other = host.placement(relative.nativeID);
        const inverse = other?.world && inverseAffine(other.world);
        if (world && inverse) {
          const rect = affineBounds(multiplyAffine(inverse, world), local.width, local.height);
          success(rect.x, rect.y, rect.width, rect.height);
        } else if (world && other?.world) failure?.();
        else if (other)
          success(
            global.x - other.global.x,
            global.y - other.global.y,
            global.width,
            global.height,
          );
        else failure?.();
      }, failure);
    },
    requestTVFocus() {
      const generation = lifetime.generation;
      if (active(generation)) host.requestFocus(id, handle, () => active(generation));
    },
    focus() {
      const generation = lifetime.generation;
      if (active(generation)) host.requestFocus(id, handle, () => active(generation));
    },
    setNativeProps(props) {
      if (!active())
        throw new RokuHostError("RETIRED_VIEW", "A retired view cannot receive native props");
      host.setNativeProps(id, props);
    },
  };
  tags.set(handle, lifetime);
  return handle;
}
