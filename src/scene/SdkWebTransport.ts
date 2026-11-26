import type {
  AbortControllerInstance,
  FetchFunction,
  Request as SdkRequestConstructor,
  RequestMethod,
  ResponseInstance,
} from "@roku-sdk/interfaces";
import { RokuHostError } from "./sceneGraph.types";
import { PortableDOMException, type WebTransport } from "../services/webRuntime";

interface NativeWebBindings {
  readonly fetch: FetchFunction;
  readonly Request: SdkRequestConstructor;
  readonly AbortController: new () => AbortControllerInstance;
}

/** Capture the firmware bindings before installing the application globals. */
export function createSdkWebTransport(
  bindings: NativeWebBindings = globalThis as unknown as NativeWebBindings,
): WebTransport {
  const nativeFetch = bindings.fetch,
    NativeRequest = bindings.Request,
    NativeAbortController = bindings.AbortController;
  return async (request) => {
    if (request.redirect !== undefined && request.redirect !== "follow")
      throw new RokuHostError(
        "C22_FETCH_REDIRECT",
        "Firmware redirect policy cannot be overridden; no request was started",
      );
    // The SDK currently types feature metadata that may be absent on firmware.
    // Capturing the transport must not prevent an offline app from mounting.
    if (
      typeof nativeFetch !== "function" ||
      typeof NativeRequest !== "function" ||
      (typeof nativeFetch.isFeatureSupported === "function" &&
        !nativeFetch.isFeatureSupported("requestInit" as never))
    )
      throw new RokuHostError(
        "C22_FETCH_HOST",
        "Firmware fetch/Request initialization is unavailable",
      );
    if (!["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"].includes(request.method))
      throw new RokuHostError(
        "C22_FETCH_METHOD",
        "This HTTP method is outside the firmware fetch contract",
      );
    const abortReason = () =>
      request.signal?.reason ?? new PortableDOMException("The operation was aborted", "AbortError");
    if (request.signal?.aborted) throw abortReason();
    let controller: AbortControllerInstance | undefined;
    if (request.signal) {
      try {
        controller = new NativeAbortController();
      } catch {
        throw new RokuHostError(
          "C22_FETCH_ABORT",
          "Firmware request cancellation is unavailable; no request was started",
        );
      }
    }
    let rejectCancellation!: (reason: unknown) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });
    // A native binding can abort and throw synchronously before a race attaches.
    void cancelled.catch(() => {});
    const wait = <T>(pending: Promise<T>) =>
      request.signal ? Promise.race([pending, cancelled]) : pending;
    const cancel = () => {
      rejectCancellation(abortReason());
      try {
        controller?.abort("Roku request cancelled");
      } catch {
        // Caller/listener retirement must finish even when firmware cancellation
        // fails. Whether native IO actually stops remains a device observation.
      }
    };
    request.signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (request.signal?.aborted) {
        cancel();
        throw abortReason();
      }
      const response: ResponseInstance = await wait(
        nativeFetch(
          new NativeRequest(request.url, {
            method: request.method as RequestMethod,
            headers: { ...request.headers },
            body: request.body,
            ...(controller ? { signal: controller.signal } : {}),
          }),
        ),
      );
      if (request.signal?.aborted) throw abortReason();
      const headers = Object.fromEntries(
        response.headers
          .keys()
          .map((name) => [name.toLowerCase(), response.headers.get(name) ?? ""]),
      );
      const type = headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() ?? "";
      if (
        type &&
        !type.startsWith("text/") &&
        !/^application\/(json|[^;]+\+json|xml|[^;]+\+xml|vnd\.apple\.mpegurl|x-mpegurl)$/.test(type)
      )
        throw new RokuHostError(
          "C22_FETCH_BINARY",
          "Firmware text fetch cannot return this binary response without loss",
        );
      const body = await wait(response.text());
      if (request.signal?.aborted) throw abortReason();
      return {
        status: response.status,
        headers,
        body,
        url: request.url,
      };
    } finally {
      request.signal?.removeEventListener("abort", cancel);
    }
  };
}
