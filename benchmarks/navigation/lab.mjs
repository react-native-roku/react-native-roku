import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  captureRokuDiagnostics,
  createRokuDeviceClient,
  parseActiveApp,
  parseMediaPlayer,
} from "../../build/device.mjs";

const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");

export function identify(path) {
  const bytes = readFileSync(path);
  const manifest = execFileSync("unzip", ["-p", path, "manifest"], { encoding: "utf8" });
  const title = /^title=(.+)$/m.exec(manifest)?.[1]?.trim();
  assert.ok(title, "Missing title in ZIP manifest");
  return { bytes, title, md5: hash(bytes, "md5"), sha256: hash(bytes) };
}

export function installed(html, expected) {
  const plain = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");
  const explicit =
    /Currently Installed Application:\s*([a-f\d]{32})\s+zip file[^()]*\(([\d,]+) bytes\)/i.exec(
      plain,
    );
  if (explicit)
    return (
      explicit[1].toLowerCase() === expected.md5 &&
      Number(explicit[2].replaceAll(",", "")) === expected.bytes.length
    );
  // Other firmware renders the installed values as adjacent table cells.
  const digestValues = plain.match(/\b[a-f\d]{32}\b/gi) ?? [];
  if (
    new Set(digestValues.map((value) => value.toLowerCase())).size !== 1 ||
    digestValues[0]?.toLowerCase() !== expected.md5
  )
    return false;
  const normalized = plain.replace(/\d[\d,]*/g, (value) => value.replaceAll(",", ""));
  return new RegExp("\\b" + expected.bytes.length + "\\b").test(normalized);
}

export function lease(directory, serial) {
  assert.match(serial, /^[\da-z-]{8,128}$/i);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  assert.ok(
    stat.isDirectory() && (!process.getuid || stat.uid === process.getuid()),
    "Unsafe lease directory",
  );
  const path = join(directory, hash(serial.toLowerCase()) + ".lock");
  const value = JSON.stringify({
    runId: randomUUID(),
    pid: process.pid,
    started: new Date().toISOString(),
  });
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
  return () => {
    assert.equal(readFileSync(path, "utf8"), value, "Device lease ownership changed");
    unlinkSync(path);
  };
}

async function until(operation, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try {
      if (await operation()) return;
    } catch (error) {
      last = error;
    }
    await wait(300);
  } while (Date.now() < deadline);
  throw Error("Device state did not settle", { cause: last });
}

async function main() {
  const [scenario, renderer, zip, rollback, output, ...extra] = process.argv.slice(2);
  const restoreDev = extra.includes("--restore-dev");
  const host = process.env.ROKU_BENCHMARK_HOST,
    directory = process.env.ROKU_LEASE_DIR;
  assert.ok(
    host && directory && output,
    "Usage: set ROKU_BENCHMARK_HOST and ROKU_LEASE_DIR, then run lab.mjs SCENARIO react|solid ZIP ORIGINAL_ZIP NEW_OUTPUT [suite options]",
  );
  // Validate the journey before touching a device.
  const suite = join(import.meta.dirname, "suite.py");
  const choices = execFileSync("python3", [suite, "device", "--help"], { encoding: "utf8" });
  assert.ok(
    choices
      .match(/\{warm[^}]+\}/)?.[0]
      .slice(1, -1)
      .split(",")
      .includes(scenario),
    "Unknown journey",
  );
  assert.ok(["react", "solid"].includes(renderer), "Unknown renderer");
  const fixture = identify(resolve(zip)),
    original = identify(resolve(rollback));
  const client = createRokuDeviceClient({ host });
  const sdkEntry = createRequire(import.meta.url).resolve("@roku-sdk/tooling");
  const sdkRequire = createRequire(sdkEntry);
  for (const loader of ["tsx/cjs/api", "tsx/esm/api"])
    (await import(pathToFileURL(sdkRequire.resolve(loader)))).register();
  const sdk = pathToFileURL(sdkEntry);
  const { resolveTargetDevice } = await import(new URL("./tooling-utils/devices-store.ts", sdk));
  const { RokuDevice } = await import(new URL("./tooling-utils/roku-device.ts", sdk));
  const target = await resolveTargetDevice({
    cwd: process.cwd(),
    deviceSelector: host,
    requirePassword: true,
    password: process.env.ROKU_DEV_PASSWORD,
  });
  const installer = new RokuDevice(host, target.password);
  const facts = await client.query("device-info");
  const serial = /<serial-number>([^<]+)<\/serial-number>/i.exec(facts)?.[1];
  const folder = resolve(output);
  mkdirSync(folder, { mode: 0o700 });
  const save = (name, content) =>
    writeFileSync(join(folder, name), content, { flag: "wx", mode: 0o600 });
  const release = lease(directory, serial);
  const matches = async (want) =>
    installed(await (await installer.fetchRoute("plugin_install")).text(), want);
  const active = async () => parseActiveApp(await client.query("active-app"));
  const idle = async () =>
    ["close", "none"].includes(parseMediaPlayer(await client.query("media-player")).state);
  const put = async (want) => {
    if (!(await matches(want))) {
      const form = new FormData();
      form.append("archive", new Blob([want.bytes], { type: "application/zip" }), "fixture.zip");
      form.append("mysubmit", "Install");
      form.append("passwd", "");
      // The installer can close the upload response as it restarts the channel.
      try {
        await (await installer._invokeRoku(form)).text();
      } catch (error) {
        await until(() => matches(want)).catch(() => {
          throw error;
        });
      }
    }
    await until(() => matches(want));
  };
  const foreground = async (want) => {
    const state = await active();
    return state.id === "dev" && state.name === want.title;
  };
  async function transition(label, command, observed) {
    try {
      await command();
    } catch (error) {
      console.error(label + " acknowledgement: " + error.name);
    }
    try {
      await until(observed, 40000);
    } catch (error) {
      throw Error(label + " state did not settle", { cause: error });
    }
  }
  const stopChannel = async () => {
    const inactive = async () =>
      /<(?:state|channel-state)>\s*inactive\s*<\//i.test(await client.query("app-state/dev"));
    if (!(await inactive()))
      await transition("Developer channel termination", () => client.terminate(), inactive);
  };
  let touched = false,
    restored = false,
    child,
    interrupted = false,
    initial;
  const stop = () => {
    interrupted = true;
    if (child?.pid) {
      // Stop the Python replay, its Node runner and the SDK recorder together.
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    assert.ok(await matches(original), "Rollback ZIP differs from installed channel");
    assert.ok(await idle(), "Device has an active media session");
    const initialXml = await client.query("active-app");
    initial = parseActiveApp(initialXml);
    assert.ok(
      initial.id === "dev" || /<app\b[^>]*\btype="home"/i.test(initialXml),
      "Use Home or the idle original developer channel",
    );
    if (initial.id === "dev") assert.equal(initial.name, original.title);
    if (interrupted) throw Error("Interrupted");
    touched = true;
    if (extra.includes("--reboot-before")) {
      const uptime = (xml) => Number(/<uptime>(\d+)<\/uptime>/.exec(xml)?.[1]);
      const previous = uptime(facts);
      assert.ok(Number.isFinite(previous), "Device uptime missing");
      const rk = resolve(import.meta.dirname, "../../node_modules/.bin/rk");
      execFileSync(rk, ["device", "reboot", host, "--local", "--json"], {
        stdio: "pipe",
        timeout: 25000,
      });
      await until(async () => uptime(await client.query("device-info")) < previous, 180000);
      await until(() => matches(original), 60000);
      save("reboot.json", JSON.stringify({ confirmed: true }));
    }
    const toolIndex = extra.indexOf("--rk");
    if (toolIndex !== -1) {
      assert.ok(extra[toolIndex + 1], "Missing rk executable");
      const result = execFileSync(
        resolve(extra[toolIndex + 1]),
        ["perfetto", "enable", "--local", "--host", host, "--channel-id", "dev"],
        { encoding: "utf8", timeout: 30000 },
      );
      save("perfetto-enable.log", result);
    }
    await stopChannel();
    await put(fixture);
    console.log("Fixture installation verified");
    await stopChannel();
    const diagnostics =
      process.env.ROKU_STARTUP_DIAGNOSTICS === "1" ? captureRokuDiagnostics(host) : null;
    let lastTree;
    try {
      if (diagnostics) await diagnostics.ready;
      await transition(
        "Fresh launch",
        () => client.launch(),
        () => foreground(fixture),
      );
      await until(async () => {
        lastTree = await client.query("app-ui");
        return /<(?:RenderableNode|Scene|Label|Rectangle)\b/.test(lastTree);
      });
    } finally {
      if (lastTree) save("startup.xml", lastTree);
      if (diagnostics) {
        diagnostics.close();
        save("startup-log.json", JSON.stringify(diagnostics.snapshot()));
      }
    }
    const receipt = join(folder, "installer.txt");
    save(
      "installer.txt",
      "Currently Installed Application: " +
        fixture.md5 +
        " zip file (" +
        fixture.bytes.length +
        " bytes)\n",
    );
    save(
      "identity.json",
      JSON.stringify({
        sha256: fixture.sha256,
        rollbackSha256: original.sha256,
        model: /<model-number>([^<]+)/.exec(facts)?.[1],
        firmware: /<software-version>([^<]+)/.exec(facts)?.[1],
      }),
    );
    if (interrupted) throw Error("Interrupted");
    child = spawn(
      "python3",
      [
        suite,
        "device",
        scenario,
        renderer,
        resolve(zip),
        receipt,
        join(folder, "journey"),
        ...extra.filter((arg) => !["--restore-dev", "--reboot-before"].includes(arg)),
      ],
      {
        stdio: "inherit",
        detached: true,
        ...(scenario === "clipping" && {
          env: { ...process.env, ROKU_DEV_PASSWORD: target.password },
        }),
      },
    );
    const code = await new Promise((res, rej) => {
      child.once("error", rej);
      child.once("close", res);
    });
    assert.equal(code, 0, "Journey failed");
  } finally {
    try {
      if (touched) {
        await put(original);
        if (initial.id === "dev" || restoreDev) {
          if (!(await foreground(original)))
            await transition(
              "Rollback launch",
              () => client.launch(),
              () => foreground(original),
            );
          await until(() => foreground(original));
        } else {
          await client.keypress("Home");
          await until(async () => (await active()).id !== "dev");
        }
        await until(idle);
        save(
          "restoration.json",
          JSON.stringify({
            sha256: original.sha256,
            installed: true,
            foreground: initial.id === "dev" || restoreDev ? "rollback" : "home",
            playbackClosed: true,
          }),
        );
        restored = true;
      }
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (!touched || restored) release();
      else console.error("Restoration unverified. The device lease is retained for recovery.");
    }
  }
}

if (import.meta.main) await main();
