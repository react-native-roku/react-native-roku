import { describe, expect, it, vi } from "vitest";
import {
  createPortableFetch,
  PortableAbortController,
  PortableAbortSignal,
  PortableHeaders,
  PortableRequest,
  PortableResponse,
  type WebRequest,
} from "./webRuntime";
import { installWebRuntime } from "./installWebRuntime";

describe("application web API compatibility", () => {
  it("publishes a standard timeout reason once and retires its timer", async () => {
    vi.useFakeTimers();
    try {
      const signal = PortableAbortSignal.timeout(25),
        listener = vi.fn();
      signal.addEventListener("abort", listener, { once: true });
      await vi.advanceTimersByTimeAsync(24);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toMatchObject({ name: "TimeoutError" });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(() => PortableAbortSignal.timeout(-1)).toThrow(RangeError);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not dispatch when aborted while an existing Request body is being read", async () => {
    const controller = new PortableAbortController();
    let finish!: (body: string) => void;
    let sends = 0;
    const fetch = createPortableFetch(async () => {
      sends++;
      return { status: 200, headers: {}, body: "" };
    });
    const request = {
      url: "https://fixture.invalid/write",
      method: "POST",
      signal: controller.signal,
      clone: () => ({
        text: () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      }),
    };
    const result = fetch(request as unknown as Request);
    controller.abort();
    finish("late body");
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(sends).toBe(0);
  });
  it("round-trips API URLs, repeated search parameters, relative routes and packaged URIs without Node globals", () => {
    const target: Record<string, unknown> = {},
      release = installWebRuntime(undefined, target);
    const URLImpl = target.URL as typeof URL;
    const url = new URLImpl(
      "../api/videos?a=one+two&a=%E2%9C%93",
      "http://[::1]:8080/detail/movie/1",
    );
    expect(url.href).toBe("http://[::1]:8080/detail/api/videos?a=one+two&a=%E2%9C%93");
    expect(url.searchParams.getAll("a")).toEqual(["one two", "✓"]);
    url.searchParams.set("token", "a/b+c&d");
    expect(new URLImpl(url.href).searchParams.get("token")).toBe("a/b+c&d");
    expect(new URLImpl("pkg:/images/icon.png").pathname).toBe("/images/icon.png");
    release();
    expect(Object.keys(target)).toEqual([]);
  });
  it("normalizes iterable headers, clones bodies and enforces single consumption", async () => {
    const headers = new PortableHeaders([
      ["X-Fixture", " first "],
      ["x-fixture", "second"],
    ]);
    expect(headers.get("X-FIXTURE")).toBe("first, second");
    expect([...new PortableHeaders(headers)]).toEqual([["x-fixture", "first, second"]]);
    expect(() => headers.set("bad\nkey", "value")).toThrow();
    expect(() => headers.set("good", "bad\rvalue")).toThrow();
    const response = PortableResponse.json({ label: "✓" });
    const copy = response.clone();
    expect(await response.json()).toEqual({ label: "✓" });
    await expect(response.text()).rejects.toThrow("already consumed");
    expect(await copy.text()).toBe('{"label":"✓"}');
    expect(() => response.clone()).toThrow("already consumed");
  });
  it("passes methods, headers and UTF-8 text through a transport rather than losing fetch init", async () => {
    const requests: WebRequest[] = [];
    const fetch = createPortableFetch(async (request) => {
      requests.push(request);
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: '{"ok":true}',
      };
    });
    const request = new PortableRequest("https://fixture.invalid/api/write", {
      method: "POST",
      body: "✓",
      headers: [["X-Key", "fixture"]],
    });
    const response = await fetch(request as unknown as Request);
    expect(requests[0]).toMatchObject({
      method: "POST",
      body: "✓",
      headers: { "x-key": "fixture" },
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.url).toBe("https://fixture.invalid/api/write");
  });
  it("cancels immediately, ignores a late response and removes the forwarding listener", async () => {
    let finish!: (value: { status: number; headers: {}; body: string }) => void;
    const controller = new PortableAbortController();
    let adds = 0,
      removes = 0,
      events = 0;
    const signal = controller.signal;
    const add = signal.addEventListener.bind(signal),
      remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args) => {
      adds++;
      add(...args);
    };
    signal.removeEventListener = (...args) => {
      removes++;
      remove(...args);
    };
    signal.addEventListener("abort", () => events++, { once: true });
    const fetch = createPortableFetch(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = fetch("https://fixture.invalid/api/wait", {
      signal: signal as unknown as AbortSignal,
    });
    controller.abort();
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    finish({ status: 200, headers: {}, body: "late" });
    await Promise.resolve();
    expect(events).toBe(1);
    expect(adds).toBe(2);
    expect(removes).toBe(1);
    const neverSent = createPortableFetch(() => {
      throw Error("should not send");
    });
    await expect(
      neverSent("https://fixture.invalid/api", {
        signal: signal as unknown as AbortSignal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

it("retains Request security policies across cloning and rejects unsupported policies before dispatch", async () => {
  const transport = vi.fn(async () => ({ status: 200, headers: {}, body: "ok" }));
  const fetch = createPortableFetch(transport);
  for (const init of [
    { redirect: "error" },
    { redirect: "manual" },
    { credentials: "include" },
  ] as RequestInit[]) {
    const request = new PortableRequest("https://fixture.invalid/api", init);
    await expect(fetch(request.clone() as unknown as Request)).rejects.toThrow();
  }
  expect(transport).not.toHaveBeenCalled();
  const strict = new PortableRequest("https://fixture.invalid/api", { redirect: "error" });
  expect(new PortableRequest(strict).clone()).toMatchObject({
    redirect: "error",
    credentials: "same-origin",
  });
  await expect(
    fetch(strict as unknown as Request, { redirect: "follow", credentials: "omit" }),
  ).resolves.toHaveProperty("status", 200);
  expect(transport).toHaveBeenCalledOnce();
});
it("refuses URL credentials before a transport can observe them", async () => {
  const transport = vi.fn(async () => ({ status: 200, headers: {}, body: "ok" }));
  await expect(
    createPortableFetch(transport)("https://name:secret@fixture.invalid/api"),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

it("carries inherited strict policy and text request data only to an explicitly capable transport", async () => {
  const transport = Object.assign(
    vi.fn(async (_request: WebRequest) => ({ status: 200, headers: {}, body: "ok" })),
    {
      redirectModes: ["follow", "error"] as const,
    },
  );
  const fetch = createPortableFetch(transport);
  const request = new PortableRequest("https://fixture.invalid/api/queue", {
    method: "PUT",
    redirect: "error",
    credentials: "omit",
    headers: { "X-Fixture": "owned" },
    body: "{}",
  });
  await expect(fetch(request.clone() as unknown as Request)).resolves.toHaveProperty("status", 200);
  expect(transport).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      method: "PUT",
      redirect: "error",
      headers: { "x-fixture": "owned" },
      body: "{}",
    }),
  );
});

it("removes a URL fragment before dispatch and strict final-URL comparison", async () => {
  const transport = Object.assign(
    vi.fn(async (_request: WebRequest) => ({
      status: 200,
      headers: {},
      body: "ok",
      url: "https://fixture.invalid/api",
    })),
    { redirectModes: ["error"] as const },
  );
  await expect(
    createPortableFetch(transport)("https://fixture.invalid/api#local", { redirect: "error" }),
  ).resolves.toHaveProperty("status", 200);
  expect(transport.mock.calls[0]?.[0]).toMatchObject({
    url: "https://fixture.invalid/api",
    redirect: "error",
  });
});

it("does not manufacture an empty GET body when forwarding a portable Request", async () => {
  const transport = Object.assign(
    vi.fn(async (_request: WebRequest) => ({ status: 200, headers: {}, body: "ok" })),
    { redirectModes: ["error"] as const },
  );
  const fetch = createPortableFetch(transport);
  await fetch(
    new PortableRequest("https://fixture.invalid/api", { redirect: "error" }) as unknown as Request,
  );
  expect(transport.mock.calls[0]?.[0]).not.toHaveProperty("body");
  expect(() => new PortableRequest("https://fixture.invalid/api", { body: "" })).toThrow(TypeError);
  await expect(
    fetch("https://fixture.invalid/api", { body: "", redirect: "error" }),
  ).rejects.toThrow(TypeError);
  expect(transport).toHaveBeenCalledTimes(1);
});

it("freezes admitted redirect modes and refuses unsupported or malformed policy before IO", async () => {
  const modes: Array<"follow" | "error"> = ["follow"];
  const transport = Object.assign(
    vi.fn(async () => ({ status: 200, headers: {}, body: "ok" })),
    { redirectModes: modes },
  );
  const fetch = createPortableFetch(transport);
  modes.push("error");
  await expect(fetch("https://fixture.invalid", { redirect: "error" })).rejects.toMatchObject({
    code: "C22_FETCH_REDIRECT",
  });
  await expect(
    fetch("https://fixture.invalid", { redirect: "sometimes" as RequestRedirect }),
  ).rejects.toThrow(TypeError);
  expect(transport).not.toHaveBeenCalled();
});

it("rejects a redirect result or a changed final URL when the caller requires error mode", async () => {
  for (const response of [
    { status: 307, headers: {}, body: "" },
    { status: 200, headers: {}, body: "", url: "https://another.invalid/api" },
  ]) {
    const transport = Object.assign(
      vi.fn(async () => response),
      { redirectModes: ["error"] as const },
    );
    await expect(
      createPortableFetch(transport)("https://fixture.invalid/api", { redirect: "error" }),
    ).rejects.toThrow(TypeError);
  }
});
