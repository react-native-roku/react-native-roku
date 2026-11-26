import { findChromium } from "../build/environment.mjs";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(work, { timeout = 30000, interval = 100 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      const value = await work();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await pause(interval);
  }
  throw last ?? Error("Browser test timed out");
}
export async function openTestBrowser(url) {
  const browser = findChromium();
  if (!browser) throw Error("Set ROKU_TEST_CHROMIUM to run browser development-loop qualification");
  const directory = mkdtempSync(resolve(tmpdir(), "roku-browser-"));
  const child = spawn(
    browser,
    [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      "--disable-sync",
      "--remote-debugging-port=0",
      `--user-data-dir=${directory}`,
      url,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  let spawnError;
  let closed = false;
  child.once("error", (error) => {
    spawnError = error.message;
  });
  child.once("close", () => {
    closed = true;
  });
  child.stderr.on("data", (value) => {
    stderr = (stderr + value.toString()).slice(-8192);
  });
  let socket;
  const diagnostics = () => ({
    executable: browser,
    spawnError: spawnError ?? null,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    socketState: socket?.readyState ?? null,
    stderr,
  });
  const closeChild = async () => {
    if (!closed && child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {}
  };
  try {
    const portFile = resolve(directory, "DevToolsActivePort");
    const startup = await until(() => {
      if (closed || spawnError) return { exited: true };
      const port = existsSync(portFile) && Number(readFileSync(portFile, "utf8").split("\n")[0]);
      return port && { port };
    });
    if (startup.exited) throw Error("Chromium exited before creating DevToolsActivePort");
    const { port } = startup;
    const target = await until(async () => {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return (
        pages.find((page) => page.type === "page" && page.url.startsWith(url)) ??
        pages.find((page) => page.type === "page")
      );
    });
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let sequence = 0;
    const waiting = new Map();
    const events = [];
    socket.addEventListener("message", (event) => {
      const packet = JSON.parse(event.data);
      if (
        ["Runtime.exceptionThrown", "Log.entryAdded"].includes(packet.method) ||
        (packet.method === "Runtime.consoleAPICalled" && packet.params.type === "warning")
      ) {
        events.push(packet);
        if (events.length > 100) events.shift();
      }
      if (packet.id) {
        const item = waiting.get(packet.id);
        if (item) {
          waiting.delete(packet.id);
          clearTimeout(item.timer);
          packet.error ? item.reject(Error(packet.error.message)) : item.resolve(packet.result);
        }
      }
    });
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(Error("Test browser is closed"));
          return;
        }
        const id = ++sequence;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(Error(`Browser command timed out: ${method}; ${JSON.stringify(diagnostics())}`));
        }, 15000);
        waiting.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    return {
      call,
      evaluate,
      diagnostics,
      events,
      version: await call("Browser.getVersion"),
      async close() {
        for (const item of waiting.values()) {
          clearTimeout(item.timer);
          item.reject(Error("Test browser closed"));
        }
        waiting.clear();
        socket.close();
        await closeChild();
      },
    };
  } catch (error) {
    const processState = diagnostics();
    let profile;
    try {
      profile = { directory, entries: readdirSync(directory).sort().slice(0, 40) };
    } catch (error) {
      profile = { directory, error: error.message };
    }
    socket?.close();
    await closeChild();
    const version = spawnSync(browser, ["--version"], { encoding: "utf8", timeout: 3000 });
    throw Error(
      `Chromium startup failed: ${error.message}; ${JSON.stringify({
        ...processState,
        version: version.stdout?.trim() || version.stderr?.trim() || version.error?.message || null,
        profile,
      })}`,
      { cause: error },
    );
  }
}
