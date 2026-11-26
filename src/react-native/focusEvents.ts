import type { NativePlacement } from "./nativeHostContext";
import type { NativeViewHandle } from "./nativeViewHandle";

/** Focus observations use committed host ancestry, including clipping/portals.
 * Targets are the measurable host instances used by current React Native. */
export interface NativeFocusEvent {
  readonly target: NativeViewHandle;
  readonly currentTarget: NativeViewHandle;
  readonly nativeEvent: { readonly target: number | undefined; readonly timestamp: number };
  readonly type: "focus" | "blur";
  readonly timeStamp: number;
  readonly bubbles: true;
  readonly cancelable: false;
  readonly defaultPrevented: boolean;
  stopPropagation(): void;
  isPropagationStopped(): boolean;
  preventDefault(): void;
  isDefaultPrevented(): boolean;
  persist(): void;
}

export interface NativeFocusHandlers {
  readonly onFocus?: (event: NativeFocusEvent) => void;
  readonly onFocusCapture?: (event: NativeFocusEvent) => void;
  readonly onBlur?: (event: NativeFocusEvent) => void;
  readonly onBlurCapture?: (event: NativeFocusEvent) => void;
}

export type NativeFocusBinding = NativeFocusHandlers | (() => NativeFocusHandlers);

export function dispatchNativeFocus(
  placements: ReadonlyMap<string, NativePlacement>,
  id: string,
  focused: boolean,
  active: () => boolean,
): void {
  const target = placements.get(id);
  if (!target?.view) return;
  const path: { placement: NativePlacement; handlers: NativeFocusHandlers | undefined }[] = [],
    seen = new Set<NativePlacement>();
  let node: NativePlacement | undefined = target;
  while (node && !seen.has(node)) {
    const binding = node.focusEvents;
    // Snapshot the committed handlers before capture starts. A reentrant commit
    // must not replace a callback on the currently dispatching ancestry.
    path.push({ placement: node, handlers: typeof binding === "function" ? binding() : binding });
    seen.add(node);
    node = node.parentID !== undefined ? placements.get(node.parentID) : undefined;
  }
  let stopped = false,
    prevented = false;
  const timestamp = Date.now();
  const invoke = (
    { placement: current, handlers }: (typeof path)[number],
    key: keyof NativeFocusHandlers,
  ) => {
    if (stopped || !active() || !current.view) return;
    const handler = handlers?.[key];
    if (!handler) return;
    handler({
      target: target.view!,
      currentTarget: current.view,
      nativeEvent: { target: target.nativeTag, timestamp },
      type: focused ? "focus" : "blur",
      timeStamp: timestamp,
      bubbles: true,
      cancelable: false,
      get defaultPrevented() {
        return prevented;
      },
      stopPropagation() {
        stopped = true;
      },
      isPropagationStopped: () => stopped,
      preventDefault() {
        prevented = true;
      },
      isDefaultPrevented: () => prevented,
      persist() {},
    });
  };
  for (const current of [...path].reverse())
    invoke(current, focused ? "onFocusCapture" : "onBlurCapture");
  for (const current of path) invoke(current, focused ? "onFocus" : "onBlur");
}
