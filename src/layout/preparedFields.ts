import type { LayoutRect, LayoutStyle } from "./flexLayout";
import { nativeNodeFields, type MeasuredLabel } from "./nativeNodeFields";
import type { TextMetricProvider } from "./textLayout";
import type { SceneTreeElement } from "../renderer/SceneRoot";
import type { SceneFields, SceneNodeRef } from "../scene/sceneGraph.types";

interface PreparedFields {
  fields: SceneFields;
  opacity: LayoutStyle["opacity"];
  content?: string;
  font?: SceneNodeRef;
  lineHeight?: number;
  effect?: SceneTreeElement;
}

/** The owner replaces this cache on each Yoga solve. During reuse it has already
 * compared layout rectangles, label styles and line limits against that solve.
 * Paint, native font readiness and resource children can change independently. */
export class PreparedFieldCache {
  private values = new WeakMap<SceneTreeElement, PreparedFields>();

  retained(node: SceneTreeElement, fields: SceneFields | undefined) {
    const prepared = this.values.get(node);
    return prepared?.fields === fields ? prepared : undefined;
  }

  begin(sameGeometry: boolean, text: TextMetricProvider, changedGeometry?: SceneTreeElement) {
    if (!sameGeometry) this.values = new WeakMap();
    else if (changedGeometry) this.values.delete(changedGeometry);
    const heights = new Map<SceneNodeRef, number>();
    return (
      node: SceneTreeElement,
      style: LayoutStyle,
      rect: LayoutRect,
      content?: string,
      measuredLabel?: MeasuredLabel,
    ) => {
      const layout = node.props.layout;
      if (
        style.transform != null ||
        style.transformOrigin != null ||
        layout?.resource ||
        layout?.decoration ||
        layout?.paintWrapper ||
        layout?.textRaster ||
        (node.type !== "group" && node.type !== "rectangle" && node.type !== "label") ||
        (node.type === "label" && (!text.preparedFieldFont || content === undefined))
      )
        return nativeNodeFields(node, style, rect, text);

      let font: SceneNodeRef | undefined, lineHeight: number | undefined;
      if (node.type === "label") {
        font = text.preparedFieldFont!(style);
        lineHeight = heights.get(font);
        if (lineHeight === undefined) {
          lineHeight = text.metrics(style).lineHeight;
          heights.set(font, lineHeight);
        }
      }
      const effect = node.children.find(
        (child): child is SceneTreeElement => child.kind === "element" && child.type === "effect",
      );
      const previous = this.values.get(node);
      if (
        previous &&
        Object.is(style.opacity, previous.opacity) &&
        content === previous.content &&
        font === previous.font &&
        Object.is(lineHeight, previous.lineHeight) &&
        effect === previous.effect
      )
        return previous.fields;
      const fields = nativeNodeFields(node, style, rect, text, measuredLabel);
      this.values.set(node, { fields, opacity: style.opacity, content, font, lineHeight, effect });
      return fields;
    };
  }
}
