import type { LayoutStyle } from "../layout/flexLayout";
import type { TextLayout, TextMetrics } from "../layout/textLayout";
export interface TextRasterRequest {
  readonly style: LayoutStyle;
  readonly layout: TextLayout;
  readonly metrics: TextMetrics;
  readonly width: number;
  readonly height: number;
}
export interface TextRasterImage {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly inset: number;
}
export interface TextRasterLease {
  readonly image: TextRasterImage;
  release(): void;
}
export interface InlineRasterRequest {
  readonly runs: readonly {
    text: string;
    style: LayoutStyle;
    metrics: TextMetrics;
  }[];
  readonly width: number;
  readonly height: number;
}
export interface TextRasterProvider {
  acquire(request: TextRasterRequest): Promise<TextRasterLease>;
  acquireInline?(request: InlineRasterRequest): Promise<TextRasterLease>;
  /** Portable RGBA graphics share the same bounded native bitmap/file owner. */
  acquirePixels?(request: {
    key: string;
    width: number;
    height: number;
    pixels: Uint8Array | (() => Uint8Array);
  }): Promise<TextRasterLease>;
  dispose(): void;
}
export interface TextDrawCommand {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}
export interface TextRasterSpec {
  readonly width: number;
  readonly height: number;
  readonly inset: number;
  readonly scale: number;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly commands: readonly TextDrawCommand[];
  readonly color: string;
  readonly shadowColor: string;
  readonly shadowX: number;
  readonly shadowY: number;
  readonly shadowRadius: number;
}
