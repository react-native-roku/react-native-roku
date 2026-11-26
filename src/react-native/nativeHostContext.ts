import { createContext, useContext, type ReactNode } from "react";
import type { LayoutRect } from "../layout/flexLayout";
import type { SceneHandle, SceneTreeElement } from "../renderer/SceneRoot";
import { RokuHostError } from "../scene/sceneGraph.types";
import type { NativeFocusRequestOrigin, NativeInput } from "./NativeInput";
import type { SvgAtlas } from "../vector/svg.types";
import type { NativeGraphics } from "../graphics/surfaces";
import type { Affine } from "../layout/affine";
import type { TextRasterProvider } from "../graphics/textRaster.types";
import type { TextEntryPort } from "../services/DeviceServices";
import type { NativeViewHandle } from "./nativeViewHandle";
import type { NativeFocusBinding } from "./focusEvents";
import type { AccessibilitySemantics } from "./accessibility";

export interface FocusPresentation {
  readonly focusedColor: string | number;
  readonly restingColor: string | number;
  readonly label?: { readonly nativeID: string; readonly text: string };
}

export interface NativePlacement {
  readonly parentID?: string;
  readonly view?: NativeViewHandle;
  readonly focusEvents?: NativeFocusBinding;
  readonly nativeTag?: number;
  readonly focusTargets?: Readonly<
    Partial<Record<"up" | "right" | "down" | "left", number | null>>
  >;
  readonly local: LayoutRect;
  readonly world?: Affine;
  readonly global: LayoutRect;
  /** Committed visibility includes hidden/display:none ancestors. */
  readonly visible?: boolean;
  /** Explicit native focus eligibility, independent of touch/accessibility exposure. */
  readonly focusable?: boolean;
  /** Modal isolation fences remote focus/input independently of touch hit testing. */
  readonly modalBlocked?: boolean;
  /** A containing Modal can close the active accessibility scope without taking focus. */
  readonly containsActiveModalScope?: boolean;
  readonly accessibilityHidden?: boolean;
  readonly accessibilityLabel?: string;
  readonly accessibility?: AccessibilitySemantics;
  readonly pointerEvents?: string;
  readonly handle: SceneHandle;
  readonly node?: SceneTreeElement;
}

export interface NativeHostContextValue {
  readonly active: boolean;
  readonly viewport: { width: number; height: number };
  readonly input?: NativeInput;
  readonly svgAtlas?: SvgAtlas;
  readonly graphics?: NativeGraphics;
  readonly raster?: TextRasterProvider;
  readonly textEntry?: TextEntryPort;
  portal(element: ReactNode, key: string): ReactNode;
  placement(id: string): NativePlacement | undefined;
  whenCommitted(): Promise<void>;
  runSync(work: () => void): void;
  cancelInput(): void;
  requestFocus(
    id: string,
    view?: NativeViewHandle,
    isCurrent?: () => boolean,
    origin?: NativeFocusRequestOrigin,
  ): void;
  dispatchFocus(id: string, focused: boolean): void;
  announceFocus(id: string): void;
  setNativeProps(id: string, props: Readonly<Record<string, unknown>>): void;
  /** Mechanical media commands; field observers remain the source of playback truth. */
  videoCommand(id: string, fields: Readonly<Record<string, string | number | boolean>>): void;
  audioCommand(id: string, fields: Readonly<Record<string, string | number | boolean>>): void;
}
export const NativeHostContext = createContext<NativeHostContextValue | null>(null);
export function useNativeHost(): NativeHostContextValue {
  const host = useContext(NativeHostContext);
  if (!host)
    throw new RokuHostError("C01_HOST", "RN primitives must render inside a Roku native root");
  return host;
}
