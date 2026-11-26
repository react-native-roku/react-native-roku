import type { TextRasterLease, TextRasterProvider } from "../graphics/textRaster.types";

interface TextObservationNode {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly children: readonly TextObservationNode[];
}

/** Development observations describe attached, enabled scene text. They do not
 * certify clipping, native presentation, or pixels. Retired raster history must
 * never satisfy a later UI assertion. */
export function observePreviewText(source: TextRasterProvider) {
  const images = new Map<string, Map<string, number>>();
  let retired = false;
  const track = (lease: TextRasterLease, text: string): TextRasterLease => {
    if (retired) {
      lease.release();
      return { image: lease.image, release() {} };
    }
    const values = images.get(lease.image.uri) ?? new Map<string, number>();
    images.set(lease.image.uri, values);
    values.set(text, (values.get(text) ?? 0) + 1);
    let released = false;
    return {
      image: lease.image,
      release() {
        if (released) return;
        released = true;
        const owners = (values.get(text) ?? 1) - 1;
        if (owners) values.set(text, owners);
        else values.delete(text);
        if (!values.size && images.get(lease.image.uri) === values) images.delete(lease.image.uri);
        lease.release();
      },
    };
  };
  const assertActive = () => {
    if (retired) throw Error("Preview text observer retired");
  };
  const provider: TextRasterProvider = {
    async acquire(request) {
      assertActive();
      return track(await source.acquire(request), request.layout.lines.join("\n"));
    },
    ...(source.acquireInline
      ? {
          async acquireInline(
            request: Parameters<NonNullable<TextRasterProvider["acquireInline"]>>[0],
          ) {
            assertActive();
            return track(
              await source.acquireInline!(request),
              request.runs.map((run) => run.text).join(""),
            );
          },
        }
      : {}),
    ...(source.acquirePixels ? { acquirePixels: source.acquirePixels.bind(source) } : {}),
    dispose() {
      if (retired) return;
      retired = true;
      images.clear();
      source.dispose();
    },
  };
  return {
    provider,
    snapshot(root: TextObservationNode): string[] {
      if (retired) return [];
      const texts = new Set<string>();
      const visit = (node: TextObservationNode) => {
        if (node.fields.visible === false || node.fields.opacity === 0) return;
        if (typeof node.fields.text === "string" && node.fields.text) texts.add(node.fields.text);
        if (typeof node.fields.uri === "string")
          for (const value of images.get(node.fields.uri)?.keys() ?? [])
            if (value) texts.add(value);
        node.children.forEach(visit);
      };
      visit(root);
      return [...texts];
    },
  };
}
