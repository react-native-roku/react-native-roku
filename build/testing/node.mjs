// Qualification IO only. This entry is excluded from runtime/browser/SDK graphs.
const nativeFetch = globalThis.fetch?.bind(globalThis);
const NativeAbortController = globalThis.AbortController;

/** Supply the source-release operation expected by CanvasSceneGraph. The
 * consumer injects its native image; this package does not depend on Canvas. */
export function canvasImageSource(image) {
  image.removeAttribute = (name) => {
    if (name === "src") image.src = "";
  };
  return image;
}

/** Bridge a verified Node text-fetch port to the public portable web API.
 * Compile/load that API from the installed package and inject its factory.
 * A custom port must explicitly declare any strict redirect capability. */
export function createNodeTextHttp({
  createPortableFetch,
  fetch: port = nativeFetch,
  redirectModes = port === nativeFetch ? ["follow", "error"] : ["follow"],
} = {}) {
  if (
    typeof createPortableFetch !== "function" ||
    typeof port !== "function" ||
    typeof NativeAbortController !== "function"
  )
    throw Error("Node text HTTP requires fetch and abort ports");
  let requests = 0,
    active = 0,
    forwardingListeners = 0,
    aborts = 0,
    errors = 0;
  const transport = Object.assign(
    async (request) => {
      requests++;
      active++;
      const controller = new NativeAbortController();
      const cancel = () => {
        aborts++;
        controller.abort(request.signal?.reason);
      };
      try {
        if (request.signal) {
          request.signal.addEventListener("abort", cancel, { once: true });
          forwardingListeners++;
          if (request.signal.aborted) cancel();
        }
        const response = await port(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: request.redirect,
          credentials: "omit",
          signal: controller.signal,
        });
        const type =
          response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
        if (
          type &&
          !type.startsWith("text/") &&
          !/^application\/(json|[^;]+\+json|xml|[^;]+\+xml|vnd\.apple\.mpegurl|x-mpegurl)$/.test(
            type,
          )
        ) {
          await response.body?.cancel();
          throw Error("The host text fixture cannot decode a binary response");
        }
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
          url: response.url || request.url,
        };
      } catch (error) {
        errors++;
        throw error;
      } finally {
        if (request.signal) {
          request.signal.removeEventListener("abort", cancel);
          forwardingListeners--;
        }
        active--;
      }
    },
    { redirectModes: Object.freeze([...redirectModes]) },
  );
  return {
    transport,
    fetch: createPortableFetch(transport),
    async whenIdle() {
      const deadline = Date.now() + 2000;
      while (active && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (active || forwardingListeners) throw Error("Host HTTP requests/listeners did not retire");
    },
    snapshot: () => ({
      kind: "node-text-http-fixture",
      requests,
      active,
      forwardingListeners,
      aborts,
      errors,
      deviceQualified: false,
    }),
  };
}
