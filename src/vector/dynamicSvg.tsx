import { createElement, useMemo, useState, type ReactNode } from "react";
import { Text, type useElement } from "../react-native/primitives";
import { RokuHostError } from "../scene/sceneGraph.types";
import { BitmapLayer } from "../graphics/BitmapLayer";
import { shapes, type Shape, type SvgProps } from "./svgElements";
import { svgPath, type Point } from "./svgPath";
import { svgPixels, type VectorPaint } from "./svgPixels";

type Attributes = Record<string, unknown>;
type Draw =
  { kind: "paint"; paint: VectorPaint } | { kind: "text"; props: Attributes; text: string };
const number = (value: unknown, fallback = 0) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 1e7)
    throw new RokuHostError("C09_SVG_NUMBER", "SVG requires finite coordinates");
  return parsed;
};
function drawings(nodes: readonly Shape[], inherited: Attributes = {}): Draw[] {
  return nodes.flatMap(([tag, attributes]): Draw[] => {
    if (attributes.transform || attributes.clipPath || attributes.mask)
      throw new RokuHostError(
        "C09_SVG_TRANSFORM",
        "Dynamic vector transforms and masks need a graphics adapter",
      );
    const props: Attributes = {
      ...inherited,
      ...attributes,
      opacity: number(inherited.opacity, 1) * number(attributes.opacity, 1),
    };
    if (tag === "g") {
      const parent = { ...props };
      delete parent.children;
      return drawings(shapes(attributes.children), parent);
    }
    if (tag === "text") {
      if (typeof attributes.children !== "string" && typeof attributes.children !== "number")
        throw new RokuHostError("C09_SVG_TEXT", "Dynamic SVG text requires a plain text run");
      return [{ kind: "text", props, text: String(attributes.children) }];
    }
    let paths: Point[][];
    if (tag === "path") paths = svgPath(String(props.d ?? ""));
    else if (tag === "rect") {
      const x = number(props.x),
        y = number(props.y),
        w = number(props.width),
        h = number(props.height);
      if (props.rx || props.ry)
        throw new RokuHostError(
          "C09_SVG_RECT",
          "Rounded dynamic SVG rectangles need a path adapter",
        );
      paths = [
        [
          [x, y],
          [x + w, y],
          [x + w, y + h],
          [x, y + h],
          [x, y],
        ],
      ];
    } else if (tag === "line")
      paths = [
        [
          [number(props.x1), number(props.y1)],
          [number(props.x2), number(props.y2)],
        ],
      ];
    else if (tag === "circle" || tag === "ellipse") {
      const cx = number(props.cx),
        cy = number(props.cy),
        rx = number(props.rx ?? props.r),
        ry = number(props.ry ?? props.r);
      paths = [
        Array.from(
          { length: 129 },
          (_, i) =>
            [
              cx + rx * Math.cos((i * Math.PI) / 64),
              cy + ry * Math.sin((i * Math.PI) / 64),
            ] as Point,
        ),
      ];
    } else throw new RokuHostError("C09_SVG_SHAPE", `Dynamic SVG ${tag} is not admitted`);
    return [
      {
        kind: "paint",
        paint: {
          paths,
          fill: String(props.fill ?? "black"),
          stroke: props.stroke === undefined ? undefined : String(props.stroke),
          strokeWidth: number(props.strokeWidth, 1),
          opacity: number(props.opacity, 1),
          fillOpacity: number(props.fillOpacity, 1),
          strokeOpacity: number(props.strokeOpacity, 1),
        },
      },
    ];
  });
}

function Bitmap({ commands, box }: { commands: readonly VectorPaint[]; box: readonly number[] }) {
  const width = Math.ceil(box[2]),
    height = Math.ceil(box[3]);
  const shifted = commands.map((command) => ({
    ...command,
    paths: command.paths.map((path) => path.map(([x, y]) => [x - box[0], y - box[1]] as Point)),
  }));
  return createElement(BitmapLayer, {
    identity: JSON.stringify(shifted),
    width,
    height,
    pixels: () => svgPixels(width, height, shifted),
  });
}

function SvgLabel({
  draw,
  scale,
  left,
  top,
}: {
  draw: Extract<Draw, { kind: "text" }>;
  scale: number;
  left: number;
  top: number;
}) {
  const [width, setWidth] = useState(0),
    fontSize = number(draw.props.fontSize, 16) * scale;
  const anchor = draw.props.textAnchor ?? "start";
  return createElement(
    Text,
    {
      style: {
        position: "absolute",
        left:
          left +
          number(draw.props.x) * scale -
          width * (anchor === "middle" ? 0.5 : anchor === "end" ? 1 : 0),
        top: top + number(draw.props.y) * scale - fontSize,
        fontSize,
        color: String(draw.props.fill ?? "black"),
        opacity: number(draw.props.opacity, 1),
        fontFamily: typeof draw.props.fontFamily === "string" ? draw.props.fontFamily : undefined,
      },
      onLayout(event: unknown) {
        const next = (event as { nativeEvent: { layout: { width: number } } }).nativeEvent.layout
          .width;
        setWidth((old) => (old === next ? old : next));
      },
    },
    draw.text,
  );
}

/** Bitmap paths and native font labels retain SVG source order and measured placement. */
export function DynamicSvg({
  props,
  element,
  children,
  box,
}: {
  props: SvgProps;
  element: ReturnType<typeof useElement>;
  children: readonly Shape[];
  box: readonly number[];
}) {
  const [size, setSize] = useState<{ width: number; height: number }>();
  const commands = useMemo(
    () =>
      drawings(children, {
        fill: props.fill ?? "black",
        stroke: props.stroke,
        strokeWidth: props.strokeWidth,
      }),
    [children, props.fill, props.stroke, props.strokeWidth],
  );
  const layers: Array<readonly VectorPaint[] | Extract<Draw, { kind: "text" }>> = [];
  for (const command of commands) {
    if (command.kind === "text") layers.push(command);
    else {
      const last = layers.at(-1);
      if (Array.isArray(last)) (last as VectorPaint[]).push(command.paint);
      else layers.push([command.paint]);
    }
  }
  const scale = size ? Math.min(size.width / box[2], size.height / box[3]) : 0;
  const left = size ? (size.width - box[2] * scale) / 2 - box[0] * scale : 0,
    top = size ? (size.height - box[3] * scale) / 2 - box[1] * scale : 0;
  const items: ReactNode[] = layers.map((layer, index) =>
    Array.isArray(layer)
      ? createElement(Bitmap, { key: index, commands: layer, box })
      : size
        ? createElement(SvgLabel, {
            key: index,
            draw: layer as Extract<Draw, { kind: "text" }>,
            scale,
            left,
            top,
          })
        : null,
  );
  return createElement(
    "group",
    {
      fields: element.fields,
      layout: {
        ...element.layout,
        onLayout(event: unknown) {
          const value = (
            event as {
              nativeEvent: { layout: { width: number; height: number } };
            }
          ).nativeEvent.layout;
          if (value.width > 0 && value.height > 0)
            setSize((previous) =>
              previous?.width === value.width && previous.height === value.height
                ? previous
                : { width: value.width, height: value.height },
            );
          props.onLayout?.(event);
        },
      },
    },
    ...items,
  );
}
