import type {
  createPortableFetch as portableFetch,
  WebTransport,
} from "../../src/services/webRuntime";

export function canvasImageSource<Image extends { src: string | Uint8Array }>(
  image: Image,
): Image & {
  removeAttribute(name: string): void;
};

export function createNodeTextHttp(options: {
  createPortableFetch: typeof portableFetch;
  fetch?: typeof globalThis.fetch;
  redirectModes?: readonly ("follow" | "error")[];
}): {
  transport: WebTransport;
  fetch: typeof globalThis.fetch;
  whenIdle(): Promise<void>;
  snapshot(): {
    kind: string;
    requests: number;
    active: number;
    forwardingListeners: number;
    aborts: number;
    errors: number;
    deviceQualified: false;
  };
};
