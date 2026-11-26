import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fontVariantFamily } from "../src/layout/fontVariants.mjs";
import { prepareFontFamilies } from "../src/layout/fontFaces.mjs";

// OpenType: https://learn.microsoft.com/en-us/typography/opentype/spec/gsub
// https://learn.microsoft.com/en-us/typography/opentype/spec/cmap
// This deliberately bounded derivative handles static TrueType single-glyph
// tnum substitutions. Contextual shaping/variable fonts need a different owner.
const fail = (message) => {
  throw Error(`C04_FONT_VARIANT_BUILD: ${message}`);
};
const requireValue = (value, message) => {
  if (!value) fail(message);
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function tableReader(bytes) {
  const range = (offset, length) => {
    requireValue(
      Number.isSafeInteger(offset) &&
        Number.isSafeInteger(length) &&
        offset >= 0 &&
        length >= 0 &&
        offset + length <= bytes.length,
      "Font table is truncated",
    );
    return bytes.subarray(offset, offset + length);
  };
  return {
    bytes,
    range,
    u16: (offset) => range(offset, 2).readUInt16BE(),
    i16: (offset) => range(offset, 2).readInt16BE(),
    u32: (offset) => range(offset, 4).readUInt32BE(),
  };
}
function readFont(input) {
  requireValue(
    input instanceof Uint8Array && input.length >= 12 && input.length <= 32 * 1024 * 1024,
    "Use a bounded static TrueType font",
  );
  const font = tableReader(Buffer.from(input));
  requireValue(font.u32(0) === 0x00010000, "Only standalone TrueType outlines are admitted");
  const tables = new Map();
  const count = font.u16(4);
  requireValue(count > 0 && count <= 256, "Invalid font table count");
  for (let i = 0; i < count; i++) {
    const offset = 12 + i * 16,
      tag = font.range(offset, 4).toString("ascii");
    requireValue(!tables.has(tag), "Duplicate font table");
    tables.set(tag, tableReader(font.range(font.u32(offset + 8), font.u32(offset + 12))));
  }
  for (const tag of ["cmap", "GSUB", "head", "hhea", "hmtx", "maxp", "name", "glyf", "loca"])
    requireValue(tables.has(tag), `Missing ${tag} table`);
  requireValue(!tables.has("fvar"), "Variable fonts are not admitted");
  return tables;
}
function characterMap(cmap) {
  const candidates = [];
  for (let i = 0; i < cmap.u16(2); i++) {
    const entry = 4 + 8 * i,
      platform = cmap.u16(entry),
      encoding = cmap.u16(entry + 2),
      offset = cmap.u32(entry + 4);
    if (platform !== 0 && !(platform === 3 && [1, 10].includes(encoding))) continue;
    const format = cmap.u16(offset);
    requireValue(
      format !== 14,
      "Variation selector mappings require a reviewed derivation profile",
    );
    if ([4, 12].includes(format)) candidates.push({ offset, format });
  }
  candidates.sort((a, b) => b.format - a.format);
  requireValue(candidates.length, "A Unicode format 4 or 12 character map is required");
  const { offset: base, format } = candidates[0],
    result = new Map();
  const put = (cp, glyph) => {
    requireValue(cp <= 0x10ffff && glyph >= 0 && glyph <= 0xffff, "Invalid Unicode/glyph mapping");
    if (glyph) result.set(cp, glyph);
  };
  if (format === 12) {
    const count = cmap.u32(base + 12);
    requireValue(count <= 0x110000, "Character map exceeds the Unicode budget");
    let previous = -1;
    for (let i = 0; i < count; i++) {
      const p = base + 16 + 12 * i,
        first = cmap.u32(p),
        last = cmap.u32(p + 4),
        glyph = cmap.u32(p + 8);
      requireValue(
        first > previous && last >= first && last <= 0x10ffff,
        "Unordered character map ranges",
      );
      for (let cp = first; cp <= last; cp++) put(cp, glyph + cp - first);
      previous = last;
    }
  } else {
    const count = cmap.u16(base + 6) / 2;
    requireValue(Number.isInteger(count) && count > 0, "Invalid character map segments");
    const ends = base + 14,
      starts = ends + 2 * count + 2,
      deltas = starts + 2 * count,
      offsets = deltas + 2 * count;
    let previous = -1;
    for (let i = 0; i < count; i++) {
      const first = cmap.u16(starts + i * 2),
        last = cmap.u16(ends + i * 2),
        delta = cmap.i16(deltas + i * 2),
        offset = cmap.u16(offsets + i * 2);
      requireValue(first > previous && last >= first, "Unordered character map segments");
      for (let cp = first; cp <= last && cp < 0xffff; cp++) {
        const glyph = offset ? cmap.u16(offsets + i * 2 + offset + 2 * (cp - first)) : cp;
        put(cp, offset && !glyph ? 0 : (glyph + delta) & 0xffff);
      }
      previous = last;
    }
  }
  return result;
}
function coverage(table, base) {
  const format = table.u16(base),
    count = table.u16(base + 2),
    result = [];
  if (format === 1) for (let i = 0; i < count; i++) result.push(table.u16(base + 4 + 2 * i));
  else if (format === 2)
    for (let i = 0; i < count; i++) {
      const p = base + 4 + i * 6,
        first = table.u16(p),
        last = table.u16(p + 2);
      requireValue(
        first <= last && table.u16(p + 4) === result.length,
        "Invalid feature coverage range",
      );
      for (let glyph = first; glyph <= last; glyph++) result.push(glyph);
      requireValue(result.length <= 65536, "Feature coverage exceeds glyph budget");
    }
  else fail("Unsupported feature coverage format");
  requireValue(
    result.every((value, index) => index === 0 || value > result[index - 1]),
    "Unordered feature coverage",
  );
  return result;
}
function tabularLookups(gsub) {
  requireValue(gsub.u16(0) === 1, "Unsupported GSUB version");
  requireValue(
    gsub.u16(2) === 0 || (gsub.u16(2) === 1 && gsub.u32(10) === 0),
    "Conditional feature variations require review",
  );
  const features = gsub.u16(6),
    lookups = gsub.u16(8),
    indexes = new Set();
  let profile;
  for (let i = 0; i < gsub.u16(features); i++) {
    const p = features + 2 + i * 6;
    if (gsub.range(p, 4).toString("ascii") !== "tnum") continue;
    const f = features + gsub.u16(p + 4);
    requireValue(gsub.u16(f) === 0, "Feature parameters require review");
    const selected = Array.from({ length: gsub.u16(f + 2) }, (_, j) => gsub.u16(f + 4 + 2 * j));
    requireValue(
      selected.every((value, index) => index === 0 || value > selected[index - 1]),
      "Unordered feature lookups require review",
    );
    requireValue(
      profile === undefined || profile === JSON.stringify(selected),
      "Language-specific tnum profiles require review",
    );
    profile = JSON.stringify(selected);
    for (const index of selected) indexes.add(index);
  }
  requireValue(indexes.size, "Font has no tnum substitution feature");
  return [...indexes].map((index) => {
    requireValue(index < gsub.u16(lookups), "Feature references an absent lookup");
    const base = lookups + gsub.u16(lookups + 2 + 2 * index),
      kind = gsub.u16(base),
      result = new Map();
    requireValue(gsub.u16(base + 2) === 0, "Filtered/contextual feature lookups are not admitted");
    requireValue(kind === 1 || kind === 7, "Only single-glyph tnum substitutions are admitted");
    for (let i = 0; i < gsub.u16(base + 4); i++) {
      let sub = base + gsub.u16(base + 6 + 2 * i);
      if (kind === 7) {
        requireValue(
          gsub.u16(sub) === 1 && gsub.u16(sub + 2) === 1,
          "Only extension single substitutions are admitted",
        );
        sub += gsub.u32(sub + 4);
      }
      const format = gsub.u16(sub),
        covered = coverage(gsub, sub + gsub.u16(sub + 2));
      requireValue(format === 1 || format === 2, "Unsupported single substitution format");
      if (format === 2)
        requireValue(gsub.u16(sub + 4) === covered.length, "Feature coverage count differs");
      for (const [i, glyph] of covered.entries()) {
        requireValue(!result.has(glyph), "Overlapping feature subtables require review");
        result.set(
          glyph,
          format === 1 ? (glyph + gsub.i16(sub + 4)) & 0xffff : gsub.u16(sub + 6 + 2 * i),
        );
      }
    }
    return result;
  });
}
function encodeCmap(mapping) {
  const entries = [...mapping].sort((a, b) => a[0] - b[0]),
    groups = [];
  for (const [cp, glyph] of entries) {
    const previous = groups.at(-1);
    if (previous && cp === previous[1] + 1 && glyph === previous[2] + cp - previous[0])
      previous[1] = cp;
    else groups.push([cp, cp, glyph]);
  }
  const wide = Buffer.alloc(16 + groups.length * 12);
  wide.writeUInt16BE(12);
  wide.writeUInt32BE(wide.length, 4);
  wide.writeUInt32BE(groups.length, 12);
  groups.forEach((group, i) =>
    group.forEach((value, j) => wide.writeUInt32BE(value, 16 + i * 12 + j * 4)),
  );
  const segments = [];
  for (const [cp, glyph] of entries.filter(([cp]) => cp < 0xffff)) {
    const delta = (glyph - cp) & 0xffff,
      previous = segments.at(-1);
    if (previous && cp === previous[1] + 1 && delta === previous[2]) previous[1] = cp;
    else segments.push([cp, cp, delta]);
  }
  segments.push([0xffff, 0xffff, 1]);
  const n = segments.length,
    narrow = Buffer.alloc(16 + 8 * n);
  requireValue(narrow.length <= 65535, "BMP character map exceeds format 4 capacity");
  narrow.writeUInt16BE(4);
  narrow.writeUInt16BE(narrow.length, 2);
  narrow.writeUInt16BE(n * 2, 6);
  const power = 2 ** Math.floor(Math.log2(n));
  narrow.writeUInt16BE(power * 2, 8);
  narrow.writeUInt16BE(Math.log2(power), 10);
  narrow.writeUInt16BE(n * 2 - power * 2, 12);
  segments.forEach(([first, last, delta], i) => {
    narrow.writeUInt16BE(last, 14 + 2 * i);
    narrow.writeUInt16BE(first, 16 + 2 * n + 2 * i);
    narrow.writeUInt16BE(delta, 16 + 4 * n + 2 * i);
  });
  const header = Buffer.alloc(36);
  header.writeUInt16BE(4, 2);
  [
    [0, 3, 36],
    [0, 4, 36 + narrow.length],
    [3, 1, 36],
    [3, 10, 36 + narrow.length],
  ].forEach(([platform, encoding, offset], i) => {
    header.writeUInt16BE(platform, 4 + 8 * i);
    header.writeUInt16BE(encoding, 6 + 8 * i);
    header.writeUInt32BE(offset, 8 + 8 * i);
  });
  return Buffer.concat([header, narrow, wide]);
}
function renamed(table, family) {
  requireValue(table.u16(0) === 0, "Only format 0 font names are admitted");
  const count = table.u16(2),
    storage = table.u16(4),
    records = [],
    strings = [];
  requireValue(6 + 12 * count <= 65535, "Font names exceed header offset budget");
  let total = 0;
  for (let i = 0; i < count; i++) {
    const p = 6 + 12 * i,
      record = Buffer.from(table.range(p, 12)),
      platform = table.u16(p),
      name = table.u16(p + 6);
    let bytes = Buffer.from(table.range(storage + table.u16(p + 10), table.u16(p + 8)));
    if ([1, 3, 4, 6, 16, 18, 21].includes(name)) {
      requireValue([0, 1, 3].includes(platform), "Unknown font name encoding");
      bytes = Buffer.from(family, platform === 1 ? "ascii" : "utf16le");
      if (platform !== 1) bytes.swap16();
    }
    requireValue(total + bytes.length <= 65535, "Font name table exceeds offset budget");
    record.writeUInt16BE(bytes.length, 8);
    record.writeUInt16BE(total, 10);
    total += bytes.length;
    records.push(record);
    strings.push(bytes);
  }
  const header = Buffer.alloc(6);
  header.writeUInt16BE(count, 2);
  header.writeUInt16BE(6 + 12 * count, 4);
  return Buffer.concat([header, ...records, ...strings]);
}
function checksum(bytes) {
  let result = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    let word = 0;
    for (let j = 0; j < 4; j++) word = (word * 256 + (bytes[i + j] ?? 0)) >>> 0;
    result = (result + word) >>> 0;
  }
  return result;
}
function encodeFont(tables) {
  const ordered = [...tables]
    .filter(([tag]) => tag !== "DSIG")
    .sort(([a], [b]) => a.localeCompare(b));
  const count = ordered.length,
    directory = Buffer.alloc(12 + 16 * count),
    power = 2 ** Math.floor(Math.log2(count));
  directory.writeUInt32BE(0x00010000);
  directory.writeUInt16BE(count, 4);
  directory.writeUInt16BE(power * 16, 6);
  directory.writeUInt16BE(Math.log2(power), 8);
  directory.writeUInt16BE(count * 16 - power * 16, 10);
  const data = [];
  let offset = directory.length,
    headOffset;
  ordered.forEach(([tag, table], i) => {
    const bytes = Buffer.from(table.bytes ?? table),
      p = 12 + 16 * i;
    if (tag === "head") {
      requireValue(bytes.length >= 54, "Truncated font header");
      bytes.writeUInt32BE(0, 8);
      headOffset = offset;
    }
    directory.write(tag, p, 4, "ascii");
    directory.writeUInt32BE(checksum(bytes), p + 4);
    directory.writeUInt32BE(offset, p + 8);
    directory.writeUInt32BE(bytes.length, p + 12);
    const padding = Buffer.alloc((4 - (bytes.length % 4)) % 4);
    data.push(bytes, padding);
    offset += bytes.length + padding.length;
  });
  const result = Buffer.concat([directory, ...data]);
  result.writeUInt32BE((0xb1b0afba - checksum(result)) >>> 0, headOffset + 8);
  return result;
}

/** Bake the font's real tnum glyph substitution into a renamed static asset.
 * Never changes outlines, advances or license records. No shaping approximation. */
export function deriveTabularFont(input) {
  const tables = readFont(input),
    original = characterMap(tables.get("cmap")),
    lookups = tabularLookups(tables.get("GSUB"));
  const glyphCount = tables.get("maxp").u16(4),
    mapping = new Map(original);
  for (const [cp, initial] of mapping) {
    let glyph = initial;
    for (const lookup of lookups) glyph = lookup.get(glyph) ?? glyph;
    requireValue(glyph < glyphCount, "Substitution references an absent glyph");
    mapping.set(cp, glyph);
  }
  const metricCount = tables.get("hhea").u16(34),
    metrics = tables.get("hmtx");
  const widths = Array.from({ length: 10 }, (_, i) => {
    const glyph = mapping.get(48 + i);
    requireValue(glyph > 0 && metricCount > 0, "Tabular font needs decimal digit glyphs");
    return metrics.u16(Math.min(glyph, metricCount - 1) * 4);
  });
  requireValue(
    widths.every((width) => width > 0 && width === widths[0]),
    "tnum feature does not yield equal decimal advances",
  );
  const family = `RNRVariant-${hash(input).slice(0, 16)}-tnum`;
  tables.set("cmap", encodeCmap(mapping));
  tables.set("name", renamed(tables.get("name"), family));
  return {
    bytes: encodeFont(tables),
    family,
    sourceSha256: hash(input),
    digitAdvance: widths[0],
    characters: mapping.size,
  };
}

/** Prepare ordinary and explicitly requested variant faces in one owned build
 * directory. All sources/derivatives are validated before any font is written. */
export function prepareRokuFontAssets({ assets, families, variants = [], outputDirectory }) {
  variants ??= [];
  requireValue(
    typeof outputDirectory === "string" && outputDirectory.length > 0,
    "Choose a font output directory",
  );
  fontVariantFamily("validation", variants);
  requireValue(assets && Object.keys(assets).length > 0, "Supply font assets");
  const preparedFamilies = prepareFontFamilies(assets, families);
  const faces = [],
    sources = new Set();
  for (const [index, [family, path]] of Object.entries(assets).entries()) {
    requireValue(family.length > 0 && typeof path === "string", "Use named font file paths");
    const source = resolve(path),
      bytes = readFileSync(source);
    sources.add(source);
    faces.push({
      family,
      file: `font-${index}.ttf`,
      bytes,
      sourceSha256: hash(bytes),
      features: [],
    });
    if (variants.length) {
      requireValue(!family.includes("::"), "Variant family namespace is reserved");
      const { family: fontFamily, ...derived } = deriveTabularFont(bytes);
      faces.push({
        family: fontVariantFamily(family, variants),
        file: `font-${index}-tabular-nums.ttf`,
        ...derived,
        features: ["tnum"],
        fontFamily,
      });
    }
  }
  for (const face of faces)
    requireValue(
      !sources.has(resolve(outputDirectory, face.file)),
      "Output must not overwrite a font source",
    );
  mkdirSync(outputDirectory, { recursive: true });
  const prepared = faces.map(({ bytes, file, ...face }) => {
    const path = resolve(outputDirectory, file);
    writeFileSync(path, bytes);
    return { ...face, path, sha256: hash(bytes) };
  });
  return {
    assets: Object.fromEntries(prepared.map((face) => [face.family, face.path])),
    families: preparedFamilies,
    faces: prepared,
  };
}
