import { createElement } from "react";
import { createNativeRoot } from "react-native-roku";
import { Image } from "expo-image";
import { RecordingSceneGraph } from "react-native-roku/testing";

/** The Expo alias reaches the same public Poster owner; observations here are synthetic. */
export async function qualifyImageLifetimes() {
  const scene = new RecordingSceneGraph(),
    events: string[] = [];
  const root = createNativeRoot(scene, {
    strictMode: true,
    viewport: { width: 100, height: 60 },
    text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 8 }) },
  });
  const demand = (condition: unknown, message: string) => {
    if (!condition) throw Error("Packed image: " + message);
  };
  const render = (
    cycle: string,
    onLoad?: () => void,
    source = "https://fixture.invalid/image.png",
  ) =>
    root.render(
      createElement(Image, {
        source,
        recyclingKey: cycle,
        style: { width: 80, height: 60 },
        onLoad: (event) => {
          events.push(cycle + ":" + event.source.width + "x" + event.source.height);
          onLoad?.();
        },
        onDisplay: () => events.push(cycle + ":display"),
        onLoadEnd: () => events.push(cycle + ":end"),
      }),
    );
  const poster = () => [...scene.nodes.values()].find((node) => node.type === "poster")!;
  const ready = (width: number, height: number) => {
    const node = poster();
    scene.emit(node, "bitmapWidth", width);
    scene.emit(node, "bitmapHeight", height);
    scene.emit(node, "loadStatus", "ready");
  };
  try {
    render("old");
    const retired = poster();
    scene.emit(retired, "bitmapWidth", 100);
    scene.emit(retired, "loadStatus", "ready");
    render("next");
    const current = poster();
    demand(current.id !== retired.id, "recycling must create a fresh Poster lifetime");
    scene.emit(current, "bitmapHeight", 80);
    demand(events.length === 0, "dimensions must not cross recycling lifetimes");
    ready(200, 80);
    demand(
      events.join(",") === "next:200x80,next:display,next:end",
      "the successor must report its own complete raster once",
    );
    scene.emit(retired, "loadStatus", "failed");
    demand(events.length === 3, "retired native observations must be ignored");
    render("retire", () => root.render(null));
    ready(40, 30);
    demand(events.at(-1) === "retire:40x30", "public callbacks must stop when their owner retires");
    render("row", undefined, "https://first.invalid/a:https://second.invalid/b");
    const first = poster();
    render("row:https://first.invalid/a", undefined, "https://second.invalid/b");
    demand(poster().id !== first.id, "source/recycling identity must be an unambiguous tuple");
  } finally {
    root.unmount();
  }
  demand(
    scene.nodes.size === 1 && scene.listenerCount === 0,
    "all native resources and subscriptions must retire",
  );
  return {
    sameUriRecycling: true,
    partialPreparationIsolation: true,
    reentrantRetirement: true,
    tupleIdentity: true,
    cleanup: true,
    scope:
      "Synthetic Poster observations; native raster display and firmware ordering remain pending",
  };
}
