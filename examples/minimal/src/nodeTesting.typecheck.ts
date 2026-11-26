import { createPortableFetch, type WebTransport } from "react-native-roku/web";
import { canvasImageSource, createNodeTextHttp } from "react-native-roku/testing/node";
import { Image } from "@napi-rs/canvas";

// Compiled by the independently installed consumer's declared compiler. This
// file is not imported into its React application or SDK/browser entry graph.
const host = createNodeTextHttp({ createPortableFetch, redirectModes: ["follow", "error"] });
const transport: WebTransport = host.transport;
const image = canvasImageSource({ src: "fixture:/consumer-owned.png" });
image.removeAttribute("src");
const nativeImage = canvasImageSource(new Image());
const decoder: Image = nativeImage;
nativeImage.src = new Uint8Array();
nativeImage.removeAttribute("src");
void decoder;
void transport;
void host.whenIdle;
