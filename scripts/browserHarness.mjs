import { findChromium } from "../build/environment.mjs";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  child.stderr.on("data", (value) => {
    stderr = (stderr + value.toString()).slice(-8192);
  });
  let socket;
  const diagnostics = () => ({
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    socketState: socket?.readyState ?? null,
    stderr,
  });
  const closeChild = async () => {
    if (child.exitCode === null && child.signalCode === null) {
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
  child.on("error", () => {});
  try {
    const port = await until(() => {
      const path = resolve(directory, "DevToolsActivePort");
      return existsSync(path) && Number(readFileSync(path, "utf8").split("\n")[0]);
    });
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
    socket?.close();
    await closeChild();
    throw error;
  }
}
