import { useLayoutEffect, useRef, useState } from "react";
import { Image } from "expo-image";
import type { NativeViewHandle } from "react-native";

// Authored 2x2 RGBA PNG, all pixels [34,102,136,255].
const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGNQSuv4D8IMMAYARLwIPRFZQJ0AAAAASUVORK5CYII=";
/** Real browser decoder observations, separate from synthetic Poster field tests. */
export function ImageLifecycleFixture() {
  const [image, setImage] = useState({ key: "initial", source: pixel }),
    [visible, setVisible] = useState(true);
  const handle = useRef<NativeViewHandle>(null),
    events = useRef<{ cycle: string; event: string; width?: number; height?: number }[]>([]);
  useLayoutEffect(() => {
    const api = {
      recycle: (key: string) => setImage((previous) => ({ ...previous, key })),
      load: (key: string, source: string) => {
        setImage({ key, source });
        setVisible(true);
      },
      reset: (key: string) => {
        setImage({ key, source: pixel });
        setVisible(true);
      },
      retire: () => setVisible(false),
      snapshot() {
        let rect: { x: number; y: number; width: number; height: number } | undefined;
        handle.current?.measureInWindow((x, y, width, height) => {
          rect = { x, y, width, height };
        });
        return { rect, events: [...events.current] };
      },
    };
    const target = globalThis as unknown as { __RNR_IMAGE_LIFECYCLE__?: typeof api };
    target.__RNR_IMAGE_LIFECYCLE__ = api;
    return () => {
      if (target.__RNR_IMAGE_LIFECYCLE__ === api) delete target.__RNR_IMAGE_LIFECYCLE__;
    };
  }, []);
  if (!visible) return null;
  return (
    <Image
      ref={handle}
      source={image.source}
      recyclingKey={image.key}
      style={{ position: "absolute", left: 1450, top: 300, width: 80, height: 60 }}
      onLoad={({ source }) =>
        events.current.push({
          cycle: image.key,
          event: "load",
          width: source.width,
          height: source.height,
        })
      }
      onDisplay={() => events.current.push({ cycle: image.key, event: "display" })}
      onLoadEnd={() => events.current.push({ cycle: image.key, event: "end" })}
      onError={() => events.current.push({ cycle: image.key, event: "error" })}
    />
  );
}
