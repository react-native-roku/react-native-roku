import { useCallback, useLayoutEffect, useRef } from "react";
import { useNativeHost } from "./nativeHostContext";
import { RokuHostError } from "../scene/sceneGraph.types";

export interface ViewToken<T = unknown> {
  readonly item: T;
  readonly key: string;
  readonly index: number;
  readonly isViewable: boolean;
}
export interface ViewabilityConfig {
  readonly minimumViewTime?: number;
  readonly viewAreaCoveragePercentThreshold?: number;
  readonly itemVisiblePercentThreshold?: number;
  readonly waitForInteraction?: boolean;
}
export interface ViewabilityInfo<T> {
  readonly viewableItems: ViewToken<T>[];
  readonly changed: ViewToken<T>[];
}
interface Frame {
  readonly offset: number;
  readonly alignmentLength: number;
  readonly measured: boolean;
}
export interface ViewabilitySnapshot<T> {
  readonly data: readonly T[];
  readonly keys: readonly string[];
  readonly frames: readonly Frame[];
  readonly first: number;
  readonly last: number;
  readonly offset: number;
  readonly viewport: number;
  readonly leading: number;
}

/** Validate the bounded public config and preserve undefined-vs-authored identity
 * for the same-value configuration invariant used by the pinned FlatList. */
export function viewabilityConfigIdentity(config: ViewabilityConfig | undefined): string {
  if (config === undefined) return "default";
  const area = config?.viewAreaCoveragePercentThreshold,
    item = config?.itemVisiblePercentThreshold,
    delay = config?.minimumViewTime;
  if (
    config == null ||
    (area != null) === (item != null) ||
    !Number.isFinite(area ?? item) ||
    (area ?? item)! < 0 ||
    (area ?? item)! > 100 ||
    (delay !== undefined && (!Number.isFinite(delay) || delay < 0 || delay > 0x7fffffff)) ||
    (config.waitForInteraction !== undefined && typeof config.waitForInteraction !== "boolean")
  )
    throw new RokuHostError(
      "C05_LIST_VIEWABILITY_CONFIG",
      "Viewability requires exactly one finite 0–100 threshold and an optional finite nonnegative timer delay",
    );
  return JSON.stringify([
    area ?? null,
    item ?? null,
    delay ?? null,
    config.waitForInteraction ?? null,
  ]);
}

/** Pure geometry follows the pinned ViewabilityHelper's integer pixel and
 * fully-visible rules. Only known metrics in the retained row range are read. */
export function computeViewableRows<T>(
  snapshot: ViewabilitySnapshot<T>,
  config: ViewabilityConfig,
) {
  const result: number[] = [],
    area = config.viewAreaCoveragePercentThreshold != null,
    threshold = (
      area ? config.viewAreaCoveragePercentThreshold : config.itemVisiblePercentThreshold
    )!;
  for (let index = snapshot.first; index < snapshot.last; index++) {
    const frame = snapshot.frames[index];
    if (!frame?.measured) continue;
    const top = Math.floor(snapshot.leading + frame.offset - snapshot.offset),
      bottom = Math.floor(top + frame.alignmentLength);
    if (top >= snapshot.viewport || bottom <= 0) continue;
    const entire = top >= 0 && bottom <= snapshot.viewport && bottom > top,
      pixels = Math.max(0, Math.min(bottom, snapshot.viewport) - Math.max(top, 0)),
      percentage = (100 * pixels) / (area ? snapshot.viewport : frame.alignmentLength);
    if (entire || percentage >= threshold) result.push(index);
  }
  return result;
}

/** A mounted collection owns every delayed set. Data/extraData replacement
 * retires its pending sets, while published key identity survives replacement.
 * Within a generation, timers use the pinned captured-set/current-index filter;
 * they do not promise uninterrupted dwell time. */
export class ViewabilityTracker<T> {
  readonly config: ViewabilityConfig;
  private interacted = false;
  private indices: readonly number[] = [];
  private published = new Map<string, ViewToken<T>>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private data: readonly T[] | undefined;
  private extraData: unknown;
  constructor(config: ViewabilityConfig | undefined) {
    this.config = Object.freeze({ ...(config ?? { viewAreaCoveragePercentThreshold: 0 }) });
  }
  recordInteraction() {
    this.interacted = true;
  }
  replaceData(data: readonly T[], extraData: unknown) {
    if (this.data === data && this.extraData === extraData) return;
    this.cancelTimers();
    this.indices = [];
    this.data = data;
    this.extraData = extraData;
  }
  update(snapshot: ViewabilitySnapshot<T>, callback: (info: ViewabilityInfo<T>) => void) {
    if (
      (this.config.waitForInteraction && !this.interacted) ||
      snapshot.data.length === 0 ||
      !snapshot.frames[0]?.measured
    )
      return;
    const indices = computeViewableRows(snapshot, this.config);
    if (
      indices.length === this.indices.length &&
      indices.every((value, i) => value === this.indices[i])
    )
      return;
    this.indices = indices;
    const publish = () => {
      const current = new Set(this.indices),
        next = new Map<string, ViewToken<T>>();
      for (const index of indices)
        if (current.has(index)) {
          const token = {
            item: snapshot.data[index],
            key: snapshot.keys[index],
            index,
            isViewable: true,
          };
          next.set(token.key, token);
        }
      const changed: ViewToken<T>[] = [];
      for (const [key, token] of next) if (!this.published.has(key)) changed.push(token);
      for (const [key, token] of this.published)
        if (!next.has(key)) changed.push({ ...token, isViewable: false });
      if (changed.length) {
        this.published = next;
        const info = { viewableItems: [...next.values()], changed, viewabilityConfig: this.config };
        callback(info);
      }
    };
    if (this.config.minimumViewTime) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        publish();
      }, this.config.minimumViewTime);
      this.timers.add(timer);
    } else publish();
  }
  private cancelTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
  dispose() {
    this.cancelTimers();
    this.indices = [];
    this.published.clear();
    this.interacted = false;
    this.data = undefined;
    this.extraData = undefined;
  }
}

export function useCollectionViewability<T>(
  config: ViewabilityConfig | undefined,
  callback: ((info: ViewabilityInfo<T>) => void) | undefined,
  extraData: unknown,
  snapshot: ViewabilitySnapshot<T>,
  ready: () => boolean,
) {
  const host = useNativeHost(),
    tracker = useRef<ViewabilityTracker<T> | null>(null),
    current = useRef<{
      snapshot: ViewabilitySnapshot<T>;
      callback: typeof callback;
      ready: typeof ready;
    } | null>(null),
    live = useRef(false),
    revision = useRef(0);
  if (tracker.current == null) tracker.current = new ViewabilityTracker<T>(config);
  const owner = tracker.current;
  const refresh = useCallback(() => {
    const request = ++revision.current;
    void host.whenCommitted().then(
      () => {
        const committed = current.current;
        if (
          !live.current ||
          !host.active ||
          request !== revision.current ||
          !committed?.callback ||
          !committed.ready()
        )
          return;
        owner.update(committed.snapshot, (info) => {
          if (live.current && host.active) current.current?.callback?.(info);
        });
      },
      () => {},
    );
  }, [host, owner]);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      current.current = null;
      revision.current++;
      owner.dispose();
    };
  }, [owner]);
  useLayoutEffect(() => {
    current.current = { snapshot, callback, ready };
    owner.replaceData(snapshot.data, extraData);
    if (callback) refresh();
  });
  return useCallback(() => {
    if (!live.current || !host.active) return;
    owner.recordInteraction();
    refresh();
  }, [host, owner, refresh]);
}
