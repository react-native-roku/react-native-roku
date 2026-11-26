import { RokuHostError } from "../scene/sceneGraph.types";
import type {
  TextRasterProvider,
  TextRasterSpec,
  TextRasterRequest,
  TextRasterImage,
  TextRasterLease,
  InlineRasterRequest,
} from "./textRaster.types";
import { inlineRasterSpecs, overlayRgba } from "./inlineRaster";
import { textRasterSpec } from "./textRasterGeometry";
import { paintTextMask } from "./rasterPixels";
import { rgbaPng } from "./png";
export interface TextRasterTransport {
  mask(spec: TextRasterSpec): Promise<Uint8Array>;
  write(name: string, bytes: Uint8Array): Promise<string>;
  delete(uri: string): Promise<void>;
  dispose(): void;
}
interface Entry {
  readonly key: string;
  readonly size: number;
  readonly pending: Promise<TextRasterImage>;
  references: number;
  image?: TextRasterImage;
}
/** Bounded whole-text rasters. Visible/committing text retains its own lease. */
export class TextRasterCache implements TextRasterProvider {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  private transportDisposed = false;
  private disposing = false;
  private sequence = 0;
  private bytes = 0;
  constructor(
    private readonly transport: TextRasterTransport,
    private readonly maximumBytes = 8 * 1024 * 1024,
  ) {}
  async acquire(request: TextRasterRequest): Promise<TextRasterLease> {
    const spec = textRasterSpec(request),
      key = JSON.stringify(spec);
    return this.acquireImage(key, spec.width * spec.height * 4, (name) => this.render(spec, name));
  }
  async acquireInline(request: InlineRasterRequest): Promise<TextRasterLease> {
    const specs = inlineRasterSpecs(request),
      spec = specs[0];
    return this.acquireImage(
      `inline:${JSON.stringify(specs)}`,
      spec.width * spec.height * 4,
      async (name) => {
        const pixels = new Uint8Array(spec.width * spec.height * 4);
        for (const run of specs) {
          const mask = await this.transport.mask(run);
          if (this.disposed)
            throw new RokuHostError("C04_RASTER_DISPOSED", "Mixed text retired during drawing");
          overlayRgba(
            pixels,
            paintTextMask(
              mask,
              run.width,
              run.height,
              run.color,
              run.shadowColor,
              run.shadowRadius,
              run.shadowX,
              run.shadowY,
            ),
          );
        }
        const uri = await this.transport.write(name, rgbaPng(spec.width, spec.height, pixels));
        return {
          uri,
          width: spec.width / spec.scale,
          height: spec.height / spec.scale,
          inset: spec.inset,
        };
      },
    );
  }
  async acquirePixels(request: {
    key: string;
    width: number;
    height: number;
    pixels: Uint8Array | (() => Uint8Array);
  }): Promise<TextRasterLease> {
    const { key, width, height, pixels } = request;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 2048 ||
      height > 2048 ||
      (typeof pixels !== "function" && pixels.length !== width * height * 4)
    )
      throw new RokuHostError("C09_RASTER_SIZE", "Invalid vector bitmap dimensions or byte count");
    return this.acquireImage(
      `bitmap:${width}:${height}:${key}`,
      width * height * 4,
      async (name) => {
        const values = typeof pixels === "function" ? pixels() : pixels;
        if (this.disposed)
          throw new RokuHostError("C04_RASTER_DISPOSED", "Bitmap resources retired during drawing");
        if (values.length !== width * height * 4)
          throw new RokuHostError("C09_RASTER_SIZE", "Invalid vector bitmap byte count");
        return {
          uri: await this.transport.write(name, rgbaPng(width, height, values)),
          width,
          height,
          inset: 0,
        };
      },
    );
  }
  private async acquireImage(
    key: string,
    size: number,
    render: (name: string) => Promise<TextRasterImage>,
  ): Promise<TextRasterLease> {
    if (this.disposed)
      throw new RokuHostError("C04_RASTER_DISPOSED", "Text raster resources have retired");
    let entry = this.entries.get(key);
    if (!entry) {
      // Plan eviction without invoking transport/user code. Publish the new
      // reservation before any delete or draw callback can reenter this key.
      const retired = this.trim(size);
      this.bytes += size;
      const name = `text-${++this.sequence}.png`;
      let resolveImage!: (image: TextRasterImage) => void, rejectImage!: (error: unknown) => void;
      const pending = new Promise<TextRasterImage>((resolve, reject) => {
        resolveImage = resolve;
        rejectImage = reject;
      });
      entry = { key, size, pending, references: 1 };
      this.entries.set(key, entry);
      const owned = entry;
      void pending.then(
        (image) => {
          owned.image = image;
        },
        () => {
          if (this.entries.get(key) === owned) {
            this.entries.delete(key);
            this.bytes -= size;
          }
        },
      );
      try {
        for (const uri of retired) {
          if (this.disposed)
            throw new RokuHostError(
              "C04_RASTER_DISPOSED",
              "Text raster resources retired during eviction",
            );
          void this.transport.delete(uri).catch(() => undefined);
        }
        if (this.disposed)
          throw new RokuHostError(
            "C04_RASTER_DISPOSED",
            "Text raster resources retired before drawing",
          );
        // Keep invocation synchronous; only its result joins the published
        // pending identity shared by every current acquisition.
        void render(name).then(resolveImage, rejectImage);
      } catch (error) {
        rejectImage(error);
      }
    } else {
      this.entries.delete(key);
      this.entries.set(key, entry);
      entry.references++;
    }
    let image: TextRasterImage;
    try {
      image = await entry.pending;
    } catch (error) {
      entry.references--;
      throw error;
    }
    if (this.disposed) {
      entry.references--;
      throw new RokuHostError(
        "C04_RASTER_DISPOSED",
        "Text raster resources retired during preparation",
      );
    }
    let active = true;
    return {
      image,
      release: () => {
        if (!active) return;
        active = false;
        entry!.references--;
      },
    };
  }
  private async render(spec: TextRasterSpec, name: string): Promise<TextRasterImage> {
    const mask = await this.transport.mask(spec);
    if (this.disposed)
      throw new RokuHostError(
        "C04_RASTER_DISPOSED",
        "Text raster resources retired during drawing",
      );
    const pixels = paintTextMask(
      mask,
      spec.width,
      spec.height,
      spec.color,
      spec.shadowColor,
      spec.shadowRadius,
      spec.shadowX,
      spec.shadowY,
    );
    const uri = await this.transport.write(name, rgbaPng(spec.width, spec.height, pixels));
    return {
      uri,
      width: spec.width / spec.scale,
      height: spec.height / spec.scale,
      inset: spec.inset,
    };
  }
  private trim(additional: number): string[] {
    const retired: Entry[] = [];
    let retainedBytes = this.bytes;
    for (const entry of this.entries.values()) {
      if (retainedBytes + additional <= this.maximumBytes) break;
      if (entry.references || !entry.image) continue;
      retired.push(entry);
      retainedBytes -= entry.size;
    }
    if (retainedBytes + additional > this.maximumBytes)
      throw new RokuHostError("C04_RASTER_BUDGET", "Visible text exceeds the beta raster budget");
    for (const entry of retired) this.entries.delete(entry.key);
    this.bytes = retainedBytes;
    return retired.map((entry) => entry.image!.uri);
  }
  diagnostics() {
    const entries = [...this.entries.values()];
    return {
      entries: entries.length,
      bytes: this.bytes,
      pending: entries.filter((entry) => !entry.image).length,
      leased: entries.filter((entry) => entry.references > 0).length,
    };
  }
  dispose(): void {
    if (this.transportDisposed || this.disposing) return;
    this.disposed = true;
    this.entries.clear();
    this.bytes = 0;
    this.disposing = true;
    try {
      this.transport.dispose();
      this.transportDisposed = true;
    } finally {
      this.disposing = false;
    }
  }
}
