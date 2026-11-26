import { RokuHostError } from "../scene/sceneGraph.types";

export type NativeRemoteKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "select"
  | "back"
  | "playPause"
  | "rewind"
  | "fastForward"
  | "options";
export type NativeFocusRequestOrigin = "imperative" | "directional";
type NativeDirection = Extract<NativeRemoteKey, "up" | "down" | "left" | "right">;
const directions: readonly NativeRemoteKey[] = ["up", "right", "down", "left"];
const MAX_QUEUED_DIRECTIONS = 8;
const FOCUS_OBSERVATION_TIMEOUT_MS = 250;
type QueuedSelect = { key: "select"; phase: "down" | "up"; gesture: object };

export interface NativeRemoteEvent {
  readonly key: NativeRemoteKey;
  readonly phase: "down" | "repeat" | "up";
}
export interface TVEvent {
  readonly tag?: number;
  readonly eventType: NativeRemoteKey | "cancel";
  readonly reason?: "focus-request" | "inactive" | "text-entry";
  readonly eventKeyAction: 0 | 1;
  readonly repeat: boolean;
}
export interface NativeInputTarget {
  readonly tag?: number;
  enabled(): boolean;
  focus(focused: boolean): void;
  pressed(pressed: boolean): void;
  activate(): void;
  longPress?(): void;
  readonly longPressDelay?: number;
}

/** Focus is observed from the host. A gainFocus request never changes this owner. */
export class NativeInput {
  private readonly targets = new Map<string, NativeInputTarget>();
  private readonly observers = new Set<(event: TVEvent) => unknown>();
  private readonly backHandlers = new Map<() => boolean, object>();
  private focused: string | null = null;
  private held: {
    id: string;
    target: NativeInputTarget;
    long: boolean;
    timer?: ReturnType<typeof setTimeout>;
  } | null = null;
  private retired = false;
  private active = true;
  private gestureRevision = 0;
  private focusRevision = 0;
  private requestedFocus: {
    id: string;
    origin: NativeFocusRequestOrigin;
    from: string | null;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  // A request may have moved real focus even if its observation went missing.
  private recovery: { from: string | null } | null = null;
  private readonly queuedDirections: ({ key: NativeDirection; repeat: boolean } | QueuedSelect)[] =
    [];
  private queuedSelect: object | null = null;
  private selectDown = false;
  private blockedSelect = false;
  private renderer: ((work: () => void) => void) | undefined;
  private navigation: ((direction: NativeDirection) => boolean) | undefined;
  isTargetEnabled(id: string): boolean {
    return this.targets.get(id)?.enabled() === true;
  }
  /** A refused/retired native request must not leave remote input fenced. */
  cancelFocusRequest(id: string): void {
    if (this.requestedFocus?.id === id) this.retireFocusRequest();
  }
  /** Visibility/modal/disabled changes can retire a held press without a
   * native focus change. Revealing the same target cannot revive that press. */
  reconcileTargets(): void {
    if (this.retired) return;
    if (this.requestedFocus !== null && !this.isTargetEnabled(this.requestedFocus.id))
      this.retireFocusRequest();
    if (!this.held || this.held.target.enabled()) return;
    this.batch(() => {
      this.blockedSelect ||= this.selectDown;
      this.cancelHeld(true);
    });
  }
  requestFocus(
    id: string,
    origin: NativeFocusRequestOrigin = "imperative",
    sample?: (from: string | null, confirm: (observedID: string) => void) => void,
  ): void {
    if (
      this.retired ||
      !this.targets.has(id) ||
      (id === this.focused && this.requestedFocus === null && this.recovery === null)
    )
      return;
    if (origin === "imperative") this.clearQueuedInput();
    this.clearFocusRequest();
    const from = this.navigationFocusID;
    const deadline = performance.now() + FOCUS_OBSERVATION_TIMEOUT_MS;
    const expire = () => {
      if (this.requestedFocus?.timer !== timer) return;
      // A native timer scheduled during a delayed SDK turn can fire before
      // this request has had its full observation interval.
      const remaining = deadline - performance.now();
      if (remaining > 0) {
        timer = setTimeout(expire, Math.ceil(remaining));
        this.requestedFocus.timer = timer;
        return;
      }
      this.abandonFocusRequest();
      const recovery = this.recovery;
      sample?.(from, (observedID) => {
        if (this.recovery === recovery && this.active && !this.requestedFocus)
          this.observeFocus(observedID, true);
      });
    };
    let timer = setTimeout(expire, FOCUS_OBSERVATION_TIMEOUT_MS);
    this.requestedFocus = { id, origin, from, timer };
    this.blockedSelect ||= this.selectDown;
    this.cancelHeld(true);
    for (const observer of [...this.observers])
      observer({
        eventType: "cancel",
        reason: "focus-request",
        eventKeyAction: 1,
        repeat: false,
      });
  }
  bindNavigation(navigate: NonNullable<NativeInput["navigation"]>): () => void {
    this.assertActive();
    if (this.navigation)
      throw new RokuHostError("C07_INPUT_ROOT", "An input port already has a focus executor");
    this.navigation = navigate;
    return () => {
      if (this.navigation === navigate) this.navigation = undefined;
    };
  }
  get focusedID(): string | null {
    return this.focused;
  }
  get navigationFocusID(): string | null {
    return this.focused ?? this.recovery?.from ?? null;
  }
  get targetCount(): number {
    return this.targets.size;
  }
  get observerCount(): number {
    return this.observers.size + this.backHandlers.size;
  }
  bindRenderer(batch: (work: () => void) => void): () => void {
    this.assertActive();
    if (this.renderer)
      throw new RokuHostError("C07_INPUT_ROOT", "An input port already belongs to a mounted root");
    this.renderer = batch;
    return () => {
      if (this.renderer === batch) this.renderer = undefined;
    };
  }
  register(id: string, target: NativeInputTarget): () => void {
    this.assertActive();
    if (this.targets.has(id))
      throw new RokuHostError("C07_INPUT_ID", `Duplicate input identity ${id}`);
    if (
      target.longPressDelay != null &&
      (!(target.longPressDelay >= 0) || !Number.isFinite(target.longPressDelay))
    )
      throw new RokuHostError("C07_INPUT_DELAY", "Long-press delay must be nonnegative and finite");
    this.targets.set(id, target);
    return () => {
      if (this.targets.get(id) !== target) return;
      if (this.held?.id === id) this.cancelHeld(false);
      this.targets.delete(id);
      if (this.requestedFocus?.id === id) this.retireFocusRequest();
      if (this.focused === id) this.focused = null;
      if (this.recovery?.from === id) this.recovery.from = null;
    };
  }
  observeFocus(id: string, focused: boolean): void {
    if (this.retired) return;
    let acknowledgedRevision: number | undefined;
    this.batch(() => {
      const target = this.targets.get(id);
      if (!target) return;
      const current = (revision: number) =>
        !this.retired && this.focusRevision === revision && this.targets.get(id) === target;
      if (focused) {
        const isDirectional = this.requestedFocus?.origin === "directional";
        const acknowledgesRequest = this.requestedFocus?.id === id;
        if (this.focused === id && this.requestedFocus && !acknowledgesRequest) return;
        if (acknowledgesRequest) this.clearFocusRequest();
        if (this.recovery && this.requestedFocus) {
          // An observation for another target can arrive while a recovery retry
          // is in flight. It cannot release the retry's activation fence.
          this.clearQueuedInput();
        } else {
          if (isDirectional && !acknowledgesRequest) this.retireFocusRequest();
          this.recovery = null;
        }
        if (this.focused === id) return;
        const revision = ++this.focusRevision;
        const oldID = this.focused,
          old = oldID && this.targets.get(oldID);
        this.cancelHeld(true);
        if (!current(revision)) return;
        this.focused = id;
        if (old && this.targets.get(oldID!) === old) old.focus(false);
        // Cancellation and blur can synchronously replace a route/target or
        // publish a newer observation. Their retired continuation owns neither.
        if (!current(revision) || this.focused !== id) return;
        target.focus(true);
        if (isDirectional && acknowledgesRequest && current(revision))
          acknowledgedRevision = revision;
      } else if (this.focused === id) {
        const revision = ++this.focusRevision;
        this.cancelHeld(true);
        if (!current(revision) || this.focused !== id) return;
        this.focused = null;
        target.focus(false);
      }
    });
    // Let the observed React state submit before replaying the next native
    // presentation. Its writes must not supersede the next prepared target.
    if (acknowledgedRevision === this.focusRevision && !this.retired) this.replayQueuedDirections();
  }
  subscribe(observer: (event: TVEvent) => unknown): () => void {
    this.assertActive();
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }
  addBackHandler(handler: () => boolean): () => void {
    this.assertActive();
    // Match callback deduplication without letting a stale removal own a later
    // registration of that callback.
    const registration = this.backHandlers.get(handler) ?? {};
    this.backHandlers.set(handler, registration);
    return () => {
      if (this.backHandlers.get(handler) === registration) this.backHandlers.delete(handler);
    };
  }
  dispatch(event: NativeRemoteEvent): boolean {
    this.assertActive();
    if (!this.active) return false;
    if (directions.includes(event.key)) return this.dispatchDirection(event);
    if (event.key === "select" && this.queueSelect(event)) return true;
    return this.dispatchNow(event);
  }
  private queueSelect(event: NativeRemoteEvent): boolean {
    if (this.queuedSelect) {
      if (event.phase === "up") {
        this.queuedDirections.push({ key: "select", phase: "up", gesture: this.queuedSelect });
        this.queuedSelect = null;
      }
      return true;
    }
    // Preserve ordering behind accepted directions. Imperative requests still
    // fence Select, and the normal dispatch path validates the observed owner.
    if (
      event.phase !== "down" ||
      this.requestedFocus?.origin !== "directional" ||
      this.recovery ||
      this.selectDown ||
      this.blockedSelect ||
      this.queuedDirections.length >= MAX_QUEUED_DIRECTIONS + 2
    )
      return false;
    this.queuedSelect = {};
    this.queuedDirections.push({ key: "select", phase: "down", gesture: this.queuedSelect });
    return true;
  }
  private currentGesture(revision: number): boolean {
    return !this.retired && this.active && revision === this.gestureRevision;
  }
  private notifyObservers(event: NativeRemoteEvent, revision: number): boolean {
    if (!this.observers.size) return false;
    let handled = false;
    for (const observer of [...this.observers]) {
      if (!this.currentGesture(revision)) break;
      handled =
        observer({
          tag: this.focused ? this.targets.get(this.focused)?.tag : undefined,
          eventType: event.key,
          eventKeyAction: event.phase === "up" ? 1 : 0,
          repeat: event.phase === "repeat",
        }) === true || handled;
    }
    return handled;
  }
  private dispatchDirection(event: NativeRemoteEvent): boolean {
    let handled = false;
    const revision = this.gestureRevision;
    this.batch(() => {
      handled = this.notifyObservers(event, revision);
      if (!this.currentGesture(revision)) {
        handled = true;
        return;
      }
      const key = event.key as NativeDirection;
      if (event.phase === "up") {
        const queuedRepeat = this.queuedDirections.findIndex(
          (direction) => direction.key !== "select" && direction.repeat && direction.key === key,
        );
        if (queuedRepeat >= 0) this.queuedDirections.splice(queuedRepeat, 1);
      } else if (!handled) {
        handled = this.navigate(key, event.phase === "repeat");
      }
    });
    return handled;
  }
  private dispatchNow(event: NativeRemoteEvent): boolean {
    if (event.key === "back" && event.phase === "down") this.abandonFocusRequest();
    if (event.key === "select") {
      if (event.phase === "down") this.selectDown = true;
      else if (event.phase === "up") this.selectDown = false;
      if (this.requestedFocus || this.recovery || this.blockedSelect) {
        if (event.phase !== "up") this.blockedSelect = true;
        else this.blockedSelect = false;
        return false;
      }
    }
    let handled = false;
    const revision = this.gestureRevision;
    this.batch(() => {
      handled = this.notifyObservers(event, revision);
      if (!this.currentGesture(revision)) {
        handled = true;
        return;
      }
      if (event.key === "select" && this.blockedSelect) return;
      if (event.key === "back" && event.phase === "down" && !handled) {
        for (const [handler, registration] of [...this.backHandlers].reverse()) {
          if (this.backHandlers.get(handler) !== registration) continue;
          if (handler() || this.retired || !this.active || revision !== this.gestureRevision) {
            handled = true;
            break;
          }
        }
      }
      if (event.key !== "select") return;
      if (event.phase === "up") {
        const held = this.held;
        if (!held) return;
        this.held = null;
        clearTimeout(held.timer);
        if (this.targets.get(held.id) !== held.target) return;
        const focusRevision = this.focusRevision;
        held.target.pressed(false);
        if (
          this.active &&
          !this.retired &&
          revision === this.gestureRevision &&
          focusRevision === this.focusRevision &&
          !this.requestedFocus &&
          this.targets.get(held.id) === held.target &&
          held.id === this.focused &&
          held.target.enabled() &&
          !held.long
        )
          held.target.activate();
        handled = true;
      } else if (event.phase === "down" && !this.held && this.focused) {
        const id = this.focused,
          target = this.targets.get(id);
        if (!target?.enabled()) return;
        const held = (this.held = { id, target, long: false } as NonNullable<NativeInput["held"]>);
        target.pressed(true);
        if (this.held !== held || this.retired) return;
        if (target.longPress)
          held.timer = setTimeout(
            () =>
              this.batch(() => {
                if (this.held !== held || !target.enabled() || this.focused !== id) return;
                held.long = true;
                target.longPress?.();
              }),
            target.longPressDelay ?? 500,
          );
        handled = true;
      } else handled = this.held !== null;
    });
    return handled;
  }
  dispose(): void {
    if (this.retired) return;
    this.cancelHeld(false);
    this.retired = true;
    this.targets.clear();
    this.observers.clear();
    this.backHandlers.clear();
    this.focused = null;
    this.retireFocusRequest();
    this.recovery = null;
    this.selectDown = false;
    this.blockedSelect = false;
    this.renderer = undefined;
    this.navigation = undefined;
  }
  setActive(active: boolean): void {
    if (this.retired || this.active === active) return;
    this.active = active;
    if (!active) this.cancelInteraction("inactive");
  }
  /** An admitted external editor owns the gesture even before native focus-loss
   * or key-up arrives. This cancels work; it does not acknowledge native focus. */
  cancelPendingInput(): void {
    this.cancelInteraction("text-entry");
  }
  private cancelInteraction(reason: "inactive" | "text-entry"): void {
    if (this.retired) return;
    const revision = ++this.gestureRevision;
    this.batch(() => {
      this.retireFocusRequest();
      this.recovery = null;
      this.selectDown = false;
      this.blockedSelect = false;
      this.cancelHeld(true);
      for (const observer of [...this.observers]) {
        if (this.retired || revision !== this.gestureRevision) break;
        observer({ eventType: "cancel", reason, eventKeyAction: 1, repeat: false });
      }
    });
  }
  private navigate(key: NativeDirection, repeat: boolean): boolean {
    if (this.requestedFocus?.origin !== "directional") return this.navigation?.(key) ?? false;
    if (
      this.queuedDirections.filter((entry) => entry.key !== "select").length <
        MAX_QUEUED_DIRECTIONS &&
      (!repeat ||
        !this.queuedDirections.some(
          (direction) => direction.key !== "select" && direction.repeat && direction.key === key,
        ))
    )
      this.queuedDirections.push({ key, repeat });
    return true;
  }
  private replayQueuedDirections(): void {
    // Resolve each step from the observed native card. Several accepted key
    // downs can arrive before gainFocus produces its committed observation.
    while (this.active && !this.retired && this.requestedFocus === null) {
      const next = this.queuedDirections.shift();
      if (!next) return;
      if (next.key === "select") {
        if (next.phase === "down" && this.queuedSelect === next.gesture) this.queuedSelect = null;
        this.dispatchNow(next);
      } else {
        this.navigation?.(next.key);
      }
    }
  }
  private abandonFocusRequest(): void {
    if (this.requestedFocus) {
      const from = this.requestedFocus.from;
      this.recovery = { from: from && this.targets.has(from) ? from : null };
    }
    this.retireFocusRequest();
  }
  private clearFocusRequest(): void {
    if (!this.requestedFocus) return;
    clearTimeout(this.requestedFocus.timer);
    this.requestedFocus = null;
  }
  private retireFocusRequest(): void {
    this.clearFocusRequest();
    this.clearQueuedInput();
  }
  private clearQueuedInput(): void {
    this.queuedDirections.length = 0;
    this.blockedSelect ||= this.queuedSelect !== null;
    this.queuedSelect = null;
  }
  private batch(work: () => void) {
    if (!this.retired) {
      if (this.renderer) this.renderer(work);
      else work();
    }
  }
  private assertActive() {
    if (this.retired) throw new RokuHostError("C07_INPUT_DISPOSED", "The input port was disposed");
  }
  private cancelHeld(notify: boolean) {
    const held = this.held;
    this.held = null;
    if (held) {
      clearTimeout(held.timer);
      if (notify && this.targets.get(held.id) === held.target) held.target.pressed(false);
    }
  }
}
