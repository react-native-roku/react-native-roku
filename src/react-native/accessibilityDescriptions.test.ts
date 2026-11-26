import { createElement, Fragment } from "react";
import { expect, it } from "vitest";
import { normalizeAccessibility } from "./accessibility";
import { createNativeRoot } from "./createNativeRoot";
import { NativeInput } from "./NativeInput";
import { NativeSystemState } from "./NativeSystemState";
import { Pressable, Text, View } from "./primitives";
import { useNativeHost, type NativeHostContextValue } from "./nativeHostContext";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

function fixture() {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    speech: { message: string; queue?: boolean }[] = [];
  const system = new NativeSystemState({ screenReader: true }, (message, options) =>
    speech.push({ message, queue: options?.queue }),
  );
  let host!: NativeHostContextValue;
  function Probe() {
    host = useNativeHost();
    return null;
  }
  const root = createNativeRoot(scene, {
    input,
    system,
    strictMode: true,
    viewport: { width: 400, height: 200 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
    },
  });
  const render = async (element: Parameters<typeof root.render>[0]) => {
    root.render(createElement(Fragment, {}, createElement(Probe), element));
    for (let index = 0; index < 4; index++) {
      await root.whenCommitted();
      root.flush();
    }
  };
  const focus = (id: string) => {
    const node = [...scene.nodes.values()].find((node) => node.fields.id === id)!;
    scene.emit(node, "focusedChild", id);
  };
  const dispose = () => {
    root.unmount();
    input.dispose();
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  };
  return {
    scene,
    input,
    speech,
    root,
    render,
    focus,
    dispose,
    placement: (id: string) => host.placement(id),
  };
}

it("parses description IDREFs with HTML whitespace and snapshots an immutable ordered list", () => {
  const semantics = normalizeAccessibility({
    "aria-describedby": " \tsecond\nfirst\r\fmissing second ",
  });
  expect(semantics.describedBy).toEqual(["second", "first", "missing", "second"]);
  expect(Object.isFrozen(semantics.describedBy)).toBe(true);
  expect(normalizeAccessibility({ "aria-describedby": "first,second" }).describedBy).toEqual([
    "first,second",
  ]);
  expect(normalizeAccessibility({ "aria-describedby": "first\u00a0second" }).describedBy).toEqual([
    "first\u00a0second",
  ]);
  expect(normalizeAccessibility({ "aria-describedby": "" }).describedBy).toEqual([]);
});

it("keeps the accessible name separate from ordered descriptions and native-hint fallback", async () => {
  const f = fixture();
  const render = (first: string | null, second: string | null, generation = 0) =>
    f.render(
      createElement(
        View,
        {},
        first === null
          ? null
          : createElement(Text, { nativeID: "first", key: "first-" + generation }, first),
        second === null ? null : createElement(Text, { nativeID: "second" }, second),
        createElement(Pressable, {
          nativeID: "control",
          role: "button",
          accessibilityLabel: "Answer",
          accessibilityHint: "Native hint",
          "aria-describedby": " second\tmissing first second ",
        }),
      ),
    );
  try {
    await render("Alpha", "Beta");
    f.focus("control");
    expect(f.speech.at(-1)?.message).toBe("Answer, button, Beta Alpha Beta");
    expect(f.placement("control")?.accessibility?.label).toBe("Answer");
    expect(f.placement("control")?.accessibility?.hint).toBe("Beta Alpha Beta");
    await render("Changed", "Beta", 1);
    expect(f.speech.at(-1)?.message).toBe("Answer, button, Beta Changed Beta");
    const count = f.speech.length;
    await render("Changed", "Beta", 1);
    expect(f.speech).toHaveLength(count);
    await render(null, "Beta");
    expect(f.speech.at(-1)?.message).toBe("Answer, button, Beta Beta");
    await render(null, null);
    expect(f.speech.at(-1)?.message).toBe("Answer, button, Native hint");
  } finally {
    f.dispose();
  }
});

it("lets an existing empty description suppress a native hint while missing IDs fall back", async () => {
  const f = fixture();
  const render = (source: boolean, ids = "empty") =>
    f.render(
      createElement(
        View,
        {},
        source ? createElement(Text, { nativeID: "empty" }, "") : null,
        createElement(Pressable, {
          nativeID: "control",
          accessibilityLabel: "Answer",
          accessibilityHint: "Fallback",
          "aria-describedby": ids,
        }),
      ),
    );
  try {
    await render(true);
    f.focus("control");
    expect(f.speech.at(-1)?.message).toBe("Answer");
    expect(f.placement("control")?.accessibility?.hint).toBe("");
    await render(false);
    expect(f.speech.at(-1)?.message).toBe("Answer, Fallback");
    await render(true, "");
    expect(f.placement("control")?.accessibility?.hint).toBe("Fallback");
  } finally {
    f.dispose();
  }
});

it.each([false, true])(
  "resolves final modal description exposure before tree order (%s)",
  async (sourceFirst) => {
    const f = fixture();
    const source = createElement(
      Text,
      { key: "outside", nativeID: "outside" },
      "Outside description",
    );
    const dialog = createElement(
      View,
      { key: "dialog", "aria-modal": true },
      createElement(Text, { nativeID: "inside" }, "Inside description"),
      createElement(Pressable, {
        nativeID: "control",
        accessibilityLabel: "Answer",
        accessibilityHint: "Fallback",
        "aria-describedby": "outside inside",
      }),
    );
    try {
      await f.render(
        createElement(View, {}, ...(sourceFirst ? [source, dialog] : [dialog, source])),
      );
      f.focus("control");
      expect(f.speech.at(-1)?.message).toBe("Answer, Inside description");
    } finally {
      f.dispose();
    }
  },
);

it("excludes hidden sources in the explicit host profile and restores them when exposed", async () => {
  const f = fixture();
  const render = (hidden: boolean) =>
    f.render(
      createElement(
        View,
        {},
        createElement(Text, { nativeID: "source", "aria-hidden": hidden }, "Description"),
        createElement(Pressable, {
          nativeID: "control",
          accessibilityLabel: "Answer",
          accessibilityHint: "Fallback",
          "aria-describedby": "source",
        }),
      ),
    );
  try {
    await render(false);
    f.focus("control");
    expect(f.speech.at(-1)?.message).toBe("Answer, Description");
    await render(true);
    expect(f.speech.at(-1)?.message).toBe("Answer, Fallback");
    await render(false);
    expect(f.speech.at(-1)?.message).toBe("Answer, Description");
  } finally {
    f.dispose();
  }
});

it.each([false, true])(
  "bounds description cycles against one direct source snapshot (%s)",
  async (reverse) => {
    const f = fixture();
    const nodes = [
      createElement(Text, { key: "a", nativeID: "a", "aria-describedby": "b" }, "Alpha"),
      createElement(Text, { key: "b", nativeID: "b", "aria-describedby": "a" }, "Beta"),
      createElement(Pressable, {
        key: "control",
        nativeID: "control",
        accessibilityLabel: "Answer",
        "aria-describedby": "a b",
      }),
    ];
    try {
      await f.render(createElement(View, {}, ...(reverse ? [...nodes].reverse() : nodes)));
      f.focus("control");
      expect(f.speech.at(-1)?.message).toBe("Answer, Alpha Beta");
    } finally {
      f.dispose();
    }
  },
);

it("publishes committed live description changes once and retires source authority", async () => {
  const f = fixture();
  const render = (value: string, active = true) =>
    f.render(
      createElement(
        View,
        {},
        createElement(Text, { nativeID: "description" }, value),
        active
          ? createElement(View, {
              nativeID: "status",
              role: "status",
              accessibilityLabel: "State",
              "aria-describedby": "description",
            })
          : null,
      ),
    );
  try {
    await render("Before");
    expect(f.speech.at(-1)).toEqual({ message: "State, status, Before", queue: true });
    await render("After");
    const count = f.speech.length;
    expect(f.speech.at(-1)?.message).toBe("State, status, After");
    await render("After");
    expect(f.speech).toHaveLength(count);
    await render("Retired", false);
    expect(f.speech).toHaveLength(count);
    for (const node of f.scene.nodes.values())
      expect(
        Object.keys(node.fields).some((key) => key.startsWith("aria-") || key === "accessibility"),
      ).toBe(false);
  } finally {
    f.dispose();
  }
});
