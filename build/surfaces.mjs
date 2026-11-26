import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
export async function buildSurfaceAssets(root, generated) {
  const require = createRequire(resolve(root, "node_modules/@roku-sdk/tooling/package.json")),
    sharp = require("sharp");
  mkdirSync(resolve(generated, "surfaces"), { recursive: true });
  const centers = [
    [256, 256],
    [0, 256],
    [0, 0],
    [256, 0],
  ];
  for (let index = 0; index < centers.length; index++) {
    const [cx, cy] = centers[index];
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="257" height="257"><circle cx="${cx}" cy="${cy}" r="256" fill="white"/></svg>`;
    const { data, info } = await sharp(Buffer.from(source))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // MaskGroup repeats edge rows/columns. The inward edges extend opaque
    // half-planes, including the antialiased pixel at circle tangency.
    const column = index === 0 || index === 3 ? 256 : 0,
      row = index < 2 ? 256 : 0;
    for (let pixel = 0; pixel < 257; pixel++)
      for (const [x, y] of [
        [column, pixel],
        [pixel, row],
      ])
        data.fill(255, (y * 257 + x) * 4, (y * 257 + x + 1) * 4);
    writeFileSync(
      resolve(generated, `surfaces/corner-${index}.png`),
      await sharp(data, { raw: info }).png().toBuffer(),
    );
  }
  writeFileSync(
    resolve(generated, "surfaceAssets.ts"),
    centers
      .map((_, index) => `import { uri as corner${index} } from "./surfaces/corner-${index}.png";`)
      .join("\n") + "\nexport const cornerMasks = [corner0,corner1,corner2,corner3] as const;\n",
  );
}
