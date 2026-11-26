import { afterEach, expect, it, vi } from "vitest";
import type { DomNode } from "@roku-sdk/interfaces";
const bridge = vi.hoisted(() => ({
  fields: new Map<string, unknown>(),
  fail: false,
  calls: [] as { field: string; value: unknown; previous: unknown }[],
}));
vi.mock("@roku-sdk/common/transaction", () => ({ transactionManager: { startTransaction() {} } }));
vi.mock("@roku-sdk/solid", () => ({
  tmTransaction: {
    setProperty(_node: unknown, field: string, value: unknown, previous?: unknown) {
      bridge.calls.push({ field, value, previous });
      if (bridge.fail && field === "textEntryRequest") throw Error("native transport failed");
      bridge.fields.set(field, value);
    },
  },
}));
import { SdkTextEntry } from "./SdkTextEntry";
const request = {
  title: "Name",
  text: "",
  secure: false,
  domain: "generic" as const,
  maxLength: 20,
};
const replyPort = () => bridge.fields.get("onTextEntryReply") as (value: unknown) => void;
const packet = (id: number, text: string | null, closed: boolean) =>
  JSON.stringify({ version: 2, id, text, closed });
const draft = (id: number, text: string, sequence: number, revision = 0) =>
  JSON.stringify({ version: 2, id, text, draft: true, sequence, revision });
const caret = (id: number, text: string, prefix: string, sequence: number, revision = 0) =>
  JSON.stringify({ version: 2, id, text, prefix, caret: true, sequence, revision });
afterEach(() => {
  bridge.fields.clear();
  bridge.fail = false;
  bridge.calls.length = 0;
  vi.useRealTimers();
});

it("submits the pinned SDK unregister cue when retiring its owned reply handler", () => {
  const port = new SdkTextEntry({} as DomNode),
    reply = replyPort();
  port.dispose();
  expect(
    bridge.calls.find((call) => call.field === "onTextEntryReply" && call.value === null)?.previous,
  ).toBe(reply);
});

it("separates cancellation from observed closure and fences stale, malformed and unmarked replies", async () => {
  const port = new SdkTextEntry({} as DomNode),
    reply = replyPort();
  try {
    const first = port.open(request);
    let closed = false;
    void first.closed!.then(() => {
      closed = true;
    });
    expect(() => port.open(request)).toThrow("already active");
    first.close();
    first.close();
    expect(await first.result).toBeNull();
    expect(closed).toBe(false);
    expect(JSON.parse(bridge.fields.get("textEntryRequest") as string)).toEqual({
      version: 2,
      id: 1,
      close: true,
    });
    const next = port.open({ ...request, secure: true, domain: "password", maxLength: 4 });
    reply(packet(1, "stale", true));
    expect(await first.closed).toBe(true);
    let nextSettled = false;
    void next.result.then(() => {
      nextSettled = true;
    });
    reply("null");
    reply("bad json");
    reply("");
    reply(JSON.stringify({ id: 2, text: "unmarked" }));
    await Promise.resolve();
    expect(nextSettled).toBe(false);
    reply(packet(2, "123456", true));
    expect(await next.result).toBe("1234");
    expect(await next.closed).toBe(true);
    expect(bridge.fields.get("textEntryReply")).toBe("");
    const canceled = port.open(request);
    port.dispose();
    expect(await canceled.result).toBeNull();
    expect(await canceled.closed).toBe(false);
    expect(() => port.open(request)).toThrow("unavailable");
    reply(packet(3, "late", true));
  } finally {
    port.dispose();
  }
});

it("bounds both open and unacknowledged-close lifetimes without claiming the keyboard hid", async () => {
  vi.useFakeTimers();
  const port = new SdkTextEntry({} as DomNode),
    reply = replyPort();
  try {
    expect(() => port.open({ ...request, maxLength: 0 })).toThrow("contract");
    expect(bridge.fields.has("textEntryRequest")).toBe(false);
    const expired = port.open(request);
    vi.advanceTimersByTime(600000);
    expect(await expired.result).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10000);
    expect(await expired.closed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => port.open(request)).toThrow("unavailable");
    reply(packet(1, null, true));
    const next = port.open(request);
    port.dismiss();
    expect(await next.result).toBeNull();
    reply(packet(2, null, true));
    expect(await next.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    port.dispose();
  }
});

it("does not turn an unshown queued cancellation into an observed dismissal", async () => {
  vi.useFakeTimers();
  const port = new SdkTextEntry({} as DomNode),
    reply = replyPort();
  try {
    const first = port.open(request);
    first.close();
    const queued = port.open(request);
    queued.close();
    reply(packet(2, null, false));
    expect(await queued.closed).toBe(false);
    reply(packet(1, null, true));
    expect(await first.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const entries = [];
    for (let i = 0; i < 32; i++) {
      const entry = port.open(request);
      entry.close();
      entries.push(entry);
    }
    expect(() => port.open(request)).toThrow("unavailable");
    port.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(await Promise.all(entries.map((entry) => entry.closed))).toEqual(Array(32).fill(false));
  } finally {
    port.dispose();
  }
});

it("retires timers and closure observers when request transport fails", async () => {
  vi.useFakeTimers();
  const port = new SdkTextEntry({} as DomNode);
  try {
    const session = port.open(request);
    bridge.fail = true;
    expect(() => session.close()).toThrow("native transport failed");
    expect(await session.result).toBeNull();
    expect(await session.closed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => port.open(request)).toThrow("unavailable");
  } finally {
    bridge.fail = false;
    port.dispose();
  }
  expect(bridge.fields.get("onTextEntryReply")).toBeNull();
});

it("updates the same editor, bounds text and fences an older native submission after a controlled reset", async () => {
  const port = new SdkTextEntry({} as DomNode),
    reply = replyPort();
  try {
    const session = port.open({ ...request, maxLength: 4 });
    expect(session.setText!("Updated")).toBe(true);
    expect(JSON.parse(bridge.fields.get("textEntryRequest") as string)).toEqual({
      version: 2,
      id: 1,
      update: true,
      revision: 1,
      text: "Upda",
    });
    expect(() => session.setText!("x".repeat(4097))).toThrow("contract");
    // The user closed before the native update arrived. Observe dismissal, but
    // never deliver the preceding draft to the new controlled owner.
    reply(packet(1, "old", true));
    expect(await session.result).toBeNull();
    expect(await session.closed).toBe(true);
    const before = bridge.fields.get("textEntryRequest");
    expect(session.setText!("late")).toBe(false);
    expect(bridge.fields.get("textEntryRequest")).toBe(before);
    const next = port.open(request);
    expect(next.setText!("Reset")).toBe(true);
    reply(JSON.stringify({ version: 2, id: 2, text: "edited reset", closed: true, revision: 1 }));
    expect(await next.result).toBe("edited reset");
    expect(await next.closed).toBe(true);
  } finally {
    port.dispose();
  }
});

it("admits updates to a queued successor and fences updates after cancellation", async () => {
  const port = new SdkTextEntry({} as DomNode),
    reply = replyPort();
  try {
    const first = port.open(request);
    first.close();
    const next = port.open(request);
    expect(next.setText!("queued")).toBe(true);
    reply(packet(1, null, true));
    reply(JSON.stringify({ version: 2, id: 2, text: "queued", closed: true, revision: 1 }));
    expect(await next.result).toBe("queued");
    const closing = port.open(request);
    closing.close();
    expect(closing.setText!("stale")).toBe(false);
    expect(JSON.parse(bridge.fields.get("textEntryRequest") as string)).toMatchObject({
      id: 3,
      close: true,
    });
  } finally {
    port.dispose();
  }
});

it("cancels uncertain updates and retires all timers on transport failure", async () => {
  vi.useFakeTimers();
  const port = new SdkTextEntry({} as DomNode);
  try {
    const session = port.open(request);
    bridge.fail = true;
    expect(() => session.setText!("reset")).toThrow("native transport failed");
    expect(await session.result).toBeNull();
    expect(await session.closed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => port.open(request)).toThrow("unavailable");
  } finally {
    bridge.fail = false;
    port.dispose();
  }
});

it("publishes ordered native edits without settling the editor, and suppresses controlled echoes", async () => {
  vi.useFakeTimers();
  const port = new SdkTextEntry({} as DomNode),
    reply = replyPort();
  try {
    const session = port.open(request),
      changes: string[] = [];
    const opened = bridge.fields.get("textEntryRequest");
    expect(JSON.parse(opened as string).observeChanges).toBe(true);
    let settled = false;
    void session.result.then(() => {
      settled = true;
    });
    reply(draft(1, "a", 1));
    const remove = session.subscribeText!((text) => changes.push(text));
    expect(changes).toEqual(["a"]);
    expect(session.setText!("a")).toBe(true);
    expect(bridge.fields.get("textEntryRequest")).toBe(opened);
    reply(draft(1, "ab", 2));
    reply(draft(1, "stale", 1));
    reply(draft(1, "ab", 3));
    reply(draft(1, "malformed", -1));
    reply(draft(2, "wrong editor", 4));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(changes).toEqual(["a", "ab"]);
    expect(session.setText!("AB")).toBe(true);
    reply(draft(1, "old revision", 4));
    reply(draft(1, "ABC", 5, 1));
    expect(changes).toEqual(["a", "ab", "ABC"]);
    remove();
    reply(draft(1, "ABCD", 6, 1));
    reply(JSON.stringify({ version: 2, id: 1, closed: true, text: "ABCD", revision: 1 }));
    expect(await session.result).toBe("ABCD");
    expect(await session.closed).toBe(true);
    expect(changes).toEqual(["a", "ab", "ABC"]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    port.dispose();
  }
});

it("fences reentrant native publications, controlled replacements and canceled subscribers", async () => {
  const port = new SdkTextEntry({} as DomNode),
    reply = replyPort();
  try {
    const session = port.open(request),
      first: string[] = [],
      second: string[] = [];
    session.subscribeText!((text) => {
      first.push(text);
      if (text === "a") reply(draft(1, "ab", 2));
      if (text === "reset") session.setText!("controlled");
      if (text === "close") session.close();
    });
    session.subscribeText!((text) => second.push(text));
    reply(draft(1, "a", 1));
    expect(first).toEqual(["a", "ab"]);
    expect(second).toEqual(["ab"]);
    reply(draft(1, "reset", 3));
    expect(second).toEqual(["ab"]);
    reply(draft(1, "close", 4, 1));
    reply(draft(1, "late", 5, 1));
    expect(await session.result).toBeNull();
    expect(first).toEqual(["a", "ab", "reset", "close"]);
    expect(second).toEqual(["ab"]);
    reply(packet(1, null, true));
  } finally {
    port.dispose();
  }
});

it("requires a terminal acknowledgement after expiry and retires throwing text observers", async () => {
  vi.useFakeTimers();
  const port = new SdkTextEntry({} as DomNode),
    reply = replyPort();
  try {
    const expired = port.open(request);
    vi.advanceTimersByTime(610000);
    expect(await expired.closed).toBe(false);
    reply(draft(1, "late", 1));
    expect(() => port.open(request)).toThrow("unavailable");
    reply(packet(1, null, true));
    const next = port.open(request);
    next.subscribeText!(() => {
      throw Error("subscriber failed");
    });
    expect(() => reply(draft(2, "edit", 1))).toThrow("subscriber failed");
    expect(await next.result).toBeNull();
    reply(packet(2, null, true));
    expect(await next.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    port.dispose();
  }
});

it("reports observed caret prefixes in UTF-16 units, replays current observations and rejects malformed or stale positions", async () => {
  vi.useFakeTimers();
  const port = new SdkTextEntry({} as DomNode),
    reply = replyPort();
  try {
    const session = port.open({ ...request, text: "A😀B" });
    const changes: string[] = [],
      positions: number[] = [],
      late: number[] = [];
    session.subscribeText!((text) => changes.push(text));
    session.subscribeSelection!((selection) => positions.push(selection.start));
    expect(JSON.parse(bridge.fields.get("textEntryRequest") as string).observeSelection).toBe(true);
    expect(positions).toEqual([]);
    reply(caret(1, "A😀B", "A😀", 1));
    reply(caret(1, "A😀B", "A😀", 2));
    expect(positions).toEqual([3]);
    // Invalid prefixes cannot consume a newer native sequence or split a UTF-16 pair.
    reply(caret(1, "A😀B", "A\ud83d", 300));
    reply(caret(1, "A😀B", "not a prefix", 300));
    reply(caret(1, "different draft", "", 300));
    reply(caret(2, "A😀B", "", 300));
    reply(caret(1, "A😀B", "", 3));
    reply(caret(1, "A😀B", "A", 4));
    reply(caret(1, "A😀B", "", 3));
    expect(positions).toEqual([3, 0, 1]);
    expect(changes).toEqual([]);
    expect(session.setText!("Z")).toBe(true);
    const remove = session.subscribeSelection!((selection) => late.push(selection.start));
    expect(late).toEqual([]);
    reply(caret(1, "A😀B", "A😀", 5));
    reply(caret(1, "Z", "Z", 5, 1));
    expect(late).toEqual([1]);
    const replay: number[] = [];
    session.subscribeSelection!((selection) => replay.push(selection.start));
    expect(replay).toEqual([1]);
    remove();
    session.close();
    reply(caret(1, "Z", "", 6, 1));
    expect(late).toEqual([1]);
    expect(changes).toEqual([]);
    expect(await session.result).toBeNull();
    reply(packet(1, null, true));
    expect(await session.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    port.dispose();
  }
});

it("fences reentrant caret listeners after controlled correction or cancellation", async () => {
  const port = new SdkTextEntry({} as DomNode),
    reply = replyPort();
  try {
    const session = port.open({ ...request, text: "AB" });
    const first: number[] = [],
      second: number[] = [];
    let corrected = false;
    session.subscribeSelection!(({ start }) => {
      first.push(start);
      if (!corrected) {
        corrected = true;
        session.setText!("XX");
      }
      if (start === 2) session.close();
    });
    session.subscribeSelection!(({ start }) => second.push(start));
    reply(caret(1, "AB", "A", 1));
    expect(first).toEqual([1]);
    expect(second).toEqual([]);
    reply(caret(1, "XX", "X", 2, 1));
    expect(second).toEqual([1]);
    reply(caret(1, "XX", "XX", 3, 1));
    reply(caret(1, "XX", "", 4, 1));
    expect(first).toEqual([1, 1, 2]);
    expect(second).toEqual([1]);
    expect(await session.result).toBeNull();
    reply(packet(1, null, true));
  } finally {
    port.dispose();
  }
});

it("publishes a draft before its caret and discards the caret when React corrects that draft", () => {
  const port = new SdkTextEntry({} as DomNode),
    reply = replyPort();
  try {
    const session = port.open(request);
    const events: string[] = [];
    session.subscribeText!((text) => {
      events.push("text:" + text);
      session.setText!(text.toUpperCase());
    });
    session.subscribeSelection!(({ start }) => events.push("cursor:" + start));
    reply(
      JSON.stringify({
        version: 2,
        id: 1,
        text: "abc",
        draft: true,
        prefix: "ab",
        sequence: 1,
        revision: 0,
      }),
    );
    expect(events).toEqual(["text:abc"]);
    reply(caret(1, "abc", "ab", 2));
    reply(caret(1, "ABC", "AB", 2, 1));
    expect(events).toEqual(["text:abc", "cursor:2"]);
    reply(
      JSON.stringify({
        version: 2,
        id: 1,
        text: "ABC",
        draft: true,
        prefix: "A",
        sequence: 3,
        revision: 1,
      }),
    );
    expect(events).toEqual(["text:abc", "cursor:2", "cursor:1"]);
  } finally {
    port.dispose();
  }
});

it("retires throwing caret subscribers and isolates their observation objects", async () => {
  vi.useFakeTimers();
  const port = new SdkTextEntry({} as DomNode),
    reply = replyPort();
  try {
    const session = port.open({ ...request, text: "AB" });
    const positions: number[] = [];
    session.subscribeSelection!((selection) => {
      (selection as { start: number }).start = 99;
    });
    session.subscribeSelection!(({ start }) => positions.push(start));
    reply(caret(1, "AB", "A", 1));
    expect(positions).toEqual([1]);
    // A late subscriber replays immediately, so its failure retires the editor.
    expect(() =>
      session.subscribeSelection!(() => {
        throw Error("caret subscriber failed");
      }),
    ).toThrow("caret subscriber failed");
    expect(await session.result).toBeNull();
    reply(packet(1, null, true));
    expect(await session.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    port.dispose();
  }
});
