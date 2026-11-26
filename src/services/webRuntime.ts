import { encodeUtf8 } from "./utf8";
import { RokuHostError } from "../scene/sceneGraph.types";

export class PortableDOMException extends Error {
  constructor(message = "", name = "Error") {
    super(message);
    this.name = name;
  }
}
type AbortListener = EventListenerOrEventListenerObject;
export class PortableAbortSignal {
  aborted = false;
  reason: unknown;
  onabort: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<AbortListener, boolean>();
  addEventListener(
    type: string,
    listener: AbortListener | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (type === "abort" && listener && !this.listeners.has(listener))
      this.listeners.set(listener, typeof options === "object" && options.once === true);
  }
  removeEventListener(type: string, listener: AbortListener | null) {
    if (type === "abort" && listener) this.listeners.delete(listener);
  }
  throwIfAborted() {
    if (this.aborted) throw this.reason;
  }
  abort(reason: unknown = new PortableDOMException("The operation was aborted", "AbortError")) {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    const event = {
      type: "abort",
      target: this,
      currentTarget: this,
    } as unknown as Event;
    this.onabort?.(event);
    for (const [listener, once] of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      if (once) this.listeners.delete(listener);
      if (typeof listener === "function") listener.call(this as unknown as EventTarget, event);
      else listener.handleEvent(event);
    }
    this.listeners.clear();
  }
  static abort(reason?: unknown) {
    const signal = new PortableAbortSignal();
    signal.abort(reason);
    return signal;
  }
  static timeout(milliseconds: number) {
    if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 2_147_483_647)
      throw new RangeError("Abort timeout must fit a nonnegative native timer");
    const signal = new PortableAbortSignal();
    const timer = setTimeout(
      () => signal.abort(new PortableDOMException("The operation timed out", "TimeoutError")),
      milliseconds,
    );
    // Node host qualification must not stay alive solely for a retired deadline.
    (timer as unknown as { unref?: () => void }).unref?.();
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    return signal;
  }
}
export class PortableAbortController {
  readonly signal = new PortableAbortSignal();
  abort(reason?: unknown) {
    this.signal.abort(reason);
  }
}

type HeaderInput = HeadersInit | PortableHeaders;
export class PortableHeaders implements Iterable<[string, string]> {
  private readonly fields = new Map<string, string>();
  constructor(input?: HeaderInput) {
    if (!input) return;
    if (typeof (input as Iterable<unknown>)[Symbol.iterator] === "function") {
      for (const entry of input as Iterable<[string, string]>) {
        if (!Array.isArray(entry) || entry.length !== 2)
          throw new TypeError("Headers require name/value pairs");
        this.append(entry[0], entry[1]);
      }
    } else for (const [name, value] of Object.entries(input)) this.append(name, value);
  }
  private name(value: string) {
    const name = String(value).toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw new TypeError("Invalid header name");
    return name;
  }
  private value(value: string) {
    const text = String(value).replace(/^[\t ]+|[\t ]+$/g, "");
    if (/[\0\r\n]/.test(text)) throw new TypeError("Invalid header value");
    return text;
  }
  append(name: string, value: string) {
    const key = this.name(name),
      text = this.value(value);
    this.fields.set(key, this.fields.has(key) ? `${this.fields.get(key)}, ${text}` : text);
  }
  set(name: string, value: string) {
    this.fields.set(this.name(name), this.value(value));
  }
  delete(name: string) {
    this.fields.delete(this.name(name));
  }
  get(name: string) {
    return this.fields.get(this.name(name)) ?? null;
  }
  has(name: string) {
    return this.fields.has(this.name(name));
  }
  *entries(): IterableIterator<[string, string]> {
    yield* [...this.fields].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
  *keys() {
    for (const [key] of this.entries()) yield key;
  }
  *values() {
    for (const [, value] of this.entries()) yield value;
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  forEach(
    callback: (value: string, key: string, headers: PortableHeaders) => void,
    thisArg?: unknown,
  ) {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
  getSetCookie(): string[] {
    return [];
  } // Native API requests use explicit credentials, never a browser cookie jar.
}

export class PortableResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: PortableHeaders;
  readonly ok: boolean;
  readonly redirected = false;
  readonly type = "default";
  readonly body = null;
  bodyUsed = false;
  url = "";
  private readonly data: string;
  constructor(body: string | null = null, init: ResponseInit = {}) {
    this.status = init.status ?? 200;
    if (!Number.isInteger(this.status) || this.status < 200 || this.status > 599)
      throw new RangeError("Invalid response status");
    if ([204, 205, 304].includes(this.status) && body !== null)
      throw new TypeError("This response status cannot have a body");
    this.data = body ?? "";
    this.statusText = init.statusText ?? "";
    this.headers = new PortableHeaders(init.headers);
    this.ok = this.status >= 200 && this.status < 300;
  }
  async text(): Promise<string> {
    if (this.bodyUsed) throw new TypeError("Response body was already consumed");
    this.bodyUsed = true;
    return this.data;
  }
  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return encodeUtf8(await this.text()).buffer as ArrayBuffer;
  }
  clone(): PortableResponse {
    if (this.bodyUsed) throw new TypeError("Response body was already consumed");
    const result = new PortableResponse(this.data || null, {
      status: this.status,
      statusText: this.statusText,
      headers: Object.fromEntries(this.headers),
    });
    result.url = this.url;
    return result;
  }
  static json(value: unknown, init: ResponseInit = {}) {
    const headers = new PortableHeaders(init.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new PortableResponse(JSON.stringify(value), {
      ...init,
      headers: headers as unknown as Headers,
    });
  }
}

export class PortableRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: PortableHeaders;
  readonly signal: AbortSignal;
  readonly credentials: RequestCredentials;
  readonly redirect: RequestRedirect;
  bodyUsed = false;
  private readonly data: string;
  constructor(input: string | URL | PortableRequest, init: RequestInit = {}) {
    const previous = input instanceof PortableRequest ? input : undefined;
    this.url = new URL(previous?.url ?? String(input)).href;
    this.method = String(init.method ?? previous?.method ?? "GET").toUpperCase();
    this.headers = new PortableHeaders(init.headers ?? previous?.headers);
    this.credentials = init.credentials ?? previous?.credentials ?? "same-origin";
    this.redirect = init.redirect ?? previous?.redirect ?? "follow";
    if (
      !["omit", "same-origin", "include"].includes(this.credentials) ||
      !["follow", "error", "manual"].includes(this.redirect)
    )
      throw new TypeError("Unsupported Request credential or redirect policy");
    this.signal =
      init.signal ??
      previous?.signal ??
      (new PortableAbortController().signal as unknown as AbortSignal);
    const body = init.body ?? previous?.data ?? "";
    if (typeof body !== "string")
      throw new RokuHostError("C22_FETCH_BODY", "Request admits text bodies only");
    if (["GET", "HEAD"].includes(this.method) && (init.body != null || body))
      throw new TypeError("GET and HEAD requests cannot have a body");
    this.data = body;
  }
  async text() {
    if (this.bodyUsed) throw new TypeError("Request body was already consumed");
    this.bodyUsed = true;
    return this.data;
  }
  async json() {
    return JSON.parse(await this.text());
  }
  clone() {
    if (this.bodyUsed) throw new TypeError("Request body was already consumed");
    return new PortableRequest(this);
  }
}

export interface WebRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  readonly redirect?: WebRedirectMode;
}
export interface WebResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly url?: string;
}
export type WebRedirectMode = "follow" | "error";
export type WebTransport = ((request: WebRequest) => Promise<WebResponse>) & {
  /** Omission preserves the legacy follow-only contract. Each advertised mode
   * must be enforced before a redirect hop, not inferred from a final response. */
  readonly redirectModes?: readonly WebRedirectMode[];
};

/** The SDK fetch takes a native Request, not the browser's second init argument. */
export function createPortableFetch(transport: WebTransport) {
  const modes = [...(transport.redirectModes ?? ["follow"])];
  if (modes.some((mode) => mode !== "follow" && mode !== "error"))
    throw new TypeError("Unsupported transport redirect capability");
  return async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const request = typeof input === "object" && "url" in input ? (input as Request) : undefined;
    const url = new URL(request?.url ?? String(input));
    if (!["http:", "https:"].includes(url.protocol))
      throw new TypeError("Fetch requires an HTTP URL");
    if (url.username || url.password) throw new TypeError("Fetch URLs cannot contain credentials");
    url.hash = "";
    const signal = init.signal ?? request?.signal;
    if (signal?.aborted)
      throw signal.reason ?? new PortableDOMException("The operation was aborted", "AbortError");
    if ((init.credentials ?? request?.credentials) === "include")
      throw new RokuHostError("C22_FETCH_COOKIES", "Native requests have no browser cookie jar");
    const redirect = init.redirect ?? request?.redirect ?? "follow";
    if (!["follow", "error", "manual"].includes(redirect))
      throw new TypeError("Invalid redirect policy");
    if (!modes.includes(redirect as WebRedirectMode))
      throw new RokuHostError(
        "C22_FETCH_REDIRECT",
        "This transport cannot enforce the requested redirect policy",
      );
    const method = String(init.method ?? request?.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method))
      throw new TypeError("Unsupported request method");
    const headers = new PortableHeaders(init.headers ?? request?.headers);
    let body = init.body;
    if (body === undefined && request && !["GET", "HEAD"].includes(request.method))
      body = await request.clone().text();
    if (body instanceof URLSearchParams) {
      if (!headers.has("content-type"))
        headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      body = body.toString();
    }
    if (body != null && typeof body !== "string")
      throw new RokuHostError(
        "C22_FETCH_BODY",
        "This native transport admits text request bodies only",
      );
    if (["GET", "HEAD"].includes(method) && body != null)
      throw new TypeError("GET and HEAD requests cannot have a body");
    // Reading a caller's cloned Request body can yield. An abort in that window
    // predates listener registration and must still prevent native dispatch.
    if (signal?.aborted)
      throw signal.reason ?? new PortableDOMException("The operation was aborted", "AbortError");
    let cancel: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () =>
        reject(
          signal?.reason ?? new PortableDOMException("The operation was aborted", "AbortError"),
        );
      signal?.addEventListener("abort", cancel, { once: true });
    });
    try {
      const result = await Promise.race([
        transport({
          url: url.href,
          method,
          redirect: redirect as WebRedirectMode,
          headers: Object.fromEntries(headers),
          ...(body == null ? {} : { body }),
          ...(signal ? { signal } : {}),
        }),
        cancelled,
      ]);
      if (signal?.aborted)
        throw signal.reason ?? new PortableDOMException("The operation was aborted", "AbortError");
      if (
        redirect === "error" &&
        ([301, 302, 303, 307, 308].includes(result.status) ||
          (result.url && result.url !== url.href))
      )
        throw new TypeError("A redirect is not allowed for this request");
      const response = new PortableResponse(
        [204, 205, 304].includes(result.status) ? null : result.body,
        {
          status: result.status,
          headers: result.headers,
        },
      );
      response.url = result.url ?? url.href;
      return response as unknown as Response;
    } finally {
      if (cancel) signal?.removeEventListener("abort", cancel);
    }
  };
}
