import { expect, it, vi } from "vitest";
import { CanvasSceneGraph, type CanvasFactory } from "./CanvasSceneGraph";

class Bitmap {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 4;
  naturalHeight = 3;
  src = "";
  clears = 0;
  removeAttribute(name: string) {
    expect(name).toBe("src");
    this.src = "";
    this.clears++;
  }
}
function fixture() {
  const bitmaps: Bitmap[] = [],
    cancelled: number[] = [];
  const factory: CanvasFactory = {
    image: () => {
      const image = new Bitmap();
      bitmaps.push(image);
      return image as unknown as HTMLImageElement;
    },
    canvas: () => {
      throw Error("No rasterization requested");
    },
    uri: (uri) => uri,
    requestFrame: () => 1,
    cancelFrame: (handle) => cancelled.push(handle),
  };
  const scene = new CanvasSceneGraph(
    { getContext: () => ({}) } as unknown as HTMLCanvasElement,
    factory,
  );
  const parent = scene.create("group");
  scene.insert(scene.root, parent);
  const poster = scene.create("poster");
  scene.insert(parent, poster);
  const dispose = () => {
    scene.remove(scene.root, parent);
    scene.dispose();
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  };
  return { scene, bitmaps, cancelled, parent, poster, dispose };
}

it("releases previous bitmap handlers and source attributes when a Poster URI changes", async () => {
  const f = fixture(),
    observed = vi.fn();
  try {
    f.scene.subscribe(f.poster, "loadStatus", observed);
    f.scene.set(f.poster, "uri", "https://fixture.invalid/old.png");
    const old = f.bitmaps[0],
      queuedOldLoad = old.onload!;
    f.scene.set(f.poster, "uri", "https://fixture.invalid/new.png");
    expect(old.onload).toBeNull();
    expect(old.onerror).toBeNull();
    expect(old.src).toBe("");
    expect(old.clears).toBe(1);
    queuedOldLoad();
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    f.bitmaps[1].onload!();
    await Promise.resolve();
    expect(observed).toHaveBeenCalledExactlyOnceWith("ready");
    expect(f.scene.imageDiagnostics()).toEqual([
      {
        id: f.poster.id,
        uri: "https://fixture.invalid/new.png",
        status: "ready",
        width: 4,
        height: 3,
      },
    ]);
  } finally {
    f.dispose();
  }
});

it("releases Poster and mask decoder references when an ancestor retires", async () => {
  const f = fixture();
  const mask = f.scene.create("maskGroup");
  f.scene.insert(f.parent, mask);
  f.scene.set(f.poster, "uri", "https://fixture.invalid/poster.png");
  f.scene.set(mask, "maskUri", "pkg:/images/corner-0.png");
  const callbacks = f.bitmaps.map((image) => image.onload!);
  f.scene.remove(f.scene.root, f.parent);
  for (const image of f.bitmaps) {
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
    expect(image.src).toBe("");
    expect(image.clears).toBe(1);
  }
  callbacks.forEach((callback) => callback());
  await Promise.resolve();
  expect(f.scene.imageDiagnostics()).toEqual([]);
  expect(f.scene.nodes.size).toBe(1);
  f.scene.dispose();
});

it("disposes pending bitmap resources once and ignores an already queued completion", async () => {
  const f = fixture(),
    observed = vi.fn();
  f.scene.subscribe(f.poster, "loadStatus", observed);
  f.scene.set(f.poster, "uri", "https://fixture.invalid/pending.png");
  f.bitmaps[0].onload!();
  f.scene.batch(() => {});
  f.scene.dispose();
  f.scene.dispose();
  expect(f.bitmaps[0].onload).toBeNull();
  expect(f.bitmaps[0].onerror).toBeNull();
  expect(f.bitmaps[0].src).toBe("");
  expect(f.bitmaps[0].clears).toBe(1);
  await Promise.resolve();
  expect(observed).not.toHaveBeenCalled();
  expect(f.cancelled).toEqual([1]);
  expect(f.scene.imageDiagnostics()).toEqual([]);
  f.scene.remove(f.scene.root, f.parent);
  expect(f.scene.nodes.size).toBe(1);
});

it("clears empty Poster and mask sources without starting replacement decoders", () => {
  const f = fixture(),
    mask = f.scene.create("maskGroup");
  f.scene.insert(f.parent, mask);
  try {
    f.scene.set(f.poster, "uri", "https://fixture.invalid/poster.png");
    f.scene.set(mask, "maskUri", "pkg:/images/corner-0.png");
    f.scene.set(f.poster, "uri", null);
    f.scene.set(mask, "maskUri", "");
    expect(f.bitmaps).toHaveLength(2);
    expect(f.scene.imageDiagnostics()).toEqual([]);
    for (const image of f.bitmaps) {
      expect(image.src).toBe("");
      expect(image.onload).toBeNull();
      expect(image.clears).toBe(1);
    }
  } finally {
    f.dispose();
  }
});
