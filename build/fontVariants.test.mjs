import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { deriveTabularFont, prepareRokuFontAssets } from "./fontVariants.mjs";

const face = (name = "400Regular") =>
  readFileSync(
    new URL(`../node_modules/@expo-google-fonts/inter/${name}/Inter_${name}.ttf`, import.meta.url),
  );
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function tables(bytes) {
  return new Map(
    Array.from({ length: bytes.readUInt16BE(4) }, (_, i) => {
      const p = 12 + 16 * i,
        offset = bytes.readUInt32BE(p + 8),
        length = bytes.readUInt32BE(p + 12);
      return [
        bytes.toString("ascii", p, p + 4),
        { offset, bytes: bytes.subarray(offset, offset + length) },
      ];
    }),
  );
}
function unicodeGlyphs(bytes) {
  const cmap = tables(bytes).get("cmap").bytes;
  const record = Array.from({ length: cmap.readUInt16BE(2) }, (_, i) => 4 + i * 8).find(
    (p) => cmap.readUInt16BE(p) === 3 && cmap.readUInt16BE(p + 2) === 10,
  );
  assert.notEqual(record, undefined);
  const base = cmap.readUInt32BE(record + 4),
    result = new Map();
  for (let i = 0; i < cmap.readUInt32BE(base + 12); i++) {
    const p = base + 16 + 12 * i,
      first = cmap.readUInt32BE(p),
      last = cmap.readUInt32BE(p + 4),
      glyph = cmap.readUInt32BE(p + 8);
    for (let cp = first; cp <= last; cp++) result.set(cp, glyph + cp - first);
  }
  return result;
}
function advances(bytes) {
  const map = unicodeGlyphs(bytes),
    entries = tables(bytes),
    hmtx = entries.get("hmtx").bytes,
    count = entries.get("hhea").bytes.readUInt16BE(34);
  return Array.from({ length: 10 }, (_, i) =>
    hmtx.readUInt16BE(Math.min(map.get(48 + i), count - 1) * 4),
  );
}
function names(bytes) {
  const name = tables(bytes).get("name").bytes,
    storage = name.readUInt16BE(4);
  return Array.from({ length: name.readUInt16BE(2) }, (_, i) => {
    const p = 6 + 12 * i,
      length = name.readUInt16BE(p + 8),
      offset = name.readUInt16BE(p + 10);
    return {
      id: name.readUInt16BE(p + 6),
      key: name.subarray(p, p + 8).toString("hex"),
      bytes: name.subarray(storage + offset, storage + offset + length),
    };
  });
}
for (const [name, width] of [
  ["400Regular", 1328],
  ["500Medium", 1327],
  ["600SemiBold", 1325],
  ["700Bold", 1324],
  ["800ExtraBold", 1322],
])
  test(`bakes ${name}'s real tabular glyphs while retaining Unicode coverage and source bytes`, () => {
    const original = face(name),
      before = digest(original),
      result = deriveTabularFont(original);
    assert.ok(new Set(advances(original)).size > 1);
    assert.deepEqual(advances(result.bytes), Array(10).fill(width));
    assert.deepEqual([...unicodeGlyphs(result.bytes).keys()], [...unicodeGlyphs(original).keys()]);
    assert.equal(digest(original), before);
    assert.deepEqual(deriveTabularFont(original), result);
  });

test("derivatives retain outlines, metrics, license records and valid checksums while changing family identity", () => {
  const original = face(),
    { bytes, family } = deriveTabularFont(original),
    before = tables(original),
    after = tables(bytes);
  for (const [tag, entry] of before)
    if (!["cmap", "name", "head", "DSIG"].includes(tag))
      assert.deepEqual(after.get(tag).bytes, entry.bytes, tag);
  const oldNames = names(original),
    newNames = names(bytes);
  for (const entry of oldNames.filter((entry) => ![1, 3, 4, 6, 16, 18, 21].includes(entry.id)))
    assert.deepEqual(newNames.find((candidate) => candidate.key === entry.key)?.bytes, entry.bytes);
  assert.ok(
    newNames.some(
      (entry) => entry.id === 1 && entry.bytes.equals(Buffer.from(family, "utf16le").swap16()),
    ),
  );
  let sum = 0;
  for (let p = 0; p < bytes.length; p += 4) sum = (sum + bytes.readUInt32BE(p)) >>> 0;
  assert.equal(sum, 0xb1b0afba);
});

test("rejects truncated or unsupported font containers before producing a derivative", () => {
  for (const bytes of [
    Buffer.alloc(0),
    face().subarray(0, 100),
    Buffer.from("OTTO" + " ".repeat(30)),
  ])
    assert.throws(() => deriveTabularFont(bytes), /C04_FONT_VARIANT_BUILD/);
});

test("rejects missing and contextual feature profiles rather than approximating their glyphs", () => {
  const source = face(),
    table = tables(source).get("GSUB"),
    gsub = table.bytes;
  const features = gsub.readUInt16BE(6),
    record = Array.from(
      { length: gsub.readUInt16BE(features) },
      (_, i) => features + 2 + i * 6,
    ).find((p) => gsub.toString("ascii", p, p + 4) === "tnum");
  const absent = Buffer.from(source);
  absent.write("xxxx", table.offset + record, 4, "ascii");
  assert.throws(() => deriveTabularFont(absent), /no tnum/);
  const feature = features + gsub.readUInt16BE(record + 4),
    index = gsub.readUInt16BE(feature + 4),
    lookups = gsub.readUInt16BE(8),
    lookup = lookups + gsub.readUInt16BE(lookups + 2 + 2 * index);
  const contextual = Buffer.from(source);
  contextual.writeUInt16BE(6, table.offset + lookup);
  assert.throws(() => deriveTabularFont(contextual), /Only single-glyph/);
});

test("prepares named ordinary/variant assets with exact source identity and refuses source overwrite", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "roku-font-assets-"));
  try {
    const source = resolve(directory, "source.ttf"),
      original = face();
    writeFileSync(source, original);
    const result = prepareRokuFontAssets({
      assets: { Fixture: source },
      variants: ["tabular-nums"],
      outputDirectory: resolve(directory, "generated"),
    });
    assert.deepEqual(Object.keys(result.assets), ["Fixture", "Fixture::tabular-nums"]);
    assert.deepEqual(readFileSync(result.assets.Fixture), original);
    assert.deepEqual(
      advances(readFileSync(result.assets["Fixture::tabular-nums"])),
      Array(10).fill(1328),
    );
    assert.ok(
      result.faces.every(
        (entry) =>
          entry.sourceSha256 === digest(original) &&
          entry.sha256 === digest(readFileSync(entry.path)),
      ),
    );
    const unsafe = resolve(directory, "font-0.ttf");
    writeFileSync(unsafe, original);
    assert.throws(
      () => prepareRokuFontAssets({ assets: { Fixture: unsafe }, outputDirectory: directory }),
      /overwrite a font source/,
    );
    assert.deepEqual(readFileSync(unsafe), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing/unsupported feature leaves an owned generation unwritten", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "roku-font-assets-refusal-"));
  try {
    const source = resolve(directory, "source.ttf");
    writeFileSync(source, "invalid font");
    const outputDirectory = resolve(directory, "failed");
    assert.throws(
      () =>
        prepareRokuFontAssets({
          assets: { Fixture: source },
          variants: ["tabular-nums"],
          outputDirectory,
        }),
      /C04_FONT_VARIANT_BUILD/,
    );
    assert.equal(existsSync(outputDirectory), false);
    assert.throws(
      () =>
        prepareRokuFontAssets({
          assets: { Fixture: source },
          variants: ["small-caps"],
          outputDirectory,
        }),
      /C04_FONT_VARIANT/,
    );
    assert.equal(existsSync(outputDirectory), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("validates and snapshots logical faces before writing any generated font", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "roku-font-family-build-"));
  try {
    const source = resolve(directory, "source.ttf");
    writeFileSync(source, face());
    const families = { Body: { normal: { 400: "Regular", 700: "Bold" } } };
    const result = prepareRokuFontAssets({
      assets: { Regular: source, Bold: source },
      families,
      outputDirectory: resolve(directory, "valid"),
    });
    assert.deepEqual(JSON.parse(JSON.stringify(result.families)), families);
    families.Body.normal[700] = "Missing";
    assert.equal(result.families.Body.normal[700], "Bold");
    const outputDirectory = resolve(directory, "invalid");
    assert.throws(
      () =>
        prepareRokuFontAssets({
          assets: { Regular: source, Bold: source },
          families,
          outputDirectory,
        }),
      /C04_FONT_FACE_CONFIG/,
    );
    assert.equal(existsSync(outputDirectory), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
