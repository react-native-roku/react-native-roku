import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { watch, readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".map": "application/json",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".css": "text/css",
};
const ignored = (path) =>
  path
    .split(/[\\/]/)
    .some((part) =>
      [
        "node_modules",
        ".git",
        ".local",
        ".roku",
        "dist",
        "generated",
        ".build-state",
        ".turbo",
        "coverage",
      ].includes(part),
    ) || /\.tsbuildinfo$/.test(path);
function browserClient(generation, sessionId) {
  return `<script>(()=>{
    let initial=${generation},closed=false,latest,queue=Promise.resolve();
    const session=${JSON.stringify(sessionId)},events=new EventSource('/__roku/events');
    function show(message){let panel=document.getElementById('roku-build-status');if(!panel){panel=document.createElement('div');panel.id='roku-build-status';panel.style.cssText='position:fixed;bottom:8px;left:8px;right:8px;padding:8px;background:#202030;color:white;z-index:999999;white-space:pre-wrap;font:13px monospace';document.body.append(panel);}panel.textContent=message||'';panel.hidden=!message;}
    function reload(reason){if(closed)return;console.warn('Roku preview full reload',typeof reason==='string'?reason:'update delivery failed');closed=true;events.close();location.reload();}
    events.onmessage=event=>{
      const value=JSON.parse(event.data);latest=value;
      if(value.state==='error'){show(value.error);return;}
      if(value.state==='building'){show('Rebuilding Roku preview…');return;}
      queue=queue.then(async()=>{
        if(closed)return;
        if(value.sessionId!==session){reload('development server changed');return;}
        if(value.generation===initial)return;
        const runtime=globalThis.__RNR_ROKU_REFRESH__;
        if(value.refresh?.type!=='refresh'||!runtime){reload(value.refresh?.reason||'refresh runtime unavailable');return;}
        const result=await runtime.applyUpdate(value.refresh);
        if(closed||result.type==='retired')return;
        if(result.type==='reload'){reload(result.reason||'refresh lifetime changed');return;}
        initial=value.generation;
        if(latest.state==='ready'&&latest.generation===value.generation)show(result.error);
      }).catch(reload);
    };
    window.addEventListener('pagehide',()=>{closed=true;events.close();},{once:true});
  })();</script>`;
}
/** Serial, coalescing development builds. Publication happens only after a complete successful build. */
export async function createRokuDevServer({
  build,
  watchPaths = [],
  port = 9389,
  handleRequest,
  debounceMs = 120,
  onBuild = () => {},
}) {
  const clients = new Set(),
    watchers = [];
  let directory = null,
    generation = 0,
    state = "building",
    error = null,
    closed = false,
    pending = false,
    running = null,
    timer;
  let refreshPlan;
  const sessionId = randomUUID();
  let closing;
  const durations = [];
  let builds = 0,
    failures = 0,
    lastBuildMs = null,
    invalidatedAt = null,
    lastEditToReadyMs = null;
  const snapshot = () => ({
    state,
    generation,
    error,
    sessionId,
    ...(refreshPlan ? { refresh: refreshPlan } : {}),
    metrics: { builds, failures, lastBuildMs, lastEditToReadyMs, recentBuildMs: [...durations] },
  });
  const publish = () => {
    const value = snapshot();
    onBuild(value);
    for (const client of clients) client.write(`data: ${JSON.stringify(value)}\n\n`);
  };
  const run = () => {
    pending = true;
    if (running || closed) return running;
    running = (async () => {
      while (pending && !closed) {
        pending = false;
        state = "building";
        error = null;
        publish();
        const next = generation + 1;
        const started = performance.now();
        builds++;
        try {
          const result = await build({ generation: next });
          if (closed) break;
          const candidate = resolve(typeof result === "string" ? result : result.directory);
          if (!existsSync(resolve(candidate, "index.html")))
            throw Error("A development build needs index.html");
          if (pending) continue;
          directory = candidate;
          generation = next;
          refreshPlan = typeof result === "string" ? undefined : result.refresh;
          lastBuildMs = Math.round(performance.now() - started);
          durations.push(lastBuildMs);
          if (durations.length > 32) durations.shift();
          lastEditToReadyMs =
            invalidatedAt === null ? null : Math.round(performance.now() - invalidatedAt);
          invalidatedAt = null;
          state = "ready";
          error = null;
          publish();
        } catch (value) {
          if (closed) break;
          state = "error";
          failures++;
          lastBuildMs = Math.round(performance.now() - started);
          error = value instanceof Error ? value.message : String(value);
          publish();
        }
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };
  const invalidate = () => {
    if (closed) return;
    invalidatedAt ??= performance.now();
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (pending) void run();
    }, debounceMs);
  };
  const server = createServer((request, response) => {
    const host = request.headers.host,
      local = request.socket.localPort;
    if (
      ![`127.0.0.1:${local}`, `localhost:${local}`].includes(host) ||
      (request.headers.origin && request.headers.origin !== `http://${host}`)
    ) {
      response.writeHead(403).end("Development origin refused");
      return;
    }
    try {
      const path = decodeURIComponent(new URL(request.url ?? "/", `http://${host}`).pathname);
      if (path === "/__roku/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        response.write(`data: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(response);
        response.on("close", () => clients.delete(response));
        return;
      }
      if (path === "/__roku/status") {
        response
          .writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          })
          .end(JSON.stringify(snapshot()));
        return;
      }
      if (handleRequest?.(request, response)) return;
      if (!directory) {
        response
          .writeHead(200, {
            "Content-Type": "text/html",
            "Cache-Control": "no-store",
          })
          .end(
            '<!doctype html><body style="background:#101014;color:white;font:16px system-ui">Waiting for a successful Roku build.</body>' +
              browserClient(generation, sessionId),
          );
        return;
      }
      const file = resolve(directory, `.${path === "/" ? "/index.html" : path}`);
      if (
        !file.startsWith(directory + sep) ||
        !existsSync(file) ||
        !statSync(file).isFile() ||
        !realpathSync(file).startsWith(realpathSync(directory) + sep) ||
        path.split("/").some((part) => part.startsWith("."))
      ) {
        response.writeHead(404).end("Not found");
        return;
      }
      let content = readFileSync(file);
      if (extname(file) === ".html")
        content = Buffer.from(content.toString() + browserClient(generation, sessionId));
      response
        .writeHead(200, {
          "Content-Type": mime[extname(file)] ?? "application/octet-stream",
          "Cache-Control": "no-store",
        })
        .end(content);
    } catch {
      response.writeHead(400).end("Invalid request");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  try {
    for (const path of watchPaths) {
      if (existsSync(path) && statSync(path).isDirectory()) {
        watchers.push(
          watch(path, { recursive: true }, (_event, file) => {
            if (!file || !ignored(String(file))) invalidate();
          }),
        );
      } else {
        // File-name notifications for an atomic editor replacement can be lost
        // or refer only to the temporary source. Poll the configured file's
        // identity/metadata instead of depending on a directory rename event.
        const signature = () => {
          try {
            const value = statSync(path);
            return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
          } catch (error) {
            return `unavailable:${error.code ?? "unknown"}`;
          }
        };
        let previous = signature();
        const poll = setInterval(() => {
          const current = signature();
          if (current !== previous) {
            previous = current;
            invalidate();
          }
        }, 100);
        watchers.push({ close: () => clearInterval(poll) });
      }
    }
    // Watch before compiling so edits during the cold build coalesce into a
    // fresh candidate rather than being lost before the first publication.
    await run();
  } catch (error) {
    closed = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    for (const client of clients) client.end();
    clients.clear();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    snapshot,
    invalidate,
    rebuild: run,
    async idle() {
      clearTimeout(timer);
      if (pending && !running) await run();
      await running;
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        clearTimeout(timer);
        for (const watcher of watchers) watcher.close();
        for (const client of clients) client.end();
        clients.clear();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await running;
      })();
      return closing;
    },
  };
}
