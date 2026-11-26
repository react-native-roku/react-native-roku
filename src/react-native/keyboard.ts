import { RokuHostError } from "../scene/sceneGraph.types";
import type { TextEntrySession } from "../services/DeviceServices";

const listeners = new Set<() => void>();
let attempt = 0,
  generation = 0;
let current: { generation: number; dismiss(): void } | undefined;

/** A blur callback may synchronously focus another editor. The outer request
 * must not overwrite that newer focus transaction. */
export function prepareKeyboardFocus(): () => boolean {
  const request = ++attempt;
  current?.dismiss();
  return () => attempt === request;
}

export function trackKeyboardSession(
  session: TextEntrySession,
  dismiss: () => void,
  alive: () => boolean,
): () => void {
  const token = ++generation;
  const owner = { generation: token, dismiss };
  current = owner;
  if (session.closed) {
    // TextInput's result handler is registered first. Even a provider delivering
    // closure before its result cannot let a hide listener discard accepted text.
    void Promise.all([session.result, session.closed]).then(
      ([, observed]) => {
        if (observed !== true || generation !== token || !alive()) return;
        for (const listener of [...listeners]) listener();
      },
      () => undefined,
    );
  }
  return () => {
    if (current === owner) current = undefined;
  };
}

/** Modal keyboard subset: observed dismissal has no invented IME geometry,
 * animation timing or will/show events. */
export const Keyboard = Object.freeze({
  addListener(name: string, listener: () => void) {
    if (name !== "keyboardDidHide")
      throw new RokuHostError(
        "C07_KEYBOARD_EVENT",
        "Only keyboardDidHide is supported by the modal keyboard host",
      );
    listeners.add(listener);
    return {
      remove: () => {
        listeners.delete(listener);
      },
    };
  },
  dismiss(): void {
    current?.dismiss();
  },
});
