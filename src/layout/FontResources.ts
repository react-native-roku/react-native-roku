import { RokuHostError, type SceneGraphPort, type SceneNodeRef } from "../scene/sceneGraph.types";
import type { LayoutStyle } from "./flexLayout";
import type { TextMetricProvider, TextMetrics } from "./textLayout";
import { fontVariantFamily } from "./fontVariants.mjs";
import { prepareFontFamilies, fontFaceFamily, type FontFamilyGroups } from "./fontFaces.mjs";
export { fontVariantFamily } from "./fontVariants.mjs";

export interface FontCancellation {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
export interface FontEngine {
  ready(font: SceneNodeRef, signal: FontCancellation): Promise<void>;
  metrics(font: SceneNodeRef): TextMetrics;
}
export interface FontResourcesOptions {
  readonly assets: Readonly<Record<string, string>>;
  readonly defaultFamily: string;
  readonly families?: FontFamilyGroups;
  readonly timeoutMs?: number;
  readonly maximumFonts?: number;
}
interface Entry {
  ref: SceneNodeRef;
  pending: Promise<void>;
  ready: boolean;
  retained: boolean;
  attached: boolean;
  releasing: boolean;
  cancel(reason: unknown): void;
}

/** Owns packaged font lifetimes. Metrics are supplied by the host's font engine. */
export class FontResources implements TextMetricProvider {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  private readonly families: FontFamilyGroups;
  constructor(
    private readonly scene: SceneGraphPort,
    private readonly engine: FontEngine,
    private readonly options: FontResourcesOptions,
  ) {
    this.options = { ...options, assets: Object.freeze({ ...options.assets }) };
    this.families = prepareFontFamilies(this.options.assets, this.options.families);
    this.identity({});
    if (!(
      Number.isFinite(this.options.timeoutMs ?? 15_000) && (this.options.timeoutMs ?? 15_000) > 0
    ))
      throw new RokuHostError("C04_FONT_TIMEOUT", "Font timeout must be positive and finite");
    if (
      !Number.isInteger(this.options.maximumFonts ?? 128) ||
      (this.options.maximumFonts ?? 128) < 1
    )
      throw new RokuHostError("C04_FONT_LIMIT", "Font resource limit must be a positive integer");
  }
  fontFamily(style: LayoutStyle): string {
    return this.identity(style).family;
  }
  prepare(style: LayoutStyle): void | Promise<void> {
    this.assertActive();
    const { key, family, size } = this.identity(style);
    const existing = this.entries.get(key);
    if (existing) return existing.ready ? undefined : existing.pending;
    if (this.entries.size >= (this.options.maximumFonts ?? 128))
      throw new RokuHostError("C04_FONT_LIMIT", "The font resource budget was exceeded");
    const listeners = new Set<() => void>();
    let aborted = false,
      reason: unknown;
    const signal: FontCancellation = {
      get aborted() {
        return aborted;
      },
      get reason() {
        return reason;
      },
      addEventListener(_type, listener) {
        listeners.add(listener);
      },
      removeEventListener(_type, listener) {
        listeners.delete(listener);
      },
    };
    const ref = this.scene.create("font");
    const entry: Entry = {
      ref,
      ready: false,
      retained: true,
      attached: false,
      releasing: false,
      pending: Promise.resolve(),
      cancel(value) {
        if (aborted) return;
        aborted = true;
        reason = value;
        for (const listener of [...listeners]) listener();
        listeners.clear();
      },
    };
    this.entries.set(key, entry);
    const assertCurrent = () => {
      if (this.disposed || signal.aborted || !entry.retained)
        throw (
          signal.reason ?? new RokuHostError("C04_FONT_DISPOSED", "Font resources were disposed")
        );
    };
    try {
      assertCurrent();
      this.scene.batch(() => {
        // Attach the nonvisual resource before configuring it, so a failed
        // field write still has a confirmed parent for release/disposal.
        this.scene.insert(this.scene.root, ref);
        entry.attached = true;
        this.scene.set(ref, "uri", this.options.assets[family]);
        this.scene.set(ref, "size", size);
      });
      assertCurrent();
    } catch (error) {
      entry.pending = Promise.reject(error);
      void entry.pending.catch(() => undefined);
      try {
        this.release(entry);
      } finally {
        // A failed cleanup remains retained for disposal to retry. It cannot
        // replace the initialization error or leave a resolved placeholder.
        throw error;
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
      timer = setTimeout(
        () =>
          entry.cancel(
            new RokuHostError(
              "C04_FONT_TIMEOUT",
              `Font ${family} at ${size}px did not become measurable`,
            ),
          ),
        this.options.timeoutMs ?? 15_000,
      );
    });
    entry.pending = Promise.race([
      Promise.resolve().then(() => {
        assertCurrent();
        return this.engine.ready(ref, signal);
      }),
      deadline,
    ])
      .then(() => {
        assertCurrent();
        const metrics = this.engine.metrics(ref);
        assertCurrent();
        if (!(Number.isFinite(metrics.lineHeight) && metrics.lineHeight > 0))
          throw new RokuHostError("C04_FONT_METRICS", "The font engine returned invalid metrics");
        entry.ready = true;
      })
      .catch((error) => {
        try {
          this.release(entry);
        } finally {
          throw error;
        }
      })
      .finally(() => {
        clearTimeout(timer);
        listeners.clear();
      });
    // The render preparation owns error delivery, including disposal while it is pending.
    void entry.pending.catch(() => undefined);
    return entry.pending;
  }
  metrics(style: LayoutStyle): TextMetrics {
    return this.engine.metrics(this.font(style));
  }
  protected retainedLineHeight(font: SceneNodeRef): number {
    this.assertActive();
    return this.engine.metrics(font).lineHeight;
  }
  font(style: LayoutStyle): SceneNodeRef {
    this.assertActive();
    const entry = this.entries.get(this.identity(style).key);
    if (!entry?.ready)
      throw new RokuHostError("C04_FONT_PENDING", "Font metrics were requested before readiness");
    return entry.ref;
  }
  fontAsset(style: LayoutStyle): string {
    return this.options.assets[this.identity(style).family];
  }
  dispose(): void {
    if (this.disposed && this.entries.size === 0) return;
    this.disposed = true;
    const failures: unknown[] = [];
    for (const [key, entry] of this.entries) {
      try {
        entry.cancel(new RokuHostError("C04_FONT_DISPOSED", "Font resources were disposed"));
      } catch (error) {
        failures.push(error);
      }
      try {
        this.release(entry);
      } catch (error) {
        failures.push(error);
      }
      if (!entry.retained) this.entries.delete(key);
    }
    // Preserve the first failure while retaining only cleanup that still owns
    // a native ref. Further disposal calls can retry it; prepare stays retired.
    if (failures.length) throw failures[0];
  }
  private identity(style: LayoutStyle) {
    const baseFamily = fontFaceFamily(
        String(style.fontFamily ?? this.options.defaultFamily),
        { fontWeight: style.fontWeight, fontStyle: style.fontStyle },
        this.options.assets,
        this.families,
      ),
      family = fontVariantFamily(baseFamily, style.fontVariant),
      size = Number(style.fontSize ?? 14);
    if (!this.options.assets[family])
      throw new RokuHostError(
        family === baseFamily ? "C04_FONT_ASSET" : "C04_FONT_VARIANT_ASSET",
        `No packaged font asset for ${family}`,
      );
    if (!(Number.isFinite(size) && size > 0))
      throw new RokuHostError("C04_FONT_SIZE", "Font size must be positive and finite");
    return { key: `${family}\u0000${size}`, family, size };
  }
  private assertActive() {
    if (this.disposed) throw new RokuHostError("C04_FONT_DISPOSED", "Font resources were disposed");
  }
  private release(entry: Entry) {
    if (!entry.retained || entry.releasing) return;
    entry.releasing = true;
    try {
      this.scene.batch(() => {
        // An insertion may fail before or after attaching. Explicitly move
        // the retained ref to this root before removal when no attachment was
        // acknowledged; insert supports both unattached and already owned refs.
        if (!entry.attached) {
          this.scene.insert(this.scene.root, entry.ref);
          entry.attached = true;
        }
        this.scene.remove(this.scene.root, entry.ref);
      });
      entry.retained = false;
    } finally {
      entry.releasing = false;
    }
  }
}
