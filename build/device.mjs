import { createHash, randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { isRokuDiagnosticError } from "./identity.mjs";
export { parseRokuHostDiagnostics } from "./identity.mjs";
const xmlText = (xml, name) =>
  new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`, "i").exec(xml)?.[1]?.trim() ?? null;
const attribute = (text, name) => new RegExp(`\\b${name}="([^"]*)"`, "i").exec(text)?.[1] ?? null;
export function parseActiveApp(xml) {
  const element = /<app\b[^>]*>([^<]*)<\/app>/.exec(xml);
  return element
    ? { id: attribute(element[0], "id"), name: element[1].trim() }
    : { id: null, name: null };
}
export function parseMediaPlayer(xml) {
  const player = /<player\b[^>]*>/.exec(xml)?.[0] ?? "";
  const seconds = (value) => {
    if (!value) return null;
    const number = parseFloat(value);
    return Number.isFinite(number) ? number / (value.includes("ms") ? 1000 : 1) : null;
  };
  return {
    state: attribute(player, "state"),
    error: attribute(player, "error"),
    positionSeconds: seconds(xmlText(xml, "position")),
    durationSeconds: seconds(xmlText(xml, "duration")),
  };
}
export function parseDeviceFacts(xml) {
  return {
    model: xmlText(xml, "model-number"),
    modelName: xmlText(xml, "model-name"),
    firmware: xmlText(xml, "software-version"),
    developerEnabled: xmlText(xml, "developer-enabled"),
  };
}
export function createRokuDeviceClient({
  host,
  ecpPort = 8060,
  installerPort = 80,
  timeoutMs = 5000,
}) {
  if (
    typeof host !== "string" ||
    !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)$/.test(host) ||
    host.includes("..")
  )
    throw Error(
      "Choose a device IPv4 address or hostname without a URL, credentials, path or port",
    );
  const origin = `http://${host}:${ecpPort}`,
    installer = `http://${host}:${installerPort}`;
  const request = async (path, { method = "GET", headers, body, base = origin } = {}) => {
    const result = await fetch(new URL(path, base), {
      method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!result.ok) throw Error(`Roku ${method} ${path} returned ${result.status}`);
    return result;
  };
  const query = async (name) => {
    if (!/^[a-z0-9/-]+(?:\?[a-z0-9_=&]+)?$/i.test(name) || name.toLowerCase().includes("registry"))
      throw Error("Unsupported diagnostic query");
    return (await request("/query/" + name)).text();
  };
  const keypress = async (key) => {
    if (
      ![
        "Up",
        "Down",
        "Left",
        "Right",
        "Select",
        "Back",
        "Home",
        "Play",
        "Rev",
        "Fwd",
        "Info",
      ].includes(key)
    )
      throw Error("Unsupported qualification key");
    await request("/keypress/" + key, { method: "POST" });
  };
  async function digest(path, options, password) {
    const url = new URL(path, installer);
    const challenge = await fetch(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (challenge.ok) return challenge;
    if (challenge.status !== 401)
      throw Error(`Developer screenshot endpoint returned ${challenge.status}`);
    const header = challenge.headers.get("www-authenticate") ?? "";
    const fields = Object.fromEntries(
      [...header.matchAll(/([a-z]+)=(?:"([^"]*)"|([^, ]+))/gi)].map((match) => [
        match[1].toLowerCase(),
        match[2] ?? match[3],
      ]),
    );
    if (
      !/^Digest /i.test(header) ||
      !fields.realm ||
      !fields.nonce ||
      !["MD5", "SHA-256"].includes(fields.algorithm ?? "MD5") ||
      !fields.qop
        ?.split(",")
        .map((value) => value.trim())
        .includes("auth")
    )
      throw Error("Unsupported developer authentication challenge");
    const algorithm = (fields.algorithm ?? "MD5").toLowerCase().replace("-", ""),
      hash = (value) => createHash(algorithm).update(value).digest("hex"),
      username = "rokudev",
      cnonce = randomBytes(12).toString("hex"),
      nc = "00000001",
      uri = url.pathname + url.search,
      method = options.method ?? "GET";
    const response = hash(
      `${hash(`${username}:${fields.realm}:${password}`)}:${fields.nonce}:${nc}:${cnonce}:auth:${hash(`${method}:${uri}`)}`,
    );
    const quote = (value) =>
      '"' + String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
    const authorization =
      "Digest " +
      Object.entries({
        username,
        realm: fields.realm,
        nonce: fields.nonce,
        uri,
        response,
        algorithm: fields.algorithm ?? "MD5",
        qop: "auth",
        nc,
        cnonce,
        ...(fields.opaque ? { opaque: fields.opaque } : {}),
      })
        .map(
          ([name, value]) =>
            `${name}=${["algorithm", "qop", "nc"].includes(name) ? value : quote(value)}`,
        )
        .join(", ");
    const result = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: authorization },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!result.ok)
      throw Error(`Developer screenshot authentication/request failed (${result.status})`);
    return result;
  }
  async function screenshot(password) {
    if (!password)
      throw Error("Set ROKU_DEV_PASSWORD in the environment to collect a developer screenshot");
    const form = new FormData();
    form.append("mysubmit", "Screenshot");
    form.append("archive", "");
    form.append("passwd", "");
    const html = await (
      await digest("/plugin_inspect", { method: "POST", body: form }, password)
    ).text();
    const match = /<img\s+src="(pkgs\/dev\.(?:jpg|png)(?:\?[^"<>]*)?)"/i.exec(html);
    if (!match)
      throw Error(
        "Developer installer returned no screenshot; keep the sideloaded app in the foreground",
      );
    const data = Buffer.from(await (await digest("/" + match[1], {}, password)).arrayBuffer());
    const format = data.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]))
      ? "png"
      : data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        ? "jpg"
        : null;
    if (!format) throw Error("Developer installer returned non-image screenshot data");
    return { data, format };
  }
  return {
    query,
    keypress,
    screenshot,
    launch: async () => {
      await request("/launch/dev", { method: "POST" });
    },
    terminate: async () => {
      const result = await fetch(new URL("/exit-app/dev/true", origin), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!result.ok && result.status !== 404)
        throw Error(`Roku cold-start termination returned ${result.status}`);
      return result.status === 404 ? "not-running" : "terminated";
    },
    appInstalled: async (expectedName) => {
      const xml = await query("apps");
      return [...xml.matchAll(/<app\b[^>]*>([^<]*)<\/app>/g)].some(
        (match) => attribute(match[0], "id") === "dev" && match[1].trim() === expectedName,
      );
    },
  };
}
/** Only diagnostic-prefixed lines are retained. Arbitrary application logs are not collected. */
export function captureRokuDiagnostics(
  host,
  { port = 8085, maxLines = 2000, maxLineLength = 8192 } = {},
) {
  if (
    !Number.isInteger(maxLines) ||
    maxLines < 1 ||
    maxLines > 10000 ||
    !Number.isInteger(maxLineLength) ||
    maxLineLength < 256 ||
    maxLineLength > 16384
  )
    throw Error("Choose bounded diagnostic line and buffer limits");
  const lines = [];
  let decoder = new StringDecoder("utf8");
  let pending = "",
    available = false,
    status = "connecting",
    discarded = false,
    droppedLines = 0,
    settle;
  const ready = new Promise((resolve) => {
    settle = resolve;
  });
  const retain = (value) => {
    const line = value.replace(/\r/g, "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
    if (!line.includes("RNR_") && !isRokuDiagnosticError(line)) return;
    lines.push(
      line
        .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
        .replace(
          /((?:token|password|authorization|cookie|secret)["']?\s*[=:]\s*)("(?:\\.|[^"])*"|'[^']*'|[^,\s}]+)/gi,
          "$1[redacted]",
        )
        .replace(/https?:\/\/[^\s"']+/gi, "[url omitted]"),
    );
    if (lines.length > maxLines) {
      lines.shift();
      droppedLines++;
    }
  };
  const flush = () => {
    if (!discarded && pending) retain(pending);
    pending = "";
    discarded = false;
  };
  const socket = createConnection({ host, port });
  socket.setTimeout(5000, () => {
    status = "timed-out";
    settle(false);
    socket.destroy();
  });
  socket.on("connect", () => {
    available = true;
    status = "connected";
    settle(true);
    socket.setTimeout(0);
  });
  socket.on("error", () => {
    status = "error";
    settle(false);
  });
  socket.on("close", () => {
    flush();
    if (status === "connected" || status === "connecting") status = "closed";
    settle(false);
  });
  socket.on("data", (data) => {
    const complete = decoder.write(data).split("\n");
    for (let index = 0; index < complete.length; index++) {
      const part = complete[index];
      if (!discarded && pending.length + part.length <= maxLineLength) pending += part;
      else {
        if (!discarded) droppedLines++;
        discarded = true;
        pending = "";
      }
      if (index === complete.length - 1) break;
      const line = pending;
      pending = "";
      if (discarded) {
        discarded = false;
        continue;
      }
      retain(line);
    }
  });
  return {
    ready,
    clear: () => {
      lines.length = 0;
      pending = "";
      discarded = false;
      droppedLines = 0;
      decoder = new StringDecoder("utf8");
    },
    snapshot: () => ({ available, status, droppedLines, lines: [...lines] }),
    close: () => {
      flush();
      settle(false);
      socket.destroy();
    },
  };
}
