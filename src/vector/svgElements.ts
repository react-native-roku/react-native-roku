import { Children, isValidElement, Fragment, type ReactNode } from "react";
import { RokuHostError } from "../scene/sceneGraph.types";
import type { NativeElementProps } from "../react-native/primitives";

export interface ShapeProps {
  readonly children?: ReactNode;
  readonly [key: string]: unknown;
}
export type Shape = readonly [string, ShapeProps];
function shape(tag: string) {
  const component = (_props: ShapeProps) => {
    throw new RokuHostError("C09_SVG_CONTEXT", `${tag} must be inside Svg`);
  };
  return Object.assign(component, { svgTag: tag });
}
export const Path = shape("path"),
  Rect = shape("rect"),
  Circle = shape("circle"),
  Ellipse = shape("ellipse"),
  Line = shape("line"),
  Polyline = shape("polyline"),
  Polygon = shape("polygon"),
  G = shape("g");
export const Defs = shape("defs"),
  ClipPath = shape("clipPath"),
  Mask = shape("mask"),
  LinearGradient = shape("linearGradient"),
  RadialGradient = shape("radialGradient"),
  Stop = shape("stop"),
  Pattern = shape("pattern"),
  Text = shape("text"),
  TSpan = shape("tspan"),
  Use = shape("use"),
  Symbol = shape("symbol"),
  Image = shape("image");
export function shapes(children: ReactNode): Shape[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<ShapeProps>(child))
      throw new RokuHostError("C09_SVG_CHILD", "Svg requires vector shape children");
    if (child.type === Fragment) return shapes(child.props.children);
    const tag = (child.type as { svgTag?: string }).svgTag;
    if (!tag)
      throw new RokuHostError("C09_SVG_CHILD", "Custom SVG child components need a vector adapter");
    return [[tag, child.props] as const];
  });
}
export interface SvgProps extends NativeElementProps {
  readonly width?: number | string;
  readonly height?: number | string;
  readonly viewBox?: string;
  readonly stroke?: string;
  readonly fill?: string;
  readonly color?: string;
  readonly strokeWidth?: number | string;
  readonly opacity?: number;
  readonly strokeLinecap?: string;
  readonly strokeLinejoin?: string;
}
