import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createCanvas, Image, GlobalFonts } from "@napi-rs/canvas";
import { CanvasSceneGraph, createCanvasFontRegistry } from "react-native-roku/preview";
import { canvasImageSource } from "react-native-roku/testing/node";

/** Actual native Canvas IO, with this consumer's generated PNG and declared
 * font dependency. This remains host resource/pixel evidence, never firmware. */
export async function qualifyPreviewAssets({ fontURI: font, imagePath }) {
  let registered = 0,
    removed = 0;
  const fonts = createCanvasFontRegistry({
    limit: 1,
    register(uri, family) {
      const key = GlobalFonts.registerFromPath(uri, family);
      if (!key) throw Error("Consumer font preparation failed");
      registered++;
      return key;
    },
    unregister(key) {
      GlobalFonts.remove(key);
      removed++;
    },
  });
  const first = fonts.createOwner(),
    second = fonts.createOwner();
  await assert.rejects(first.ready(font + ".missing", "MissingConsumerFont"));
  assert.equal(fonts.snapshot().registrations, 0);
  await Promise.all([
    first.ready(font, "ConsumerOwnedInter"),
    second.ready(font, "ConsumerOwnedInter"),
  ]);
  assert.equal(registered, 1);
  const measurement = createCanvas(32, 32).getContext("2d");
  measurement.font = '20px "ConsumerOwnedInter"';
  assert.ok(measurement.measureText("Own font").width > 0);
  first.dispose();
  fonts.retireUnused();
  assert.equal(removed, 0);
  second.dispose();
  fonts.retireUnused();
  assert.equal(removed, 1);

  const original = createCanvas(4, 4),
    pixels = original.getContext("2d");
  pixels.fillStyle = "#1769aa";
  pixels.fillRect(0, 0, 4, 4);
  const png = original.toBuffer("image/png");
  writeFileSync(imagePath, png);
  const uri = "data:image/png;base64," + png.toString("base64");
  const bitmaps = [],
    statuses = [];
  const surface = createCanvas(8, 8);
  const scene = new CanvasSceneGraph(surface, {
    image() {
      const value = canvasImageSource(new Image());
      bitmaps.push(value);
      return value;
    },
    canvas: createCanvas,
    uri: (value) => value,
    requestFrame: () => 1,
    cancelFrame() {},
  });
  const poster = scene.create("poster");
  scene.insert(scene.root, poster);
  scene.set(poster, "width", 4);
  scene.set(poster, "height", 4);
  scene.subscribe(poster, "loadStatus", (value) => statuses.push(value));
  const until = async (condition) => {
    const deadline = Date.now() + 3000;
    while (!condition() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
    assert.ok(condition(), "Consumer decoder did not settle");
  };
  try {
    scene.set(poster, "uri", "data:image/png;base64,bm90LWFuLWltYWdl");
    await until(() => statuses.includes("failed"));
    const retired = bitmaps[0],
      stale = retired.onload;
    scene.set(poster, "uri", uri);
    assert.equal(retired.onload, null);
    assert.equal(retired.onerror, null);
    stale();
    await until(() => statuses.includes("ready"));
    assert.deepEqual(statuses, ["failed", "ready"]);
    scene.draw();
    assert.deepEqual(
      [...surface.getContext("2d").getImageData(1, 1, 1, 1).data],
      [23, 105, 170, 255],
    );
    scene.remove(scene.root, poster);
    assert.equal(bitmaps[1].onload, null);
    assert.equal(bitmaps[1].onerror, null);
    scene.dispose();
    scene.dispose();
    assert.equal(scene.nodes.size, 1);
    assert.equal(scene.listenerCount, 0);
    return {
      status: "passed",
      image: { width: 4, height: 4, sha256: createHash("sha256").update(png).digest("hex") },
      fontSha256: createHash("sha256").update(readFileSync(font)).digest("hex"),
      sharedFonts: true,
      failedPreparation: true,
      sourceRelease: true,
      deviceQualified: false,
    };
  } finally {
    scene.dispose();
    first.dispose();
    second.dispose();
    fonts.retireUnused();
  }
}
