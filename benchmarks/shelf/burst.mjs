import { setTimeout as wait } from "node:timers/promises";

export const burstKeys = ["Right", "Right", "Right", "Left", "Select"];
export const activationCard = "shelf-2";
export const focusOrder = ["shelf-1", "shelf-2", "shelf-3", "shelf-2"];
export const burstPlan = [
  { name: "paced", spacingMs: 300 },
  ...Array.from({ length: 3 }, (_, index) => ({ name: `rapid-${index + 1}`, spacingMs: 40 })),
];

export async function sendBurst(client, spacingMs) {
  const origin = performance.now();
  return Promise.all(
    burstKeys.map(async (key, index) => {
      const scheduledMs = index * spacingMs;
      if (index) await wait(Math.max(0, origin + scheduledMs - performance.now()));
      const sendMs = performance.now();
      try {
        await client.keypress(key);
        return { key, scheduledMs, sendMs, ackMs: performance.now() };
      } catch (error) {
        return { key, scheduledMs, sendMs, error: String(error) };
      }
    }),
  );
}

export function scoreBurst({ edges, nativeFocus, callbackFocus, activation }) {
  const equal = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);
  const keysPassed = equal(
    edges,
    burstKeys.flatMap((key) => [key + ":down", key + ":up"]),
  );
  const focusPassed = equal(nativeFocus, focusOrder);
  const activationPassed = equal(activation, [activationCard]);
  const callbackPassed = callbackFocus === undefined || equal(callbackFocus, focusOrder);
  return {
    callbackPassed,
    keysPassed,
    focusPassed,
    activationPassed,
    pass: keysPassed && focusPassed && callbackPassed && activationPassed,
  };
}
