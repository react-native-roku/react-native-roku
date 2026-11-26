import {
  createElement,
  forwardRef,
  Fragment,
  isValidElement,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ForwardedRef,
  type ReactElement,
  type RefAttributes,
} from "react";
import { View, type NativeElementProps } from "./primitives";
import {
  ScrollView,
  type ScrollEvent,
  type ScrollViewHandle,
  type ScrollViewProps,
} from "./scrollView";
import { flattenStyle, type NativeStyle } from "./styleSheet";
import { useNativeHost } from "./nativeHostContext";
import { RokuHostError } from "../scene/sceneGraph.types";
import { InteractionManager } from "./interactionManager";
import {
  useCollectionViewability,
  viewabilityConfigIdentity,
  type ViewabilityConfig,
  type ViewabilityInfo,
  type ViewToken,
} from "./flatListViewability";
export type { ViewabilityConfig, ViewabilityInfo, ViewToken } from "./flatListViewability";
type Boundary = ReactElement | ComponentType<Record<string, never>> | null;
export interface FlatListSeparators {
  highlight(): void;
  unhighlight(): void;
  updateProps(select: "leading" | "trailing", newProps: Readonly<Record<string, unknown>>): void;
}
export interface FlatListRenderItemInfo<T> {
  readonly item: T;
  readonly index: number;
  readonly separators: FlatListSeparators;
}
export interface FlatListProps<T> extends NativeElementProps {
  readonly data: readonly T[];
  readonly keyExtractor?: (item: T, index: number) => string;
  readonly renderItem: (info: FlatListRenderItemInfo<T>) => ReactElement | null;
  readonly getItemLayout?: (
    data: readonly T[] | null | undefined,
    index: number,
  ) => { length: number; offset: number; index?: number };
  readonly ListHeaderComponent?: Boundary;
  readonly ListHeaderComponentStyle?: NativeStyle;
  readonly ListFooterComponent?: Boundary;
  readonly ListFooterComponentStyle?: NativeStyle;
  readonly ListEmptyComponent?: Boundary;
  /** Component props are open, as upstream updateProps supplies consumer-authored fields.
   * leadingItem is the original item, or an entire row array with numColumns > 1. */
  readonly ItemSeparatorComponent?: ReactElement | ComponentType<any> | null;
  /** This renderer rerenders the retained window when any prop changes. */
  readonly extraData?: unknown;
  readonly viewabilityConfig?: ViewabilityConfig;
  readonly onViewableItemsChanged?: (info: ViewabilityInfo<T>) => void;
  /** Native groups in the retained React window are always preserved. */
  readonly removeClippedSubviews?: boolean;
  readonly contentContainerStyle?: NativeStyle;
  readonly initialNumToRender?: number;
  readonly initialScrollIndex?: number;
  readonly windowSize?: number;
  readonly maxToRenderPerBatch?: number;
  readonly updateCellsBatchingPeriod?: number;
  readonly renderScrollComponent?: (props: ScrollViewProps) => ReactElement;
  readonly showsVerticalScrollIndicator?: boolean;
  readonly showsHorizontalScrollIndicator?: boolean;
  readonly scrollEventThrottle?: number;
  readonly onScroll?: (event: ScrollEvent) => void;
  readonly onContentSizeChange?: (width: number, height: number) => void;
  readonly onScrollToIndexFailed?: (info: {
    averageItemLength: number;
    index: number;
    highestMeasuredFrameIndex: number;
  }) => void;
  readonly maintainVisibleContentPosition?: { minIndexForVisible?: number };
  readonly horizontal?: boolean;
  /** Vertical rows of equal-height items; geometry and scroll indices address rows. */
  readonly numColumns?: number;
  readonly columnWrapperStyle?: NativeStyle;
}
export interface FlatListHandle {
  scrollToIndex(options: {
    index: number;
    animated?: boolean;
    viewOffset?: number;
    viewPosition?: number;
  }): void;
  scrollToOffset(options: { offset: number; animated?: boolean }): void;
  scrollToEnd(options?: { animated?: boolean }): void;
  getNativeScrollRef(): ScrollViewHandle | null;
  recordInteraction(): void;
}
function boundary(value?: Boundary): ReactElement | null {
  return value == null ? null : isValidElement(value) ? value : createElement(value);
}

function itemKey<T>(item: T, index: number): string {
  if (typeof item === "object" && item !== null) {
    const keyed = item as { key?: unknown; id?: unknown };
    if (keyed.key != null) return String(keyed.key);
    if (keyed.id != null) return String(keyed.id);
  }
  return String(index);
}

interface CollectionWindow {
  readonly first: number;
  readonly last: number;
}

type SeparatorUpdate = (newProps: Readonly<Record<string, unknown>>) => void;
interface CellProps<T> {
  readonly item: T;
  readonly index: number;
  readonly cellKey: string;
  readonly previousKey?: string;
  readonly horizontal: boolean;
  readonly separator?: FlatListProps<T>["ItemSeparatorComponent"];
  readonly renderItem: FlatListProps<T>["renderItem"];
  readonly onLayout: NativeElementProps["onLayout"];
  readonly updates: Map<string, SeparatorUpdate>;
}

/** Separator state and callback authority belong to one mounted keyed cell.
 * A retired callback cannot target a later cell that reuses the same key. */
function FlatListCell<T>(props: CellProps<T>) {
  const host = useNativeHost(),
    current = useRef(props),
    live = useRef(false),
    [separatorProps, setSeparatorProps] = useState<Readonly<Record<string, unknown>>>({
      highlighted: false,
    });
  const update = useCallback<SeparatorUpdate>(
    (next) => {
      if (live.current && host.active) setSeparatorProps((previous) => ({ ...previous, ...next }));
    },
    [host],
  );
  useLayoutEffect(() => {
    current.current = props;
  });
  useLayoutEffect(() => {
    live.current = true;
    props.updates.set(props.cellKey, update);
    return () => {
      live.current = false;
      if (props.updates.get(props.cellKey) === update) props.updates.delete(props.cellKey);
    };
  }, [props.updates, props.cellKey, update]);
  const separators = useMemo<FlatListSeparators>(() => {
    const submit = (
      keys: readonly (string | undefined)[],
      next: Readonly<Record<string, unknown>>,
    ) => {
      const owner = current.current;
      if (!live.current || !host.active || owner.updates.get(owner.cellKey) !== update) return;
      host.runSync(() => {
        for (const key of keys) if (key != null) owner.updates.get(key)?.(next);
      });
    };
    return {
      highlight: () =>
        submit([current.current.cellKey, current.current.previousKey], { highlighted: true }),
      unhighlight: () =>
        submit([current.current.cellKey, current.current.previousKey], { highlighted: false }),
      updateProps: (select, next) =>
        submit(
          [select === "leading" ? current.current.previousKey : current.current.cellKey],
          next,
        ),
    };
  }, [host, update]);
  const separator =
    props.separator == null
      ? null
      : isValidElement(props.separator)
        ? props.separator
        : createElement(props.separator, { ...separatorProps, leadingItem: props.item });
  return createElement(
    View,
    {
      style: props.horizontal ? { flexDirection: "row", flexShrink: 0 } : undefined,
      onLayout: props.onLayout,
    },
    props.renderItem({ item: props.item, index: props.index, separators }),
    separator,
  );
}

/** Visible rows have priority. Grow the remaining retained window in bounded
 * JS batches, without replacing the existing keyed/native rows. Every queued
 * task belongs to one committed data/window generation. */
function useBatchedWindow(
  target: CollectionWindow,
  visible: CollectionWindow,
  measured: boolean,
  keys: readonly string[],
  batch: number,
  period: number,
) {
  const host = useNativeHost();
  const [retained, setRetained] = useState(target);
  const committedKeys = useRef(keys);
  const committedVisible = useRef<CollectionWindow | undefined>(undefined);
  const trimFirst = Math.max(retained.first, target.first);
  const trimLast = Math.min(retained.last, target.last);
  const surplus = trimFirst - retained.first + retained.last - trimLast;
  // A nearby scroll can reuse the mounted window for its visible update. One
  // retiring edge row can go with the next offscreen batch instead of forcing
  // two structural commits. Larger jumps and changed keys use the usual window.
  const sameKeys =
    keys === committedKeys.current ||
    (keys.length === committedKeys.current.length &&
      keys.every((key, index) => key === committedKeys.current[index]));
  const mayDeferTrim = surplus === 1 && retained.last <= keys.length && sameKeys;
  const previous = committedVisible.current;
  const nearby =
    previous &&
    sameKeys &&
    (visible.first !== previous.first || visible.last !== previous.last) &&
    visible.first < trimLast &&
    trimFirst < visible.last;
  // Directional focus can only choose mounted controls. Keep the adjacent
  // rows available when scrolling within the existing window, even if
  // repeated scroll commits postpone the background overscan batch.
  const adjacent = nearby
    ? {
        first: Math.max(target.first, visible.first - 1),
        last: Math.min(target.last, visible.last + 1),
      }
    : visible;
  const window = !measured
    ? target
    : nearby && (adjacent.first < trimFirst || adjacent.last > trimLast)
      ? { first: Math.min(trimFirst, adjacent.first), last: Math.max(trimLast, adjacent.last) }
      : retained.first > visible.first || retained.last < visible.last
        ? visible
        : mayDeferTrim
          ? retained
          : { first: trimFirst, last: trimLast };
  const { first, last } = window;
  useLayoutEffect(() => {
    committedKeys.current = keys;
    committedVisible.current = measured ? visible : undefined;
  });
  useLayoutEffect(() => {
    if (retained.first !== first || retained.last !== last) {
      setRetained({ first, last });
      return;
    }
    if (!measured || (first === target.first && last === target.last)) return;
    let cancelled = false;
    let deferred: ReturnType<typeof InteractionManager.runAfterInteractions> | undefined;
    const timer = setTimeout(() => {
      deferred = InteractionManager.runAfterInteractions(() => {
        if (cancelled || !host.active) return;
        const insideFirst = Math.max(first, target.first);
        const insideLast = Math.min(last, target.last);
        const before = insideFirst - target.first,
          after = target.last - insideLast;
        // Split work across both edges, then use any spare allowance on the
        // unfinished edge. The visible interval can never be removed here.
        const leading = Math.min(before, Math.ceil(batch / 2));
        const trailing = Math.min(after, batch - leading);
        const extra = Math.min(before - leading, batch - leading - trailing);
        host.runSync(() =>
          setRetained({ first: insideFirst - leading - extra, last: insideLast + trailing }),
        );
      });
    }, period);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      deferred?.cancel();
    };
  }, [host, measured, first, last, target.first, target.last, retained, keys, batch, period]);
  return window;
}

function FlatListWindow<T>(props: FlatListProps<T>, forwardedRef: ForwardedRef<FlatListHandle>) {
  const horizontal = props.horizontal === true,
    axis = horizontal ? "x" : "y",
    dimension = horizontal ? "width" : "height";
  const host = useNativeHost(),
    scroll = useRef<ScrollViewHandle>(null),
    contentExtent = useRef<number | undefined>(undefined),
    latest = useRef(props);
  latest.current = props;
  const batch = props.maxToRenderPerBatch ?? 10;
  const period = props.updateCellsBatchingPeriod ?? 50;
  if (
    !Number.isSafeInteger(batch) ||
    batch <= 0 ||
    !Number.isFinite(period) ||
    period < 0 ||
    period > 0x7fffffff
  )
    throw new RokuHostError(
      "C05_LIST_BATCH",
      "Collection batches require a positive integer limit and a finite nonnegative timer delay",
    );
  const initialIndex = useRef(props.initialScrollIndex ?? 0).current;
  const initialPending = useRef(initialIndex !== 0);
  if (!Number.isSafeInteger(initialIndex) || initialIndex < 0)
    throw new RokuHostError(
      "C05_LIST_INDEX",
      "An initial collection index must be a nonnegative integer",
    );
  if (
    initialPending.current &&
    (!props.getItemLayout || (props.data.length > 0 && initialIndex >= props.data.length))
  )
    throw new RokuHostError(
      "C05_LIST_INITIAL_LAYOUT",
      "An initial collection index requires declared geometry and an in-range item",
    );
  const anchorMinimum = props.maintainVisibleContentPosition?.minIndexForVisible ?? 0;
  if (!Number.isSafeInteger(anchorMinimum) || anchorMinimum < 0)
    throw new RokuHostError(
      "C05_LIST_ANCHOR",
      "A collection anchor index must be a nonnegative integer",
    );
  const [observedOffset, setOffset] = useState(() =>
      initialPending.current && props.data.length > 0
        ? props.getItemLayout!(props.data, initialIndex).offset -
          props.getItemLayout!(props.data, 0).offset
        : 0,
    ),
    [viewport, setViewport] = useState(host.viewport[dimension]),
    [measuredHeader, setHeader] = useState(0),
    [headerMeasured, setHeaderMeasured] = useState(props.ListHeaderComponent == null),
    [measurementVersion, setMeasurementVersion] = useState(0),
    [endJump, setEndJump] = useState(false);
  const header = props.ListHeaderComponent == null ? 0 : measuredHeader;
  const endGeneration = useRef(0),
    live = useRef(true);
  const [viewportMeasured, setViewportMeasured] = useState(false);
  const measurements = useRef(new Map<string, number>()),
    separatorUpdates = useRef(new Map<string, SeparatorUpdate>()).current,
    firstRows = Math.max(1, Math.floor(props.initialNumToRender ?? 6));
  const anchor = useRef<{
    keys: readonly string[];
    key?: string;
    intra: number;
    minimum: number;
    enabled: boolean;
  } | null>(null);
  const keys = useMemo(
    () =>
      props.data.map((item, index) => props.keyExtractor?.(item, index) ?? itemKey(item, index)),
    [props.data, props.keyExtractor],
  );
  if (new Set(keys).size !== keys.length)
    throw new RokuHostError("C05_LIST_KEY", "Collection keys must be unique");
  const style = flattenStyle(props.contentContainerStyle),
    padding = Number(
      (horizontal
        ? (style?.paddingLeft ?? style?.paddingHorizontal)
        : (style?.paddingTop ?? style?.paddingVertical)) ??
        style?.padding ??
        0,
    );
  if (!Number.isFinite(padding) || padding < 0)
    throw new RokuHostError(
      "C05_LIST_INSET",
      "Collection leading padding must be finite and nonnegative",
    );
  const layout = useMemo(() => {
    const known = [...measurements.current.values()],
      average = known.length
        ? known.reduce((sum, value) => sum + value, 0) / known.length
        : Math.max(1, host.viewport[dimension] / firstRows);
    const start =
      props.data.length && props.getItemLayout ? props.getItemLayout(props.data, 0).offset : 0;
    let cursor = 0;
    const frames = props.data.map((_item, index) => {
      const declared = props.getItemLayout?.(props.data, index),
        next =
          props.ItemSeparatorComponent && index + 1 < props.data.length
            ? props.getItemLayout?.(props.data, index + 1)
            : undefined,
        measured = measurements.current.get(keys[index]);
      const length =
          (declared && next ? next.offset - declared.offset : declared?.length) ??
          measured ??
          average,
        position = declared ? declared.offset - start : cursor;
      const alignmentLength = declared?.length ?? length;
      if (
        !Number.isFinite(length) ||
        length < 0 ||
        !Number.isFinite(alignmentLength) ||
        alignmentLength < 0 ||
        !Number.isFinite(position) ||
        position < cursor - 0.5
      )
        throw new RokuHostError(
          "C05_LIST_GEOMETRY",
          "Collection geometry must be finite and ordered",
        );
      cursor = position + length;
      return {
        offset: position,
        length,
        alignmentLength,
        measured: declared != null || measured != null,
      };
    });
    return { frames, total: cursor, average };
  }, [
    props.data,
    props.getItemLayout,
    props.ItemSeparatorComponent,
    keys,
    measurementVersion,
    firstRows,
    host,
    dimension,
  ]);
  const previousAnchor = anchor.current,
    anchorFrame =
      !initialPending.current &&
      props.maintainVisibleContentPosition &&
      previousAnchor?.enabled &&
      previousAnchor.key &&
      previousAnchor.keys !== keys &&
      previousAnchor.minimum === anchorMinimum
        ? layout.frames[keys.indexOf(previousAnchor.key)]
        : undefined;
  // Select the new keyed window before reconciliation retires the old one.
  // The layout effect below submits the same offset to the scroll owner.
  const offset = anchorFrame
    ? Math.max(0, header + padding + anchorFrame.offset + previousAnchor!.intra)
    : observedOffset;
  const budget = Math.max(viewport, (viewport * Math.max(0, (props.windowSize ?? 5) - 1)) / 2);
  const contentOffset = offset - header - padding,
    relative = Math.max(0, contentOffset),
    visibleExtentEnd = Math.max(0, contentOffset + viewport),
    start = layout.frames.findIndex(
      (frame) => frame.offset + frame.length >= Math.max(0, relative - budget),
    );
  const desiredFirst = endJump
      ? Math.max(
          0,
          props.data.length -
            Math.max(firstRows, Math.ceil(viewport / layout.average) * (props.windowSize ?? 5)),
        )
      : !viewportMeasured
        ? Math.min(initialIndex, props.data.length)
        : start < 0
          ? Math.max(0, props.data.length - firstRows)
          : start,
    end = layout.frames.findIndex((frame) => frame.offset > relative + viewport + budget);
  const desiredLast = Math.min(
    props.data.length,
    endJump
      ? props.data.length
      : !viewportMeasured
        ? desiredFirst + firstRows
        : end < 0
          ? props.data.length
          : Math.max(desiredFirst + firstRows, end),
  );
  const visibleStart = layout.frames.findIndex((frame) => frame.offset + frame.length > relative);
  const visibleEnd = layout.frames.findIndex((frame) => frame.offset >= visibleExtentEnd);
  const visibleFirst = Math.max(
    desiredFirst,
    Math.min(desiredLast, visibleStart < 0 ? Math.max(0, props.data.length - 1) : visibleStart),
  );
  const visibleLast = Math.max(
    visibleFirst,
    Math.min(desiredLast, visibleEnd < 0 ? props.data.length : visibleEnd),
  );
  const { first, last } = useBatchedWindow(
    { first: desiredFirst, last: desiredLast },
    { first: visibleFirst, last: visibleLast },
    viewportMeasured,
    keys,
    batch,
    period,
  );
  const mounted = props.data.slice(first, last);
  const before = layout.frames[first]?.offset ?? 0,
    after = Math.max(
      0,
      layout.total -
        (layout.frames[last - 1]?.offset ?? 0) -
        (layout.frames[last - 1]?.length ?? 0),
    );
  const windowState = useRef({
    layout,
    header,
    padding,
    viewport,
    viewportMeasured,
    offset,
    first,
    keys,
  });
  windowState.current = {
    layout,
    header,
    padding,
    viewport,
    viewportMeasured,
    offset,
    first,
    keys,
  };
  const pendingAnchor = useRef<number | null>(null);
  const scrollToOffset = useCallback(
    (options: { offset: number; animated?: boolean }, preserveAnchorWindow = false) => {
      if (!Number.isFinite(options.offset) || options.offset < 0)
        throw new RokuHostError(
          "C05_SCROLL_OFFSET",
          "Collection offsets must be finite and nonnegative",
        );
      pendingAnchor.current = null;
      initialPending.current = false;
      endGeneration.current++;
      host.runSync(() => {
        setEndJump(false);
        if (!options.animated) {
          const extent = contentExtent.current,
            current = windowState.current;
          // A repeated clamped native command need not emit another scroll
          // event. Keep the selected window at that same committed clamp.
          setOffset(
            !preserveAnchorWindow && extent != null && current.viewportMeasured
              ? Math.min(options.offset, Math.max(0, extent - current.viewport))
              : options.offset,
          );
        }
        scroll.current?.scrollTo({
          [axis]: options.offset,
          animated: options.animated,
        });
      });
    },
    [host, axis],
  );
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      endGeneration.current++;
    };
  }, []);
  useLayoutEffect(() => {
    if (
      !initialPending.current ||
      !viewportMeasured ||
      (props.ListHeaderComponent != null && !headerMeasured) ||
      props.data.length === 0
    )
      return;
    let cancelled = false;
    // An empty list can receive data before ScrollView's new content measurement.
    // Wait for that committed extent rather than clamping the initial command
    // against the old empty content and retiring it prematurely.
    void host.whenCommitted().then(
      () => {
        if (cancelled || !live.current || !host.active || !initialPending.current) return;
        const current = windowState.current,
          frame = current.layout.frames[initialIndex];
        if (frame)
          scrollToOffset({
            offset: current.header + current.padding + frame.offset,
            animated: false,
          });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [
    host,
    viewportMeasured,
    headerMeasured,
    props.ListHeaderComponent,
    props.data.length,
    initialIndex,
    layout,
    header,
    padding,
    scrollToOffset,
  ]);
  useLayoutEffect(() => {
    if (!endJump) return;
    const token = ++endGeneration.current;
    void host.whenCommitted().then(
      () => {
        if (
          !live.current ||
          token !== endGeneration.current ||
          !layout.frames.slice(first, last).every((frame) => frame.measured)
        )
          return;
        // Measured tail rows can correct the estimated total. Submit End against
        // that committed content before releasing the forced destination window.
        scroll.current?.scrollToEnd({ animated: false });
        void host.whenCommitted().then(
          () => {
            if (live.current && token === endGeneration.current)
              host.runSync(() => setEndJump(false));
          },
          () => {},
        );
      },
      () => {},
    );
  }, [endJump, first, last, layout, host]);
  useLayoutEffect(() => {
    const currentKeys = new Set(keys);
    for (const key of measurements.current.keys())
      if (!currentKeys.has(key)) measurements.current.delete(key);
  }, [keys]);
  useLayoutEffect(() => {
    const previous = anchor.current;
    const visible = layout.frames.findIndex(
      (frame, index) =>
        index >= anchorMinimum &&
        frame.offset + frame.length > relative &&
        frame.offset < visibleExtentEnd,
    );
    anchor.current = {
      keys,
      key: visible < 0 ? undefined : keys[visible],
      intra: offset - header - padding - (layout.frames[visible]?.offset ?? 0),
      minimum: anchorMinimum,
      enabled: props.maintainVisibleContentPosition != null,
    };
    if (
      initialPending.current ||
      !props.maintainVisibleContentPosition ||
      !previous?.enabled ||
      !previous.key ||
      previous.keys === keys ||
      previous.minimum !== anchorMinimum
    )
      return;
    const index = keys.indexOf(previous.key),
      frame = layout.frames[index];
    if (!frame) return;
    const desired = Math.max(0, header + padding + frame.offset + previous.intra);
    // The selected keyed anchor already uses the arriving layout. Preserve
    // that window until its new native content measurement can apply the
    // pending command against the grown extent.
    scrollToOffset({ offset: desired, animated: false }, true);
    pendingAnchor.current = desired;
  }, [
    keys,
    layout,
    offset,
    header,
    padding,
    relative,
    visibleExtentEnd,
    props.maintainVisibleContentPosition,
    anchorMinimum,
    viewport,
    scrollToOffset,
  ]);
  const recordInteraction = useCollectionViewability(
    props.viewabilityConfig,
    props.onViewableItemsChanged,
    props.extraData,
    {
      data: props.data,
      keys,
      frames: layout.frames,
      first,
      last,
      offset,
      viewport,
      leading: header + padding,
    },
    () =>
      viewportMeasured &&
      (props.ListHeaderComponent == null || headerMeasured) &&
      !initialPending.current &&
      !endJump,
  );
  useImperativeHandle(
    forwardedRef,
    () => ({
      scrollToOffset,
      recordInteraction,
      scrollToIndex(options) {
        const { layout, header, padding, viewport } = windowState.current,
          index = Math.floor(options.index),
          frame = layout.frames[index];
        if (!frame || !Number.isFinite(options.index) || index !== options.index)
          throw new RokuHostError("C05_LIST_INDEX", "Collection index is outside the current data");
        const knownThrough = layout.frames.slice(0, index + 1).every((value) => value.measured);
        if (!knownThrough) {
          latest.current.onScrollToIndexFailed?.({
            averageItemLength: layout.average,
            index,
            highestMeasuredFrameIndex: layout.frames.findIndex((value) => !value.measured) - 1,
          });
          return;
        }
        scrollToOffset({
          offset: Math.max(
            0,
            header +
              padding +
              frame.offset -
              (viewport - frame.alignmentLength) *
                Math.min(1, Math.max(0, options.viewPosition ?? 0)) -
              (options.viewOffset ?? 0),
          ),
          animated: options.animated,
        });
      },
      scrollToEnd(options) {
        const { layout, header, padding, viewport } = windowState.current;
        pendingAnchor.current = null;
        initialPending.current = false;
        host.runSync(() => {
          // Mount the destination window for an immediate jump, just as
          // scrollToOffset does. The native host retains footer/inset clamping.
          if (!options?.animated) {
            setEndJump(true);
            setOffset(
              Math.max(0, (contentExtent.current ?? header + padding + layout.total) - viewport),
            );
          }
          scroll.current?.scrollToEnd(options);
        });
      },
      getNativeScrollRef: () => scroll.current,
    }),
    [scrollToOffset, recordInteraction],
  );
  const scrollProps: ScrollViewProps & { ref: typeof scroll } = {
    ...props,
    ref: scroll,
    style: props.style,
    contentContainerStyle: props.contentContainerStyle,
    focusable: props.focusable,
    testID: props.testID,
    nativeID: props.nativeID,
    showsVerticalScrollIndicator: horizontal ? false : props.showsVerticalScrollIndicator,
    showsHorizontalScrollIndicator: horizontal ? props.showsHorizontalScrollIndicator : false,
    scrollEventThrottle: props.scrollEventThrottle,
    onLayout(event) {
      const length = (event as { nativeEvent: { layout: { width: number; height: number } } })
        .nativeEvent.layout[dimension];
      if (length > 0) {
        setViewport(length);
        setViewportMeasured(true);
      }
      props.onLayout?.(event);
    },
    onScroll(event) {
      host.runSync(() => setOffset(event.nativeEvent.contentOffset[axis]));
      props.onScroll?.(event);
    },
    onContentSizeChange(width, height) {
      contentExtent.current = horizontal ? width : height;
      const desired = pendingAnchor.current;
      if (desired != null) scrollToOffset({ offset: desired, animated: false });
      props.onContentSizeChange?.(width, height);
    },
    children: createElement(
      Fragment,
      {},
      props.ListHeaderComponent
        ? createElement(
            View,
            {
              style: [horizontal ? { flexShrink: 0 } : undefined, props.ListHeaderComponentStyle],
              onLayout(event) {
                setHeaderMeasured(true);
                setHeader(
                  (event as { nativeEvent: { layout: { width: number; height: number } } })
                    .nativeEvent.layout[dimension],
                );
              },
            },
            boundary(props.ListHeaderComponent),
          )
        : null,
      props.data.length === 0
        ? boundary(props.ListEmptyComponent)
        : createElement(
            Fragment,
            {},
            createElement(View, {
              key: "before",
              style: { [dimension]: before, flexShrink: 0 },
              onLayout(event) {
                if (props.ListHeaderComponent == null) return;
                // The following cell's committed origin includes the header's
                // outer margins, including percentages resolved by layout.
                const origin = (event as { nativeEvent: { layout: { x: number; y: number } } })
                  .nativeEvent.layout[axis];
                setHeader(origin - padding);
                setHeaderMeasured(true);
              },
            }),
            ...mounted.map((item, local) => {
              const index = first + local,
                key = keys[index];
              return createElement(FlatListCell<T>, {
                key,
                item,
                index,
                cellKey: key,
                previousKey: keys[index - 1],
                horizontal,
                updates: separatorUpdates,
                separator: index + 1 < props.data.length ? props.ItemSeparatorComponent : undefined,
                renderItem: props.renderItem,
                onLayout(event) {
                  const length = (
                    event as { nativeEvent: { layout: { width: number; height: number } } }
                  ).nativeEvent.layout[dimension];
                  if (
                    !props.getItemLayout &&
                    length > 0 &&
                    measurements.current.get(key) !== length
                  ) {
                    measurements.current.set(key, length);
                    setMeasurementVersion((value) => value + 1);
                  }
                },
              });
            }),
            createElement(View, {
              key: "after",
              style: { [dimension]: after, flexShrink: 0 },
            }),
          ),
      props.ListFooterComponent
        ? createElement(
            View,
            { style: [horizontal ? { flexShrink: 0 } : undefined, props.ListFooterComponentStyle] },
            boundary(props.ListFooterComponent),
          )
        : null,
    ),
  };
  return props.renderScrollComponent
    ? props.renderScrollComponent(scrollProps)
    : createElement(ScrollView, scrollProps);
}

const FlatListRows = forwardRef(FlatListWindow) as <T>(
  props: FlatListProps<T> & RefAttributes<FlatListHandle>,
) => ReactElement;

/** Match the pinned FlatList's row adapter: item callbacks use original indices,
 * while virtualization, separators, layout and scroll commands address rows. */
function FlatListInner<T>(props: FlatListProps<T>, forwardedRef: ForwardedRef<FlatListHandle>) {
  const columns = props.numColumns ?? 1;
  const mountedColumns = useRef(props.numColumns).current;
  const mountedHorizontal = useRef(props.horizontal === true).current;
  if (mountedHorizontal !== (props.horizontal === true))
    throw new RokuHostError(
      "C05_LIST_AXIS_CHANGE",
      "Changing the collection axis requires a new key prop on FlatList",
    );
  if (!Number.isSafeInteger(columns) || columns < 1)
    throw new RokuHostError("C05_LIST_COLUMNS", "numColumns must be a positive safe integer");
  if (mountedColumns !== props.numColumns)
    throw new RokuHostError(
      "C05_LIST_COLUMNS_CHANGE",
      "Changing numColumns is not supported. Change the key prop on FlatList to remount it",
    );
  if (columns > 1 && props.horizontal)
    throw new RokuHostError("C05_LIST_AXIS", "numColumns does not support horizontal grids");
  if (columns === 1 && props.columnWrapperStyle)
    throw new RokuHostError(
      "C05_LIST_COLUMNS_STYLE",
      "columnWrapperStyle is not supported for single-column lists",
    );
  const configIdentity = viewabilityConfigIdentity(props.viewabilityConfig),
    mountedViewability = useRef({
      configIdentity,
      callback: props.onViewableItemsChanged != null,
    }).current;
  if (
    configIdentity !== mountedViewability.configIdentity ||
    mountedViewability.callback !== (props.onViewableItemsChanged != null)
  )
    throw new RokuHostError(
      "C05_LIST_VIEWABILITY_CHANGE",
      "Changing viewability configuration or callback nullability requires a new key prop on FlatList",
    );
  if (
    (props as FlatListProps<T> & { viewabilityConfigCallbackPairs?: unknown })
      .viewabilityConfigCallbackPairs != null
  )
    throw new RokuHostError(
      "C05_LIST_VIEWABILITY_PAIRS",
      "Multiple viewability callbacks are not supported by this collection profile",
    );
  const rows = useMemo(() => {
    const result: (readonly T[])[] = [];
    if (columns > 1)
      for (let index = 0; index < props.data.length; index += columns)
        result.push(props.data.slice(index, index + columns));
    return result;
  }, [props.data, columns]);
  const keyExtractor = useCallback(
    (row: readonly T[], index: number) =>
      row
        .map((item, column) => (props.keyExtractor ?? itemKey)(item, index * columns + column))
        .join(":"),
    [props.keyExtractor, columns],
  );
  const renderItem = useCallback(
    ({ item: row, index, separators }: FlatListRenderItemInfo<readonly T[]>) =>
      createElement(
        View,
        { style: [{ flexDirection: "row" }, props.columnWrapperStyle] },
        ...row.map((item, column) => {
          const element = props.renderItem({ item, index: index * columns + column, separators });
          return element == null ? null : createElement(Fragment, { key: column }, element);
        }),
      ),
    [props.renderItem, props.columnWrapperStyle, columns],
  );
  const getItemLayout = useMemo(
    () =>
      props.getItemLayout
        ? (_rows: readonly (readonly T[])[] | null | undefined, index: number) =>
            props.getItemLayout!(props.data, index)
        : undefined,
    [props.getItemLayout, props.data],
  );
  const onViewableItemsChanged = useCallback(
    (info: ViewabilityInfo<readonly T[]>) => {
      const expand = (tokens: readonly ViewToken<readonly T[]>[]): ViewToken<T>[] =>
        tokens.flatMap((token) =>
          token.item.map((item, column) => {
            const index = token.index * columns + column;
            return { ...token, item, index, key: (props.keyExtractor ?? itemKey)(item, index) };
          }),
        );
      props.onViewableItemsChanged?.({
        viewableItems: expand(info.viewableItems),
        changed: expand(info.changed),
      });
    },
    [props.onViewableItemsChanged, props.keyExtractor, columns],
  );
  if (columns === 1) return createElement(FlatListRows<T>, { ...props, ref: forwardedRef });
  return createElement(FlatListRows<readonly T[]>, {
    ...props,
    ref: forwardedRef,
    data: rows,
    onViewableItemsChanged: props.onViewableItemsChanged ? onViewableItemsChanged : undefined,
    keyExtractor,
    renderItem,
    getItemLayout,
  });
}
export const FlatList = forwardRef(FlatListInner) as <T>(
  props: FlatListProps<T> & RefAttributes<FlatListHandle>,
) => ReactElement;
