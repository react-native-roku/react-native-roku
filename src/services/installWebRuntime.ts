import { URL, URLSearchParams } from "react-native-url-polyfill/js/URL";
import { installLanguageRuntime } from "./languageRuntime";
import {
  PortableAbortController,
  PortableAbortSignal,
  PortableDOMException,
  PortableHeaders,
  PortableRequest,
  PortableResponse,
  createPortableFetch,
  type WebTransport,
} from "./webRuntime";
export { createPortableFetch } from "./webRuntime";
export type { WebTransport, WebRequest, WebResponse, WebRedirectMode } from "./webRuntime";

interface GlobalLease {
  readonly value: unknown;
}
const owners = new WeakMap<
  object,
  Map<
    string,
    {
      previous?: PropertyDescriptor;
      leases: GlobalLease[];
    }
  >
>();

/** Install before the product graph is initialized. Returning a lease also
 * lets host qualification restore its original globals without leaking state. */
export function installWebRuntime(
  transport?: WebTransport,
  target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): () => void {
  const releaseLanguage = installLanguageRuntime();
  const values: Record<string, unknown> = {
    URL,
    URLSearchParams,
    Headers: PortableHeaders,
    Request: PortableRequest,
    Response: PortableResponse,
    DOMException: PortableDOMException,
    AbortController: PortableAbortController,
    AbortSignal: PortableAbortSignal,
  };
  if (transport) values.fetch = createPortableFetch(transport);
  let entries = owners.get(target);
  if (!entries) owners.set(target, (entries = new Map()));
  const releases = new Set<() => void>([releaseLanguage]);
  const release = () => {
    if (!releases.size) return;
    const failures: unknown[] = [];
    for (const work of [...releases]) {
      try {
        work();
        releases.delete(work);
      } catch (error) {
        failures.push(error);
      }
    }
    if (!entries.size && owners.get(target) === entries) owners.delete(target);
    if (failures.length) throw failures[0];
  };
  try {
    for (const [key, value] of Object.entries(values)) {
      const entry = entries.get(key) ?? {
        previous: Object.getOwnPropertyDescriptor(target, key),
        leases: [],
      };
      const lease = { value };
      Object.defineProperty(target, key, { value, writable: true, configurable: true });
      entries.set(key, entry);
      entry.leases.push(lease);
      releases.add(() => {
        const index = entry.leases.indexOf(lease);
        if (index < 0) return;
        if (
          index === entry.leases.length - 1 &&
          Object.getOwnPropertyDescriptor(target, key)?.value === value
        ) {
          const previous = entry.leases[index - 1];
          if (previous)
            Object.defineProperty(target, key, {
              value: previous.value,
              writable: true,
              configurable: true,
            });
          else if (entry.previous) Object.defineProperty(target, key, entry.previous);
          else Reflect.deleteProperty(target, key);
        }
        entry.leases.splice(index, 1);
        if (!entry.leases.length) entries.delete(key);
      });
    }
  } catch (error) {
    try {
      release();
    } catch {
      /* Preserve the installation error. */
    }
    throw error;
  }
  return release;
}
