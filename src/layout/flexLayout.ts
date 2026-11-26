import Yoga from "yoga-layout-prebuilt";
import { RokuHostError } from "../scene/sceneGraph.types";

export type LayoutStyle = Readonly<Record<string, unknown>>;
export interface LayoutInput {
  readonly style: LayoutStyle;
  readonly children: readonly LayoutInput[];
  readonly text?: string;
}
export interface LayoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export type TextMeasure = (
  node: LayoutInput,
  width: number | undefined,
  height: number | undefined,
) => { width: number; height: number };

const DIMENSIONS = [
  ["width", "setWidth"],
  ["height", "setHeight"],
  ["minWidth", "setMinWidth"],
  ["minHeight", "setMinHeight"],
  ["maxWidth", "setMaxWidth"],
  ["maxHeight", "setMaxHeight"],
  ["flexBasis", "setFlexBasis"],
] as const;
const EDGES = {
  Left: Yoga.EDGE_LEFT,
  Top: Yoga.EDGE_TOP,
  Right: Yoga.EDGE_RIGHT,
  Bottom: Yoga.EDGE_BOTTOM,
  Start: Yoga.EDGE_START,
  End: Yoga.EDGE_END,
  Horizontal: Yoga.EDGE_HORIZONTAL,
  Vertical: Yoga.EDGE_VERTICAL,
  "": Yoga.EDGE_ALL,
} as const;
const ALIGNMENTS = {
  auto: Yoga.ALIGN_AUTO,
  "flex-start": Yoga.ALIGN_FLEX_START,
  center: Yoga.ALIGN_CENTER,
  "flex-end": Yoga.ALIGN_FLEX_END,
  stretch: Yoga.ALIGN_STRETCH,
  baseline: Yoga.ALIGN_BASELINE,
  "space-between": Yoga.ALIGN_SPACE_BETWEEN,
  "space-around": Yoga.ALIGN_SPACE_AROUND,
};
const DIRECTIONS = {
  row: Yoga.FLEX_DIRECTION_ROW,
  column: Yoga.FLEX_DIRECTION_COLUMN,
  "row-reverse": Yoga.FLEX_DIRECTION_ROW_REVERSE,
  "column-reverse": Yoga.FLEX_DIRECTION_COLUMN_REVERSE,
};
const JUSTIFY = {
  "flex-start": Yoga.JUSTIFY_FLEX_START,
  center: Yoga.JUSTIFY_CENTER,
  "flex-end": Yoga.JUSTIFY_FLEX_END,
  "space-between": Yoga.JUSTIFY_SPACE_BETWEEN,
  "space-around": Yoga.JUSTIFY_SPACE_AROUND,
  "space-evenly": Yoga.JUSTIFY_SPACE_EVENLY,
};

function dimension(value: unknown, name: string): number | string {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && (value === "auto" || /^-?\d+(?:\.\d+)?%$/.test(value)))
    return value;
  throw new RokuHostError(
    "C03_LAYOUT_VALUE",
    `${name}=${String(value)} is not a supported dimension`,
  );
}
function numeric(value: unknown, name: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new RokuHostError("C03_LAYOUT_VALUE", `${name} must be finite`);
}
function enumValue<T extends Record<string, number>>(
  values: T,
  value: unknown,
  name: string,
): T[keyof T] {
  if (typeof value === "string" && value in values) return values[value] as T[keyof T];
  throw new RokuHostError("C03_LAYOUT_VALUE", `${name}=${String(value)} is not implemented`);
}

function applyStyle(node: Yoga.YogaNode, style: LayoutStyle): void {
  for (const [name, setter] of DIMENSIONS) {
    const authored = style[name];
    if (authored == null) continue;
    const value = dimension(authored, name);
    if (value === "auto") {
      if (name === "width") node.setWidthAuto();
      else if (name === "height") node.setHeightAuto();
      else if (name !== "flexBasis")
        throw new RokuHostError("C03_LAYOUT_VALUE", `${name} does not admit auto`);
      // Every Yoga node is fresh. Its default flex basis is already auto;
      // the old JS setter accepts numbers/percentages but rejects this token.
    } else node[setter](value);
  }
  node.setFlexDirection(enumValue(DIRECTIONS, style.flexDirection ?? "column", "flexDirection"));
  if (style.flex != null) node.setFlex(numeric(style.flex, "flex"));
  if (style.flexGrow != null) node.setFlexGrow(numeric(style.flexGrow, "flexGrow"));
  if (style.flexShrink != null) node.setFlexShrink(numeric(style.flexShrink, "flexShrink"));
  if (style.aspectRatio != null) node.setAspectRatio(numeric(style.aspectRatio, "aspectRatio"));
  if (style.alignItems != null)
    node.setAlignItems(enumValue(ALIGNMENTS, style.alignItems, "alignItems"));
  if (style.alignSelf != null)
    node.setAlignSelf(enumValue(ALIGNMENTS, style.alignSelf, "alignSelf"));
  if (style.alignContent != null)
    node.setAlignContent(enumValue(ALIGNMENTS, style.alignContent, "alignContent"));
  if (style.justifyContent != null)
    node.setJustifyContent(enumValue(JUSTIFY, style.justifyContent, "justifyContent"));
  node.setFlexWrap(
    enumValue(
      {
        nowrap: Yoga.WRAP_NO_WRAP,
        wrap: Yoga.WRAP_WRAP,
        "wrap-reverse": Yoga.WRAP_WRAP_REVERSE,
      },
      style.flexWrap ?? "nowrap",
      "flexWrap",
    ),
  );
  node.setPositionType(
    enumValue(
      {
        relative: Yoga.POSITION_TYPE_RELATIVE,
        absolute: Yoga.POSITION_TYPE_ABSOLUTE,
      },
      style.position ?? "relative",
      "position",
    ),
  );
  if (style.display != null)
    node.setDisplay(
      enumValue({ flex: Yoga.DISPLAY_FLEX, none: Yoga.DISPLAY_NONE }, style.display, "display"),
    );
  if (style.overflow != null)
    node.setOverflow(
      enumValue(
        {
          visible: Yoga.OVERFLOW_VISIBLE,
          hidden: Yoga.OVERFLOW_HIDDEN,
          scroll: Yoga.OVERFLOW_SCROLL,
        },
        style.overflow,
        "overflow",
      ),
    );
  for (const [suffix, edge] of Object.entries(EDGES)) {
    const margin = style[`margin${suffix}`];
    if (margin != null) {
      const value = dimension(margin, `margin${suffix}`);
      if (value === "auto") node.setMarginAuto(edge);
      else if (typeof value === "string") node.setMarginPercent(edge, Number.parseFloat(value));
      else node.setMargin(edge, value);
    }
    const padding = style[`padding${suffix}`];
    if (padding != null) node.setPadding(edge, dimension(padding, `padding${suffix}`));
    const border = style[`border${suffix}Width`];
    if (border != null) node.setBorder(edge, numeric(border, `border${suffix}Width`));
  }
  // Resolve shorthand precedence independently of object insertion order.
  // Old Yoga otherwise lets its start/end fallback to EDGE_ALL mask an explicit
  // physical side. RN's inline aliases override start/end, while physical
  // top/bottom override the corresponding block aliases.
  const positions = {
    left: style.left ?? style.insetInline ?? style.inset,
    right: style.right ?? style.insetInline ?? style.inset,
    top: style.top ?? style.insetBlockStart ?? style.insetBlock ?? style.inset,
    bottom: style.bottom ?? style.insetBlockEnd ?? style.insetBlock ?? style.inset,
    start: style.insetInlineStart ?? style.start,
    end: style.insetInlineEnd ?? style.end,
  };
  for (const [name, edge] of Object.entries({
    left: Yoga.EDGE_LEFT,
    right: Yoga.EDGE_RIGHT,
    top: Yoga.EDGE_TOP,
    bottom: Yoga.EDGE_BOTTOM,
    start: Yoga.EDGE_START,
    end: Yoga.EDGE_END,
  })) {
    const value = positions[name as keyof typeof positions];
    if (value != null) node.setPosition(edge, dimension(value, name));
  }
}

function trailingMargin(style: LayoutStyle, edge: "Right" | "Left" | "Top" | "Bottom"): number {
  const axis = edge === "Left" || edge === "Right" ? "Horizontal" : "Vertical";
  const value = style[`margin${edge}`] ?? style[`margin${axis}`] ?? style.margin ?? 0;
  return numeric(value, `margin${edge} with gap`);
}

/** Executes asm.js Yoga without assuming Wasm support. Its admitted subset is explicitly tested. */
export function calculateFlexLayout(
  input: LayoutInput,
  viewport: { width: number; height: number },
  measureText?: TextMeasure,
  retainedChildren?: ReadonlyMap<LayoutInput, unknown>,
): Map<LayoutInput, LayoutRect> {
  if (
    !(viewport.width > 0) ||
    !(viewport.height > 0) ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height)
  ) {
    throw new RokuHostError("C03_VIEWPORT", "Layout requires a finite, positive viewport");
  }
  const nodes = new Map<LayoutInput, Yoga.YogaNode>();
  const config = Yoga.Config.create();
  config.setPointScaleFactor(0);
  const allocations: Yoga.YogaNode[] = [];
  const shimParents = new Map<Yoga.YogaNode, Yoga.YogaNode>();
  const percentages: Array<{
    node: Yoga.YogaNode;
    parent: Yoga.YogaNode;
    name: "width" | "minWidth" | "maxWidth" | "flexBasis";
    ratio: number;
    applied?: number;
  }> = [];
  const build = (entry: LayoutInput): Yoga.YogaNode => {
    const node = Yoga.Node.createWithConfig(config);
    allocations.push(node);
    nodes.set(entry, node);
    applyStyle(node, entry.style);
    if (entry.text != null) {
      if (entry.children.length)
        throw new RokuHostError(
          "C03_TEXT_CHILDREN",
          "Measured text cannot also own layout children",
        );
      if (!measureText)
        throw new RokuHostError("C04_TEXT_METRICS", "A real text-metric adapter must be supplied");
      node.setMeasureFunc((width, widthMode, height, heightMode) => {
        const result = measureText(
          entry,
          widthMode === Yoga.MEASURE_MODE_UNDEFINED ? undefined : width,
          heightMode === Yoga.MEASURE_MODE_UNDEFINED ? undefined : height,
        );
        if (
          !Number.isFinite(result.width) ||
          !Number.isFinite(result.height) ||
          result.width < 0 ||
          result.height < 0
        )
          throw new RokuHostError(
            "C04_TEXT_METRICS",
            "Text measurement returned invalid dimensions",
          );
        return result;
      });
    }
    if (retainedChildren?.has(entry)) return node;
    const relative = entry.children.filter(
      (child) => child.style.position !== "absolute" && child.style.display !== "none",
    );
    const direction = String(entry.style.flexDirection ?? "column");
    const horizontal = direction.startsWith("row");
    const gap = numeric(
      entry.style[horizontal ? "columnGap" : "rowGap"] ?? entry.style.gap ?? 0,
      "gap",
    );
    if (gap < 0) throw new RokuHostError("C03_GAP", "Negative gaps are unsupported");
    const crossGap = numeric(
      entry.style[horizontal ? "rowGap" : "columnGap"] ?? entry.style.gap ?? 0,
      "cross gap",
    );
    if (crossGap < 0) throw new RokuHostError("C03_GAP", "Negative gaps are unsupported");
    const wrappedGap =
      (gap || crossGap) && entry.style.flexWrap != null && entry.style.flexWrap !== "nowrap";
    let content = node;
    if (wrappedGap) {
      if (
        direction !== "row" ||
        entry.style.flexWrap !== "wrap" ||
        (entry.style.alignContent != null && entry.style.alignContent !== "flex-start")
      )
        throw new RokuHostError(
          "C03_WRAP_GAP",
          "This wrapped-gap direction/alignment requires a modern layout adapter",
        );
      // Internal content extends by one trailing gutter. Every real child owns
      // a right/bottom gutter, and the negative outer margins remove the last
      // gutter from the measured size. The public parent keeps its original
      // padding, border, bounds and clip; no product JSX wrapper is introduced.
      content = Yoga.Node.createWithConfig(config);
      allocations.push(content);
      content.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
      content.setFlexWrap(Yoga.WRAP_WRAP);
      content.setAlignSelf(Yoga.ALIGN_STRETCH);
      if (entry.style.alignItems != null)
        content.setAlignItems(enumValue(ALIGNMENTS, entry.style.alignItems, "alignItems"));
      if (entry.style.justifyContent != null)
        content.setJustifyContent(enumValue(JUSTIFY, entry.style.justifyContent, "justifyContent"));
      content.setMargin(Yoga.EDGE_RIGHT, -gap);
      content.setMargin(Yoga.EDGE_BOTTOM, -crossGap);
      node.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);
      node.setAlignItems(Yoga.ALIGN_STRETCH);
      node.setJustifyContent(Yoga.JUSTIFY_FLEX_START);
      node.insertChild(content, 0);
    }
    const edge = horizontal
      ? direction.endsWith("reverse")
        ? "Left"
        : "Right"
      : direction.endsWith("reverse")
        ? "Top"
        : "Bottom";
    let contentIndex = 0,
      absoluteIndex = wrappedGap ? 1 : 0;
    entry.children.forEach((child, index) => {
      const yogaChild = build(child);
      if (wrappedGap && child.style.position !== "absolute") {
        if (child.style.display !== "none") {
          yogaChild.setMargin(Yoga.EDGE_RIGHT, trailingMargin(child.style, "Right") + gap);
          yogaChild.setMargin(Yoga.EDGE_BOTTOM, trailingMargin(child.style, "Bottom") + crossGap);
        }
        content.insertChild(yogaChild, contentIndex++);
        shimParents.set(yogaChild, content);
        for (const name of ["width", "minWidth", "maxWidth", "flexBasis"] as const) {
          const value = child.style[name];
          if (typeof value === "string" && value.endsWith("%"))
            percentages.push({
              node: yogaChild,
              parent: node,
              name,
              ratio: Number.parseFloat(value) / 100,
            });
        }
      } else if (wrappedGap) node.insertChild(yogaChild, absoluteIndex++);
      else {
        if (gap && relative.includes(child) && child !== relative[relative.length - 1]) {
          yogaChild.setMargin(EDGES[edge], trailingMargin(child.style, edge) + gap);
        }
        node.insertChild(yogaChild, index);
      }
    });
    return node;
  };
  try {
    const root = build(input);
    root.setWidth(viewport.width);
    root.setHeight(viewport.height);
    root.calculateLayout(viewport.width, viewport.height, Yoga.DIRECTION_LTR);
    // Percentages refer to the original content box, not the shim's extra
    // trailing gutter. Resolve those constraints and recalculate to convergence.
    for (let pass = 0; percentages.length; pass++) {
      let changed = false;
      for (const entry of percentages) {
        const width =
          entry.parent.getComputedWidth() -
          entry.parent.getComputedPadding(Yoga.EDGE_LEFT) -
          entry.parent.getComputedPadding(Yoga.EDGE_RIGHT) -
          entry.parent.getComputedBorder(Yoga.EDGE_LEFT) -
          entry.parent.getComputedBorder(Yoga.EDGE_RIGHT);
        const value = Math.max(0, width * entry.ratio);
        if (entry.applied != null && Math.abs(entry.applied - value) < 1e-5) continue;
        entry.applied = value;
        changed = true;
        if (entry.name === "width") entry.node.setWidth(value);
        else if (entry.name === "minWidth") entry.node.setMinWidth(value);
        else if (entry.name === "maxWidth") entry.node.setMaxWidth(value);
        else entry.node.setFlexBasis(value);
      }
      if (!changed) break;
      if (pass >= 3)
        throw new RokuHostError("C03_WRAP_GAP", "Wrapped percentage constraints did not converge");
      root.calculateLayout(viewport.width, viewport.height, Yoga.DIRECTION_LTR);
    }
    return new Map(
      [...nodes].map(([entry, node]) => {
        const layout = node.getComputedLayout();
        const shim = shimParents.get(node)?.getComputedLayout();
        return [
          entry,
          {
            x: layout.left + (shim?.left ?? 0),
            y: layout.top + (shim?.top ?? 0),
            width: layout.width,
            height: layout.height,
          },
        ];
      }),
    );
  } finally {
    // Individual frees also cover partially constructed trees when admission fails.
    for (let index = allocations.length - 1; index >= 0; index--) {
      const node = allocations[index],
        parent = node.getParent();
      if (parent) parent.removeChild(node);
      node.free();
    }
    Yoga.Config.destroy(config);
  }
}
