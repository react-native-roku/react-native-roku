import {
  createElement,
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { makeMutable } from "../animation/sharedValue";
import { ScrollViewLayer, View, type NativeElementProps } from "./primitives";
import { useNativeHost } from "./nativeHostContext";
import { findNodeHandle, type NativeViewHandle } from "./nativeViewHandle";
import { RokuHostError } from "../scene/sceneGraph.types";
import { flattenStyle, type NativeStyle } from "./styleSheet";
export interface ScrollEvent {
  readonly nativeEvent: {
    readonly contentOffset: { x: number; y: number };
    readonly contentSize: { width: number; height: number };
    readonly layoutMeasurement: { width: number; height: number };
  };
}
export interface ScrollViewProps extends NativeElementProps {
  readonly children?: ReactNode;
  readonly horizontal?: boolean;
  readonly contentContainerStyle?: NativeStyle;
  readonly onContentSizeChange?: (width: number, height: number) => void;
  readonly onScroll?: (event: ScrollEvent) => void;
  readonly scrollEventThrottle?: number;
  readonly showsVerticalScrollIndicator?: boolean;
  readonly showsHorizontalScrollIndicator?: boolean;
  readonly scrollEnabled?: boolean;
}
export interface ScrollViewHandle extends NativeViewHandle {
  scrollTo(
    options?: { x?: number; y?: number; animated?: boolean } | number,
    y?: number,
    animated?: boolean,
  ): void;
  scrollToEnd(options?: { animated?: boolean }): void;
  getScrollResponder(): ScrollViewHandle;
  getScrollableNode(): number | null;
  flashScrollIndicators(): void;
}
const geometry = (event: unknown) =>
  (
    event as {
      nativeEvent: {
        layout: { x: number; y: number; width: number; height: number };
      };
    }
  ).nativeEvent.layout;
export const ScrollView = forwardRef<ScrollViewHandle, ScrollViewProps>((props, forwardedRef) => {
  const host = useNativeHost(),
    outer = useRef<NativeViewHandle>(null),
    latest = useRef(props);
  latest.current = props;
  const x = useMemo(() => makeMutable(0), []),
    y = useMemo(() => makeMutable(0), []);
  const offsetX = useSyncExternalStore(x.subscribe, x.get),
    offsetY = useSyncExternalStore(y.subscribe, y.get);
  const viewport = useRef<{ width: number; height: number } | null>(null),
    content = useRef<{ width: number; height: number } | null>(null);
  const pending = useRef<{
    x?: number;
    y?: number;
    animated?: boolean;
  } | null>(null);
  const generation = useRef(0),
    live = useRef(true),
    [indicator, setIndicator] = useState(false),
    indicatorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flash = () => {
    const frame = viewport.current,
      extent = content.current;
    if (
      !frame ||
      !extent ||
      !(
        (extent.height > frame.height && latest.current.showsVerticalScrollIndicator !== false) ||
        (extent.width > frame.width && latest.current.showsHorizontalScrollIndicator !== false)
      )
    )
      return;
    setIndicator(true);
    clearTimeout(indicatorTimer.current);
    indicatorTimer.current = setTimeout(() => {
      if (live.current) host.runSync(() => setIndicator(false));
    }, 800);
  };
  const apply = (options: { x?: number; y?: number; animated?: boolean }) => {
    for (const value of [options.x, options.y])
      if (value != null && (!Number.isFinite(value) || value < 0))
        throw new RokuHostError(
          "C05_SCROLL_OFFSET",
          "Scroll offsets must be finite and nonnegative",
        );
    pending.current = options;
    if (!viewport.current || !content.current) return;
    const nextX = Math.min(
        options.x ?? x.get(),
        Math.max(0, content.current.width - viewport.current.width),
      ),
      nextY = Math.min(
        options.y ?? y.get(),
        Math.max(0, content.current.height - viewport.current.height),
      );
    pending.current = null;
    host.runSync(() => {
      if (options.animated) {
        x.value = {
          kind: "timing",
          to: nextX,
          duration: 220,
          easing: (value) => 1 - (1 - value) ** 3,
        };
        y.value = {
          kind: "timing",
          to: nextY,
          duration: 220,
          easing: (value) => 1 - (1 - value) ** 3,
        };
      } else {
        x.value = nextX;
        y.value = nextY;
      }
      flash();
    });
  };
  useImperativeHandle(forwardedRef, () => {
    if (!outer.current)
      throw new RokuHostError("C05_SCROLL_ATTACHMENT", "The scroll owner has not attached");
    const handle = Object.assign(outer.current, {
      scrollTo(
        options: { x?: number; y?: number; animated?: boolean } | number = {},
        legacyY?: number,
        animated?: boolean,
      ) {
        apply(typeof options === "number" ? { x: options, y: legacyY, animated } : options);
      },
      scrollToEnd(options: { animated?: boolean } = {}) {
        apply({
          [latest.current.horizontal ? "x" : "y"]: Number.MAX_SAFE_INTEGER,
          animated: options.animated,
        });
      },
      getScrollResponder(): ScrollViewHandle {
        return handle;
      },
      getScrollableNode() {
        return findNodeHandle(outer.current);
      },
      flashScrollIndicators() {
        host.runSync(flash);
      },
    });
    return handle;
  }, [host]);
  useLayoutEffect(() => {
    const token = ++generation.current;
    void host.whenCommitted().then(
      () => {
        if (!live.current || token !== generation.current || !content.current || !viewport.current)
          return;
        latest.current.onScroll?.({
          nativeEvent: {
            contentOffset: { x: offsetX, y: offsetY },
            contentSize: content.current,
            layoutMeasurement: viewport.current,
          },
        });
      },
      () => undefined,
    );
  }, [host, offsetX, offsetY]);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
      x.cancel();
      y.cancel();
      clearTimeout(indicatorTimer.current);
    };
  }, [x, y]);
  const sizeChanged = () => apply(pending.current ?? { x: x.get(), y: y.get(), animated: false });
  const extent = content.current,
    frame = viewport.current;
  const vertical =
    frame && extent && extent.height > frame.height && props.showsVerticalScrollIndicator !== false;
  const horizontal =
    frame && extent && extent.width > frame.width && props.showsHorizontalScrollIndicator !== false;
  const viewportStyle = flattenStyle(props.style);
  const contentStyle = flattenStyle(props.contentContainerStyle);
  // Keep Yoga's edge precedence for authored logical insets and reversed flow.
  const translateContent =
    (viewportStyle?.flexDirection == null ||
      viewportStyle.flexDirection === "column" ||
      viewportStyle.flexDirection === "row") &&
    (viewportStyle?.flexWrap == null || viewportStyle.flexWrap === "nowrap") &&
    viewportStyle?.alignItems !== "baseline" &&
    contentStyle?.start == null &&
    contentStyle?.insetInlineStart == null;
  const indicatorY = vertical ? ((frame.height - 8) * offsetY) / extent.height : 0;
  const indicatorX = horizontal ? ((frame.width - 8) * offsetX) / extent.width : 0;
  return createElement(
    View,
    {
      ...props,
      ref: outer,
      nativeID: props.nativeID,
      testID: props.testID,
      focusable: props.focusable,
      onFocus: props.onFocus,
      onFocusCapture: props.onFocusCapture,
      onBlur: props.onBlur,
      onBlurCapture: props.onBlurCapture,
      style: [{ flexGrow: 1, flexShrink: 1, overflow: "hidden" }, viewportStyle],
      onLayout(event) {
        const value = geometry(event);
        const previous = viewport.current;
        viewport.current = { width: value.width, height: value.height };
        props.onLayout?.(event);
        if (!previous || previous.width !== value.width || previous.height !== value.height)
          sizeChanged();
      },
    },
    createElement(
      ScrollViewLayer,
      {
        scrollTranslation: translateContent ? [-offsetX, -offsetY] : undefined,
        style: [
          {
            flexShrink: 0,
            alignSelf: props.horizontal ? "flex-start" : "stretch",
            flexDirection: props.horizontal ? "row" : "column",
          },
          contentStyle,
          {
            position: "relative",
            left: translateContent ? 0 : -offsetX,
            top: translateContent ? 0 : -offsetY,
          },
        ],
        onLayout(event) {
          const value = geometry(event),
            previous = content.current;
          content.current = { width: value.width, height: value.height };
          if (!previous || previous.width !== value.width || previous.height !== value.height) {
            props.onContentSizeChange?.(value.width, value.height);
            sizeChanged();
          }
        },
      },
      props.children,
    ),
    vertical
      ? createElement(ScrollViewLayer, {
          scrollTranslation: [0, indicatorY],
          style: {
            position: "absolute",
            right: 2,
            top: 4,
            width: 3,
            height: Math.max(12, ((frame.height - 8) * frame.height) / extent.height),
            backgroundColor: "#ffffff88",
            opacity: indicator ? 1 : 0,
          },
        })
      : null,
    horizontal
      ? createElement(ScrollViewLayer, {
          scrollTranslation: [indicatorX, 0],
          style: {
            position: "absolute",
            bottom: 2,
            left: 4,
            height: 3,
            width: Math.max(12, ((frame.width - 8) * frame.width) / extent.width),
            backgroundColor: "#ffffff88",
            opacity: indicator ? 1 : 0,
          },
        })
      : null,
  );
});
ScrollView.displayName = "RokuScrollView";
