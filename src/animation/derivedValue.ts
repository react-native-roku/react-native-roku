import { RokuHostError } from "../scene/sceneGraph.types";
import {
  collectValues,
  isAnimation,
  makeMutable,
  type Animatable,
  type Animation,
  type MutableValue,
} from "./sharedValue";

function sameAnimationShape(left: Animation, right: Animation): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "timing": {
      const next = right as typeof left;
      return Object.is(left.to, next.to) && left.duration === next.duration;
    }
    case "delay": {
      const next = right as typeof left;
      return left.duration === next.duration && sameAnimationShape(left.animation, next.animation);
    }
    case "repeat": {
      const next = right as typeof left;
      return (
        left.count === next.count &&
        left.reverse === next.reverse &&
        sameAnimationShape(left.animation, next.animation)
      );
    }
    case "sequence": {
      const next = right as typeof left;
      return (
        left.animations.length === next.animations.length &&
        left.animations.every((child, index) => sameAnimationShape(child, next.animations[index]))
      );
    }
  }
}

/** Keep one admitted clock while callbacks/easing receive committed closures.
 * A changed target, duration or composition admits a new request instead. */
function animationFacade(read: () => Animation): Animation {
  const initial = read();
  switch (initial.kind) {
    case "timing": {
      const current = () => read() as typeof initial;
      return {
        kind: "timing",
        to: initial.to,
        duration: initial.duration,
        easing: (progress) => current().easing(progress),
        callback: (finished, value) => current().callback?.(finished, value),
      };
    }
    case "delay":
      return {
        kind: "delay",
        duration: initial.duration,
        animation: animationFacade(() => (read() as typeof initial).animation),
      };
    case "repeat":
      return {
        kind: "repeat",
        count: initial.count,
        reverse: initial.reverse,
        animation: animationFacade(() => (read() as typeof initial).animation),
        callback: (finished) => (read() as typeof initial).callback?.(finished),
      };
    case "sequence":
      return {
        kind: "sequence",
        animations: initial.animations.map((_, index) =>
          animationFacade(() => (read() as typeof initial).animations[index]),
        ),
      };
  }
}

/** Private JS mapper: React commits publish closures; actual shared reads own
 * subscriptions. Render-time/retired callbacks never install mapper state. */
export function createDerivedMapper<T extends Animatable>(initial: T) {
  const value = makeMutable(initial);
  const subscriptions = new Map<MutableValue<unknown>, () => void>();
  let active = false,
    updating = false,
    pending = false,
    applied = false;
  let updater: (() => T | Animation) | undefined;
  let previous: T | Animation;
  let slot: { current: Animation } | undefined;
  const apply = () => {
    const next = collectValues(updater!);
    if (next.dependencies.has(value as MutableValue<unknown>))
      throw new RokuHostError(
        "C06_ANIMATION_CYCLE",
        "Derived values must not depend on themselves",
      );
    for (const [dependency, release] of subscriptions)
      if (!next.dependencies.has(dependency)) {
        release();
        subscriptions.delete(dependency);
      }
    for (const dependency of next.dependencies)
      if (!subscriptions.has(dependency))
        subscriptions.set(dependency, dependency.subscribe(update));
    if (isAnimation(next.value)) {
      if (slot && sameAnimationShape(slot.current, next.value)) {
        slot.current = next.value;
        previous = next.value;
        return;
      }
      const request = { current: next.value };
      slot = request;
      previous = next.value;
      applied = true;
      value.value = animationFacade(() => request.current);
    } else if (!applied || !Object.is(previous, next.value)) {
      slot = undefined;
      previous = next.value;
      applied = true;
      value.value = next.value;
    }
  };
  function update() {
    if (!active || !updater) return;
    if (updating) {
      pending = true;
      return;
    }
    updating = true;
    try {
      let passes = 0;
      do {
        pending = false;
        apply();
        if (++passes > 100)
          throw new RokuHostError("C06_ANIMATION_CYCLE", "Derived updates cannot stabilize");
      } while (active && pending);
    } finally {
      updating = false;
    }
  }
  return {
    value,
    mount() {
      active = true;
      return () => {
        active = false;
        pending = false;
        for (const release of subscriptions.values()) release();
        subscriptions.clear();
        applied = false;
        slot = undefined;
        value.cancel();
      };
    },
    commit(next: () => T | Animation) {
      if (!active) return;
      updater = next;
      update();
    },
  };
}
