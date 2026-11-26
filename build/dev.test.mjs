import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRokuDevServer } from "./dev.mjs";
test("repeated shutdown waits for the active build before callers may remove its workspace", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-dev-close-"));
  writeFileSync(resolve(root, "index.html"), "initial");
  let calls = 0,
    release,
    entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const server = await createRokuDevServer({
    port: 0,
    build: async () => {
      if (++calls === 2) {
        entered();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return root;
    },
  });
  const rebuild = server.rebuild();
  await started;
  const first = server.close(),
    second = server.close();
  let finished = false;
  second.then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(finished, false);
  release();
  await Promise.all([first, second, rebuild]);
});
test("watch builds serialize, coalesce and retain the last good output after an error", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-dev-test-"));
  let calls = 0,
    active = 0,
    max = 0,
    fail = false;
  const server = await createRokuDevServer({
    port: 0,
    build: async ({ generation }) => {
      calls++;
      max = Math.max(max, ++active);
      try {
        if (fail) throw Error("fixture compile error");
        const dir = resolve(root, String(generation));
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, "index.html"), `generation ${generation}`);
        return dir;
      } finally {
        active--;
      }
    },
  });
  try {
    assert.match(await (await fetch(server.url)).text(), /generation 1/);
    fail = true;
    await server.rebuild();
    assert.equal(server.snapshot().state, "error");
    assert.match(await (await fetch(server.url)).text(), /generation 1/);
    fail = false;
    await server.rebuild();
    assert.equal(server.snapshot().generation, 2);
    assert.equal(max, 1);
    const blocked = await fetch(server.url, {
      headers: { Origin: "https://untrusted.invalid" },
    });
    assert.equal(blocked.status, 403);
    symlinkSync(resolve(root, "outside.html"), resolve(root, "2/leak.html"));
    writeFileSync(resolve(root, "outside.html"), "private");
    assert.equal((await fetch(server.url + "/leak.html")).status, 404);
  } finally {
    await server.close();
  }
});

test("changes arriving during a build coalesce without exposing an incomplete generation", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-dev-coalesce-"));
  let calls = 0,
    active = 0,
    maxActive = 0,
    release,
    entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const server = await createRokuDevServer({
    port: 0,
    build: async ({ generation }) => {
      calls++;
      maxActive = Math.max(maxActive, ++active);
      try {
        if (calls === 2) {
          entered();
          await new Promise((resolve) => {
            release = resolve;
          });
        }
        const directory = resolve(root, `${generation}-${calls}`);
        mkdirSync(directory, { recursive: true });
        writeFileSync(resolve(directory, "index.html"), `build ${calls}`);
        return directory;
      } finally {
        active--;
      }
    },
  });
  try {
    const rebuild = server.rebuild();
    await started;
    server.rebuild();
    server.rebuild();
    server.invalidate();
    assert.match(await (await fetch(server.url)).text(), /build 1/);
    release();
    await rebuild;
    await server.idle();
    assert.equal(calls, 3);
    assert.equal(maxActive, 1);
    assert.equal(server.snapshot().generation, 2);
    assert.match(await (await fetch(server.url)).text(), /build 3/);
  } finally {
    release?.();
    await server.close();
  }
});

test("an initial error recovers and atomic configuration replacements remain watched", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-dev-config-"));
  const config = resolve(root, "roku.config.json");
  writeFileSync(config, "broken");
  const server = await createRokuDevServer({
    port: 0,
    debounceMs: 5,
    watchPaths: [config],
    build: async () => {
      const value = readFileSync(config, "utf8");
      if (value === "broken") throw Error("initial error");
      writeFileSync(resolve(root, "index.html"), `<h1>config:${value}</h1>`);
      return root;
    },
  });
  const waitForConfig = async (value) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (
        server.snapshot().state === "ready" &&
        (await (await fetch(server.url)).text()).includes(`<h1>config:${value}</h1>`)
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(
      `Atomic configuration ${value} was not served: ${JSON.stringify(server.snapshot())}`,
    );
  };
  try {
    assert.equal(server.snapshot().state, "error");
    assert.match(await (await fetch(server.url)).text(), /Waiting for a successful/);
    for (const generation of [1, 2]) {
      const replacement = resolve(root, "replacement.json");
      writeFileSync(replacement, String(generation));
      renameSync(replacement, config);
      await waitForConfig(generation);
    }
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("an atomic configuration edit during cold compilation is published without another save", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-dev-cold-edit-"));
  const config = resolve(root, "roku.config.json");
  writeFileSync(config, "before");
  let release,
    entered,
    calls = 0,
    server;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const starting = createRokuDevServer({
    port: 0,
    debounceMs: 5,
    watchPaths: [config],
    build: async ({ generation }) => {
      const value = readFileSync(config, "utf8");
      if (++calls === 1) {
        entered();
        await gate;
      }
      const directory = resolve(root, `output-${generation}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(directory, "index.html"), `<h1>${value}</h1>`);
      return directory;
    },
  });
  try {
    await started;
    const replacement = resolve(root, "replacement.json");
    writeFileSync(replacement, "after");
    renameSync(replacement, config);
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    server = await starting;
    assert.ok(calls >= 2, "The edit must trigger a second build during startup");
    assert.match(await (await fetch(server.url)).text(), /<h1>after<\/h1>/);
  } finally {
    release();
    server ??= await starting;
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
