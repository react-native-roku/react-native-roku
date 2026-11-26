import {
  createElement,
  forwardRef,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { RokuHostError } from "../scene/sceneGraph.types";
import {
  generatedSceneFields,
  plainImageLayout,
  type SceneElementProps,
} from "../renderer/SceneRoot";
import { background, useElement, View, type NativeElementProps } from "./primitives";
import { useNativeHost } from "./nativeHostContext";
import { hasRoundedCorners, uniformBorder } from "../graphics/surfaces";
import type { NativeViewHandle } from "./nativeViewHandle";

export interface ImageSource {
  readonly uri: string;
  readonly width?: number;
  readonly height?: number;
  readonly headers?: Readonly<Record<string, string>>;
}
export interface ImageLoadEvent {
  readonly source: {
    readonly url: string;
    readonly width: number;
    readonly height: number;
  };
}
export interface ImageProps extends NativeElementProps {
  readonly source?: ImageSource | string | null;
  readonly contentFit?: "cover" | "contain" | "fill" | "none" | "scale-down";
  readonly resizeMode?: "cover" | "contain" | "stretch" | "center" | "repeat";
  readonly contentPosition?: string | object;
  readonly blurRadius?: number;
  readonly transition?: number;
  readonly recyclingKey?: string | null;
  readonly placeholder?: ImageSource | string;
  readonly placeholderContentFit?: string;
  readonly cachePolicy?: "none" | "disk" | "memory" | "memory-disk";
  readonly priority?: "low" | "normal" | "high";
  readonly onLoadStart?: () => void;
  readonly onLoad?: (event: ImageLoadEvent) => void;
  readonly onDisplay?: () => void;
  readonly onLoadEnd?: () => void;
  readonly onError?: (event: { readonly error: string }) => void;
}
const packagedImages = new Map<string, string>();
/** The bundler preserves source values for schema validation; only the image port resolves assets. */
export function registerPackagedImage(source: string, target: string): string {
  if (
    !source.startsWith("data:image/") ||
    !/^pkg:\/images\/asset-[a-f0-9]{24}\.(png|jpe?g)$/.test(target)
  )
    throw new RokuHostError("C08_IMAGE_ASSET", "Invalid packaged raster registration");
  packagedImages.set(source, target);
  return source;
}
function uri(source: ImageProps["source"]): string {
  if (source == null) return "";
  if (typeof source === "string") return packagedImages.get(source) ?? source;
  if (typeof source === "object" && typeof source.uri === "string") {
    if (source.headers && Object.keys(source.headers).length)
      throw new RokuHostError(
        "C08_IMAGE_HEADERS",
        "Authenticated image headers require the native networking adapter",
      );
    return packagedImages.get(source.uri) ?? source.uri;
  }
  throw new RokuHostError(
    "C08_IMAGE_ASSET",
    "Image sources require a resolved URI; numeric Metro asset IDs are not valid in the Roku bundle",
  );
}
const modes = {
  cover: "scaleToZoom",
  contain: "scaleToFit",
  fill: "scaleToFill",
  none: "noScale",
  "scale-down": "limitSize",
} as const;

type ImageLoadSession = Readonly<
  Record<"bitmapWidth" | "bitmapHeight" | "loadStatus", (value: unknown) => void>
>;

function createImageLoadSession(
  source: string,
  currentProps: (session: ImageLoadSession) => ImageProps | undefined,
): ImageLoadSession {
  let width = 0,
    height = 0,
    ready = false,
    loaded = false,
    failed = false,
    started = false;
  const finish = (props: ImageProps) => {
    if (!ready || loaded || failed || !(width > 0 && height > 0) || !currentProps(session)) return;
    loaded = true;
    props.onLoad?.({ source: { url: source, width, height } });
    if (!currentProps(session)) return;
    // Poster readiness is a loaded renderable raster, not a physical frame acknowledgement.
    props.onDisplay?.();
    if (!currentProps(session)) return;
    props.onLoadEnd?.();
  };
  const session: ImageLoadSession = Object.freeze({
    bitmapWidth(value) {
      const props = currentProps(session);
      if (!props || loaded || failed) return;
      width = Number(value);
      finish(props);
    },
    bitmapHeight(value) {
      const props = currentProps(session);
      if (!props || loaded || failed) return;
      height = Number(value);
      finish(props);
    },
    loadStatus(value) {
      const props = currentProps(session);
      if (!props || loaded || failed) return;
      if (value === "loading" && !started) {
        started = true;
        props.onLoadStart?.();
      } else if (value === "ready") {
        ready = true;
        finish(props);
      } else if (value === "failed") {
        failed = true;
        props.onError?.({ error: `Native Poster failed to load ${source}` });
        if (currentProps(session)) props.onLoadEnd?.();
      }
    },
  });
  return session;
}

const ImageComponent = forwardRef<NativeViewHandle, ImageProps>((props, ref) => {
  const element = useElement(props, ref),
    host = useNativeHost(),
    source = uri(props.source),
    placeholder = uri(props.placeholder);
  const rounded = hasRoundedCorners(element.style),
    border = rounded ? uniformBorder(element.style) : 0;
  if (props.blurRadius)
    throw new RokuHostError("C08_IMAGE_BLUR", "Image blur requires an admitted native shader");
  if (props.transition)
    throw new RokuHostError(
      "C08_IMAGE_TRANSITION",
      "Image transitions are owned by the shared artwork animation executor",
    );
  if (
    props.contentPosition != null &&
    props.contentPosition !== "center" &&
    props.contentPosition !== "50% 50%"
  )
    throw new RokuHostError(
      "C08_IMAGE_POSITION",
      "Noncentral image positioning requires native bitmap geometry",
    );
  const fit =
    props.contentFit ??
    (props.resizeMode === "stretch"
      ? "fill"
      : props.resizeMode === "center"
        ? "none"
        : (props.resizeMode ?? "cover"));
  if (!(fit in modes)) throw new RokuHostError("C08_IMAGE_FIT", `Image fit ${fit} is unavailable`);
  const resourceKey = JSON.stringify([props.recyclingKey ?? "", source]);
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const committed = useRef<{ props: ImageProps; session: ImageLoadSession } | null>(null);
  // The Poster key and event lifetime change together. Pending React renders
  // keep the prior mounted Poster and its committed callbacks authoritative.
  const session = useMemo(
    () =>
      createImageLoadSession(source, (current) =>
        live.current && host.active && committed.current?.session === current
          ? committed.current.props
          : undefined,
      ),
    [host, resourceKey, source],
  );
  useInsertionEffect(() => {
    committed.current = { props, session };
  }, [props, session]);
  return createElement(
    "group",
    { fields: element.fields, layout: element.layout },
    ...background(element.style, host.graphics),
    source
      ? createElement(
          "poster",
          {
            key: resourceKey,
            fields: generatedSceneFields({
              loadDisplayMode: modes[fit as keyof typeof modes],
              loadingBitmapUri: placeholder,
              shaderCompatible: rounded,
              uri: source,
            }),
            layout: rounded ? { decoration: "surface", border } : plainImageLayout,
            events: session,
          } satisfies SceneElementProps & { key: string },
          rounded
            ? createElement("effect", {
                fields: { borderWidth: 0 },
                layout: {
                  resource: true,
                  radiusStyle: element.style,
                  insetBorder: border,
                },
              })
            : null,
        )
      : null,
  );
});
ImageComponent.displayName = "RokuImage";
export const Image = Object.assign(ImageComponent, {
  // No positive cache/prefetch claim is made without a corresponding native capability.
  prefetch: async (_urls: string | string[], _policy?: unknown): Promise<boolean> => false,
  clearMemoryCache: async (): Promise<boolean> => false,
  clearDiskCache: async (): Promise<boolean> => false,
});
export const ImageBackground = forwardRef<NativeViewHandle, ImageProps>((props, ref) =>
  createElement(
    View,
    { style: props.style, ref },
    createElement(Image, {
      ...props,
      children: undefined,
      style: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
    }),
    props.children,
  ),
);
ImageBackground.displayName = "RokuImageBackground";
