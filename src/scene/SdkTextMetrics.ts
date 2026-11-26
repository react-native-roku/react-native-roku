import type { LayoutStyle } from "../layout/flexLayout";
import { getFontMeasure } from "@roku-sdk/runtime/font";
import {
  FontResources,
  type FontCancellation,
  type FontResourcesOptions,
} from "../layout/FontResources";
import { RokuHostError, type SceneNodeRef } from "./sceneGraph.types";
import type { SdkSceneGraph } from "./SdkSceneGraph";

const cachedWidthsPerFont = 64;
const cacheableTextLength = 256;
type FontWidths = WeakMap<SceneNodeRef, Map<string, number>>;

// Some firmware leaves the SDK readiness promise pending after native
// measurements start succeeding. FontResources owns the deadline and cancels
// this poll when a font times out or the host is retired.
function waitForMeasurableFont(scene: SdkSceneGraph, font: SceneNodeRef, signal: FontCancellation) {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 16;
    function finish() {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
    function cancel() {
      finish();
      reject(
        signal.reason ?? new RokuHostError("C04_FONT_DISPOSED", "Font readiness was cancelled"),
      );
    }
    function check() {
      if (signal.aborted) {
        cancel();
        return;
      }
      let height: number | undefined;
      try {
        height = getFontMeasure().getOneLineHeight(scene.native(font).r);
      } catch {
        // The native API can throw until the Label's font is initialized.
      }
      if (height !== undefined && Number.isFinite(height) && height > 0) {
        finish();
        queueMicrotask(resolve);
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        check();
      }, delay);
      delay = Math.min(delay * 2, 250);
    }
    signal.addEventListener("abort", cancel);
    check();
  });
}

/** Device metrics, measured by Roku from the exact packaged font used by Labels. */
export class SdkTextMetrics extends FontResources {
  private readonly measurements: { widths: FontWidths };

  preparedFieldFont(style: LayoutStyle): SceneNodeRef {
    return this.font(style);
  }

  readRetainedFontLineHeight(font: SceneNodeRef): number {
    return this.retainedLineHeight(font);
  }

  dispose(): void {
    this.measurements.widths = new WeakMap();
    super.dispose();
  }

  constructor(scene: SdkSceneGraph, options: FontResourcesOptions) {
    const measurements = { widths: new WeakMap() as FontWidths };
    super(
      scene,
      {
        async ready(font, signal) {
          // Roku OS initializes a packaged font when a Label references it.
          // Keep the Label transparent and retire it once the font is measurable.
          const label = scene.create("label");
          let attached = false;
          try {
            scene.batch(() => {
              scene.insert(scene.root, label);
              attached = true;
              scene.set(label, "opacity", 0);
              scene.set(label, "text", "");
              scene.set(label, "font", font);
            });
            await waitForMeasurableFont(scene, font, signal);
          } finally {
            if (attached) scene.batch(() => scene.remove(scene.root, label));
          }
        },
        metrics(font) {
          const ref = scene.native(font).r,
            api = getFontMeasure();
          // Probe the native font on each metrics request, even for cached widths.
          const lineHeight = api.getOneLineHeight(ref);
          const generation = measurements.widths;
          let widths = generation.get(font);
          if (!widths) {
            widths = new Map();
            generation.set(font, widths);
          }
          return {
            lineHeight,
            width(text) {
              const cacheable =
                generation === measurements.widths && text.length <= cacheableTextLength;
              const cached = cacheable ? widths.get(text) : undefined;
              if (cached !== undefined) return cached;
              const width = api.getOneLineWidth(ref, text, 2_147_483_647);
              if (!Number.isFinite(width) || width < 0)
                throw new RokuHostError("C04_FONT_METRICS", "Roku returned invalid text width");
              if (cacheable && generation === measurements.widths) {
                if (widths.size === cachedWidthsPerFont) {
                  const oldest = widths.keys().next().value;
                  if (oldest !== undefined) widths.delete(oldest);
                }
                widths.set(text, width);
              }
              return width;
            },
          };
        },
      },
      options,
    );
    this.measurements = measurements;
  }
}
