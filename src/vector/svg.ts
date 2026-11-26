import { createElement, forwardRef } from "react";
import { RokuHostError } from "../scene/sceneGraph.types";
import { useNativeHost } from "../react-native/nativeHostContext";
import { useElement } from "../react-native/primitives";
import { rokuColor } from "../react-native/styleSheet";
import type { NativeViewHandle } from "../react-native/nativeViewHandle";
import { svgShapeKey } from "./svgKey.mjs";
import { DynamicSvg } from "./dynamicSvg";

export * from "./svgElements";
import { shapes, type ShapeProps, type SvgProps } from "./svgElements";

export function rectilinearPath(
  path: string,
): Array<{ x: number; y: number; width: number; height: number }> {
  const tokens = path.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/g) ?? [],
    result = [];
  if (path.replace(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?|[\s,]/g, ""))
    throw new RokuHostError("C09_SVG_PATH", "Invalid path data");
  let index = 0,
    x = 0,
    y = 0,
    startX = 0,
    startY = 0,
    command = "",
    points: number[][] = [];
  const number = () => {
    const value = Number(tokens[index++]);
    if (!Number.isFinite(value))
      throw new RokuHostError("C09_SVG_PATH", "Path coordinate is missing");
    return value;
  };
  while (index < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[index])) command = tokens[index++];
    const relative = command === command.toLowerCase();
    if (command === "z" || command === "Z") {
      const xs = points.map((point) => point[0]),
        ys = points.map((point) => point[1]),
        left = Math.min(...xs),
        top = Math.min(...ys),
        width = Math.max(...xs) - left,
        height = Math.max(...ys) - top;
      let area = 0;
      for (let i = 0; i < points.length; i++) {
        const a = points[i],
          b = points[(i + 1) % points.length];
        if (a[0] !== b[0] && a[1] !== b[1])
          throw new RokuHostError(
            "C09_SVG_PATH",
            "Dynamic vector paths currently require axis-aligned rectangles",
          );
        area += a[0] * b[1] - b[0] * a[1];
      }
      if (!width || !height || Math.abs(Math.abs(area) / 2 - width * height) > 0.001)
        throw new RokuHostError("C09_SVG_PATH", "Dynamic filled paths must be rectangular");
      result.push({ x: left, y: top, width, height });
      x = startX;
      y = startY;
      points = [];
      command = "";
      continue;
    }
    if (command.toLowerCase() === "m" || command.toLowerCase() === "l") {
      const nextX = number(),
        nextY = number();
      x = (relative ? x : 0) + nextX;
      y = (relative ? y : 0) + nextY;
      if (command.toLowerCase() === "m") {
        if (points.length) throw new RokuHostError("C09_SVG_PATH", "Filled paths must be closed");
        startX = x;
        startY = y;
        command = relative ? "l" : "L";
      }
    } else if (command.toLowerCase() === "h") x = (relative ? x : 0) + number();
    else if (command.toLowerCase() === "v") y = (relative ? y : 0) + number();
    else
      throw new RokuHostError(
        "C09_SVG_PATH",
        `Dynamic SVG command ${command} needs raster support`,
      );
    points.push([x, y]);
  }
  if (points.length) throw new RokuHostError("C09_SVG_PATH", "Filled paths must be closed");
  return result;
}
export const Svg = forwardRef<NativeViewHandle, SvgProps>((props, ref) => {
  const host = useNativeHost(),
    children = shapes(props.children),
    viewBox = props.viewBox ?? `0 0 ${props.width ?? 24} ${props.height ?? 24}`;
  const classes = props.className
    ?.split(/\s+/)
    .filter((value) => !/^lucide(?:-[a-z0-9-]+)?$/.test(value))
    .join(" ");
  const element = useElement(
    {
      ...props,
      className: classes,
      style: [
        {
          width: props.width ?? 24,
          height: props.height ?? 24,
          opacity: props.opacity ?? 1,
        },
        props.style,
      ],
    },
    ref,
  );
  const key = svgShapeKey(viewBox, children),
    atlas = host.svgAtlas?.[key];
  const foreground =
      props.color ?? (typeof element.style.color === "string" ? element.style.color : "black"),
    stroke = !props.stroke || props.stroke === "currentColor" ? foreground : props.stroke;
  const filled = props.fill != null && props.fill !== "none" && props.fill !== "transparent";
  if (atlas) {
    const fill = props.fill === "currentColor" ? foreground : props.fill;
    if (filled && rokuColor(fill) !== rokuColor(stroke))
      throw new RokuHostError(
        "C09_SVG_PAINT",
        "Multi-color icon paint needs separate native raster layers",
      );
    if (
      (props.strokeLinecap && props.strokeLinecap !== "round") ||
      (props.strokeLinejoin && props.strokeLinejoin !== "round")
    )
      throw new RokuHostError(
        "C09_SVG_STROKE",
        "The packaged Lucide raster uses its canonical round stroke joins and caps",
      );
    const uri = atlas.variants[`${props.strokeWidth ?? 2}:${filled ? "filled" : "outline"}`];
    if (!uri)
      throw new RokuHostError(
        "C09_SVG_VARIANT",
        `The build has no raster for stroke width ${props.strokeWidth ?? 2}`,
      );
    return createElement(
      "group",
      { fields: element.fields, layout: element.layout },
      createElement("poster", {
        fields: {
          loadDisplayMode: "scaleToFit",
          blendColor: rokuColor(stroke),
          uri,
        },
        layout: { decoration: "background" },
      }),
    );
  }
  // Dynamic QR matrices are rectangles, so preserve their exact authored geometry without an icon atlas.
  const box = viewBox.trim().split(/[ ,]+/).map(Number);
  if (
    box.length !== 4 ||
    box.some((value) => !Number.isFinite(value)) ||
    !(box[2] > 0 && box[3] > 0)
  )
    throw new RokuHostError("C09_SVG_VIEWBOX", "Svg requires a finite positive viewBox");
  if (
    typeof props.width !== "number" ||
    typeof props.height !== "number" ||
    children.some(
      ([tag, attributes]) =>
        (tag !== "rect" && tag !== "path") || (attributes.stroke && attributes.stroke !== "none"),
    )
  )
    return createElement(DynamicSvg, { props, element, children, box });
  const paths = new Map<ShapeProps, ReturnType<typeof rectilinearPath>>();
  for (const [tag, attributes] of children) {
    if (tag !== "path") continue;
    try {
      paths.set(attributes, rectilinearPath(String(attributes.d)));
    } catch (error) {
      if (!(error instanceof RokuHostError)) throw error;
      return createElement(DynamicSvg, { props, element, children, box });
    }
  }
  const scaleX = props.width / box[2],
    scaleY = props.height / box[3];
  const rectangles = children.flatMap(([tag, attributes]) => {
    if (attributes.stroke && attributes.stroke !== "none")
      throw new RokuHostError(
        "C09_SVG_UNKNOWN",
        `This SVG shape was not included in the build's raster atlas: ${key}`,
      );
    const fill = attributes.fill ?? props.fill ?? "black";
    if (fill === "none" || fill === "transparent") return [];
    const rects =
      tag === "rect" && !attributes.rx && !attributes.ry
        ? [
            {
              x: Number(attributes.x ?? 0),
              y: Number(attributes.y ?? 0),
              width: Number(attributes.width),
              height: Number(attributes.height),
            },
          ]
        : tag === "path"
          ? paths.get(attributes)!
          : null;
    if (!rects)
      throw new RokuHostError("C09_SVG_UNKNOWN", `SVG ${tag} requires an admitted raster adapter`);
    return rects.map((rect) =>
      createElement("rectangle", {
        key: `${tag}:${rect.x}:${rect.y}:${rect.width}:${rect.height}`,
        fields: {
          color: rokuColor(fill === "currentColor" ? foreground : fill),
        },
        layout: {
          style: {
            position: "absolute",
            left: (rect.x - box[0]) * scaleX,
            top: (rect.y - box[1]) * scaleY,
            width: rect.width * scaleX,
            height: rect.height * scaleY,
          },
        },
      }),
    );
  });
  return createElement("group", { fields: element.fields, layout: element.layout }, ...rectangles);
});
Svg.displayName = "RokuSvg";
export default Svg;
