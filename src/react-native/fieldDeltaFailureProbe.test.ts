import { createElement as h } from "react";
import { expect, it, vi } from "vitest";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { createNativeRoot } from "./createNativeRoot";
import { Text, View } from "./primitives";

it("recovers a failed retained field update with a complete subsequent tree", async () => {
  const scene = new RecordingSceneGraph();
  const font = scene.create("font");
  const prepare = vi.fn();
  const text = {
    prepare,
    font: () => font,
    preparedFieldFont: () => font,
    readRetainedFontLineHeight: () => 20,
    metrics: () => ({ lineHeight: 20, width: (s: string) => s.length * 7 }),
  };
  const root = createNativeRoot(scene, {
    viewport: { width: 320, height: 180 },
    text,
  });
  const style = { width: 150, height: 30 };
  const fixed = h(Text, { nativeID: "fixed", style }, "Fixed");
  const change = (name: string) =>
    root.render(h(View, null, h(Text, { nativeID: "title", style }, name), fixed));
  const fields = (id: string) => [...scene.nodes.values()].find((n) => n.fields.id === id)!.fields;
  try {
    change("One");
    await root.whenCommitted();
    prepare.mockClear();
    const set = scene.set.bind(scene);
    const spy = vi.spyOn(scene, "set").mockImplementation((node, field, value) => {
      if (field === "text" && value === "Failed") throw Error("native write failed");
      set(node, field, value);
    });
    change("Failed");
    await expect(root.whenCommitted()).rejects.toThrow("native write failed");
    expect(prepare).not.toHaveBeenCalled();
    expect(fields("title").text).toBe("One");
    expect(fields("fixed").text).toBe("Fixed");
    spy.mockRestore();
    change("Recovered");
    await root.whenCommitted();
    expect(fields("title").text).toBe("Recovered");
    expect(fields("fixed").text).toBe("Fixed");
    change("Next");
    await root.whenCommitted();
    expect(fields("title").text).toBe("Next");
    expect(fields("fixed").text).toBe("Fixed");
  } finally {
    root.unmount();
  }
});
