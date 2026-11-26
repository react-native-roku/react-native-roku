import { restartDevChannel } from "../navigation/cold.mjs";

function valueAtFocus(xml, focus) {
  if (!/<plugin\b[^>]*\bid="dev"/.test(xml)) return;
  const tags = xml.match(/<[A-Za-z][^<>]*>/g) ?? [];
  if (!tags.some((tag) => tag.includes(`name="${focus}"`) && tag.includes('focused="true"')))
    return;
  const label = tags.find((tag) => tag.includes('name="settings-layout-value"'));
  return /\btext="(Comfortable|Compact)"/.exec(label)?.[1];
}

export async function verifySavedLayout(client, expect, save) {
  const editor = "settings-edit",
    toggle = "settings-layout";
  const initial = await expect("loaded", (xml) => Boolean(valueAtFocus(xml, editor)));
  const original = valueAtFocus(initial, editor);
  const changed = original === "Compact" ? "Comfortable" : "Compact";
  for (const [phase, before, after] of [
    ["change", original, changed],
    ["restore", changed, original],
  ]) {
    await client.keypress("Down");
    await expect(phase + "-focused", (xml) => valueAtFocus(xml, toggle) === before);
    await client.keypress("Select");
    await expect(phase + "-saved", (xml) => valueAtFocus(xml, toggle) === after);
    await restartDevChannel(client, (name, data) => save(phase + "-" + name, data));
    await expect(phase + "-after-cold-launch", (xml) => valueAtFocus(xml, editor) === after);
  }
}
