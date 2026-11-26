import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { createHash } from "node:crypto";
import {
  createRokuDeviceClient,
  parseMediaPlayer,
  parseActiveApp,
  parseDeviceFacts,
  captureRokuDiagnostics,
  parseRokuHostDiagnostics,
} from "./device.mjs";
test("diagnostic capture retains only bounded diagnostic lines and removes credentials/URLs", async () => {
  let connection;
  const server = createTcpServer((socket) => {
    connection = socket;
    socket.write(
      'ordinary token=unrelated\nRNR_HOST {"token":"secret-token","password":"secret-password"} Bearer secret-bearer https://host.invalid/?token=secret-url\n',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const capture = captureRokuDiagnostics("127.0.0.1", { port: server.address().port, maxLines: 2 });
  try {
    for (let index = 0; index < 100 && !capture.snapshot().lines.length; index++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const report = capture.snapshot();
    assert.equal(report.lines.length, 1);
    assert.equal(report.available, true);
    for (const value of [
      "secret-token",
      "secret-password",
      "secret-bearer",
      "secret-url",
      "unrelated",
      "host.invalid",
    ])
      assert.ok(!JSON.stringify(report).includes(value), value);
  } finally {
    capture.close();
    connection?.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
test("device evidence parses native observations without retaining stream URLs or device serials", () => {
  assert.deepEqual(
    parseMediaPlayer(
      '<player state="play" error="false"><position>2000 ms</position><duration>30000 ms</duration><url>secret</url></player>',
    ),
    { state: "play", error: "false", positionSeconds: 2, durationSeconds: 30 },
  );
  assert.equal(parseActiveApp('<active-app><app id="dev">Fixture</app></active-app>').id, "dev");
  assert.equal(
    JSON.stringify(
      parseDeviceFacts(
        "<device-info><model-number>4850X</model-number><serial-number>private</serial-number></device-info>",
      ),
    ).includes("private"),
    false,
  );
});
test("device transport authenticates installer screenshots, refuses redirects and validates the sideloaded app", async () => {
  let authorized = 0;
  let running = true;
  const server = createServer(async (request, response) => {
    if (request.url === "/exit-app/dev/true") {
      response.writeHead(running ? 200 : 404).end();
      running = false;
      return;
    }
    if (request.url === "/query/apps") {
      response.end('<apps><app id="dev">Fixture</app></apps>');
      return;
    }
    if (request.url === "/query/redirect") {
      response.writeHead(302, { Location: "http://outside.invalid" }).end();
      return;
    }
    if (request.url.startsWith("/keypress/")) {
      response.end();
      return;
    }
    if (!request.headers.authorization) {
      response
        .writeHead(401, {
          "WWW-Authenticate": 'Digest realm="roku", nonce="fixture", qop="auth", algorithm=MD5',
        })
        .end();
      return;
    }
    const values = Object.fromEntries(
      [...request.headers.authorization.matchAll(/(\w+)=(?:"([^"]*)"|([^, ]+))/g)].map((match) => [
        match[1],
        match[2] ?? match[3],
      ]),
    );
    const md5 = (value) => createHash("md5").update(value).digest("hex");
    const expected = md5(
      `${md5("rokudev:roku:fixture-password")}:fixture:${values.nc}:${values.cnonce}:auth:${md5(`${request.method}:${values.uri}`)}`,
    );
    if (values.response !== expected) {
      response.writeHead(403).end();
      return;
    }
    authorized++;
    if (request.url === "/plugin_inspect") response.end('<img src="pkgs/dev.png">');
    else response.end(Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port,
      client = createRokuDeviceClient({ host: "127.0.0.1", ecpPort: port, installerPort: port });
    assert.equal(await client.appInstalled("Fixture"), true);
    assert.equal(await client.appInstalled("Other"), false);
    await client.keypress("Right");
    assert.equal(await client.terminate(), "terminated");
    assert.equal(await client.terminate(), "not-running");
    assert.equal((await client.screenshot("fixture-password")).format, "png");
    assert.equal(authorized, 2);
    await assert.rejects(client.query("redirect"));
    await assert.rejects(client.query("registry/dev"));
    await assert.rejects(client.keypress("Power"));
    assert.throws(() => createRokuDeviceClient({ host: "http://name:password@device" }));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test("diagnostic connection readiness, bounded lines and split UTF-8 survive real TCP framing", async () => {
  let connection;
  const server = createTcpServer((socket) => {
    connection = socket;
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const capture = captureRokuDiagnostics("127.0.0.1", {
    port: server.address().port,
    maxLines: 2,
    maxLineLength: 256,
  });
  try {
    assert.equal(await capture.ready, true);
    connection.write("RNR_" + "x".repeat(1000) + "\n");
    const bytes = Buffer.from('RNR_HOST_READY {"label":"café"}\n');
    const split = bytes.indexOf(Buffer.from("é")) + 1;
    connection.write(bytes.subarray(0, split));
    await new Promise((resolve) => setTimeout(resolve, 5));
    connection.write(bytes.subarray(split));
    for (let i = 0; i < 100 && !capture.snapshot().lines.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(capture.snapshot().droppedLines, 1);
    assert.deepEqual(parseRokuHostDiagnostics(capture.snapshot().lines).ready, [{ label: "café" }]);
    capture.clear();
    assert.equal(capture.snapshot().lines.length, 0);
  } finally {
    capture.close();
    connection?.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
test("diagnostics preserve only valid build hashes and surface fatal native/render errors", () => {
  const identity = {
    schema: "react-native-roku-build/v1",
    application: "Fixture",
    inputFingerprint: "a".repeat(64),
    password: "never-retain",
  };
  const report = parseRokuHostDiagnostics([
    "[device] RNR_BUILD " + JSON.stringify(identity),
    'RNR_BUILD {"schema":"react-native-roku-build/v1","application":"Fixture","runtimeSha256":"bad"}',
    "ROKU_RENDER_ERROR uncaught fixture failure",
    "BRIGHTSCRIPT: ERROR: fixture failure",
    'RNR_HOST_MEMORY {"availableKb":123}',
  ]);
  assert.equal(report.identities.length, 1);
  assert.ok(!JSON.stringify(report.identities).includes("never-retain"));
  assert.equal(report.errors.length, 2);
  assert.equal(report.memory[0].availableKb, 123);
});
test("unavailable diagnostic connections settle readiness without an unhandled rejection", async () => {
  const server = createTcpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const capture = captureRokuDiagnostics("127.0.0.1", { port });
  try {
    assert.equal(await capture.ready, false);
    assert.equal(capture.snapshot().available, false);
  } finally {
    capture.close();
  }
});
test("an unterminated native crash line is retained and redacted when its stream closes", async () => {
  const server = createTcpServer((socket) => socket.end("Syntax Error. password=fixture-private"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const capture = captureRokuDiagnostics("127.0.0.1", { port: server.address().port });
  try {
    await capture.ready;
    for (let i = 0; i < 100 && capture.snapshot().status !== "closed"; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const report = parseRokuHostDiagnostics(capture.snapshot().lines);
    assert.equal(report.errors.length, 1);
    assert.ok(!report.errors[0].includes("fixture-private"));
  } finally {
    capture.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
