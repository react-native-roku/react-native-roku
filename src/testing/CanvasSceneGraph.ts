import { RokuHostError, type SceneNodeRef, type SceneValue } from "../scene/sceneGraph.types";
import { FontResources, type FontResourcesOptions } from "../layout/FontResources";
import { RecordingSceneGraph, type RecordedSceneNode } from "./RecordingSceneGraph";
import { TextRasterCache } from "../graphics/TextRasterCache";
import { encodeBase64 } from "../services/base64";
import type { TextMetricProvider } from "../layout/textLayout";
export { createCanvasTextEntry, type CanvasTextEntryPort } from "./CanvasTextEntry";
export { createCanvasFontRegistry } from "./CanvasResources";
export { observePreviewText } from "./PreviewTextObservations";

export interface CanvasFactory {
  image(): HTMLImageElement;
  canvas(width: number, height: number): HTMLCanvasElement;
  uri(uri: string): string;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
}
const browserFactory: CanvasFactory = {
  image: () => new globalThis.Image(),
  canvas(width, height) {
    const value = document.createElement("canvas");
    value.width = width;
    value.height = height;
    return value;
  },
  uri: (uri) => (uri.startsWith("pkg:/images/") ? `/assets/${uri.slice(12)}` : uri),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
};

function color(value: unknown): string {
  if (typeof value !== "string" || !/^0x[\da-f]{8}$/i.test(value))
    throw new RokuHostError("PREVIEW_COLOR", `Unrecognized SceneGraph color ${String(value)}`);
  return `#${value.slice(2)}`;
}

function releaseBitmap(image?: HTMLImageElement): void {
  if (!image) return;
  image.onload = null;
  image.onerror = null;
  image.removeAttribute("src");
}

/** A visual host harness using the same React and Yoga renderer. It is not a Roku emulator. */
export class CanvasSceneGraph extends RecordingSceneGraph {
  readonly focusRequests: string[] = [];
  focusRequestSequence = 0;
  private animationFrame: number | undefined;
  private disposed = false;
  private readonly images = new Map<
    number,
    {
      image: HTMLImageElement;
      ready: boolean;
      failed?: boolean;
      tint?: string;
      tinted?: HTMLCanvasElement;
    }
  >();
  private readonly maskLoads = new Map<number, HTMLImageElement>();
  readonly context: CanvasRenderingContext2D;
  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly factory: CanvasFactory = browserFactory,
  ) {
    super();
    const context = canvas.getContext("2d");
    if (!context) throw new RokuHostError("PREVIEW_CANVAS", "A Canvas 2D context is required");
    this.context = context;
  }
  override batch(work: () => void): void {
    super.batch(work);
    // Recording is bounded in a long-running interactive preview.
    this.operations.length = 0;
    if (this.animationFrame === undefined && !this.disposed)
      this.animationFrame = this.factory.requestFrame(() => {
        this.animationFrame = undefined;
        this.draw();
      });
  }
  override set(ref: SceneNodeRef, field: string, value: SceneValue): void {
    super.set(ref, field, value);
    if (field === "gainFocus" && value === true) {
      const id = this.nodes.get(ref.id)?.fields.id;
      if (typeof id === "string") {
        this.focusRequests.push(id);
        this.focusRequestSequence++;
        if (this.focusRequests.length > 100) this.focusRequests.shift();
      }
    }
    if (ref.type === "maskGroup" && field === "maskUri") {
      releaseBitmap(this.maskLoads.get(ref.id));
      this.maskLoads.delete(ref.id);
      if (value) {
        const image = this.factory.image();
        this.maskLoads.set(ref.id, image);
        image.onload = () => {
          // Cached host decoders may invoke onload synchronously. Native bridge
          // observations arrive after the transaction, once its nodes are live.
          queueMicrotask(() => {
            if (this.disposed || this.maskLoads.get(ref.id) !== image || !this.nodes.has(ref.id))
              return;
            this.emit(ref, "maskBitmapWidth", image.naturalWidth);
            this.emit(ref, "maskBitmapHeight", image.naturalHeight);
            this.batch(() => {});
          });
        };
        image.src = this.factory.uri(String(value));
      }
    }
    if (ref.type !== "poster" || field !== "uri") return;
    releaseBitmap(this.images.get(ref.id)?.image);
    this.images.delete(ref.id);
    if (!value) return;
    const image = this.factory.image(),
      entry = { image, ready: false, failed: false };
    this.images.set(ref.id, entry);
    image.onload = () => {
      queueMicrotask(() => {
        if (this.disposed || this.images.get(ref.id) !== entry || !this.nodes.has(ref.id)) return;
        entry.ready = true;
        this.emit(ref, "bitmapWidth", image.naturalWidth);
        this.emit(ref, "bitmapHeight", image.naturalHeight);
        this.emit(ref, "loadStatus", "ready");
        this.batch(() => {});
      });
    };
    image.onerror = () => {
      queueMicrotask(() => {
        entry.failed = true;
        if (!this.disposed && this.images.get(ref.id) === entry)
          this.emit(ref, "loadStatus", "failed");
      });
    };
    image.src = this.factory.uri(String(value ?? ""));
  }
  override remove(parent: SceneNodeRef, child: SceneNodeRef): void {
    const retire = (node: RecordedSceneNode) => {
      releaseBitmap(this.images.get(node.id)?.image);
      releaseBitmap(this.maskLoads.get(node.id));
      this.images.delete(node.id);
      this.maskLoads.delete(node.id);
      node.children.forEach(retire);
    };
    const node = this.nodes.get(child.id);
    if (node) retire(node);
    super.remove(parent, child);
  }
  fontDescription(ref: SceneNodeRef) {
    const font = this.nodes.get(ref.id);
    if (!font || font !== ref)
      throw new RokuHostError("STALE_NODE", "The preview font was retired");
    // A font family identifies the asset, while size remains a separate Canvas
    // property. Stable names avoid re-registering the same font for every root
    // and every text size in sustained host qualification.
    let hash = 2166136261;
    for (const character of String(font.fields.uri))
      hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return {
      family: `react-native-roku-font-${(hash >>> 0).toString(36)}`,
      size: Number(font.fields.size),
    };
  }
  imageDiagnostics() {
    return [...this.images].map(([id, entry]) => ({
      id,
      uri: String(this.nodes.get(id)?.fields.uri ?? "").startsWith("data:")
        ? "data:image/[generated raster]"
        : String(this.nodes.get(id)?.fields.uri ?? ""),
      status: entry.failed ? "failed" : entry.ready ? "ready" : "loading",
      width: entry.image.naturalWidth,
      height: entry.image.naturalHeight,
    }));
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.images.values()) releaseBitmap(entry.image);
    for (const image of this.maskLoads.values()) releaseBitmap(image);
    this.images.clear();
    this.maskLoads.clear();
    if (this.animationFrame !== undefined) this.factory.cancelFrame(this.animationFrame);
  }
  draw() {
    const ctx = this.context;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const visit = (node: RecordedSceneNode, ctx = this.context) => {
      const fields = node.fields;
      if (fields.visible === false) return;
      ctx.save();
      const translation = fields.translation as number[] | undefined,
        scale = fields.scale as number[] | undefined,
        center = fields.scaleRotateCenter as number[] | undefined;
      if (translation) ctx.translate(translation[0], translation[1]);
      if (center) ctx.translate(center[0], center[1]);
      if (typeof fields.rotation === "number") ctx.rotate(fields.rotation);
      if (scale) ctx.scale(scale[0], scale[1]);
      if (center) ctx.translate(-center[0], -center[1]);
      if (typeof fields.opacity === "number") ctx.globalAlpha *= fields.opacity;
      if (Array.isArray(fields.clippingRect)) {
        const clip = fields.clippingRect as number[];
        ctx.beginPath();
        ctx.rect(clip[0], clip[1], clip[2], clip[3]);
        ctx.clip();
      }
      if (
        node.type === "maskGroup" &&
        fields.maskUri &&
        (fields.maskSize as number[] | undefined)?.[0]
      ) {
        const size = fields.maskSize as number[],
          offset = fields.maskOffset as number[],
          radius = (size[0] * 256) / 257;
        const corner = /corner-(\d)\.png$/.exec(String(fields.maskUri));
        if (!corner) {
          const image = this.maskLoads.get(node.id);
          if (image?.naturalWidth && image.naturalHeight) {
            const surface = this.factory.canvas(image.naturalWidth, image.naturalHeight);
            const layer = surface.getContext("2d")!;
            layer.scale(image.naturalWidth / size[0], image.naturalHeight / size[1]);
            for (const child of node.children) visit(child, layer);
            layer.globalCompositeOperation = "destination-in";
            layer.drawImage(image, 0, 0, size[0], size[1]);
            ctx.drawImage(surface, 0, 0, size[0], size[1]);
          }
          ctx.restore();
          return;
        }
        const index = Number(corner[1]),
          extent = 100_000,
          left = index === 1 || index === 2 ? -extent : 0,
          top = index === 2 || index === 3 ? -extent : 0;
        const right = index === 1 || index === 2 ? offset[0] + radius : extent,
          bottom = index === 2 || index === 3 ? offset[1] + radius : extent;
        const radii = [0, 0, 0, 0];
        radii[index] = radius;
        ctx.beginPath();
        ctx.roundRect(left, top, right - left, bottom - top, radii);
        ctx.clip();
      }
      const effect = fields.effect ? this.nodes.get((fields.effect as SceneNodeRef).id) : undefined;
      const border = Number(effect?.fields.borderWidth ?? 0),
        radii = effect?.fields.borderRadius as number[] | undefined;
      const rounded = () => {
        ctx.beginPath();
        ctx.roundRect(0, 0, Number(fields.width), Number(fields.height), radii ?? 0);
      };
      if (node.type === "rectangle") {
        ctx.fillStyle = color(fields.color);
        if (effect?.fields.gradientStyle === "linear") {
          const angle = (Number(effect.fields.gradientAngle ?? 0) * Math.PI) / 180,
            dx = Math.sin(angle),
            dy = -Math.cos(angle),
            width = Number(fields.width),
            height = Number(fields.height);
          const minimum = Math.min(0, width * dx) + Math.min(0, height * dy),
            maximum = Math.max(0, width * dx) + Math.max(0, height * dy),
            cx = width / 2,
            cy = height / 2,
            center = cx * dx + cy * dy;
          const gradient = ctx.createLinearGradient(
            cx + dx * (minimum - center),
            cy + dy * (minimum - center),
            cx + dx * (maximum - center),
            cy + dy * (maximum - center),
          );
          const colors = effect.fields.gradientColors as string[],
            stops = effect.fields.gradientStops as number[] | undefined;
          colors.forEach((value, index) =>
            gradient.addColorStop(stops?.[index] ?? index / (colors.length - 1), color(value)),
          );
          ctx.fillStyle = gradient;
        }
        if (effect) {
          rounded();
          ctx.fill();
        } else ctx.fillRect(0, 0, Number(fields.width), Number(fields.height));
        if (border) {
          ctx.beginPath();
          ctx.roundRect(
            -border / 2,
            -border / 2,
            Number(fields.width) + border,
            Number(fields.height) + border,
            radii?.map((radius) => radius + border / 2) ?? 0,
          );
          ctx.strokeStyle = color(effect!.fields.borderColor);
          ctx.lineWidth = border;
          ctx.stroke();
        }
      } else if (node.type === "poster") {
        if (effect) {
          rounded();
          ctx.clip();
        }
        const entry = this.images.get(node.id);
        if (entry?.ready) {
          let bitmap: CanvasImageSource = entry.image;
          if (typeof fields.blendColor === "string") {
            const tint = color(fields.blendColor);
            if (entry.tint !== tint) {
              const surface = this.factory.canvas(
                entry.image.naturalWidth,
                entry.image.naturalHeight,
              );
              const painting = surface.getContext("2d")!;
              painting.drawImage(entry.image, 0, 0);
              painting.globalCompositeOperation = "source-in";
              painting.fillStyle = tint;
              painting.fillRect(0, 0, surface.width, surface.height);
              entry.tinted = surface;
              entry.tint = tint;
            }
            bitmap = entry.tinted!;
          }
          const width = Number(fields.width),
            height = Number(fields.height),
            iw = entry.image.naturalWidth,
            ih = entry.image.naturalHeight;
          const mode = fields.loadDisplayMode ?? "scaleToFill";
          const scale =
            mode === "scaleToZoom"
              ? Math.max(width / iw, height / ih)
              : Math.min(width / iw, height / ih);
          const dw = mode === "scaleToFill" || mode === "noScale" ? width : iw * scale,
            dh = mode === "scaleToFill" || mode === "noScale" ? height : ih * scale;
          ctx.beginPath();
          ctx.rect(0, 0, width, height);
          ctx.clip();
          ctx.drawImage(bitmap, (width - dw) / 2, (height - dh) / 2, dw, dh);
        }
      } else if (node.type === "multiStyleLabel") {
        const styles = fields.drawingStyles as Record<
          string,
          { fontUri: string; fontSize: number; color: string }
        >;
        const runs = [...String(fields.text ?? "").matchAll(/<(s\d+)>([\s\S]*?)<\/\1>/g)].map(
          (match) => ({
            style: styles[match[1]],
            text: match[2].replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
          }),
        );
        const selectFont = (style: (typeof runs)[number]["style"]) => {
          const ref = [...this.nodes.values()].find(
            (node) =>
              node.type === "font" &&
              node.fields.uri === style.fontUri &&
              Number(node.fields.size) === style.fontSize,
          );
          if (!ref)
            throw new RokuHostError("PREVIEW_INLINE_FONT", "A mixed text run has no prepared font");
          ctx.font = `${style.fontSize}px "${this.fontDescription(ref).family}"`;
          ctx.fillStyle = color(style.color);
          ctx.textBaseline = "top";
        };
        const width = Number(fields.width),
          height = Number(fields.height),
          total = runs.reduce((sum, run) => {
            selectFont(run.style);
            return sum + ctx.measureText(run.text).width;
          }, 0);
        ctx.beginPath();
        ctx.rect(0, 0, width, height);
        ctx.clip();
        let x =
            fields.horizAlign === "center"
              ? (width - Math.min(width, total)) / 2
              : fields.horizAlign === "right"
                ? width - Math.min(width, total)
                : 0,
          truncated = false;
        for (const run of runs) {
          selectFont(run.style);
          let value = run.text;
          if (total > width) {
            const points = Array.from(value),
              ellipsis = ctx.measureText("…").width;
            let count = 0;
            while (
              count < points.length &&
              x + ctx.measureText(points.slice(0, count + 1).join("")).width + ellipsis <= width
            )
              count++;
            if (count < points.length) {
              value = points.slice(0, count).join("") + "…";
              truncated = true;
            }
          }
          ctx.fillText(value, x, 0);
          x += ctx.measureText(value).width;
          if (truncated) break;
        }
      } else if (node.type === "label" && fields.font) {
        const { family, size } = this.fontDescription(fields.font as SceneNodeRef);
        ctx.font = `${size}px "${family}"`;
        ctx.fillStyle = color(fields.color);
        ctx.textBaseline = "top";
        const width = Number(fields.width),
          alignment = String(fields.horizAlign ?? "left");
        ctx.textAlign =
          alignment === "center" ? "center" : alignment === "right" ? "right" : "left";
        const x = alignment === "center" ? width / 2 : alignment === "right" ? width : 0;
        const native = ctx.measureText("Mg"),
          height = native.fontBoundingBoxAscent + native.fontBoundingBoxDescent;
        String(fields.text ?? "")
          .split("\n")
          .forEach((line, index) =>
            ctx.fillText(line, x, index * (height + Number(fields.lineSpacing ?? 0))),
          );
      }
      for (const child of node.children) visit(child, ctx);
      ctx.restore();
    };
    for (const node of this.root.children) visit(node);
    // The standalone preview owns this profiling timeline. Keep React's debug
    // User Timing details bounded rather than retaining every past component tree.
    performance.clearMeasures();
  }
}

/** Host font-mask source for the same portable Gaussian/PNG pipeline as the native adapter. */
export function createCanvasTextRaster(
  scene: CanvasSceneGraph,
  text: TextMetricProvider,
): TextRasterCache {
  return new TextRasterCache({
    async mask(spec) {
      const ref = text.font?.({
        fontFamily: spec.fontFamily,
        fontSize: spec.fontSize / spec.scale,
      });
      if (!ref)
        throw new RokuHostError(
          "PREVIEW_FONT",
          "Canvas text rasterization requires a prepared font reference",
        );
      const { family } = scene.fontDescription(ref),
        surface = scene.factory.canvas(spec.width, spec.height),
        context = surface.getContext("2d")!;
      context.font = `${spec.fontSize}px "${family}"`;
      context.textBaseline = "top";
      context.fillStyle = "white";
      for (const command of spec.commands) context.fillText(command.text, command.x, command.y);
      const pixels = context.getImageData(0, 0, spec.width, spec.height).data,
        alpha = new Uint8Array(spec.width * spec.height);
      for (let index = 0; index < alpha.length; index++) alpha[index] = pixels[index * 4 + 3];
      return alpha;
    },
    async write(_name, bytes) {
      return `data:image/png;base64,${encodeBase64(bytes)}`;
    },
    async delete() {},
    dispose() {},
  });
}

export function createCanvasTextMetrics(
  scene: CanvasSceneGraph,
  options: FontResourcesOptions,
): FontResources {
  const loaded = new Map<number, FontFace>();
  return new (class extends FontResources {
    override dispose() {
      super.dispose();
      for (const font of loaded.values()) document.fonts.delete(font);
      loaded.clear();
    }
  })(
    scene,
    {
      async ready(ref, signal) {
        const node = scene.nodes.get(ref.id)!,
          { family } = scene.fontDescription(ref);
        const font = new FontFace(family, `url(${JSON.stringify(String(node.fields.uri))})`);
        await font.load();
        if (signal.aborted) throw signal.reason;
        document.fonts.add(font);
        loaded.set(ref.id, font);
      },
      metrics(ref) {
        const { family, size } = scene.fontDescription(ref),
          context = scene.context;
        context.font = `${size}px "${family}"`;
        const measured = context.measureText("Mg");
        return {
          lineHeight: measured.fontBoundingBoxAscent + measured.fontBoundingBoxDescent,
          width(text) {
            context.font = `${size}px "${family}"`;
            return context.measureText(text).width;
          },
        };
      },
    },
    options,
  );
}
