import { expect, it, vi } from "vitest";
import { createSdkWebTransport } from "./SdkWebTransport";
import type { FetchFunction, Request as RequestConstructor } from "@roku-sdk/interfaces";
import { PortableAbortController } from "../services/webRuntime";

it("refuses strict policy at the native transport boundary before constructing a request", async () => {
  const fetch = vi.fn(),
    Request = vi.fn(),
    AbortController = vi.fn();
  const transport = createSdkWebTransport({
    fetch: fetch as unknown as FetchFunction,
    Request: Request as unknown as RequestConstructor,
    AbortController: AbortController as never,
  });
  await expect(
    transport({
      url: "https://fixture.invalid/api",
      method: "GET",
      headers: {},
      redirect: "error",
    } as never),
  ).rejects.toMatchObject({ code: "C22_FETCH_REDIRECT" });
  expect(fetch).not.toHaveBeenCalled();
  expect(Request).not.toHaveBeenCalled();
  expect(AbortController).not.toHaveBeenCalled();
});

it("constructs a firmware Request with init and forwards abort without logging credentials", async () => {
  const sent: unknown[] = [],
    aborted: string[] = [];
  class Request {
    constructor(url: string, init: unknown) {
      sent.push({ url, init });
    }
  }
  class AbortController {
    signal = { aborted: false, reason: null };
    abort(reason?: string) {
      this.signal.aborted = true;
      aborted.push(reason ?? "");
    }
  }
  const fetch = Object.assign(
    vi.fn(async () => ({
      status: 200,
      headers: { keys: () => ["content-type"], get: () => "application/json" },
      text: async () => '{"ok":true}',
    })),
    { isFeatureSupported: () => true },
  );
  const transport = createSdkWebTransport({
    fetch: fetch as unknown as FetchFunction,
    Request: Request as unknown as RequestConstructor,
    AbortController,
  });
  const controller = new PortableAbortController();
  const pending = transport({
    url: "http://fixture.invalid/api",
    method: "POST",
    headers: { authorization: "fixture" },
    body: "{}",
    signal: controller.signal as unknown as AbortSignal,
  });
  controller.abort();
  expect(aborted).toEqual(["Roku request cancelled"]);
  await expect(pending).rejects.toHaveProperty("name", "AbortError");
  expect(sent).toMatchObject([
    {
      init: {
        method: "POST",
        body: "{}",
        headers: { authorization: "fixture" },
        signal: { aborted: true },
      },
    },
  ]);
});
it("captures firmware-shaped globals lazily and does not require absent feature metadata for uncancelled text fetch", async () => {
  const abort = vi.fn(() => {
    throw Error("SDK constructor is not bound");
  });
  const fetch = vi.fn(async () => ({
    status: 200,
    headers: {
      keys: () => ["Content-Type"],
      get: (name: string) => (name === "Content-Type" ? "application/json" : undefined),
    },
    text: async () => '{"ok":true}',
  }));
  const transport = createSdkWebTransport({
    fetch: fetch as unknown as FetchFunction,
    Request: class {
      constructor(readonly url: string) {}
    } as RequestConstructor,
    AbortController: abort as never,
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(abort).not.toHaveBeenCalled();
  expect(
    await transport({ url: "http://fixture.invalid/api", method: "GET", headers: {} }),
  ).toMatchObject({
    status: 200,
    headers: { "content-type": "application/json" },
    body: '{"ok":true}',
  });
  expect(abort).not.toHaveBeenCalled();
  await expect(
    transport({
      url: "http://fixture.invalid/api",
      method: "GET",
      headers: {},
      signal: new PortableAbortController().signal as unknown as AbortSignal,
    }),
  ).rejects.toMatchObject({ code: "C22_FETCH_ABORT" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("recognizes case-sensitive firmware binary headers before decoding and fences unsupported methods", async () => {
  const text = vi.fn(async () => "lossy");
  const fetch = vi.fn(async () => ({
    status: 200,
    headers: {
      keys: () => ["Content-Type"],
      get: (name: string) => (name === "Content-Type" ? "image/png" : undefined),
    },
    text,
  }));
  const transport = createSdkWebTransport({
    fetch: fetch as unknown as FetchFunction,
    Request: class {
      constructor(readonly url: string) {}
    } as RequestConstructor,
    AbortController: class {
      signal = { aborted: false, reason: null };
      abort() {}
    },
  });
  await expect(
    transport({ url: "http://fixture.invalid/image", method: "GET", headers: {} }),
  ).rejects.toMatchObject({ code: "C22_FETCH_BINARY" });
  expect(text).not.toHaveBeenCalled();
  await expect(
    transport({ url: "http://fixture.invalid", method: "OPTIONS", headers: {} }),
  ).rejects.toMatchObject({ code: "C22_FETCH_METHOD" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("a late firmware body cannot satisfy a retired request and its abort listener is removed", async () => {
  let resolveBody!: (value: string) => void;
  const text = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        resolveBody = resolve;
      }),
  );
  const fetch = vi.fn(async () => ({
    status: 200,
    headers: { keys: () => ["Content-Type"], get: () => "application/json" },
    text,
  }));
  const nativeAbort = vi.fn();
  const transport = createSdkWebTransport({
    fetch: fetch as unknown as FetchFunction,
    Request: class {
      constructor(readonly url: string) {}
    } as RequestConstructor,
    AbortController: class {
      signal = { aborted: false, reason: null };
      abort() {
        nativeAbort();
      }
    },
  });
  const controller = new PortableAbortController(),
    remove = vi.spyOn(controller.signal, "removeEventListener");
  const pending = transport({
    url: "http://fixture.invalid/api",
    method: "GET",
    headers: {},
    signal: controller.signal as unknown as AbortSignal,
  });
  await vi.waitFor(() => expect(text).toHaveBeenCalledOnce());
  controller.abort();
  resolveBody('{"stale":true}');
  await expect(pending).rejects.toHaveProperty("name", "AbortError");
  expect(nativeAbort).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledOnce();
});

it("retires its listener promptly when cancelled firmware never completes", async () => {
  const abort = vi.fn();
  const transport = createSdkWebTransport({
    fetch: vi.fn(() => new Promise(() => {})) as unknown as FetchFunction,
    Request: class {
      constructor(readonly url: string) {}
    } as RequestConstructor,
    AbortController: class {
      signal = { aborted: false, reason: null };
      abort = abort;
    },
  });
  const controller = new PortableAbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const pending = transport({
    url: "https://fixture.invalid/slow",
    method: "GET",
    headers: {},
    signal: controller.signal as unknown as AbortSignal,
  });
  controller.abort();
  await expect(pending).rejects.toHaveProperty("name", "AbortError");
  expect(abort).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledOnce();
}, 1000);

it("does not decode a late response or throw from a broken native cancellation callback", async () => {
  let finish!: (value: unknown) => void;
  const text = vi.fn(async () => "stale");
  const transport = createSdkWebTransport({
    fetch: vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ) as unknown as FetchFunction,
    Request: class {
      constructor(readonly url: string) {}
    } as RequestConstructor,
    AbortController: class {
      signal = { aborted: false, reason: null };
      abort() {
        throw Error("Native cancellation failed");
      }
    },
  });
  const controller = new PortableAbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const pending = transport({
    url: "https://fixture.invalid/slow",
    method: "GET",
    headers: {},
    signal: controller.signal as unknown as AbortSignal,
  });
  expect(() => controller.abort()).not.toThrow();
  await expect(pending).rejects.toHaveProperty("name", "AbortError");
  finish({ status: 200, headers: { keys: () => [], get() {} }, text });
  await Promise.resolve();
  expect(text).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledOnce();
}, 1000);

it("refuses a text-only firmware response for binary bytes", async () => {
  const fetch = Object.assign(
    async () => ({
      status: 200,
      headers: { keys: () => ["content-type"], get: () => "image/png" },
      text: async () => "corrupt",
    }),
    { isFeatureSupported: () => true },
  );
  const transport = createSdkWebTransport({
    fetch: fetch as unknown as FetchFunction,
    Request: class {
      url = "http://fixture.invalid";
    } as RequestConstructor,
    AbortController: class {
      signal = { aborted: false, reason: null };
      abort() {}
    },
  });
  await expect(
    transport({
      url: "http://fixture.invalid/image",
      method: "GET",
      headers: {},
    }),
  ).rejects.toThrow("binary response without loss");
});
