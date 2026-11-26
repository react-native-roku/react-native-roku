import { afterEach, expect, it, vi } from "vitest";
import type { DomNode } from "@roku-sdk/interfaces";
const boundary = vi.hoisted(() => ({
  fields: new Map<string, unknown>(),
  faults: new Map<string, Error>(),
  calls: [] as { field: string; value: unknown; applied: boolean }[],
  onSet: undefined as (() => void) | undefined,
}));
vi.mock("@roku-sdk/common/transaction", () => ({ transactionManager: { startTransaction() {} } }));
vi.mock("@roku-sdk/solid", () => ({
  tmTransaction: {
    setProperty(_node: unknown, field: string, value: unknown, _previous?: unknown) {
      const call = { field, value, applied: false };
      boundary.calls.push(call);
      const onSet = boundary.onSet;
      boundary.onSet = undefined;
      onSet?.();
      const failure = boundary.faults.get(field);
      if (failure) {
        boundary.faults.delete(field);
        throw failure;
      }
      boundary.fields.set(field, value);
      call.applied = true;
    },
  },
}));
import { SdkTextRasterTransport } from "./SdkTextRasterTransport";
afterEach(() => {
  boundary.fields.clear();
  boundary.faults.clear();
  boundary.calls.length = 0;
  boundary.onSet = undefined;
  vi.useRealTimers();
});
const fixture = () =>
  new SdkTextRasterTransport({} as DomNode, { Body: "pkg:/body.ttf" }, "fixture");
const submittedDisposals = () =>
  boundary.calls.filter(
    (call) =>
      call.applied && call.field === "request" && JSON.parse(String(call.value)).type === "dispose",
  );

it("retires admission and still detaches its observer when dispose-request submission fails", async () => {
  const port = fixture(),
    failure = Error("Dispose request submission failed");
  boundary.faults.set("request", failure);
  expect(() => port.dispose()).toThrow(failure);
  expect(boundary.fields.get("onReply")).toBeNull();
  await expect(port.delete("tmp:/retired.png")).rejects.toThrow(/retired/);
  port.dispose();
  port.dispose();
  expect(submittedDisposals()).toHaveLength(1);
});

it("retries a failed observer detach without replaying an accepted disposal request", () => {
  const port = fixture(),
    failure = Error("Observer detach failed");
  boundary.faults.set("onReply", failure);
  expect(() => port.dispose()).toThrow(failure);
  port.dispose();
  port.dispose();
  expect(submittedDisposals()).toHaveLength(1);
  expect(boundary.fields.get("onReply")).toBeNull();
});

it("preserves the first disposal failure and retries both failed mechanics", () => {
  const port = fixture(),
    first = Error("First request failure"),
    second = Error("Later detach failure");
  boundary.faults.set("request", first);
  boundary.faults.set("onReply", second);
  expect(() => port.dispose()).toThrow(first);
  port.dispose();
  expect(submittedDisposals()).toHaveLength(1);
  expect(boundary.fields.get("onReply")).toBeNull();
});

it("cancels current and queued operations before a cleanup failure without reviving late replies", async () => {
  vi.useFakeTimers();
  const port = fixture(),
    listener = boundary.fields.get("onReply") as (value: string) => void;
  const first = port.delete("tmp:/one.png"),
    second = port.delete("tmp:/two.png");
  await Promise.resolve();
  const old = JSON.parse(String(boundary.fields.get("request")));
  boundary.faults.set("request", Error("Cleanup request failed"));
  expect(() => port.dispose()).toThrow("Cleanup request failed");
  await expect(first).rejects.toThrow(/retired/);
  await expect(second).rejects.toThrow(/retired/);
  listener(JSON.stringify({ id: old.id, uri: "tmp:/late.png" }));
  port.dispose();
  expect(vi.getTimerCount()).toBe(0);
  expect(
    boundary.calls.filter(
      (call) =>
        call.applied &&
        call.field === "request" &&
        JSON.parse(String(call.value)).type === "delete",
    ),
  ).toHaveLength(1);
});

it("does not duplicate accepted cleanup during reentrant disposal", () => {
  const port = fixture();
  boundary.onSet = () => port.dispose();
  port.dispose();
  port.dispose();
  expect(submittedDisposals()).toHaveLength(1);
  expect(boundary.fields.get("onReply")).toBeNull();
});

it("releases a failed request's timer while its queued successor owns a different reply", async () => {
  vi.useFakeTimers();
  const port = fixture(),
    failure = Error("Request submission failed");
  boundary.faults.set("request", failure);
  const first = port.delete("tmp:/failed.png"),
    second = port.delete("tmp:/successor.png");
  await expect(first).rejects.toBe(failure);
  for (let step = 0; step < 4; step++) await Promise.resolve();
  const current = JSON.parse(String(boundary.fields.get("request"))),
    reply = boundary.fields.get("onReply") as (value: string) => void;
  expect(current.type).toBe("delete");
  reply(JSON.stringify({ id: current.id - 1 }));
  reply(JSON.stringify({ id: current.id }));
  await second;
  expect(vi.getTimerCount()).toBe(0);
  port.dispose();
});

it("clears failed predecessor and active successor timers when disposing the request queue", async () => {
  vi.useFakeTimers();
  const port = fixture(),
    failure = Error("Request submission failed");
  boundary.faults.set("request", failure);
  const first = port.delete("tmp:/failed.png"),
    second = port.delete("tmp:/pending.png");
  await expect(first).rejects.toBe(failure);
  for (let step = 0; step < 4; step++) await Promise.resolve();
  port.dispose();
  await expect(second).rejects.toThrow(/retired/);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps raster requests on the physical font map captured by their transport", async () => {
  const fonts = { Body: "pkg:/original.ttf" },
    port = new SdkTextRasterTransport({} as DomNode, fonts, "fixture");
  fonts.Body = "pkg:/replacement.ttf";
  const pending = port.mask({
    fontFamily: "Body",
    width: 1,
    height: 1,
    fontSize: 20,
    lineHeight: 20,
    commands: [{ text: "a", x: 0, y: 0 }],
    inset: 0,
    scale: 1,
    color: "white",
    shadowColor: "transparent",
    shadowX: 0,
    shadowY: 0,
    shadowRadius: 0,
  });
  try {
    await Promise.resolve();
    expect(JSON.parse(String(boundary.fields.get("request"))).font).toBe("pkg:/original.ttf");
  } finally {
    port.dispose();
    await expect(pending).rejects.toThrow(/retired/);
  }
});
