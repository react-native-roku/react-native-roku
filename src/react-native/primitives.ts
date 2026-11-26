import {
  createElement,
  forwardRef,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useMemo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ForwardedRef,
  type ForwardRefExoticComponent,
  type ReactNode,
  type ReactElement,
  type RefAttributes,
  Children,
  isValidElement,
} from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import {
  generatedSceneFields,
  plainBackgroundLayout,
  type SceneElementProps,
} from "../renderer/SceneRoot";
import type { LayoutStyle } from "../layout/flexLayout";
import { hasOnlyBuiltinObjectPrototypeFields } from "../layout/layoutReuse";
import { RokuHostError } from "../scene/sceneGraph.types";
import { RoundedBorder } from "../graphics/RoundedBorder";
import {
  useNativeHost,
  type FocusPresentation,
  type NativeHostContextValue,
} from "./nativeHostContext";
import {
  createNativeViewHandle,
  bindNativeViewHandle,
  findNodeHandle,
  type NativeViewHandle,
} from "./nativeViewHandle";
import { flattenStyle, rokuColor, type NativeStyle } from "./styleSheet";
import { hasRoundedCorners, uniformBorder, type NativeGraphics } from "../graphics/surfaces";
import {
  scalarPressableKeyOrder,
  usesScalarPressableStyle,
  type CompiledPressableKeys,
} from "./compilerPressable";
import type { NativeFocusBinding, NativeFocusHandlers } from "./focusEvents";
import { normalizeAccessibility, type AccessibilityProps } from "./accessibility";

// SceneGraph host names are strings outside React's DOM JSX namespace.
type CreateSceneElement = (
  type: string,
  props: SceneElementProps & { children?: ReactNode },
) => ReturnType<typeof jsx>;
const sceneElement = jsx as CreateSceneElement;
const sceneElementWithChildren = jsxs as CreateSceneElement;
declare const __DEV__: boolean;
const reuseBackgroundElements = typeof __DEV__ !== "undefined" && !__DEV__;
const backgroundElements = new Map<string | number, ReactElement>();
const defaultAccessibility = normalizeAccessibility({});
const borderEdges = [
  ["Top", "borderTopWidth", "borderTopColor"],
  ["Bottom", "borderBottomWidth", "borderBottomColor"],
  ["Left", "borderLeftWidth", "borderLeftColor"],
  ["Right", "borderRightWidth", "borderRightColor"],
] as const;

function plainBackground(color: unknown) {
  // Development React elements retain their rendering owner.
  const cacheable =
    reuseBackgroundElements && (typeof color === "string" || typeof color === "number");
  const previous = cacheable ? backgroundElements.get(color) : undefined;
  if (previous) return previous;
  const element = createElement("rectangle", {
    key: "background",
    fields: plainBackgroundFields(color),
    layout: plainBackgroundLayout,
  } satisfies SceneElementProps & { key: string });
  if (cacheable && backgroundElements.size < 64) backgroundElements.set(color, element);
  return element;
}

const backgroundFieldsByColor = new Map<string | number, Readonly<{ color: string }>>();

function plainBackgroundFields(color: unknown) {
  const cacheable = typeof color === "string" || typeof color === "number";
  const previous = cacheable ? backgroundFieldsByColor.get(color) : undefined;
  if (previous) return previous;
  const fields = generatedSceneFields({ color: rokuColor(color) });
  if (cacheable && backgroundFieldsByColor.size < 64) backgroundFieldsByColor.set(color, fields);
  return fields;
}

export interface NativeElementProps extends NativeFocusHandlers, AccessibilityProps {
  readonly children?: ReactNode;
  readonly style?: NativeStyle;
  readonly className?: string;
  readonly onLayout?: (event: unknown) => void;
  readonly nativeID?: string;
  readonly testID?: string;
  readonly focusable?: boolean;
  readonly accessible?: boolean;
  readonly accessibilityLabel?: string;
  readonly accessibilityRole?: string;
  readonly pointerEvents?: string;
  readonly importantForAccessibility?: string;
  readonly accessibilityElementsHidden?: boolean;
  readonly "aria-hidden"?: boolean;
  readonly nextFocusUp?: number | null;
  readonly nextFocusRight?: number | null;
  readonly nextFocusDown?: number | null;
  readonly nextFocusLeft?: number | null;
}
interface NativeTextProps extends NativeElementProps {
  readonly numberOfLines?: number;
  readonly allowFontScaling?: boolean;
  readonly ellipsizeMode?: "tail" | "head" | "middle" | "clip";
  readonly onPress?: () => void;
}

export function useElement(props: NativeElementProps, ref: ForwardedRef<NativeViewHandle>) {
  return useNativeElement(useNativeHost(), props, ref, props.style);
}

function useNativeIdentity(
  host: NativeHostContextValue,
  nativeID: string | undefined,
  ref: ForwardedRef<NativeViewHandle>,
) {
  const reactId = useId();
  const id = nativeID ?? reactId;
  const { handle, fields, bind, read } = useMemo(() => {
    const handle = createNativeViewHandle(id, host);
    return {
      handle,
      fields: generatedSceneFields({ id }),
      bind: () => bindNativeViewHandle(handle),
      read: () => handle,
    };
  }, [host, id]);
  useLayoutEffect(bind, [bind]);
  useImperativeHandle(ref, read, [read]);
  return { id, handle, fields };
}

function primitiveStyle(
  props: Pick<NativeElementProps, "className">,
  nativeStyle: NativeStyle,
): LayoutStyle {
  if (props.className)
    throw new RokuHostError(
      "C05_NATIVEWIND",
      `Class ${props.className} reached a primitive without style interop`,
    );
  return flattenStyle(nativeStyle) ?? {};
}

function nativeLayout(
  { id, handle }: ReturnType<typeof useNativeIdentity>,
  nativeTag: number | null,
  props: Omit<NativeElementProps, "style" | "children">,
  style: LayoutStyle,
  disabled: boolean | undefined,
  plainText?: boolean,
  stableFocus?: NativeFocusBinding,
) {
  if (plainText)
    return {
      id,
      nativeTag,
      view: handle,
      style,
      accessibility: defaultAccessibility,
      importantForAccessibility: "auto",
      accessibilityElementsHidden: false,
      pointerEvents: style.pointerEvents ?? "auto",
    };
  return {
    id,
    nativeTag,
    view: handle,
    focusEvents:
      stableFocus ??
      (props.onFocus || props.onFocusCapture || props.onBlur || props.onBlurCapture
        ? {
            onFocus: props.onFocus,
            onFocusCapture: props.onFocusCapture,
            onBlur: props.onBlur,
            onBlurCapture: props.onBlurCapture,
          }
        : undefined),
    style,
    onLayout: props.onLayout,
    focusable: props.focusable,
    accessibilityLabel: props.accessibilityLabel,
    accessibility: normalizeAccessibility(props, disabled),
    importantForAccessibility: props.importantForAccessibility ?? "auto",
    accessibilityElementsHidden: props["aria-hidden"] ?? props.accessibilityElementsHidden ?? false,
    accessible: props.accessible,
    pointerEvents: props.pointerEvents ?? style.pointerEvents ?? "auto",
    testID: props.testID,
    focusTargets:
      props.nextFocusUp !== undefined ||
      props.nextFocusRight !== undefined ||
      props.nextFocusDown !== undefined ||
      props.nextFocusLeft !== undefined
        ? {
            up: props.nextFocusUp,
            right: props.nextFocusRight,
            down: props.nextFocusDown,
            left: props.nextFocusLeft,
          }
        : undefined,
  };
}

function useNativeElement(
  host: NativeHostContextValue,
  props: Omit<NativeElementProps, "style" | "children">,
  ref: ForwardedRef<NativeViewHandle>,
  nativeStyle: NativeStyle,
  disabled?: boolean,
  plainText = false,
) {
  const identity = useNativeIdentity(host, props.nativeID, ref);
  const style = primitiveStyle(props, nativeStyle);
  const nativeTag = findNodeHandle(identity.handle);
  return {
    id: identity.id,
    nativeTag,
    style,
    layout: nativeLayout(identity, nativeTag, props, style, disabled, plainText),
    fields: identity.fields,
  };
}

export function background(style: LayoutStyle, graphics?: NativeGraphics): ReactNode[] {
  const result: ReactNode[] = [];
  if (hasRoundedCorners(style)) {
    if (!graphics?.effects)
      throw new RokuHostError(
        "C03_ROUNDED_SURFACE",
        "Rounded surfaces require an OS 16 OpenGL Effect capability",
      );
    let border = 0,
      asymmetric = false;
    try {
      border = uniformBorder(style);
    } catch (error) {
      if (!(error instanceof RokuHostError) || error.code !== "C03_ROUNDED_BORDER") throw error;
      asymmetric = true;
    }
    return [
      createElement(
        "rectangle",
        {
          key: "rounded-surface",
          fields: { color: rokuColor(style.backgroundColor ?? "transparent") },
          layout: { decoration: "surface", border },
        },
        createElement("effect", {
          fields: {
            borderWidth: border,
            borderColor: rokuColor(style.borderColor ?? "black"),
          },
          layout: { resource: true, radiusStyle: style, insetBorder: border },
        }),
      ),
      ...(asymmetric ? [createElement(RoundedBorder, { key: "asymmetric-border", style })] : []),
    ];
  }
  if (style.backgroundColor != null) result.push(plainBackground(style.backgroundColor));
  for (const [edge, widthField, colorField] of borderEdges) {
    const border = style[widthField] ?? style.borderWidth ?? 0;
    if (typeof border !== "number" || !Number.isFinite(border) || border < 0)
      throw new RokuHostError("C03_BORDER", "Border widths must be finite and nonnegative");
    if (border > 0) {
      const color = rokuColor(style[colorField] ?? style.borderColor ?? "black");
      result.push(
        createElement("rectangle", {
          key: `border-${edge}`,
          fields: { color },
          layout: { decoration: edge, thickness: border },
        } satisfies SceneElementProps & { key: string }),
      );
    }
  }
  return result;
}

// Every View retains its native group. The upstream collapse hint never removes
// ref/measurement identity in this renderer, including collapsable={false}.
type ViewProps = NativeElementProps & { readonly collapsable?: boolean };
export const ScrollViewLayer = forwardRef<
  NativeViewHandle,
  ViewProps & { readonly scrollTranslation?: readonly [number, number] }
>((props, ref) => {
  const element = useElement(props, ref),
    host = useNativeHost();
  return createElement(
    "group",
    {
      fields: element.fields,
      layout: props.scrollTranslation
        ? { ...element.layout, scrollTranslation: props.scrollTranslation }
        : element.layout,
    },
    ...background(element.style, host.graphics),
    element.style.overflow === "hidden" && hasRoundedCorners(element.style)
      ? createElement(SurfaceClip, { style: element.style }, props.children)
      : props.children,
  );
});
export const View: ForwardRefExoticComponent<ViewProps & RefAttributes<NativeViewHandle>> =
  ScrollViewLayer;
View.displayName = "RokuView";

export function SurfaceClip({
  style,
  children,
}: {
  readonly style: LayoutStyle;
  readonly children?: ReactNode;
}) {
  const host = useNativeHost(),
    [ready, setReady] = useState(0),
    dimensions = useRef(new Map<number, { width: boolean; height: boolean }>());
  const masks = host.graphics?.cornerMasks;
  const composed = host.graphics?.composedMasks;
  const composedDimensions = useRef({ width: false, height: false });
  if (composed) {
    const observe = (axis: "width" | "height", value: unknown) => {
      if (!(Number(value) > 0)) return;
      composedDimensions.current[axis] = true;
      if (composedDimensions.current.width && composedDimensions.current.height) setReady(15);
    };
    return createElement(
      "maskGroup",
      {
        layout: {
          decoration: "background",
          paintWrapper: true,
          radiusStyle: style,
          composedMask: true,
        },
        events: {
          maskBitmapWidth: (value) => observe("width", value),
          maskBitmapHeight: (value) => observe("height", value),
        },
      } satisfies SceneElementProps,
      createElement(
        "group",
        { layout: { decoration: "background", paintWrapper: true, maskReadiness: ready === 15 } },
        children,
      ),
    );
  }
  if (!masks)
    throw new RokuHostError(
      "C03_ROUNDED_CLIP",
      "Rounded child clipping requires the OpenGL corner-mask assets",
    );
  let content: ReactNode = createElement(
    "group",
    {
      layout: {
        decoration: "background",
        paintWrapper: true,
        maskReadiness: ready === 15,
      },
    },
    children,
  );
  for (let corner = 3; corner >= 0; corner--) {
    const current = corner;
    const observe = (axis: "width" | "height", value: unknown) => {
      if (!(Number(value) > 0)) return;
      const entry = dimensions.current.get(current) ?? {
        width: false,
        height: false,
      };
      entry[axis] = true;
      dimensions.current.set(current, entry);
      if (entry.width && entry.height) setReady((previous) => previous | (1 << current));
    };
    content = createElement(
      "maskGroup",
      {
        fields: { maskUri: masks[corner] },
        layout: {
          decoration: "background",
          paintWrapper: true,
          corner,
          radiusStyle: style,
        },
        events: {
          maskBitmapWidth: (value) => observe("width", value),
          maskBitmapHeight: (value) => observe("height", value),
        },
      } satisfies SceneElementProps,
      content,
    );
  }
  return content;
}

export const Text = forwardRef<NativeViewHandle, NativeTextProps>((props, ref) => {
  const plain =
    Object.keys(props).length === 2 &&
    Object.hasOwn(props, "style") &&
    Object.hasOwn(props, "children") &&
    (typeof props.children === "string" || typeof props.children === "number");
  const element = useNativeElement(useNativeHost(), props, ref, props.style, undefined, plain);
  if (props.onPress)
    throw new RokuHostError("C07_TEXT_PRESS", "Pressable text needs an input adapter");
  if (props.ellipsizeMode && props.ellipsizeMode !== "tail")
    throw new RokuHostError(
      "C04_TEXT_ELLIPSIS",
      `Ellipsis mode ${props.ellipsizeMode} needs conformance`,
    );
  const raster =
    Number(element.style.letterSpacing ?? 0) !== 0 ||
    element.style.textShadowColor != null ||
    element.style.textShadowRadius != null;
  let inline = false;
  const children = props.children;
  const scalarText =
    typeof children === "string"
      ? children
      : typeof children === "number"
        ? String(children)
        : undefined;
  if (children != null && scalarText === undefined) {
    Children.forEach(children, (child) => {
      if (isValidElement(child)) inline = true;
    });
  }
  const directText = raster ? undefined : scalarText;
  return sceneElement(
    inline && !raster
      ? props.numberOfLines === 1
        ? "multiStyleLabel"
        : "inlineText"
      : raster
        ? "poster"
        : "label",
    {
      fields: element.fields,
      layout: Object.assign(element.layout, {
        textRaster: raster,
        inlineRaster: inline && raster,
        numberOfLines: props.numberOfLines ?? 0,
        scalarText: directText,
      }),
      children: directText === undefined ? children : undefined,
    },
  );
});
Text.displayName = "RokuText";

interface PressableState {
  readonly pressed: boolean;
  readonly focused: boolean;
  readonly hovered: boolean;
}
interface PressableEvent {
  readonly nativeEvent: {
    readonly target: number | undefined;
    readonly timestamp: number;
  };
}
export interface NativePressableProps extends Omit<NativeElementProps, "style" | "children"> {
  /** Experimental early presentation for already-mounted native focus moves.
   * The ordinary React focus callback still owns the final render. */
  readonly unstable_tvFocusPresentation?: FocusPresentation;
  readonly style?: NativeStyle | ((state: PressableState) => NativeStyle);
  readonly children?: ReactNode | ((state: PressableState) => ReactNode);
  readonly disabled?: boolean;
  readonly hasTVPreferredFocus?: boolean;
  readonly delayLongPress?: number;
  readonly onPress?: (event: PressableEvent) => void;
  readonly onPressIn?: (event: PressableEvent) => void;
  readonly onPressOut?: (event: PressableEvent) => void;
  readonly onLongPress?: (event: PressableEvent) => void;
}

type PressableProps = NativePressableProps & RefAttributes<NativeViewHandle>;
type PressableLayoutCache = {
  readonly handle: NativeViewHandle;
  readonly nativeTag: number | null;
  readonly style: LayoutStyle;
  readonly content: ReactNode;
  readonly metadata: {
    readonly keys: CompiledPressableKeys;
    readonly values: readonly unknown[];
  };
  readonly output: ReactElement;
};
type PressableBinding = {
  props: PressableProps;
  focusEvents?: () => NativeFocusHandlers;
  output?: PressableLayoutCache;
};
// Branded JSX uses ordinary data props. Inherited layout or input fields
// require the public primitive's full prop-reading path.
function comparePressableInputs(
  props: PressableProps,
  baseline?: PressableLayoutCache["metadata"],
): PressableLayoutCache["metadata"] | undefined {
  const keys = scalarPressableKeyOrder(props);
  if (
    !keys ||
    Object.getPrototypeOf(props) !== Object.prototype ||
    !hasOnlyBuiltinObjectPrototypeFields()
  )
    return undefined;
  if (baseline?.keys === keys) {
    for (let i = 0; i < keys.length; i++) {
      if (!Object.is(props[keys[i]], baseline.values[i])) return undefined;
    }
    return baseline;
  }
  if (baseline) return undefined;
  const values: unknown[] = [];
  for (const name of keys) {
    const value = props[name];
    if (
      value != null &&
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      typeof value !== "number"
    )
      return undefined;
    values.push(value);
  }
  return { keys, values };
}

export function Pressable(props: PressableProps) {
  const host = useNativeHost(),
    input = host.input;
  if (!input)
    throw new RokuHostError("C07_INPUT_HOST", "Pressable requires a mounted native input port");
  const current = useRef<PressableBinding | null>(null);
  const binding = (current.current ??= { props });
  useInsertionEffect(() => {
    binding.props = props;
  }, [binding, props]);
  const [state, setState] = useState<PressableState>({
    pressed: false,
    focused: false,
    hovered: false,
  });
  const style = typeof props.style === "function" ? props.style(state) : props.style;
  const identity = useNativeIdentity(host, props.nativeID, props.ref ?? null);
  const paint = primitiveStyle(props, style);
  const nativeTag = findNodeHandle(identity.handle);
  const { id } = identity;
  const focusable = !props.disabled && props.focusable !== false;
  const nativeProps = useMemo(
    () => ({
      fields: generatedSceneFields({ id, focusable }),
      events: Object.freeze({
        focusedChild: (value: unknown) => input.observeFocus(id, value === id),
      }),
    }),
    [id, focusable, input],
  );
  const event = () => ({
    nativeEvent: {
      target: nativeTag ?? undefined,
      timestamp: Date.now(),
    },
  });
  useLayoutEffect(
    () =>
      input.register(id, {
        tag: nativeTag ?? undefined,
        enabled: () => {
          const placement = host.placement(id);
          return (
            host.active &&
            !!placement &&
            placement.visible !== false &&
            placement.modalBlocked !== true &&
            !binding.props.disabled &&
            binding.props.focusable !== false
          );
        },
        focus(focused) {
          setState((value) => (value.focused === focused ? value : { ...value, focused }));
          if (focused) host.announceFocus(id);
          host.dispatchFocus(id, focused);
        },
        pressed(pressed) {
          setState((value) => (value.pressed === pressed ? value : { ...value, pressed }));
          (pressed ? binding.props.onPressIn : binding.props.onPressOut)?.(event());
        },
        activate: () => binding.props.onPress?.(event()),
        get longPress() {
          return binding.props.onLongPress ? () => binding.props.onLongPress?.(event()) : undefined;
        },
        get longPressDelay() {
          return binding.props.delayLongPress;
        },
      }),
    [input, id, host],
  );
  useEffect(() => {
    if (!props.hasTVPreferredFocus || props.disabled || props.focusable === false) return;
    let canceled = false;
    void host.whenCommitted().then(
      () => {
        if (!canceled) host.requestFocus(id);
      },
      () => undefined,
    );
    return () => {
      canceled = true;
    };
  }, [host, id, props.hasTVPreferredFocus, props.disabled, props.focusable]);
  const previous = binding.output;
  if (
    previous?.handle === identity.handle &&
    previous.nativeTag === nativeTag &&
    previous.style === paint &&
    comparePressableInputs(props, previous.metadata) &&
    previous.content === props.children
  )
    return previous.output;

  const metadata = usesScalarPressableStyle(paint) ? comparePressableInputs(props) : undefined;
  const cacheable = metadata && typeof props.children !== "function" ? metadata : undefined;
  const base = nativeLayout(
    identity,
    nativeTag,
    props,
    paint,
    props.disabled,
    false,
    cacheable ? (binding.focusEvents ??= () => binding.props) : undefined,
  );
  const layout = props.unstable_tvFocusPresentation
    ? { ...base, focusPresentation: props.unstable_tvFocusPresentation }
    : base;
  const rounded = hasRoundedCorners(paint);
  const simplePaint =
    !rounded &&
    paint.borderWidth == null &&
    paint.borderTopWidth == null &&
    paint.borderBottomWidth == null &&
    paint.borderLeftWidth == null &&
    paint.borderRightWidth == null;
  const backgroundFields =
    simplePaint && paint.backgroundColor != null
      ? plainBackgroundFields(paint.backgroundColor)
      : undefined;
  const decorations = simplePaint ? undefined : background(paint, host.graphics);
  const content = typeof props.children === "function" ? props.children(state) : props.children;
  const child =
    paint.overflow === "hidden" && rounded
      ? createElement(SurfaceClip, { style: paint }, content)
      : content;
  const { fields, events } = nativeProps;
  let output;
  if (!decorations?.length) {
    output = sceneElement("group", { fields, layout, events, backgroundFields, children: child });
  } else {
    decorations.push(child);
    output = sceneElementWithChildren("group", { fields, layout, events, children: decorations });
  }
  binding.output = cacheable
    ? {
        handle: identity.handle,
        nativeTag,
        style: paint,
        content,
        metadata: cacheable,
        output,
      }
    : undefined;
  return output;
}
Pressable.displayName = "RokuPressable";
