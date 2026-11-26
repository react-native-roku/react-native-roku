import { createElement, type ReactNode } from "react";
import {
  calculateFlexLayout,
  type LayoutInput,
  type LayoutRect,
  type LayoutStyle,
  type TextMeasure,
} from "../layout/flexLayout";
import {
  labelText,
  nativeInlineTextLines,
  nativeNodeFields,
  type MeasuredLabel,
} from "../layout/nativeNodeFields";
import { PreparedFieldCache } from "../layout/preparedFields";
import { layoutText, type RetainedFontMetrics } from "../layout/textLayout";
import {
  captureLayoutStyle,
  hasOnlyBuiltinObjectPrototypeFields,
  sameLayoutStyle,
  type LayoutStyleSnapshot,
} from "../layout/layoutReuse";
import {
  createPreparedSceneRoot,
  hasGeneratedSceneFields,
  reuseSceneGeometry,
  tryUpdateCommittedOpacity,
  trySubmitFocusPresentation,
  type FocusPresentationWrite,
  type SceneRoot,
  type SceneTreeElement,
  plainBackgroundLayout,
  plainImageLayout,
} from "../renderer/SceneRoot";
import {
  RokuHostError,
  type SceneFields,
  type SceneGraphPort,
  type SceneNodeRef,
  type SceneValue,
} from "../scene/sceneGraph.types";
import {
  NativeHostContext,
  type NativeHostContextValue,
  type FocusPresentation,
  type NativePlacement,
} from "./nativeHostContext";
import { bindNativeEnvironment } from "./environment";
import { roundedMask, surfaceRadii } from "../graphics/surfaces";
import { gradientFields, type GradientSpec } from "../graphics/gradient";
import type { TextRasterLease } from "../graphics/textRaster.types";
import { inlineTextRuns, measureInlineText } from "../layout/inlineText";
import { layoutInlineParagraph } from "../layout/inlineParagraph";
import { affineBounds, identityAffine, sceneWorld, type Affine } from "../layout/affine";
import { flattenStyle, rokuColor, type NativeStyle } from "./styleSheet";
import { directionalFocusTarget } from "./directionalFocus";

import type { NativeRootOptions } from "./nativeRoot.types";
import { dispatchNativeFocus } from "./focusEvents";
import { accessibilitySpeech, type AccessibilitySemantics } from "./accessibility";
export type { NativeRootOptions } from "./nativeRoot.types";

interface PlacementAncestor extends PlacementScroll {
  parent?: SceneTreeElement;
  pointerEvents: unknown;
  importance: unknown;
  accessibilityElementsHidden: unknown;
  accessible: unknown;
}
interface PlacementScroll {
  scrollX?: number;
  scrollY?: number;
}
type PlacementParents = Map<SceneTreeElement, PlacementAncestor>;
interface PlacementWalk {
  rectangles: ReadonlyMap<SceneTreeElement, LayoutRect>;
  callbacks: readonly LayoutDelivery[];
  fields: Map<SceneTreeElement, SceneFields>;
  bases: Map<SceneTreeElement, SceneFields>;
  parents: PlacementParents;
  contentLabels: Map<SceneTreeElement, string>;
  local?: {
    bases: ReadonlyMap<SceneTreeElement, SceneFields>;
    labels: ReadonlyMap<SceneTreeElement, string>;
    visited: ReadonlySet<SceneTreeElement>;
    scrollChanges?: ReadonlyMap<SceneTreeElement, PlacementScroll>;
  };
  retained?: RetainedPlacement;
}

type LayoutDependency = {
  element: SceneTreeElement;
  style: LayoutStyleSnapshot;
  text?: string;
  measured: boolean;
  lines: unknown;
  children: readonly SceneTreeElement[];
};

type LayoutDelivery = {
  id: string;
  rect: LayoutRect;
  callback: (event: unknown) => void;
};

type IsolatedLabel = {
  element: SceneTreeElement;
  index: number;
  rect: LayoutRect;
  text: string;
  measured: boolean;
};

function sameRect(a: LayoutRect | undefined, b: LayoutRect): boolean {
  return a?.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

interface RetainedPlacement {
  readLineHeight(font: SceneNodeRef): number;
  text: RetainedFontMetrics;
  fonts: ReadonlyMap<SceneNodeRef, number>;
}

const emptyStyle: LayoutStyle = {};
const fontStyleKeys = ["fontFamily", "fontSize", "fontStyle", "fontWeight", "fontVariant"] as const;

function fixedLabel(dependency: LayoutDependency, style: LayoutStyle, committed?: LayoutRect) {
  return (
    dependency.element.type === "label" &&
    dependency.text !== undefined &&
    !dependency.measured &&
    typeof style.height === "number" &&
    style.height > 0 &&
    ((typeof style.width === "number" &&
      style.width > 0 &&
      (!committed || Object.hasOwn(style, "width"))) ||
      // A retained Yoga solve can constrain the width through flex stretch.
      // No measure call means glyphs did not contribute to that geometry.
      (style.width == null &&
        !!committed &&
        Object.hasOwn(style, "height") &&
        committed.width > 0 &&
        committed.height === Math.fround(style.height) &&
        hasOnlyBuiltinObjectPrototypeFields()))
  );
}

// A single child of a fixed absolute box can be laid out independently
// when the rest of the layout inputs haven't changed.
const isolatedBoxStyle = new Set([
  "position",
  "left",
  "top",
  "right",
  "bottom",
  "width",
  "height",
  "opacity",
  "backgroundColor",
]);

function isolatedBox(style: LayoutStyle, rect: LayoutRect | undefined): rect is LayoutRect {
  return (
    !!rect &&
    style.position === "absolute" &&
    typeof style.width === "number" &&
    typeof style.height === "number" &&
    Math.fround(style.width) === rect.width &&
    Math.fround(style.height) === rect.height &&
    rect.width > 0 &&
    rect.height > 0 &&
    Object.getOwnPropertyNames(style).every((key) => isolatedBoxStyle.has(key))
  );
}

const fixedScrollBoxSpacing =
  /^(?:margin|padding)(?:Left|Top|Right|Bottom|Start|End|Horizontal|Vertical)?$/;

function fixedScrollBox(input: LayoutInput, rect: LayoutRect): boolean {
  const { style, children } = input;
  return (
    input.text === undefined &&
    children.length > 0 &&
    children.every((child) => child.children.length === 0) &&
    typeof style.width === "number" &&
    typeof style.height === "number" &&
    rect.width > 0 &&
    rect.height > 0 &&
    Math.fround(style.width) === rect.width &&
    Math.fround(style.height) === rect.height &&
    Object.getOwnPropertyNames(style).every((key) => {
      if (key === "width" || key === "height" || key === "opacity" || key === "backgroundColor")
        return true;
      const value = style[key];
      return typeof value === "number" && Number.isFinite(value) && fixedScrollBoxSpacing.test(key);
    })
  );
}

const fixedWidthTextStyle = new Set([
  "width",
  "color",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontWeight",
  "fontVariant",
  "lineHeight",
  "letterSpacing",
  "opacity",
  "textAlign",
  "textTransform",
]);

function intrinsicLabelRect(
  input: LayoutInput,
  before: LayoutRect,
  measure: TextMeasure,
): LayoutRect | undefined {
  // A single fixed-width label in a default column has no flex, alignment,
  // padding or margin constraints. Its auto height is its measured height.
  const { width } = input.style;
  if (
    typeof width !== "number" ||
    !Object.hasOwn(input.style, "width") ||
    before.x !== 0 ||
    before.y !== 0 ||
    before.width <= 0 ||
    Math.fround(width) !== before.width ||
    !Object.getOwnPropertyNames(input.style).every((key) => fixedWidthTextStyle.has(key))
  )
    return undefined;
  const text = measure(input, before.width, undefined);
  const height = Math.fround(text.height);
  if (!Number.isFinite(text.width) || text.width < 0 || !Number.isFinite(height)) return undefined;
  return { ...before, height };
}

function retainPlacementInputs(
  dependencies: readonly LayoutDependency[],
  bases: ReadonlyMap<SceneTreeElement, SceneFields>,
  preparedFields: PreparedFieldCache,
  text: RetainedFontMetrics,
): RetainedPlacement | undefined {
  const readLineHeight = text.readRetainedFontLineHeight;
  if (!readLineHeight) return undefined;
  const fonts = new Map<SceneNodeRef, number>();
  for (const dependency of dependencies) {
    const { element } = dependency;
    const prepared = preparedFields.retained(element, bases.get(element));
    if (!prepared) return undefined;
    if (element.type !== "label") continue;
    const { font, lineHeight } = prepared;
    // Coercions and variant collections stay on the ordinary font resolution path.
    if (
      !font ||
      lineHeight === undefined ||
      fontStyleKeys.some((key) => {
        const value = dependency.style.values[key];
        return value != null && typeof value !== "string" && typeof value !== "number";
      })
    )
      return undefined;
    fonts.set(font, lineHeight);
  }
  return { readLineHeight: readLineHeight.bind(text), text, fonts };
}

function hasLocalPlacement(node: SceneTreeElement): boolean {
  if (!hasGeneratedSceneFields(node)) return false;
  const layout = node.props.layout;
  if (node.type === "rectangle") return layout === plainBackgroundLayout;
  if (node.type === "poster") return layout === plainImageLayout;
  if (
    typeof layout?.id !== "string" ||
    layout.resource ||
    layout.decoration ||
    layout.paintWrapper ||
    layout.textRaster ||
    layout.maskReadiness != null
  )
    return false;
  const semantics = layout.accessibility as AccessibilitySemantics | undefined;
  return (
    !semantics ||
    (!semantics.modal && !semantics.labelledBy.length && !semantics.describedBy.length)
  );
}

function indexPlacementParents(
  fields: ReadonlyMap<SceneTreeElement, SceneFields>,
  readyFonts: boolean,
): PlacementParents | undefined {
  const parents = new Map<SceneTreeElement, PlacementAncestor>();
  const record = (node: SceneTreeElement, parent?: SceneTreeElement): PlacementAncestor => ({
    parent,
    pointerEvents: node.props.layout?.pointerEvents,
    importance: node.props.layout?.importantForAccessibility,
    accessibilityElementsHidden: node.props.layout?.accessibilityElementsHidden,
    accessible: node.props.layout?.accessible,
    scrollX: (node.props.layout?.scrollTranslation as readonly number[] | undefined)?.[0],
    scrollY: (node.props.layout?.scrollTranslation as readonly number[] | undefined)?.[1],
  });
  for (const node of fields.keys()) {
    if (!hasLocalPlacement(node) || (node.type === "label" && !readyFonts)) return undefined;
    if (!parents.has(node)) parents.set(node, record(node));
    for (const child of node.children)
      if (child.kind === "element" && fields.has(child)) parents.set(child, record(child, node));
  }
  return parents;
}

export function createNativeRoot(port: SceneGraphPort, options: NativeRootOptions): SceneRoot {
  const preparedFields = new PreparedFieldCache();
  let layoutCache:
    | {
        dependencies: LayoutDependency[];
        rectangles: Map<SceneTreeElement, LayoutRect>;
        width: number;
        height: number;
      }
    | undefined;
  const inlineLines = new WeakMap<SceneTreeElement, readonly SceneFields[]>();
  let placements = new Map<string, NativePlacement>();
  let committedWalk: PlacementWalk | undefined;
  const placementWalks = new WeakMap<readonly SceneTreeElement[], PlacementWalk>();
  let retired = false,
    publication = 0;
  const pendingCleanup = new Set<() => void>();
  let unmounting = false;
  let focusRequest = 0;
  let admittedFocusRequest = 0;
  let lastFocusSpeech: { id: string; handle: NativePlacement["handle"]; text: string } | undefined;
  const liveSpeech = new Map<string, { handle: NativePlacement["handle"]; text: string }>();
  const speak = (id: string, queue = false) => {
    const placement = placements.get(id);
    if (
      retired ||
      !systemAllowsInput() ||
      !placement ||
      placement.accessibilityHidden ||
      options.system?.getSnapshot().screenReader !== true
    )
      return;
    const message = placement.accessibility
      ? accessibilitySpeech(placement.accessibility, placement.accessibilityLabel)
      : (placement.accessibilityLabel ?? "");
    if (!message) return;
    const previous = queue
      ? liveSpeech.get(id)
      : lastFocusSpeech?.id === id
        ? lastFocusSpeech
        : undefined;
    if (previous?.handle === placement.handle && previous.text === message) return;
    options.system.announceForAccessibility(message, { queue });
    if (queue) liveSpeech.set(id, { handle: placement.handle, text: message });
    else lastFocusSpeech = { id, handle: placement.handle, text: message };
  };
  const focusOverrides = new Map<
    string,
    Partial<Record<"up" | "right" | "down" | "left", number | null>>
  >();
  const opacityOverrides = new Map<
    string,
    { value: number; baseline: unknown; initialized: boolean }
  >();
  const dimensionOverrides = new Map<
    string,
    {
      values: Partial<Record<"width" | "height", number>>;
      baseline: LayoutStyle;
      initialized: boolean;
    }
  >();
  type Presentation = {
    pointerEvents?: string;
    importantForAccessibility?: string;
    accessibilityElementsHidden?: boolean;
  };
  const presentationOverrides = new Map<
    string,
    { values: Presentation; baseline: Presentation; initialized: boolean }
  >();
  const declarativePresentation = new Map<string, Presentation>();
  const declarativeStyles = new Map<string, LayoutStyle>();
  let placedTags = new Map<number, string>();
  let layoutDelivery: Promise<void> = Promise.resolve();
  const deliveredLayouts = new Map<string, NativePlacement>();
  let rasterGeneration = 0;
  let committedRasterGeneration = 0;
  let committedRasters = new Set<TextRasterLease>(),
    preparingRasters = new Set<TextRasterLease>();
  const rasterLeases = new WeakMap<readonly SceneTreeElement[], Set<TextRasterLease>>();
  async function whenNativeCommitted(): Promise<void> {
    let delivery: Promise<void>;
    do {
      await root.whenCommitted();
      delivery = layoutDelivery;
      await delivery;
      await root.whenCommitted();
    } while (delivery !== layoutDelivery);
  }
  const pending = new WeakMap<
    readonly SceneTreeElement[],
    { entries: Map<string, NativePlacement>; local: boolean; isolated?: IsolatedLabel }
  >();
  const deliveries = new WeakMap<readonly SceneTreeElement[], LayoutDelivery[]>();
  const systemAllowsInput = () => {
    const state = options.system?.getSnapshot().appState;
    return state !== "background" && state !== "inactive";
  };
  const mediaCommand = (
    kind: "video" | "audio",
    id: string,
    fields: Readonly<Record<string, string | number | boolean>>,
  ) => {
    const code = kind === "video" ? "C30_VIDEO" : "C31_AUDIO";
    const ref = placements.get(id)?.handle.nativeRef;
    if (retired || !ref || ref.type !== kind)
      throw new RokuHostError(`${code}_RETIRED`, `The ${kind} surface is not mounted`);
    for (const [field, value] of Object.entries(fields)) {
      if (
        field === "control" &&
        ["play", "prebuffer", "pause", "resume", "stop"].includes(String(value))
      )
        continue;
      if (field === "seek" && typeof value === "number" && Number.isFinite(value) && value >= 0)
        continue;
      if (field === "mute" && typeof value === "boolean") continue;
      if (kind === "audio" && field === "autoplayAfterSeek" && typeof value === "boolean") continue;
      throw new RokuHostError(`${code}_COMMAND`, `Unsupported ${kind} command ${field}`);
    }
    port.batch(() => {
      for (const [field, value] of Object.entries(fields)) port.set(ref, field, value);
    });
  };
  const submitDirectionalPresentation = (id: string): boolean => {
    const planPublication = publication;
    const source = options.input?.focusedID;
    const old = source ? placements.get(source)?.node : undefined;
    const next = placements.get(id)?.node;
    const from = old?.props.layout?.focusPresentation as FocusPresentation | undefined;
    const to = next?.props.layout?.focusPresentation as FocusPresentation | undefined;
    if (
      !old ||
      !next ||
      !from ||
      !to ||
      !committedWalk?.retained ||
      !layoutCache ||
      rasterGeneration !== committedRasterGeneration ||
      opacityOverrides.size ||
      dimensionOverrides.size ||
      presentationOverrides.size
    )
      return false;
    const background = (node: SceneTreeElement) =>
      node.children.find(
        (child): child is SceneTreeElement =>
          child.kind === "element" && child.props.layout === plainBackgroundLayout,
      );
    const oldPaint = background(old),
      nextPaint = background(next);
    if (
      !oldPaint ||
      !nextPaint ||
      oldPaint.hidden ||
      nextPaint.hidden ||
      !hasGeneratedSceneFields(oldPaint) ||
      !hasGeneratedSceneFields(nextPaint)
    )
      return false;
    const oldColor = rokuColor(from.restingColor),
      nextColor = rokuColor(to.focusedColor);
    if (
      oldPaint.props.fields?.color !== rokuColor(from.focusedColor) ||
      nextPaint.props.fields?.color !== rokuColor(to.restingColor)
    )
      return false;
    const writes: FocusPresentationWrite[] = [
      { node: oldPaint, fields: { color: oldColor } },
      { node: nextPaint, fields: { color: nextColor } },
    ];
    if (to.label) {
      const placement = placements.get(to.label.nativeID);
      const label = placement?.node;
      const dependency = layoutCache.dependencies.find(({ element }) => element === label);
      const style = (label?.props.layout?.style ?? emptyStyle) as LayoutStyle;
      if (
        !label ||
        !placement ||
        placement.visible === false ||
        placement.modalBlocked ||
        !dependency ||
        !fixedLabel(dependency, style) ||
        !sameLayoutStyle(style, dependency.style, false) ||
        !Object.is(label.props.layout?.numberOfLines, dependency.lines)
      )
        return false;
      const prepared = preparedFields.retained(label, committedWalk.bases.get(label));
      if (!prepared?.font || options.text.preparedFieldFont?.(style) !== prepared.font)
        return false;
      const metrics = options.text.metrics(style);
      if (!Object.is(metrics.lineHeight, prepared.lineHeight)) return false;
      const planned = layoutText(
        to.label.text,
        style,
        metrics,
        placement.local.width,
        Number(dependency.lines ?? 0),
      );
      writes.push({ node: label, fields: { text: planned.text, numLines: planned.lines.length } });
    }
    return publication === planPublication && trySubmitFocusPresentation(root, next, writes);
  };
  const host: NativeHostContextValue = {
    get active() {
      return !retired;
    },
    input: options.input,
    svgAtlas: options.svgAtlas,
    graphics: options.graphics,
    raster: options.textRaster,
    textEntry: options.textEntry ?? options.services?.textEntry,
    portal: (element, key) => root.portal(element, key),
    viewport: options.viewport,
    placement: (id) => placements.get(id),
    whenCommitted: whenNativeCommitted,
    runSync: (work) => root.runSync(work),
    cancelInput() {
      admittedFocusRequest = ++focusRequest;
      options.input?.cancelPendingInput();
    },
    dispatchFocus: (id, focused) => {
      if (!focused && lastFocusSpeech?.id === id) lastFocusSpeech = undefined;
      dispatchNativeFocus(placements, id, focused, () => !retired);
    },
    requestFocus(id, view, isCurrent, origin) {
      if (retired || !systemAllowsInput()) return;
      const generation = ++focusRequest;
      const eligible = () => {
        const placement = placements.get(id);
        return !retired &&
          generation >= admittedFocusRequest &&
          systemAllowsInput() &&
          isCurrent?.() !== false &&
          (!view || placement?.view === view) &&
          placement?.modalBlocked !== true &&
          placement?.visible !== false &&
          placement?.focusable !== false
          ? placement?.handle.nativeRef
          : undefined;
      };
      const submit = () => {
        const ref = eligible();
        if (!ref) return;
        // Refused attempts cannot cancel a held press or supersede an admitted
        // request. Fence input only when a native command can actually be sent.
        admittedFocusRequest = generation;
        options.input?.requestFocus(id, origin, (from, confirm) => {
          const previous = from ? placements.get(from)?.handle.nativeRef : undefined;
          if (eligible() !== ref) return;
          port.sampleFocus?.(previous && previous !== ref ? [ref, previous] : [ref], (observed) => {
            if (eligible() !== ref) return;
            const observedID = observed === ref ? id : from;
            if (
              observedID &&
              placements.get(observedID)?.handle.nativeRef === observed &&
              options.input?.isTargetEnabled(observedID)
            )
              confirm(observedID);
          });
        });
        // Input cancellation callbacks may retire this root or request focus again.
        if (generation !== admittedFocusRequest || eligible() !== ref) return;
        // Only a device observation may acknowledge focus ownership.
        if (origin !== "directional" || !submitDirectionalPresentation(id))
          port.batch(() => port.set(ref, "gainFocus", true));
      };
      if (eligible() && rasterGeneration === committedRasterGeneration) submit();
      else {
        // Layout effects can still see the previous native eligibility. Recheck
        // after attachment, modal dismissal and asynchronous text preparation.
        void whenNativeCommitted().then(submit, () => undefined);
      }
    },
    announceFocus(id) {
      speak(id);
    },
    setNativeProps(id, props) {
      const next = { ...focusOverrides.get(id) };
      let opacity: number | undefined;
      let opacityOnly = true;
      const dimensions: Partial<Record<"width" | "height", number>> = {};
      const prior = presentationOverrides.get(id);
      const presentation = { ...prior?.values };
      const baseline = { ...prior?.baseline };
      for (const [key, value] of Object.entries(props)) {
        if (key !== "style") opacityOnly = false;
        if (key === "accessibilityElementsHidden") {
          if (typeof value !== "boolean")
            throw new RokuHostError("C03_ACCESSIBILITY", "Invalid accessibility exposure");
          presentation.accessibilityElementsHidden = value;
          baseline.accessibilityElementsHidden =
            declarativePresentation.get(id)?.accessibilityElementsHidden;
          continue;
        }
        if (key === "pointerEvents") {
          if (!["auto", "none", "box-none", "box-only"].includes(String(value)))
            throw new RokuHostError("C03_POINTER_EVENTS", "Invalid imperative pointer exposure");
          presentation.pointerEvents = String(value);
          baseline.pointerEvents = declarativePresentation.get(id)?.pointerEvents;
          continue;
        }
        if (key === "importantForAccessibility") {
          if (!["auto", "yes", "no", "no-hide-descendants"].includes(String(value)))
            throw new RokuHostError("C03_ACCESSIBILITY", "Invalid accessibility exposure");
          presentation.importantForAccessibility = String(value);
          baseline.importantForAccessibility =
            declarativePresentation.get(id)?.importantForAccessibility;
          continue;
        }
        if (key === "style") {
          for (const [name, field] of Object.entries(flattenStyle(value as NativeStyle) ?? {})) {
            if (name !== "opacity") opacityOnly = false;
            if (
              name === "opacity" &&
              typeof field === "number" &&
              Number.isFinite(field) &&
              field >= 0 &&
              field <= 1
            )
              opacity = field;
            else if (
              (name === "width" || name === "height") &&
              typeof field === "number" &&
              Number.isFinite(field) &&
              field >= 0
            )
              dimensions[name] = field;
            else if (
              name === "pointerEvents" &&
              ["auto", "none", "box-none", "box-only"].includes(String(field))
            ) {
              presentation.pointerEvents = String(field);
              baseline.pointerEvents = declarativePresentation.get(id)?.pointerEvents;
            } else
              throw new RokuHostError(
                "C03_IMPERATIVE_PROPS",
                `Imperative style ${name} needs a renderer binding`,
              );
          }
          continue;
        }
        const direction = {
          nextFocusUp: "up",
          nextFocusRight: "right",
          nextFocusDown: "down",
          nextFocusLeft: "left",
        }[key] as "up" | "right" | "down" | "left" | undefined;
        if (!direction)
          throw new RokuHostError(
            "C03_IMPERATIVE_PROPS",
            `Imperative prop ${key} needs a renderer binding`,
          );
        if (
          value !== null &&
          (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
        )
          throw new RokuHostError(
            "C07_FOCUS_TAG",
            "Directional targets require a stable view tag or null",
          );
        next[direction] = value as number | null;
      }
      focusOverrides.set(id, next);
      presentationOverrides.set(id, {
        values: presentation,
        baseline,
        initialized: declarativePresentation.has(id),
      });
      if (Object.keys(dimensions).length) {
        const previous = dimensionOverrides.get(id),
          declared = declarativeStyles.get(id);
        dimensionOverrides.set(id, {
          values: { ...previous?.values, ...dimensions },
          baseline: {
            ...previous?.baseline,
            ...Object.fromEntries(Object.keys(dimensions).map((name) => [name, declared?.[name]])),
          },
          initialized: !!declared,
        });
      }
      if (opacity !== undefined)
        opacityOverrides.set(id, {
          value: opacity,
          baseline: declarativeStyles.get(id)?.opacity,
          initialized: declarativeStyles.has(id),
        });
      const placement = placements.get(id);
      if (
        opacityOnly &&
        opacity !== undefined &&
        placement &&
        tryUpdateCommittedOpacity(root, placement.handle, opacity)
      )
        return;
      const ref = placement?.handle.nativeRef;
      if (ref && opacity !== undefined) port.batch(() => port.set(ref, "opacity", opacity));
      if (
        ref &&
        (opacity !== undefined ||
          Object.keys(presentation).length ||
          Object.keys(dimensions).length)
      )
        root.refreshNative();
    },
    videoCommand(id, fields) {
      mediaCommand("video", id, fields);
    },
    audioCommand(id, fields) {
      mediaCommand("audio", id, fields);
    },
  };
  const root = createPreparedSceneRoot(port, options.onError, {
    strictMode: options.strictMode,
    inlineTextLines: (node) => inlineLines.get(node) ?? [],
    prepareFields(tree, reactCommit, changes) {
      const generation = ++rasterGeneration;
      for (const lease of preparingRasters) lease.release();
      preparingRasters = new Set();
      const retained = new Set<TextRasterLease>();
      let preparationFailed = false;
      const failPreparation = (error: unknown): never => {
        preparationFailed = true;
        for (const lease of retained) {
          preparingRasters.delete(lease);
          lease.release();
        }
        retained.clear();
        throw error;
      };
      rasterLeases.set(tree, retained);
      const canRetainPlacement = () =>
        !opacityOverrides.size && !dimensionOverrides.size && !presentationOverrides.size;
      const placementFor = (
        rectangles: ReadonlyMap<SceneTreeElement, LayoutRect>,
        scrollChanges?: Map<SceneTreeElement, PlacementScroll>,
      ) => {
        const previous = committedWalk;
        if (
          !previous ||
          previous.rectangles !== rectangles ||
          !changes ||
          !canRetainPlacement() ||
          previous.callbacks.some(
            ({ id, rect }) => !sameRect(deliveredLayouts.get(id)?.local, rect),
          )
        )
          return undefined;
        for (const node of changes) {
          const context = previous.parents.get(node);
          const layout = node.props.layout;
          const scroll = layout?.scrollTranslation as readonly number[] | undefined;
          if (
            !context ||
            !hasLocalPlacement(node) ||
            context.pointerEvents !== layout?.pointerEvents ||
            context.importance !== layout?.importantForAccessibility ||
            context.accessibilityElementsHidden !== layout?.accessibilityElementsHidden ||
            context.accessible !== layout?.accessible
          )
            return undefined;
          if (
            !Object.is(context.scrollX, scroll?.[0]) ||
            !Object.is(context.scrollY, scroll?.[1])
          ) {
            if (!scrollChanges) return undefined;
            scrollChanges.set(node, { scrollX: scroll?.[0], scrollY: scroll?.[1] });
          }
          const id = layout?.id;
          if (typeof id === "string" && placements.get(id)?.handle !== node.handle)
            return undefined;
        }
        return previous;
      };
      const retainedLayout = () => {
        const settledLayout = layoutCache;
        if (
          !reactCommit ||
          !changes ||
          !settledLayout ||
          settledLayout.width !== options.viewport.width ||
          settledLayout.height !== options.viewport.height ||
          fontStyleKeys.some((key) => Object.hasOwn(Object.prototype, key))
        )
          return undefined;
        const scrollChanges = new Map<SceneTreeElement, PlacementScroll>();
        const placement = placementFor(settledLayout.rectangles, scrollChanges);
        const retained = placement?.retained;
        if (!placement || !retained || retained.text !== options.text) return undefined;
        const changedBases = new Set<SceneTreeElement>();
        let textChange:
          | { index: number; element: SceneTreeElement; input: LayoutInput & { text: string } }
          | undefined;
        for (const [index, dependency] of settledLayout.dependencies.entries()) {
          const { element } = dependency;
          const authored = element.props.layout;
          const style = (authored?.style ?? emptyStyle) as LayoutStyle;
          if (
            !Object.is(authored?.numberOfLines, dependency.lines) ||
            !sameLayoutStyle(style, dependency.style, element.type === "group")
          )
            return undefined;
          const base = placement.bases.get(element);
          const opacity = typeof style.opacity === "number" ? style.opacity : undefined;
          if (!Object.is(opacity, base?.opacity)) changedBases.add(element);
          if (element.type !== "label" || !changes.has(element)) continue;
          const text = labelText(element);
          if (text === preparedFields.retained(element, base)?.content) continue;
          changedBases.add(element);
          if (!fixedLabel(dependency, style, settledLayout.rectangles.get(element))) {
            if (textChange) return undefined;
            textChange = { index, element, input: { text, style, children: [] } };
          }
        }
        let box: { input: LayoutInput; rect: LayoutRect } | undefined;
        if (textChange) {
          const { element } = textChange;
          const parent = placement.parents.get(element)?.parent;
          const dependency = settledLayout.dependencies.find(({ element }) => element === parent);
          if (
            parent?.type !== "group" ||
            dependency?.children.length !== 1 ||
            dependency.children[0] !== element
          )
            return undefined;
          const style = (parent.props.layout?.style ?? emptyStyle) as LayoutStyle;
          const rect = settledLayout.rectangles.get(parent);
          if (!isolatedBox(style, rect)) return undefined;
          box = { input: { style, children: [textChange.input] }, rect };
        }
        for (const [font, height] of retained.fonts)
          if (!Object.is(retained.readLineHeight(font), height)) return undefined;
        return { changedBases, placement, layout: settledLayout, textChange, box, scrollChanges };
      };
      // React owns structural edits. Validate authored geometry and live fonts
      // before retaining the committed placements of a nonstructural edit.
      const settled = retainedLayout();
      const inputs = new Map<SceneTreeElement, LayoutInput>();
      const elements = new Map<LayoutInput, SceneTreeElement>();
      const styles = new Map<SceneTreeElement, LayoutStyle>();
      let scrollPositionedByYoga: Set<SceneTreeElement> | undefined;
      const preparations: Promise<void>[] = [];
      let reusableLayout = true;
      const buildChildren = (
        entry: SceneTreeElement,
        baselineAlignment: boolean,
        result: LayoutInput[] = [],
      ): LayoutInput[] => {
        for (const child of entry.children) {
          if (child.kind !== "element") continue;
          const props = child.props.layout;
          if (props?.paintWrapper) buildChildren(child, baselineAlignment, result);
          else if (!props?.decoration && !props?.resource)
            result.push(build(child, baselineAlignment));
        }
        return result;
      };
      const build = (entry: SceneTreeElement, ancestorBaseline: boolean): LayoutInput => {
        // Complex inline/raster measurement has additional run/lease dependencies.
        // Keep its existing path until separately characterized.
        if (
          entry.type === "multiStyleLabel" ||
          entry.type === "inlineText" ||
          entry.props.layout?.textRaster
        )
          reusableLayout = false;
        let style = (entry.props.layout?.style ?? {}) as LayoutStyle;
        const id = entry.props.layout?.id;
        if (typeof id === "string") {
          declarativeStyles.set(id, style);
          const dimensions = dimensionOverrides.get(id);
          if (dimensions) {
            if (!dimensions.initialized) {
              dimensions.baseline = { ...style };
              dimensions.initialized = true;
            }
            for (const name of ["width", "height"] as const)
              if (name in dimensions.values) {
                if (Object.is(style[name], dimensions.baseline[name]))
                  style = { ...style, [name]: dimensions.values[name] };
                else delete dimensions.values[name];
              }
          }
          const override = opacityOverrides.get(id);
          if (override) {
            if (!override.initialized) {
              override.baseline = style.opacity;
              override.initialized = true;
            }
            if (Object.is(style.opacity, override.baseline))
              style = { ...style, opacity: override.value };
            else opacityOverrides.delete(id);
          }
        }
        const baselineAlignment =
          ancestorBaseline || style.alignItems === "baseline" || style.alignSelf === "baseline";
        if (baselineAlignment && entry.props.layout?.scrollTranslation) {
          // Yoga can derive an ancestor's baseline from this child's position.
          const [x, y] = entry.props.layout.scrollTranslation as readonly [number, number];
          style = {
            ...style,
            ...(typeof style.left === "number" ? { left: style.left + x } : {}),
            ...(typeof style.top === "number" ? { top: style.top + y } : {}),
          };
          (scrollPositionedByYoga ??= new Set()).add(entry);
        }
        styles.set(entry, style);
        const input: LayoutInput = {
          style,
          children:
            entry.type === "label" ||
            entry.type === "multiStyleLabel" ||
            entry.type === "inlineText" ||
            entry.props.layout?.textRaster
              ? []
              : buildChildren(entry, baselineAlignment),
          ...(entry.type === "multiStyleLabel" ||
          entry.type === "inlineText" ||
          entry.props.layout?.inlineRaster
            ? {
                text: inlineTextRuns(entry)
                  .map((run) => run.text)
                  .join(""),
              }
            : entry.type === "label" || entry.props.layout?.textRaster
              ? { text: labelText(entry) }
              : {}),
        };
        inputs.set(entry, input);
        elements.set(input, entry);
        if (
          entry.type === "label" ||
          entry.type === "multiStyleLabel" ||
          entry.type === "inlineText" ||
          entry.props.layout?.textRaster
        )
          for (const fontStyle of entry.type === "multiStyleLabel" ||
          entry.type === "inlineText" ||
          entry.props.layout?.inlineRaster
            ? inlineTextRuns(entry).map((run) => run.style)
            : [style]) {
            const preparation = options.text.prepare(fontStyle);
            if (preparation) {
              preparations.push(preparation);
              // A later synchronous build failure may prevent Promise.all.
              // Keep every already-started operation observed either way.
              void preparation.catch(() => undefined);
            }
          }
        return input;
      };
      const sceneInput: LayoutInput | undefined = settled
        ? undefined
        : { style: {}, children: tree.map((entry) => build(entry, false)) };
      const styleFor = settled
        ? (entry: SceneTreeElement) => (entry.props.layout?.style ?? emptyStyle) as LayoutStyle
        : (entry: SceneTreeElement) => styles.get(entry) ?? emptyStyle;
      const finish = () => {
        if (retired || generation !== rasterGeneration)
          return new Map<SceneTreeElement, SceneFields>();
        const entries = [...inputs.entries()];
        const measured = new Set<LayoutInput>();
        const previousLayout = layoutCache;
        let changedText: LayoutInput | undefined;
        let changedTextIndex = -1;
        let severalTextChanges = false;
        const sameInputs =
          !settled &&
          reactCommit &&
          reusableLayout &&
          !preparations.length &&
          previousLayout &&
          previousLayout.width === options.viewport.width &&
          previousLayout.height === options.viewport.height &&
          entries.length === previousLayout.dependencies.length &&
          entries.every(([element, input], index) => {
            const previous = previousLayout.dependencies[index];
            if (
              input.text !== previous.text &&
              !(
                input.text !== undefined &&
                fixedLabel(previous, input.style, previousLayout.rectangles.get(element))
              )
            ) {
              severalTextChanges ||= changedText !== undefined;
              changedText = input;
              changedTextIndex = index;
            }
            return (
              element === previous.element &&
              input.children.length === previous.children.length &&
              input.children.every(
                (child, index) => elements.get(child) === previous.children[index],
              ) &&
              Object.is(element.props.layout?.numberOfLines, previous.lines) &&
              sameLayoutStyle(input.style, previous.style, element.type === "group")
            );
          });
        const reuse = (settled && !settled.textChange) || (sameInputs && !changedText);
        let measuredLabel: MeasuredLabel | undefined;
        const measure: TextMeasure = (input, width) => {
          measured.add(input);
          const element = elements.get(input)!;
          if (element.type === "inlineText")
            return layoutInlineParagraph(
              inlineTextRuns(element),
              options.text,
              width,
              Number(element.props.layout?.numberOfLines ?? 0),
            );
          if (element.type === "multiStyleLabel" || element.props.layout?.inlineRaster)
            return measureInlineText(
              inlineTextRuns(element),
              options.text,
              width,
              Number(element.props.layout?.numberOfLines ?? 0),
              element.props.layout?.inlineRaster === true,
            );
          const metrics = options.text.metrics(input.style);
          const result = layoutText(
            input.text ?? "",
            input.style,
            metrics,
            width,
            Number(element.props.layout?.numberOfLines ?? 0),
          );
          // The retained font keeps glyph widths stable. Reuse the wrapped
          // text only when Yoga commits exactly the measured constraint.
          if (input === settled?.textChange?.input)
            measuredLabel = { width, lineHeight: metrics.lineHeight, layout: result };
          return { width: result.width, height: result.height };
        };
        let isolated: IsolatedLabel | undefined;
        if (settled?.textChange && settled.box) {
          const { element, index, input } = settled.textChange;
          elements.set(input, element);
          const previous = settled.layout.rectangles.get(element)!;
          const rect =
            intrinsicLabelRect(input, previous, measure) ??
            calculateFlexLayout(settled.box.input, settled.box.rect, measure).get(input)!;
          isolated = {
            element,
            index,
            rect,
            text: input.text,
            measured: measured.has(input),
          };
        } else if (
          sameInputs &&
          options.text.preparedFieldFont &&
          changedText?.text !== undefined &&
          !severalTextChanges
        ) {
          const box = entries.find(
            ([element, input]) =>
              element.type === "group" &&
              input.children.length === 1 &&
              input.children[0] === changedText,
          );
          if (box) {
            const [element, input] = box;
            const rect = previousLayout!.rectangles.get(element);
            if (isolatedBox(input.style, rect)) {
              const solved = calculateFlexLayout(input, rect, measure);
              isolated = {
                element: elements.get(changedText)!,
                index: changedTextIndex,
                rect: solved.get(changedText)!,
                text: changedText.text,
                measured: measured.has(changedText),
              };
            }
          }
        }
        // Retain local child rectangles only for a fixed, unchanged box under
        // scroll content. Yoga still places every box in current sibling order.
        const retainFixedChildren = () => {
          const walk = committedWalk;
          const retained = walk?.retained;
          if (
            !sceneInput ||
            !reactCommit ||
            changes ||
            !reusableLayout ||
            preparations.length ||
            !previousLayout ||
            previousLayout.rectangles !== walk?.rectangles ||
            previousLayout.width !== options.viewport.width ||
            previousLayout.height !== options.viewport.height ||
            retained?.text !== options.text ||
            !hasOnlyBuiltinObjectPrototypeFields()
          )
            return undefined;
          const dependencies = new Map(
            previousLayout.dependencies.map((dep) => [dep.element, dep]),
          );
          const retainedBoxes = new Map<
            LayoutInput,
            {
              rect: LayoutRect;
              children: { input: LayoutInput; rect: LayoutRect; measured: boolean }[];
            }
          >();
          const visit = (input: LayoutInput, scroll: boolean) => {
            if (input.style.alignItems === "baseline" || input.style.alignSelf === "baseline")
              return;
            const element = elements.get(input);
            const dependency = element && dependencies.get(element);
            const rect = element && previousLayout.rectangles.get(element);
            if (
              scroll &&
              element?.type === "group" &&
              dependency &&
              rect &&
              fixedScrollBox(input, rect) &&
              input.children.length === dependency.children.length &&
              sameLayoutStyle(input.style, dependency.style, true)
            ) {
              const children = [];
              for (const [index, child] of input.children.entries()) {
                const childElement = elements.get(child)!;
                const before = dependencies.get(childElement);
                const rect = previousLayout.rectangles.get(childElement);
                if (
                  childElement !== dependency.children[index] ||
                  !before ||
                  !rect ||
                  before.children.length ||
                  before.text !== child.text ||
                  !Object.is(before.lines, childElement.props.layout?.numberOfLines) ||
                  !sameLayoutStyle(child.style, before.style, childElement.type === "group")
                )
                  break;
                children.push({ input: child, rect, measured: before.measured });
              }
              if (children.length === input.children.length) {
                retainedBoxes.set(input, { rect, children });
                return;
              }
            }
            const content = scroll || element?.props.layout?.scrollTranslation != null;
            for (const child of input.children) visit(child, content);
          };
          visit(sceneInput, false);
          if (
            retainedBoxes.size &&
            [...retained.fonts].every(([font, height]) =>
              Object.is(retained.readLineHeight(font), height),
            )
          )
            return retainedBoxes;
        };
        const retainedBoxes = reuse || isolated ? undefined : retainFixedChildren();
        let layout =
          reuse || isolated
            ? undefined
            : calculateFlexLayout(sceneInput!, options.viewport, measure, retainedBoxes);
        if (layout && retainedBoxes) {
          const solved = layout;
          if (
            [...retainedBoxes].some(([input, { rect }]) => {
              const current = solved.get(input)!;
              return current.width !== rect.width || current.height !== rect.height;
            })
          ) {
            measured.clear();
            layout = calculateFlexLayout(sceneInput!, options.viewport, measure);
          } else {
            for (const { children } of retainedBoxes.values())
              for (const child of children) {
                solved.set(child.input, child.rect);
                if (child.measured) measured.add(child.input);
              }
          }
        }
        const reusedRectangles =
          settled?.layout.rectangles ?? (reuse || isolated ? layoutCache!.rectangles : undefined);
        if (layout) {
          layoutCache = undefined;
          if (reusableLayout && !preparations.length) {
            const dependencies = entries.map(([element, input]) => ({
              element,
              style: captureLayoutStyle(input.style, element.type === "group"),
              text: input.text,
              measured: measured.has(input),
              lines: element.props.layout?.numberOfLines,
              children: input.children.map((child) => elements.get(child)!),
            }));
            if (dependencies.every((entry) => entry.style !== undefined))
              layoutCache = {
                dependencies: dependencies as LayoutDependency[],
                rectangles: new Map(entries.map(([entry, input]) => [entry, layout.get(input)!])),
                width: options.viewport.width,
                height: options.viewport.height,
              };
          }
        }
        // An isolated solve changes one label's geometry. The other rectangles
        // and field dependencies were validated against the previous layout.
        const prepareNode = preparedFields.begin(
          Boolean(reuse || isolated),
          options.text,
          isolated?.element,
        );
        const canRetainWalk = !!layoutCache && !scrollPositionedByYoga && canRetainPlacement();
        const previous =
          reusedRectangles && canRetainWalk
            ? (settled?.placement ?? placementFor(reusedRectangles))
            : undefined;
        const retainedPlacement = previous?.retained;
        const isolatedWalk = !!(
          !settled &&
          isolated &&
          retainedPlacement &&
          retainedPlacement.text === options.text &&
          [...retainedPlacement.fonts].every(([font, height]) =>
            Object.is(retainedPlacement.readLineHeight(font), height),
          )
        );
        const sparseWalk = !!settled || isolatedWalk;
        const bases = new Map<SceneTreeElement, SceneFields>();
        const invalidatedBases = sparseWalk
          ? (settled?.changedBases ?? new Set<SceneTreeElement>())
          : undefined;
        const visited = previous ? new Set<SceneTreeElement>() : undefined;
        const placementChanges = new Map<string, NativePlacement>();
        if (previous && visited && changes) {
          // A changed child's content can supply an ancestor's accessible
          // name. Include the ancestry of every changed field and host prop.
          const includeAncestry = (node: SceneTreeElement) => {
            let current: SceneTreeElement | undefined = node;
            while (current && !visited.has(current)) {
              visited.add(current);
              current = previous.parents.get(current)?.parent;
            }
          };
          if (sparseWalk) {
            // React host props are current even when a sibling keeps its rectangle.
            // Only content and paint changes need the placement walk.
            for (const node of settled?.changedBases ?? []) includeAncestry(node);
            if (settled?.scrollChanges.size)
              for (const node of settled.scrollChanges.keys()) includeAncestry(node);
            for (const [node, input] of entries) {
              const base = previous.bases.get(node);
              const opacity =
                typeof input.style.opacity === "number" ? input.style.opacity : undefined;
              const textChanged =
                node.type === "label" &&
                input.text !== preparedFields.retained(node, base)?.content;
              if (textChanged || !Object.is(opacity, base?.opacity)) {
                invalidatedBases!.add(node);
                includeAncestry(node);
              }
            }
            for (const node of changes) {
              if (
                node.props.layout === plainBackgroundLayout ||
                node.props.layout === plainImageLayout
              )
                continue;
              const layout = node.props.layout!;
              const id = layout.id as string;
              const old = placements.get(id)!;
              const accessibility = layout.accessibility as AccessibilitySemantics | undefined;
              const focusable = node.props.fields?.focusable ?? layout.focusable;
              declarativeStyles.set(id, styleFor(node));
              if (
                accessibility?.label !== old.accessibility?.label ||
                (typeof focusable === "boolean" ? focusable : undefined) !== old.focusable
              ) {
                includeAncestry(node);
              } else {
                placementChanges.set(id, {
                  ...old,
                  view: layout.view as NativePlacement["view"],
                  nativeTag: layout.nativeTag as NativePlacement["nativeTag"],
                  focusEvents: layout.focusEvents as NativePlacement["focusEvents"],
                  focusTargets: layout.focusTargets as NativePlacement["focusTargets"],
                  accessibility,
                });
              }
            }
          } else for (const node of changes) includeAncestry(node);
          if (!sparseWalk) {
            for (const [node, input] of entries) {
              // Other providers may replace fonts or change metrics without
              // a React mutation. Validate their normal field plans.
              const fields = prepareNode(
                node,
                input.style,
                node === isolated?.element ? isolated.rect : reusedRectangles!.get(node)!,
                input.text,
              );
              bases.set(node, fields);
              if (fields !== previous.bases.get(node)) includeAncestry(node);
            }
          }
        }
        // A settled walk writes only visited fields. The renderer uses the
        // already-committed map for the rest and publishes its delta after writes.
        let fieldBase = sparseWalk ? previous?.fields : undefined;
        let fields = new Map<SceneTreeElement, SceneFields>(
          fieldBase ? undefined : previous?.fields,
        );
        const originalPlacements = sparseWalk ? placements : undefined;
        let next = sparseWalk
          ? placementChanges
          : new Map<string, NativePlacement>(previous ? placements : undefined);
        let modal: { id: string; paintPath: readonly number[] } | undefined;
        const references: string[] = [];
        const paintedAbove = (left: readonly number[], right: readonly number[]) => {
          for (let index = 0; index < Math.min(left.length, right.length); index++) {
            const difference = left[index] - right[index];
            if (!Number.isNaN(difference) && difference !== 0) return difference > 0;
          }
          return left.length >= right.length;
        };
        // A changed child already marks its ancestry for placement. Recompute
        // text on that path and reuse the committed contribution of other children.
        const contentLabels = canRetainWalk
          ? new Map<SceneTreeElement, string>(sparseWalk ? undefined : previous?.contentLabels)
          : undefined;
        if (!sparseWalk && visited && contentLabels)
          for (const node of visited) contentLabels.delete(node);
        const readContentText = (entry: SceneTreeElement): string => {
          if (
            entry.hidden ||
            entry.props.layout?.accessibilityElementsHidden ||
            entry.props.layout?.importantForAccessibility === "no-hide-descendants"
          )
            return "";
          const authored = entry.props.layout?.accessibility as AccessibilitySemantics | undefined;
          if (authored?.label !== undefined) return authored.label;
          const scalar = entry.props.layout?.scalarText;
          if (typeof scalar === "string") return scalar.trim();
          return entry.children
            .map((child) =>
              child.kind === "text" ? (child.hidden ? "" : child.text) : contentText(child),
            )
            .join(" ")
            .trim();
        };
        const contentText = (entry: SceneTreeElement): string => {
          const retained =
            contentLabels?.get(entry) ??
            (sparseWalk && !visited?.has(entry) ? previous?.contentLabels.get(entry) : undefined);
          if (retained !== undefined) return retained;
          const text = readContentText(entry);
          contentLabels?.set(entry, text);
          return text;
        };
        const rasters: Promise<void>[] = [];
        const callbacks: LayoutDelivery[] = [];
        let lastBackground: SceneFields | undefined;
        // A retained scroll changes world coordinates without changing the
        // descendants' local fields, accessibility relationships or layout.
        const relocate = (entry: SceneTreeElement, parentWorld: Affine) => {
          if (
            entry.props.layout === plainBackgroundLayout ||
            entry.props.layout === plainImageLayout
          )
            return;
          const id = entry.props.layout!.id as string;
          const placement = next.get(id) ?? originalPlacements!.get(id)!;
          const world = sceneWorld(parentWorld, previous!.fields.get(entry)!);
          next.set(id, {
            ...placement,
            world,
            global: affineBounds(world, placement.local.width, placement.local.height),
          });
          for (const child of entry.children) if (child.kind === "element") relocate(child, world);
        };
        const walk = (
          entry: SceneTreeElement,
          parentWorld: Affine,
          parent?: LayoutRect,
          parentAccessibilityHidden = false,
          parentPointerHidden = false,
          parentID?: string,
          parentPaintPath: readonly number[] = [],
          siblingIndex = 0,
          parentVisible = true,
          scrolled = false,
        ) => {
          if (visited && !visited.has(entry)) {
            if (scrolled) relocate(entry, parentWorld);
            return;
          }
          if (
            parent &&
            entry.type === "rectangle" &&
            entry.props.layout === plainBackgroundLayout &&
            entry.children.length === 0 &&
            typeof entry.props.fields?.focusable !== "boolean"
          ) {
            const width = Math.max(0, parent.width),
              height = Math.max(0, parent.height);
            if (
              !lastBackground ||
              lastBackground.width !== width ||
              lastBackground.height !== height
            )
              lastBackground = nativeNodeFields(
                entry,
                {},
                { x: 0, y: 0, width, height },
                options.text,
              );
            fields.set(entry, lastBackground);
            return;
          }
          // SceneGraph sorts siblings by z-index, then authored order. A child
          // paints within its parent's position, not at a global z-index.
          const paintPath = [...parentPaintPath, Number(styleFor(entry).zIndex ?? 0), siblingIndex];
          const id = entry.props.layout?.id;
          const declared = {
            pointerEvents: entry.props.layout?.pointerEvents as string | undefined,
            importantForAccessibility: entry.props.layout?.importantForAccessibility as
              string | undefined,
            accessibilityElementsHidden: entry.props.layout?.accessibilityElementsHidden as
              boolean | undefined,
          };
          const override = typeof id === "string" ? presentationOverrides.get(id) : undefined;
          if (override && !override.initialized) {
            override.baseline = { ...declared };
            override.initialized = true;
          }
          if (typeof id === "string") declarativePresentation.set(id, declared);
          if (override)
            for (const key of [
              "pointerEvents",
              "importantForAccessibility",
              "accessibilityElementsHidden",
            ] as const)
              if (!Object.is(declared[key], override.baseline[key])) delete override.values[key];
          const presentation = override?.values;
          const importance =
            presentation?.importantForAccessibility ?? declared.importantForAccessibility;
          const pointerEvents =
            presentation?.pointerEvents ??
            (entry.props.layout?.pointerEvents as string | undefined);
          const pointerHidden =
            parentPointerHidden || pointerEvents === "none" || pointerEvents === "box-none";
          const pointerChildrenHidden =
            parentPointerHidden || pointerEvents === "none" || pointerEvents === "box-only";
          const visible =
            parentVisible && entry.hidden !== true && styleFor(entry).display !== "none";
          const hideDescendants =
            parentAccessibilityHidden ||
            !visible ||
            importance === "no-hide-descendants" ||
            (presentation?.accessibilityElementsHidden ?? declared.accessibilityElementsHidden) ===
              true;
          const decoration = entry.props.layout?.decoration;
          const thickness = Math.min(
            Number(entry.props.layout?.thickness ?? 0),
            decoration === "Top" || decoration === "Bottom"
              ? (parent?.height ?? 0)
              : (parent?.width ?? 0),
          );
          const border = decoration === "surface" ? Number(entry.props.layout?.border ?? 0) : 0;
          const solvedRect =
            entry.props.layout?.resource && parent
              ? { x: 0, y: 0, width: parent.width, height: parent.height }
              : decoration && parent
                ? {
                    x: decoration === "Right" ? parent.width - thickness : border,
                    y: decoration === "Bottom" ? parent.height - thickness : border,
                    width:
                      decoration === "Left" || decoration === "Right"
                        ? thickness
                        : Math.max(0, parent.width - 2 * border),
                    height:
                      decoration === "Top" || decoration === "Bottom"
                        ? thickness
                        : Math.max(0, parent.height - 2 * border),
                  }
                : entry === isolated?.element
                  ? isolated.rect
                  : reusedRectangles
                    ? reusedRectangles.get(entry)!
                    : layout!.get(inputs.get(entry)!)!;
          const focusable = entry.props.fields?.focusable ?? entry.props.layout?.focusable;
          const base =
            bases.get(entry) ??
            (sparseWalk && !invalidatedBases?.has(entry)
              ? previous?.bases.get(entry)
              : undefined) ??
            prepareNode(
              entry,
              styleFor(entry),
              solvedRect,
              settled && entry.type === "label" ? labelText(entry) : inputs.get(entry)?.text,
              entry === settled?.textChange?.element ? measuredLabel : undefined,
            );
          if (canRetainWalk) bases.set(entry, base);
          const native: Record<string, SceneValue> = {
            ...base,
            ...(typeof focusable === "boolean" ? { focusable } : {}),
          };
          const scrollTranslation = entry.props.layout?.scrollTranslation as
            readonly [number, number] | undefined;
          let rect = solvedRect;
          if (
            scrollTranslation &&
            visible &&
            !scrollPositionedByYoga?.has(entry) &&
            (scrollTranslation[0] || scrollTranslation[1])
          ) {
            const [x, y] = scrollTranslation;
            rect = {
              ...solvedRect,
              x: Math.fround(solvedRect.x + Math.fround(x)),
              y: Math.fround(solvedRect.y + Math.fround(y)),
            };
            const translation = native.translation as readonly number[];
            native.translation = [
              translation[0] + (rect.x - solvedRect.x),
              translation[1] + (rect.y - solvedRect.y),
            ];
          }
          if (entry.type === "inlineText")
            inlineLines.set(
              entry,
              nativeInlineTextLines(entry, styleFor(entry), rect, options.text),
            );
          // Measurements describe the semantic view's transformed bounds, not
          // a text raster's extra shadow pixels or a mask's internal geometry.
          const world = sceneWorld(parentWorld, native);
          if (
            entry.type !== "multiStyleLabel" &&
            entry.type !== "inlineText" &&
            entry.props.layout?.textRaster &&
            rect.width > 0 &&
            rect.height > 0
          ) {
            if (!options.textRaster)
              throw new RokuHostError(
                "C04_TEXT_RASTER",
                "Tracked/shadowed text requires an installed raster provider",
              );
            const style = styleFor(entry),
              metrics = options.text.metrics(style);
            const value = layoutText(
              inputs.get(entry)?.text ?? "",
              style,
              metrics,
              rect.width,
              Number(entry.props.layout?.numberOfLines ?? 0),
            );
            const preparation = (
              entry.props.layout?.inlineRaster
                ? (() => {
                    if (!options.textRaster!.acquireInline)
                      throw new RokuHostError(
                        "C04_INLINE_RASTER",
                        "Mixed tracking requires the inline raster port",
                      );
                    return options.textRaster!.acquireInline({
                      width: rect.width,
                      height: rect.height,
                      runs: inlineTextRuns(entry).map((run) => ({
                        ...run,
                        style: {
                          ...run.style,
                          fontFamily:
                            options.text.fontFamily?.(run.style) ??
                            run.style.fontFamily ??
                            "RokuDefault",
                        },
                        metrics: options.text.metrics(run.style),
                      })),
                    });
                  })()
                : options.textRaster.acquire({
                    style: {
                      ...style,
                      fontFamily:
                        options.text.fontFamily?.(style) ?? style.fontFamily ?? "RokuDefault",
                    },
                    metrics,
                    layout: value,
                    width: rect.width,
                    height: rect.height,
                  })
            ).then((lease) => {
              if (preparationFailed || retired || generation !== rasterGeneration) {
                lease.release();
                return;
              }
              retained.add(lease);
              preparingRasters.add(lease);
              native.uri = lease.image.uri;
              native.loadDisplayMode = "scaleToFill";
              native.width = lease.image.width;
              native.height = lease.image.height;
              const translation = native.translation as number[];
              native.translation = [
                translation[0] - lease.image.inset,
                translation[1] - lease.image.inset,
              ];
              if (native.scaleRotateCenter)
                native.scaleRotateCenter = (native.scaleRotateCenter as number[]).map(
                  (value) => value + lease.image.inset,
                );
              if (native.clippingRect)
                native.clippingRect = [
                  lease.image.inset,
                  lease.image.inset,
                  rect.width,
                  rect.height,
                ];
            });
            rasters.push(preparation);
            // A later walk failure can bypass the normal raster join.
            void preparation.catch(() => undefined);
          }
          if (entry.type === "effect" && entry.props.layout?.radiusStyle) {
            const inset = Number(entry.props.layout?.insetBorder ?? 0);
            native.borderRadius = surfaceRadii(
              entry.props.layout.radiusStyle as LayoutStyle,
              rect.width + 2 * inset,
              rect.height + 2 * inset,
            ).map((radius) => Math.max(0, radius - inset));
          }
          if (entry.type === "effect" && entry.props.layout?.gradient)
            Object.assign(
              native,
              gradientFields(entry.props.layout.gradient as GradientSpec, rect.width, rect.height),
            );
          if (entry.type === "maskGroup" && parent && entry.props.layout?.composedMask) {
            const provider = options.textRaster;
            if (!provider?.acquirePixels)
              throw new RokuHostError(
                "C03_ROUNDED_CLIP",
                "Rounded clipping requires a native bitmap provider",
              );
            const mask = roundedMask(
              entry.props.layout.radiusStyle as LayoutStyle,
              rect.width,
              rect.height,
            );
            const preparation = provider.acquirePixels(mask).then((lease) => {
              if (preparationFailed || retired || generation !== rasterGeneration) {
                lease.release();
                return;
              }
              retained.add(lease);
              preparingRasters.add(lease);
              native.maskUri = lease.image.uri;
              native.maskSize = [rect.width, rect.height];
            });
            rasters.push(preparation);
            void preparation.catch(() => undefined);
          }
          if (entry.type === "maskGroup" && parent && entry.props.layout?.corner != null) {
            const corner = Number(entry.props.layout?.corner),
              radius = surfaceRadii(
                entry.props.layout?.radiusStyle as LayoutStyle,
                rect.width,
                rect.height,
              )[corner];
            native.maskSize = [(257 * radius) / 256, (257 * radius) / 256];
            native.maskOffset = [
              corner === 1 || corner === 2 ? rect.width - radius : 0,
              corner === 2 || corner === 3 ? rect.height - radius : 0,
            ];
            // A zero-radius corner samples the opaque clamped half-plane.
            // Keep its bitmap loaded so later radius changes preserve readiness.
            if (!radius)
              native.maskOffset = [
                corner === 1 || corner === 2 ? rect.width + 257 : -rect.width - 257,
                corner === 2 || corner === 3 ? rect.height + 257 : -rect.height - 257,
              ];
          }
          if (entry.props.layout?.maskReadiness != null)
            native.visible = entry.props.layout.maskReadiness === true;
          // pointerEvents controls touch hit testing, not non-touch/TV focus.
          if (!visible && native.focusable === true) native.focusable = false;
          fields.set(entry, native);
          if (typeof id === "string") {
            const global = affineBounds(world, rect.width, rect.height);
            const existing = next.get(id) ?? originalPlacements?.get(id);
            if (existing && (!previous || existing.handle !== entry.handle))
              throw new RokuHostError("C03_VIEW_ID", `Duplicate native view identity ${id}`);
            const accessibility = entry.props.layout?.accessibility as
              AccessibilitySemantics | undefined;
            if (
              accessibility &&
              (accessibility.labelledBy.length || accessibility.describedBy.length)
            )
              references.push(id);
            if (accessibility?.modal && !hideDescendants && !entry.hidden) {
              if (!modal || paintedAbove(paintPath, modal.paintPath)) modal = { id, paintPath };
            }
            next.set(id, {
              parentID,
              visible,
              modalBlocked: false,
              focusable: typeof native.focusable === "boolean" ? native.focusable : undefined,
              view: entry.props.layout?.view as NativePlacement["view"],
              focusEvents: entry.props.layout?.focusEvents as NativePlacement["focusEvents"],
              local: rect,
              global,
              accessibilityHidden:
                entry.hidden ||
                hideDescendants ||
                importance === "no" ||
                entry.props.layout?.accessible === false,
              accessibility,
              accessibilityLabel: accessibility?.label ?? contentText(entry),
              pointerEvents: pointerHidden ? "none" : pointerEvents,
              world,
              handle: entry.handle,
              node: entry,
              nativeTag: entry.props.layout?.nativeTag as number | undefined,
              focusTargets: entry.props.layout?.focusTargets as NativePlacement["focusTargets"],
            });
            const callback = entry.props.layout?.onLayout;
            if (typeof callback === "function")
              callbacks.push({
                id,
                rect,
                callback: callback as (event: unknown) => void,
              });
          }
          if (
            entry.type !== "label" &&
            entry.type !== "multiStyleLabel" &&
            entry.type !== "inlineText" &&
            !entry.props.layout?.textRaster
          )
            for (const [index, child] of entry.children.entries())
              if (child.kind === "element")
                walk(
                  child,
                  world,
                  rect,
                  hideDescendants,
                  pointerChildrenHidden,
                  typeof id === "string" ? id : parentID,
                  paintPath,
                  index,
                  visible,
                  scrolled || settled?.scrollChanges.has(entry),
                );
        };
        for (const [index, entry] of tree.entries())
          walk(entry, identityAffine, undefined, false, false, undefined, [], index);
        const inside = (id: string, ancestor: string): boolean => {
          let current: string | undefined = id;
          while (current !== undefined) {
            if (current === ancestor) return true;
            current = next.get(current)?.parentID;
          }
          return false;
        };
        // Cross-tree accessibility passes use the complete proposed layout.
        const local = !!originalPlacements && !modal && references.length === 0;
        if (originalPlacements && !local) {
          const complete = new Map(originalPlacements);
          for (const [id, placement] of next) complete.set(id, placement);
          next = complete;
        }
        if (modal) {
          const scopeAncestors = new Set<string>();
          for (let id = next.get(modal.id)?.parentID; id !== undefined; id = next.get(id)?.parentID)
            scopeAncestors.add(id);
          for (const [id, placement] of next) {
            if (inside(id, modal.id)) continue;
            next.set(id, {
              ...placement,
              accessibilityHidden: true,
              modalBlocked: true,
              containsActiveModalScope: scopeAncestors.has(id),
              pointerEvents: "none",
            });
          }
        }
        // Resolve against one fully exposed, unmodified snapshot. Following a
        // referenced node's own labelled-by again would chain cycles and make
        // names depend on native tree order. Hidden/modal-excluded sources keep
        // the host's explicit exposure boundary, independently of HTML naming.
        if (references.length) {
          const labelSources = new Map(
            [...next].flatMap(([id, placement]) =>
              !placement.accessibilityHidden
                ? [[id, placement.accessibilityLabel ?? ""] as const]
                : [],
            ),
          );
          for (const id of references) {
            const placement = next.get(id)!;
            const labels = placement.accessibility?.labelledBy.flatMap((target) => {
              const label = labelSources.get(target);
              return label ? [label] : [];
            });
            if (labels?.length)
              next.set(id, {
                ...placement,
                accessibilityLabel: labels.join(" "),
                accessibility: { ...placement.accessibility!, label: labels.join(" ") },
              });
            const descriptions = placement.accessibility?.describedBy.flatMap((target) => {
              const value = labelSources.get(target);
              return value === undefined ? [] : [value];
            });
            if (descriptions?.length) {
              const current = next.get(id)!;
              next.set(id, {
                ...current,
                accessibility: { ...current.accessibility!, hint: descriptions.join(" ").trim() },
              });
            }
          }
        }
        if (fieldBase && modal) {
          const complete = new Map(fieldBase);
          for (const [entry, native] of fields) complete.set(entry, native);
          fields = complete;
          fieldBase = undefined;
        }
        if (modal)
          for (const [entry, native] of fields) {
            const id = entry.props.layout?.id;
            if (typeof id === "string" && !inside(id, modal.id) && native.focusable === true)
              fields.set(entry, { ...native, focusable: false });
          }
        pending.set(tree, { entries: next, local, isolated });
        deliveries.set(tree, callbacks);
        if (rasters.length) return Promise.all(rasters).then(() => fields);
        if (canRetainWalk) {
          const parents =
            previous?.parents ?? indexPlacementParents(fields, !!options.text.preparedFieldFont);
          if (parents)
            placementWalks.set(tree, {
              rectangles: layoutCache!.rectangles,
              callbacks,
              fields: fieldBase ?? fields,
              bases: sparseWalk ? previous!.bases : bases,
              parents,
              contentLabels: sparseWalk ? previous!.contentLabels : contentLabels!,
              local: sparseWalk
                ? {
                    bases,
                    labels: contentLabels!,
                    visited: visited!,
                    scrollChanges: settled?.scrollChanges,
                  }
                : undefined,
              retained: sparseWalk
                ? previous?.retained
                : retainPlacementInputs(
                    layoutCache!.dependencies,
                    bases,
                    preparedFields,
                    options.text,
                  ),
            });
        }
        if ((reuse || sparseWalk) && changes) reuseSceneGeometry(fields, fieldBase);
        return fields;
      };
      try {
        const prepared = preparations.length ? Promise.all(preparations).then(finish) : finish();
        return prepared instanceof Promise ? prepared.catch(failPreparation) : prepared;
      } catch (error) {
        return failPreparation(error);
      }
    },
    afterCommit(tree) {
      committedWalk = placementWalks.get(tree);
      // A discarded or failed native commit never updates the committed layout.
      if (committedWalk?.local) {
        const { bases, labels, visited, scrollChanges } = committedWalk.local;
        if (scrollChanges)
          for (const [node, scroll] of scrollChanges)
            Object.assign(committedWalk.parents.get(node)!, scroll);
        for (const [node, fields] of bases) committedWalk.bases.set(node, fields);
        for (const node of visited) committedWalk.contentLabels.delete(node);
        for (const [node, label] of labels) committedWalk.contentLabels.set(node, label);
        committedWalk.local = undefined;
      }
      committedRasterGeneration = rasterGeneration;
      const retained = rasterLeases.get(tree) ?? new Set<TextRasterLease>();
      for (const lease of committedRasters) lease.release();
      committedRasters = retained;
      for (const lease of retained) preparingRasters.delete(lease);
      const update = pending.get(tree);
      if (update?.isolated && layoutCache) {
        const { element, index, rect, text, measured } = update.isolated;
        layoutCache.rectangles.set(element, rect);
        layoutCache.dependencies[index] = { ...layoutCache.dependencies[index], text, measured };
      }
      let rebuildTags = true;
      if (update?.local) {
        rebuildTags = false;
        for (const [id, placement] of update.entries) {
          if (placements.get(id)?.nativeTag !== placement.nativeTag) rebuildTags = true;
          placements.set(id, placement);
        }
      } else placements = update?.entries ?? new Map();
      for (const [id, previous] of liveSpeech)
        if (placements.get(id)?.handle !== previous.handle) liveSpeech.delete(id);
      if (lastFocusSpeech && placements.get(lastFocusSpeech.id)?.handle !== lastFocusSpeech.handle)
        lastFocusSpeech = undefined;
      for (const [id, previous] of deliveredLayouts)
        if (placements.get(id)?.handle !== previous.handle) deliveredLayouts.delete(id);
      if (rebuildTags)
        placedTags = new Map(
          [...placements].flatMap(([id, placement]) =>
            placement.nativeTag == null ? [] : [[placement.nativeTag, id] as const],
          ),
        );
      for (const id of focusOverrides.keys()) if (!placements.has(id)) focusOverrides.delete(id);
      for (const map of [
        opacityOverrides,
        dimensionOverrides,
        presentationOverrides,
        declarativeStyles,
        declarativePresentation,
      ])
        for (const id of map.keys()) if (!placements.has(id)) map.delete(id);
      const generation = ++publication;
      const callbacks = deliveries.get(tree) ?? [];
      layoutDelivery = Promise.resolve()
        .then(() => {
          if (retired || generation !== publication) return;
          options.input?.reconcileTargets();
          if (retired || generation !== publication) return;
          const focused = options.input?.focusedID;
          if (focused && lastFocusSpeech?.id === focused) speak(focused);
          for (const [id, placement] of placements) {
            if (retired || generation !== publication) return;
            const semantics = placement.accessibility;
            if (
              id === focused ||
              !semantics ||
              semantics.live === "none" ||
              semantics.state.busy ||
              placement.accessibilityHidden
            )
              continue;
            // Live de-duplication is independent of focus de-duplication, even
            // when an assertive update interrupts the speech queue.
            const message = accessibilitySpeech(semantics, placement.accessibilityLabel);
            const previous = liveSpeech.get(id);
            if (
              !message ||
              (previous?.handle === placement.handle && previous.text === message) ||
              !systemAllowsInput() ||
              options.system?.getSnapshot().screenReader !== true
            )
              continue;
            options.system.announceForAccessibility(message, {
              queue: semantics.live === "polite",
            });
            // Native ports may synchronously retire or replace this committed
            // tree. Its remaining regions and de-duplication state then retire.
            if (retired || generation !== publication) return;
            liveSpeech.set(id, { handle: placement.handle, text: message });
          }
          for (const { id, rect, callback } of callbacks) {
            if (retired || generation !== publication) return;
            const old = deliveredLayouts.get(id)?.local;
            if (!sameRect(old, rect)) {
              deliveredLayouts.set(id, placements.get(id)!);
              root.runSync(() =>
                callback({
                  nativeEvent: {
                    layout: {
                      x: rect.x,
                      y: rect.y,
                      width: rect.width,
                      height: rect.height,
                    },
                  },
                }),
              );
            }
          }
        })
        .catch((error) => {
          options.onError?.(error instanceof Error ? error : new Error(String(error)), "uncaught");
          throw error;
        });
      void layoutDelivery.catch(() => undefined);
    },
  });
  const releaseEnvironment = bindNativeEnvironment(options);
  let releaseInput: (() => void) | undefined;
  let releaseNavigation: (() => void) | undefined;
  try {
    releaseInput = options.input?.bindRenderer(root.runSync);
    releaseNavigation = options.input?.bindNavigation((direction) => {
      const id = options.input?.navigationFocusID;
      if (!id || !options.input?.isTargetEnabled(id)) return false;
      const placement = placements.get(id),
        overrides = focusOverrides.get(id);
      const tag =
        overrides && Object.hasOwn(overrides, direction)
          ? overrides[direction]
          : placement?.focusTargets?.[direction];
      if (tag === null) return true;
      if (tag === undefined) {
        if (!placement) return false;
        const target = directionalFocusTarget(
          placement.global,
          direction,
          placements,
          (candidate) => candidate !== id && options.input?.isTargetEnabled(candidate) === true,
        );
        if (!target) return false;
        host.requestFocus(target, undefined, undefined, "directional");
        return true;
      }
      const target = placedTags.get(tag);
      if (!target || !options.input?.isTargetEnabled(target)) return false;
      if (target !== id) host.requestFocus(target, undefined, undefined, "directional");
      return true;
    });
  } catch (error) {
    releaseInput?.();
    releaseNavigation?.();
    releaseEnvironment();
    throw error;
  }
  const syncActivity = () => {
    const active = systemAllowsInput();
    if (!active) admittedFocusRequest = ++focusRequest;
    options.input?.setActive(active);
  };
  syncActivity();
  const releaseActivity = options.system?.subscribe((event) => {
    if (event.type === "appState") syncActivity();
  });
  return {
    render(element: ReactNode) {
      root.render(createElement(NativeHostContext.Provider, { value: host }, element));
    },
    runSync: root.runSync,
    flush: root.flush,
    refreshNative: root.refreshNative,
    whenCommitted: whenNativeCommitted,
    portal: root.portal,
    unmount() {
      if (unmounting || (retired && pendingCleanup.size === 0)) return;
      unmounting = true;
      const failures: unknown[] = [];
      const attempt = (work: () => void, retain = true) => {
        try {
          work();
          pendingCleanup.delete(work);
        } catch (error) {
          failures.push(error);
          if (retain) pendingCleanup.add(work);
        }
      };
      try {
        if (!retired) {
          // Revoke host authority before React cleanup can reenter retirement.
          // The renderer owns its one unmount attempt; provider/resource cleanup
          // remains independently retryable if that attempt reports an error.
          retired = true;
          publication++;
          admittedFocusRequest = ++focusRequest;
          rasterGeneration++;
          attempt(() => root.unmount(), false);
          if (releaseInput) pendingCleanup.add(releaseInput);
          if (releaseNavigation) pendingCleanup.add(releaseNavigation);
          if (releaseActivity) pendingCleanup.add(releaseActivity);
          pendingCleanup.add(releaseEnvironment);
          placements.clear();
          layoutCache = undefined;
          placedTags.clear();
          focusOverrides.clear();
          opacityOverrides.clear();
          dimensionOverrides.clear();
          presentationOverrides.clear();
          declarativePresentation.clear();
          declarativeStyles.clear();
          deliveredLayouts.clear();
          liveSpeech.clear();
          lastFocusSpeech = undefined;
          pendingCleanup.add(() => options.text.dispose?.());
          pendingCleanup.add(() => {
            const errors: unknown[] = [];
            for (const lease of new Set([...committedRasters, ...preparingRasters])) {
              try {
                lease.release();
                committedRasters.delete(lease);
                preparingRasters.delete(lease);
              } catch (error) {
                errors.push(error);
              }
            }
            if (errors.length) throw errors[0];
          });
          pendingCleanup.add(() => options.textRaster?.dispose());
        }
        // One failing owner cannot prevent another owner from retiring. Only
        // failed actions remain for a later unmount() call; successful cleanup
        // is never replayed, including during reentrant provider callbacks.
        for (const work of [...pendingCleanup]) attempt(work);
      } finally {
        unmounting = false;
      }
      if (failures.length) throw failures[0];
    },
    get mounted() {
      return root.mounted;
    },
  };
}
