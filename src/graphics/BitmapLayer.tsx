import { createElement, useEffect, useState, useRef } from "react";
import { useNativeHost } from "../react-native/nativeHostContext";
import { RokuHostError } from "../scene/sceneGraph.types";
import type { TextRasterLease } from "./textRaster.types";
export function BitmapLayer({
  identity,
  width,
  height,
  pixels,
}: {
  identity: string;
  width: number;
  height: number;
  pixels: () => Uint8Array;
}) {
  const host = useNativeHost();
  const render = useRef(pixels);
  render.current = pixels;
  identity = `${width}x${height}:${identity}`;
  const [state, setState] = useState<
    { identity: string; uri: string } | { identity: string; error: unknown }
  >();
  useEffect(() => {
    let active = true,
      lease: TextRasterLease | undefined;
    const port = host.raster?.acquirePixels;
    if (!port) {
      setState({
        identity,
        error: new RokuHostError(
          "C09_RASTER_PORT",
          "Vector graphics require the bounded bitmap resource port",
        ),
      });
      return;
    }
    void port
      .call(host.raster, {
        key: identity,
        width,
        height,
        pixels: () => render.current(),
      })
      .then(
        (value) => {
          if (!active) value.release();
          else {
            lease = value;
            setState({ identity, uri: value.image.uri });
          }
        },
        (error) => {
          if (active) setState({ identity, error });
        },
      );
    return () => {
      active = false;
      lease?.release();
    };
  }, [host, identity, width, height]);
  if (state?.identity === identity && "error" in state) throw state.error;
  return state?.identity === identity && "uri" in state
    ? createElement("poster", {
        fields: { uri: state.uri, loadDisplayMode: "scaleToFit" },
        layout: { decoration: "background" },
      })
    : null;
}
