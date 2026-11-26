import { afterEach, expect, it, vi } from "vitest";
import type { DomNode } from "@roku-sdk/interfaces";
const bridge = vi.hoisted(() => ({
  fields: new Map<string, unknown>(),
  requests: [] as { id: number }[],
  calls: [] as { field: string; value: unknown; previous: unknown }[],
}));
vi.mock("@roku-sdk/common/transaction", () => ({
  transactionManager: { startTransaction() {} },
}));
vi.mock("@roku-sdk/solid", () => ({
  tmTransaction: {
    setProperty(_node: unknown, field: string, value: unknown, previous?: unknown) {
      bridge.calls.push({ field, value, previous });
      bridge.fields.set(field, value);
      if (field === "request") bridge.requests.push(JSON.parse(String(value)));
    },
  },
}));
import { SdkDeviceFacts } from "./SdkDeviceFacts";
afterEach(() => {
  bridge.fields.clear();
  bridge.requests.length = 0;
  bridge.calls.length = 0;
  vi.useRealTimers();
});

it("submits the pinned SDK unregister cue for both owned event handlers", () => {
  const facts = new SdkDeviceFacts(
    {} as DomNode,
    () => {},
    () => {},
  );
  const reply = bridge.fields.get("onReply"),
    event = bridge.fields.get("onEvent");
  facts.dispose();
  expect(
    bridge.calls.find((call) => call.field === "onReply" && call.value === null)?.previous,
  ).toBe(reply);
  expect(
    bridge.calls.find((call) => call.field === "onEvent" && call.value === null)?.previous,
  ).toBe(event);
});

it.each(["capabilities", "memory"] as const)(
  "stops a %s callback chain when its first listener disposes the bridge",
  (type) => {
    const later = vi.fn(),
      facts = new SdkDeviceFacts(
        {} as DomNode,
        () => {},
        () => {},
      );
    const name = type === "capabilities" ? "onAudioRouteChanged" : "onResourcePressure";
    facts.addListener(name, () => facts.dispose());
    facts.addListener(name, later);
    const event = bridge.fields.get("onEvent") as (value: string) => void;
    event(JSON.stringify({ type, level: "critical", routeEpoch: 2 }));
    expect(later).not.toHaveBeenCalled();
  },
);

it("keeps a replacement event subscription when an old removal callback runs again", () => {
  const facts = new SdkDeviceFacts(
      {} as DomNode,
      () => {},
      () => {},
    ),
    later = vi.fn();
  const old = facts.addListener("onAudioRouteChanged", () => {});
  old.remove();
  facts.addListener("onAudioRouteChanged", later);
  old.remove();
  (bridge.fields.get("onEvent") as (value: string) => void)(
    JSON.stringify({ type: "capabilities", routeEpoch: 3 }),
  );
  expect(later).toHaveBeenCalledExactlyOnceWith({ audioRouteEpoch: 3 });
  facts.dispose();
});

it("serializes raw probes, fences reply IDs, routes native observations and disposes pending RPC", async () => {
  vi.useFakeTimers();
  const system: unknown[] = [],
    changes: unknown[] = [],
    memory: unknown[] = [];
  const facts = new SdkDeviceFacts(
    {} as DomNode,
    (patch) => system.push(patch),
    () => {},
  );
  const subscription = facts.addListener("onAudioRouteChanged", (event) => changes.push(event));
  facts.addListener("onResourcePressure", (event) => memory.push(event));
  const first = facts.probe({ video: [], audio: [] }),
    second = facts.probe({ video: [], audio: [] });
  await Promise.resolve();
  expect(bridge.requests).toHaveLength(1);
  const reply = bridge.fields.get("onReply") as (value: unknown) => void;
  reply(JSON.stringify({ id: 99, facts: "stale" }));
  expect(vi.getTimerCount()).toBe(1);
  reply(JSON.stringify({ id: 1, facts: { native: true } }));
  expect(await first).toEqual({ native: true });
  await Promise.resolve();
  expect(bridge.requests).toHaveLength(2);
  const event = bridge.fields.get("onEvent") as (value: unknown) => void;
  event(JSON.stringify({ type: "system", snapshot: { appState: "inactive" } }));
  event(JSON.stringify({ type: "capabilities", routeEpoch: 2 }));
  event(JSON.stringify({ type: "memory", level: "low" }));
  event(JSON.stringify({ type: "memory", level: "critical" }));
  expect(system).toEqual([{ appState: "inactive" }]);
  expect(changes).toEqual([{ audioRouteEpoch: 2 }]);
  expect(memory).toEqual([{ level: "warning" }, { level: "critical" }]);
  subscription.remove();
  event(JSON.stringify({ type: "capabilities", routeEpoch: 3 }));
  expect(changes).toHaveLength(1);
  const rejected = expect(second).rejects.toThrow("retired");
  facts.dispose();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  event(JSON.stringify({ type: "system", snapshot: { appState: "active" } }));
  expect(system).toHaveLength(1);
  await expect(facts.probe({})).rejects.toThrow("retired");
});
