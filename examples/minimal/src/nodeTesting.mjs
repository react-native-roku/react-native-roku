import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createPortableFetch } from "react-native-roku/web";
import { createNodeTextHttp, canvasImageSource } from "react-native-roku/testing/node";
import { CanvasSceneGraph } from "react-native-roku/preview";

/** Real loopback sockets plus explicit synthetic decoder ports. No firmware,
 * device networking, native font or physical presentation claim is made. */
export async function qualifyNodeTesting() {
  let requests = 0,
    hops = 0,
    slowStarted = false,
    slowClosed = false;
  const server = createServer(async (request, response) => {
    requests++;
    assert.equal(request.headers.cookie, undefined);
    if (request.url === "/slow") {
      slowStarted = true;
      response.once("close", () => {
        slowClosed = true;
      });
    } else if (request.url === "/redirect") {
      response.writeHead(307, { location: "/sink" });
      response.end();
    } else if (request.url === "/sink") {
      hops++;
      response.end("redirect destination");
    } else if (request.url === "/binary") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from([0, 255]));
    } else {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      response.writeHead(request.url === "/failure" ? 503 : 200, {
        "content-type": "application/json; charset=utf-8",
        "x-fixture": "header value",
        "retry-after": "2",
      });
      response.end(
        JSON.stringify({
          method: request.method,
          body: Buffer.concat(chunks).toString(),
          marker: request.headers["x-marker"] ?? null,
        }),
      );
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`,
    host = createNodeTextHttp({ createPortableFetch });
  const until = async (condition) => {
    const deadline = Date.now() + 3000;
    while (!condition() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
    assert.ok(condition());
  };
  try {
    const get = await host.fetch(origin + "/get");
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("x-fixture"), "header value");
    assert.deepEqual(await get.json(), { method: "GET", body: "", marker: null });
    const post = await host.fetch(origin + "/post", {
      method: "POST",
      body: "own consumer ✓ body",
      headers: { "x-marker": "synthetic" },
    });
    assert.deepEqual(await post.json(), {
      method: "POST",
      body: "own consumer ✓ body",
      marker: "synthetic",
    });
    const failure = await host.fetch(origin + "/failure");
    assert.equal(failure.status, 503);
    assert.equal(failure.headers.get("retry-after"), "2");
    await failure.text();
    const beforeAbort = requests,
      controller = new AbortController();
    controller.abort();
    await assert.rejects(host.fetch(origin + "/never", { signal: controller.signal }));
    assert.equal(requests, beforeAbort);
    const active = new AbortController(),
      pending = host.fetch(origin + "/slow", { signal: active.signal });
    const rejected = assert.rejects(pending);
    await until(() => slowStarted);
    active.abort();
    await rejected;
    await until(() => slowClosed);
    await host.whenIdle();
    assert.equal((await host.fetch(origin + "/recovery")).status, 200);
    await assert.rejects(
      host.fetch(origin + "/redirect", {
        method: "POST",
        body: "synthetic only",
        redirect: "error",
      }),
    );
    assert.equal(hops, 0, "Strict redirects leaked a hop");
    await (await host.fetch(origin + "/redirect")).text();
    assert.equal(hops, 1);
    let unsupportedSends = 0;
    const unsupported = createNodeTextHttp({
      createPortableFetch,
      fetch: async (...args) => {
        unsupportedSends++;
        return fetch(...args);
      },
      redirectModes: ["follow"],
    });
    const beforeUnsupported = requests;
    await assert.rejects(
      unsupported.fetch(origin + "/redirect", { redirect: "error" }),
      /redirect/i,
    );
    assert.equal(unsupportedSends, 0);
    assert.equal(requests, beforeUnsupported);
    await assert.rejects(host.fetch(origin + "/binary"), /binary/);
    await host.whenIdle();
    assert.deepEqual([host.snapshot().active, host.snapshot().forwardingListeners], [0, 0]);
    assert.ok(host.snapshot().aborts >= 1);

    const images = [],
      observations = [];
    const scene = new CanvasSceneGraph(
      { getContext: () => ({}) },
      {
        image() {
          const image = canvasImageSource({ src: "", naturalWidth: 1, naturalHeight: 1 });
          images.push(image);
          return image;
        },
        canvas() {
          throw Error("No raster requested");
        },
        uri: (uri) => uri,
        requestFrame: () => 1,
        cancelFrame() {},
      },
    );
    const poster = scene.create("poster");
    scene.insert(scene.root, poster);
    scene.subscribe(poster, "loadStatus", (status) => observations.push(status));
    scene.set(poster, "uri", "fixture:/consumer-failed.png");
    images[0].onerror();
    await Promise.resolve();
    assert.deepEqual(observations, ["failed"]);
    const stale = images[0].onload;
    scene.set(poster, "uri", "fixture:/consumer-success.png");
    assert.equal(images[0].src, "");
    assert.equal(images[0].onload, null);
    stale();
    images[1].onload();
    await Promise.resolve();
    assert.deepEqual(observations, ["failed", "ready"]);
    scene.remove(scene.root, poster);
    scene.dispose();
    scene.dispose();
    assert.equal(images[1].src, "");
    assert.equal(scene.listenerCount, 0);
    return {
      status: "passed",
      sockets: host.snapshot(),
      imageSourceRelease: "passed",
      deviceQualified: false,
    };
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}
