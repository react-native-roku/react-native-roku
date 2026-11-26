const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code, message) => {
  throw Error(`${code}: ${message}`);
};

/** Explicit physical assets, never filename conventions or synthetic styling. */
export function prepareFontFamilies(assets, families = {}) {
  if (!record(families) || Object.keys(families).length > 64)
    fail("C04_FONT_FACE_CONFIG", "Font families require a bounded declaration map");
  const result = Object.create(null);
  for (const [name, group] of Object.entries(families)) {
    if (
      !name.trim() ||
      Object.hasOwn(assets, name) ||
      !record(group) ||
      !Object.keys(group).length ||
      Object.keys(group).some((key) => !["normal", "italic"].includes(key))
    )
      fail(
        "C04_FONT_FACE_CONFIG",
        "A logical font family must have unique normal/italic face declarations",
      );
    const copied = Object.create(null);
    for (const [style, weights] of Object.entries(group)) {
      if (!record(weights) || !Object.keys(weights).length || Object.keys(weights).length > 9)
        fail("C04_FONT_FACE_CONFIG", "A font style needs explicit static weight faces");
      const faces = Object.create(null);
      for (const [weight, family] of Object.entries(weights)) {
        if (
          !/^[1-9]00$/.test(weight) ||
          typeof family !== "string" ||
          !Object.hasOwn(assets, family)
        )
          fail(
            "C04_FONT_FACE_CONFIG",
            "Each static weight must name a configured physical font asset",
          );
        faces[weight] = family;
      }
      copied[style] = Object.freeze(faces);
    }
    result[name] = Object.freeze(copied);
  }
  return Object.freeze(result);
}

export function fontFaceFamily(family, style, assets, families) {
  const authored = style.fontWeight ?? "normal";
  const weight = authored === "normal" ? "400" : authored === "bold" ? "700" : String(authored);
  if (!/^[1-9]00$/.test(weight))
    fail("C04_FONT_WEIGHT", "Static font weights must be normal, bold or 100–900 in steps of 100");
  const slant = style.fontStyle ?? "normal";
  if (slant !== "normal" && slant !== "italic")
    fail("C04_FONT_STYLE", "Only configured normal and italic faces are admitted");
  if (Object.hasOwn(families, family)) {
    const selected = families[family][slant]?.[weight];
    if (!selected) fail("C04_FONT_FACE", `No configured ${slant} ${weight} face for ${family}`);
    return selected;
  }
  if (!Object.hasOwn(assets, family))
    fail("C04_FONT_ASSET", `No packaged font asset for ${family}`);
  // Named physical families remain usable by shared controls that deliberately
  // normalize weight to 400 after selecting their own concrete face.
  if (slant === "normal" && weight === "400") return family;
  for (const group of Object.values(families)) {
    const faces = group[slant] ?? {};
    if (faces[weight] === family || (weight === "400" && Object.values(faces).includes(family)))
      return family;
  }
  // A control may select a physical weight first, then apply italic styling
  // while normalizing fontWeight to 400. Preserve that declared physical weight
  // when choosing its corresponding real italic file.
  const matches = new Set();
  if (slant === "italic")
    for (const group of Object.values(families))
      for (const [physicalWeight, asset] of Object.entries(group.normal ?? {}))
        if (asset === family && (weight === "400" || weight === physicalWeight)) {
          const selected = group.italic?.[physicalWeight];
          if (selected) matches.add(selected);
        }
  if (matches.size === 1) return matches.values().next().value;
  if (matches.size > 1)
    fail("C04_FONT_FACE", `Physical family ${family} has ambiguous italic selections`);
  fail("C04_FONT_FACE", `Physical family ${family} has no configured ${slant} ${weight} selection`);
}
