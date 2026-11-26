import { createElement, createRef } from "react";
import { describe, expect, it } from "vitest";
import { normalizeAccessibility } from "./accessibility";
import { createNativeRoot } from "./createNativeRoot";
import { NativeSystemState } from "./NativeSystemState";
import { NativeInput } from "./NativeInput";
import { useNativeHost, type NativeHostContextValue } from "./nativeHostContext";
import { View, Text, Pressable } from "./primitives";
import type { NativeViewHandle } from "./nativeViewHandle";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { FlatList } from "./flatList";
import { TextInput } from "./textInput";

const text = {
  prepare() {},
  metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
};
function fixture() {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput();
  const speech: { message: string; queue?: boolean }[] = [];
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
    text,
    viewport: { width: 800, height: 600 },
  });
  return {
    scene,
    input,
    system,
    speech,
    root,
    get host() {
      return host;
    },
    async render(element: Parameters<typeof root.render>[0]) {
      root.render(createElement(View, {}, createElement(Probe), element));
      await root.whenCommitted();
    },
    focus(id: string) {
      const node = [...scene.nodes.values()].find((node) => node.fields.id === id)!;
      scene.emit(node, "focusedChild", id);
    },
    dispose() {
      root.unmount();
      input.dispose();
      expect(scene.nodes.size).toBe(1);
    },
  };
}

describe("committed accessibility semantics (host contracts; firmware speech pending)", () => {
  it("parses ARIA IDREF whitespace separately from explicit RN label identities", () => {
    expect(
      normalizeAccessibility({
        "aria-labelledby": " \tsecond\nfirst\r\fmissing  second ",
        accessibilityLabelledBy: ["native"],
      }).labelledBy,
    ).toEqual(["second", "first", "missing", "second"]);
    expect(normalizeAccessibility({ "aria-labelledby": "first,second" }).labelledBy).toEqual([
      "first,second",
    ]);
    expect(normalizeAccessibility({ "aria-labelledby": "first\u00a0second" }).labelledBy).toEqual([
      "first\u00a0second",
    ]);
    expect(
      normalizeAccessibility({ "aria-labelledby": "", accessibilityLabelledBy: ["native"] })
        .labelledBy,
    ).toEqual([]);
    expect(normalizeAccessibility({ accessibilityLabelledBy: "first second" }).labelledBy).toEqual([
      "first second",
    ]);
    const ids = ["second", "first"];
    const normalized = normalizeAccessibility({ accessibilityLabelledBy: ids });
    ids.reverse();
    expect(normalized.labelledBy).toEqual(["second", "first"]);
    expect(Object.isFrozen(normalized.labelledBy)).toBe(true);
  });

  it("resolves ordered committed labels and retires missing or replaced sources", async () => {
    const f = fixture();
    const render = (first: string | null, second: string, sourceKey = "original") =>
      f.render(
        createElement(
          View,
          {},
          first === null ? null : createElement(Text, { key: sourceKey, nativeID: "first" }, first),
          createElement(Text, { key: "second", nativeID: "second" }, second),
          createElement(Pressable, {
            key: "control",
            nativeID: "relationship-control",
            role: "button",
            "aria-labelledby": " second\tmissing first second ",
            accessibilityLabel: "Fallback",
          }),
        ),
      );
    try {
      await render("Alpha", "Beta");
      expect(f.speech).toEqual([]);
      f.focus("relationship-control");
      expect(f.speech.at(-1)?.message).toBe("Beta Alpha Beta, button");
      await render("Updated", "Beta");
      await render("Updated", "Beta");
      expect(f.speech.map((entry) => entry.message)).toEqual([
        "Beta Alpha Beta, button",
        "Beta Updated Beta, button",
      ]);
      await render(null, "Beta");
      expect(f.speech.at(-1)?.message).toBe("Beta Beta, button");
      await render("Replacement", "Beta", "replacement");
      expect(f.speech.at(-1)?.message).toBe("Beta Replacement Beta, button");
      await render(null, "");
      expect(f.speech.at(-1)?.message).toBe("Fallback, button");
    } finally {
      f.dispose();
    }
  });

  it.each([false, true])(
    "resolves modal exposure before labels regardless of source order (%s)",
    async (sourceFirst) => {
      const f = fixture();
      const source = createElement(Text, { key: "source", nativeID: "outside-label" }, "Outside");
      const dialog = createElement(
        View,
        { key: "dialog", nativeID: "relationship-dialog", "aria-modal": true },
        createElement(Pressable, {
          nativeID: "relationship-control",
          role: "button",
          "aria-labelledby": "outside-label",
          accessibilityLabel: "Inside",
        }),
      );
      try {
        await f.render(
          createElement(View, {}, ...(sourceFirst ? [source, dialog] : [dialog, source])),
        );
        expect(f.host.placement("outside-label")?.accessibilityHidden).toBe(true);
        f.focus("relationship-control");
        expect(f.speech.at(-1)?.message).toBe("Inside, button");
      } finally {
        f.dispose();
      }
    },
  );

  it.each([false, true])(
    "bounds cyclic label relationships without tree-order-dependent chaining (%s)",
    async (reverse) => {
      const f = fixture();
      const labels = [
        createElement(
          Text,
          { key: "alpha", nativeID: "alpha", "aria-labelledby": "beta" },
          "Alpha",
        ),
        createElement(Text, { key: "beta", nativeID: "beta", "aria-labelledby": "alpha" }, "Beta"),
      ];
      if (reverse) labels.reverse();
      try {
        await f.render(
          createElement(
            View,
            {},
            ...labels,
            createElement(Pressable, {
              nativeID: "relationship-control",
              role: "button",
              "aria-labelledby": "alpha beta",
            }),
          ),
        );
        f.focus("relationship-control");
        expect(f.speech.at(-1)?.message).toBe("Alpha Beta, button");
      } finally {
        f.dispose();
      }
    },
  );

  it("keeps hidden label exposure, replacement live speech and stale native focus bounded", async () => {
    const f = fixture();
    const render = (hidden: boolean, identity = "first", text = "Caption") =>
      f.render(
        createElement(
          View,
          {},
          createElement(Text, { key: "caption", nativeID: "caption", "aria-hidden": hidden }, text),
          createElement(Pressable, {
            key: identity,
            nativeID: "relationship-control",
            role: "button",
            "aria-labelledby": "caption",
            "aria-live": "polite",
            accessibilityLabel: "Fallback",
          }),
        ),
      );
    try {
      await render(false);
      expect(f.speech).toEqual([{ message: "Caption, button", queue: true }]);
      f.focus("relationship-control");
      const old = [...f.scene.nodes.values()].find(
        (node) => node.fields.id === "relationship-control",
      )!;
      await render(true);
      expect(f.speech.at(-1)?.message).toBe("Fallback, button");
      await render(false, "replacement", "New caption");
      const before = f.speech.length;
      f.scene.emit(old, "focusedChild", "relationship-control");
      expect(f.speech).toHaveLength(before);
      f.focus("relationship-control");
      expect(f.speech.at(-1)?.message).toBe("New caption, button");
      await f.render(null);
      expect(f.input.targetCount).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it("rejects duplicate native label identities before resolving relationships", async () => {
    const f = fixture();
    try {
      await expect(
        f.render(
          createElement(
            View,
            {},
            createElement(Text, { nativeID: "duplicate" }, "First"),
            createElement(Text, { nativeID: "duplicate" }, "Second"),
            createElement(Pressable, { nativeID: "control", "aria-labelledby": "duplicate" }),
          ),
        ),
      ).rejects.toThrow("Duplicate native view identity duplicate");
      expect(f.speech).toEqual([]);
    } finally {
      // A failed preparation remains an error during retirement too.
      try {
        f.root.unmount();
      } catch (error) {
        expect(String(error)).toContain("Duplicate native view identity duplicate");
      }
      f.input.dispose();
      expect(f.scene.nodes.size).toBe(1);
      expect(f.scene.listenerCount).toBe(0);
    }
  });

  it("normalizes ARIA token fallbacks without confusing current and selected states", () => {
    const result = normalizeAccessibility({
      "aria-current": "unrecognized-current-token",
      "aria-invalid": "unrecognized-invalid-token",
      "aria-haspopup": "tooltip",
      accessibilityState: { selected: false },
    });
    expect(result.state).toMatchObject({ current: true, invalid: true, selected: false });
    expect(result.popup).toBe(false);
    expect(Object.isFrozen(result.state)).toBe(true);
    for (const value of [false, "false", ""] as const) {
      const empty = normalizeAccessibility({
        "aria-current": value,
        "aria-invalid": value,
        "aria-haspopup": value,
      });
      expect(empty.state).toMatchObject({ current: false, invalid: false });
      expect(empty.popup).toBe(false);
    }
    for (const role of [undefined, "presentation", "none", "unknown-role"])
      expect(
        normalizeAccessibility({ role, "aria-roledescription": "override" }).roleDescription,
      ).toBeUndefined();
    for (const level of [0, -1, 1.5, Infinity, NaN])
      expect(normalizeAccessibility({ "aria-level": level }).level).toBeUndefined();
    expect(normalizeAccessibility({ "aria-level": 3 }).level).toBe(3);
    expect(
      normalizeAccessibility({ "aria-orientation": "diagonal" as never }).orientation,
    ).toBeUndefined();
  });

  it("uses descriptions in live regions and reports secure-field errors without exposing the value", async () => {
    const f = fixture();
    const renderInput = (value: string, invalid: boolean) =>
      f.render(
        createElement(TextInput, {
          nativeID: "secure-field",
          role: "textbox",
          accessibilityLabel: "Verification code",
          secureTextEntry: true,
          value,
          "aria-invalid": invalid,
          "aria-live": "assertive",
        }),
      );
    try {
      await f.render(
        createElement(View, {
          nativeID: "notice",
          role: "status",
          "aria-roledescription": "notification",
          accessibilityLabel: "Queue updated",
        }),
      );
      expect(f.speech).toEqual([{ message: "Queue updated, notification", queue: true }]);
      await renderInput("private value", true);
      expect(f.speech.at(-1)).toEqual({
        message: "Verification code, textbox, invalid entry",
        queue: false,
      });
      const count = f.speech.length;
      await renderInput("another private value", true);
      expect(f.speech).toHaveLength(count);
      await renderInput("another private value", false);
      expect(f.speech.at(-1)?.message).toBe("Verification code, textbox");
      expect(f.speech.every((entry) => !entry.message.includes("private value"))).toBe(true);
    } finally {
      f.dispose();
    }
  });

  it("announces current, invalid and popup changes only after observed focus and commit", async () => {
    const f = fixture();
    const render = (
      current: string | boolean | undefined,
      invalid: boolean | "spelling" | undefined,
      popup: string | boolean | undefined,
    ) =>
      f.render(
        createElement(Pressable, {
          nativeID: "state-control",
          role: "button",
          accessibilityLabel: "Browse",
          "aria-current": current,
          "aria-invalid": invalid,
          "aria-haspopup": popup,
        }),
      );
    try {
      await render("page", true, "dialog");
      expect(f.speech).toEqual([]);
      f.focus("state-control");
      expect(f.speech.at(-1)?.message).toBe(
        "Browse, button, current page, invalid entry, has popup dialog",
      );
      await render("date", "spelling", true);
      await render("date", "spelling", true);
      expect(f.speech.map((entry) => entry.message)).toEqual([
        "Browse, button, current page, invalid entry, has popup dialog",
        "Browse, button, current date, spelling error, has popup menu",
      ]);
      expect(f.host.placement("state-control")?.accessibility).toMatchObject({
        state: { current: "date", invalid: "spelling" },
        popup: "menu",
      });
      const node = [...f.scene.nodes.values()].find(
        (value) => value.fields.id === "state-control",
      )!;
      for (const field of ["aria-current", "aria-invalid", "aria-haspopup", "popup"])
        expect(node.fields).not.toHaveProperty(field);
      await render(false, false, false);
      expect(f.speech.at(-1)?.message).toBe("Browse, button");
      const count = f.speech.length;
      await f.render(null);
      await render("page", true, "dialog");
      expect(f.speech).toHaveLength(count);
      f.focus("state-control");
      expect(f.speech).toHaveLength(count + 1);
    } finally {
      f.dispose();
    }
  });

  it("preserves structural roles while announcing authored descriptions, levels and orientations", async () => {
    const f = fixture();
    const render = (
      role: string,
      description?: string,
      level?: number,
      orientation?: "horizontal" | "vertical",
    ) =>
      f.render(
        createElement(Pressable, {
          nativeID: "structure-control",
          role,
          accessibilityLabel: "Chapter",
          "aria-roledescription": description,
          "aria-level": level,
          "aria-orientation": orientation,
        }),
      );
    try {
      await render("heading", undefined, 3);
      f.focus("structure-control");
      expect(f.speech.at(-1)?.message).toBe("Chapter, heading, level 3");
      await render("region", "carousel");
      expect(f.speech.at(-1)?.message).toBe("Chapter, carousel");
      expect(f.host.placement("structure-control")?.accessibility).toMatchObject({
        role: "region",
        roleDescription: "carousel",
      });
      await render("region", "  ");
      expect(f.speech.at(-1)?.message).toBe("Chapter, region");
      await render("separator", "resize handle", undefined, "vertical");
      expect(f.speech.at(-1)?.message).toBe("Chapter, resize handle, vertical");
      await render("separator", undefined, undefined, "horizontal");
      expect(f.speech.at(-1)?.message).toBe("Chapter, separator, horizontal");
      await render("separator");
      expect(f.speech.at(-1)?.message).toBe("Chapter, separator");
    } finally {
      f.dispose();
    }
  });

  it("announces toggle pressed state on observed focus and committed changes without inventing native fields", async () => {
    const f = fixture();
    const render = (pressed: boolean | "mixed" | undefined, hidden = false) =>
      f.render(
        createElement(Pressable, {
          nativeID: "toggle",
          role: "button",
          accessibilityLabel: "Repeat",
          "aria-pressed": pressed,
          "aria-hidden": hidden,
        }),
      );
    try {
      await render(false);
      expect(f.speech).toEqual([]);
      f.focus("toggle");
      await render(true);
      await render(true);
      await render("mixed");
      expect(f.speech.map((entry) => entry.message)).toEqual([
        "Repeat, button, not pressed",
        "Repeat, button, pressed",
        "Repeat, button, mixed",
      ]);
      expect(f.host.placement("toggle")?.accessibility?.state).toMatchObject({ pressed: "mixed" });
      const node = [...f.scene.nodes.values()].find((node) => node.fields.id === "toggle")!;
      expect(node.fields).not.toHaveProperty("aria-pressed");
      expect(node.fields).not.toHaveProperty("accessibilityState");
      await render(false, true);
      expect(f.speech).toHaveLength(3);
      await f.render(null);
      await render(false);
      expect(f.speech).toHaveLength(3);
      f.focus("toggle");
      expect(f.speech.at(-1)?.message).toBe("Repeat, button, not pressed");
      await render(undefined);
      expect(f.speech.at(-1)?.message).toBe("Repeat, button");
    } finally {
      f.dispose();
    }
  });

  it("isolates nested modals according to the SceneGraph hierarchy rather than comparing unrelated z-index values", async () => {
    const f = fixture();
    try {
      await f.render(
        createElement(
          View,
          {},
          createElement(
            View,
            { nativeID: "outer", "aria-modal": true, style: { zIndex: 10 } },
            createElement(Pressable, { nativeID: "outer-button", accessibilityLabel: "Outer" }),
            createElement(
              View,
              { nativeID: "nested", "aria-modal": true, style: { zIndex: 0 } },
              createElement(Pressable, { nativeID: "nested-button", accessibilityLabel: "Nested" }),
            ),
          ),
          createElement(
            View,
            { nativeID: "behind", "aria-modal": true, style: { zIndex: 5 } },
            createElement(Pressable, { nativeID: "behind-button", accessibilityLabel: "Behind" }),
          ),
        ),
      );
      expect(f.host.placement("nested-button")?.accessibilityHidden).toBe(false);
      expect(f.input.isTargetEnabled("nested-button")).toBe(true);
      expect(f.host.placement("outer-button")?.accessibilityHidden).toBe(true);
      expect(f.host.placement("behind-button")?.accessibilityHidden).toBe(true);
      expect(f.input.isTargetEnabled("outer-button")).toBe(false);
    } finally {
      f.dispose();
    }
  });
  it("forwards shared accessibility metadata through lists, scroll hosts and text entry", async () => {
    const f = fixture();
    try {
      await f.render(
        createElement(
          View,
          {},
          createElement(FlatList<string>, {
            nativeID: "list",
            data: ["one"],
            role: "list",
            accessibilityLabel: "Results",
            accessibilityState: { busy: true },
            renderItem: ({ item }) => createElement(Text, {}, item),
          }),
          createElement(TextInput, {
            nativeID: "entry",
            role: "searchbox",
            "aria-label": "Search",
            accessibilityState: { disabled: true },
          }),
        ),
      );
      expect(f.host.placement("list")?.accessibility).toMatchObject({
        role: "list",
        label: "Results",
        state: { busy: true },
      });
      expect(f.host.placement("entry")?.accessibility).toMatchObject({
        role: "searchbox",
        label: "Search",
        state: { disabled: true },
      });
    } finally {
      f.dispose();
    }
  });
  it("uses RN alias precedence including false/zero/empty values and immutable state snapshots", () => {
    const state = { checked: true, expanded: true, disabled: true, busy: true, selected: true };
    const result = normalizeAccessibility({
      accessibilityRole: "button",
      role: "checkbox",
      accessibilityLabel: "old",
      "aria-label": "",
      accessibilityState: state,
      "aria-checked": false,
      "aria-expanded": false,
      "aria-disabled": false,
      "aria-selected": false,
      "aria-busy": false,
      accessibilityValue: { min: 1, max: 9, now: 5, text: "old" },
      "aria-valuemin": 0,
      "aria-valuenow": 0,
      "aria-valuetext": "",
      accessibilityLiveRegion: "assertive",
      "aria-live": "off",
      accessibilityViewIsModal: true,
      "aria-modal": false,
    });
    expect(result).toMatchObject({
      role: "checkbox",
      label: "",
      state: { checked: false, expanded: false, disabled: false, selected: false, busy: false },
      value: { min: 0, max: 9, now: 0, text: "" },
      live: "none",
      modal: false,
    });
    state.checked = false;
    expect(Object.isFrozen(result.state)).toBe(true);
    expect(normalizeAccessibility({ role: "alert" }).live).toBe("assertive");
    expect(normalizeAccessibility({ role: "status" }).live).toBe("polite");
  });

  it("announces observed focus, roles, states, values and hints; commits updates without fabricating fields", async () => {
    const f = fixture(),
      ref = createRef<NativeViewHandle>();
    const render = (checked: boolean) =>
      f.render(
        createElement(Pressable, {
          nativeID: "checkbox",
          ref,
          role: "checkbox",
          accessibilityLabel: "Include watched",
          accessibilityState: { checked },
          accessibilityHint: "Press OK to change",
        }),
      );
    try {
      await render(false);
      ref.current!.requestTVFocus();
      expect(f.speech).toEqual([]);
      f.focus("checkbox");
      await f.root.whenCommitted();
      expect(f.speech.map((value) => value.message)).toEqual([
        "Include watched, checkbox, not checked, Press OK to change",
      ]);
      await render(true);
      await render(true);
      expect(f.speech.map((value) => value.message)).toEqual([
        "Include watched, checkbox, not checked, Press OK to change",
        "Include watched, checkbox, checked, Press OK to change",
      ]);
      expect(f.host.placement("checkbox")?.accessibility?.state.checked).toBe(true);
      const native = [...f.scene.nodes.values()].find((node) => node.fields.id === "checkbox")!;
      expect(native.fields).not.toHaveProperty("accessibilityState");
      expect(native.fields).not.toHaveProperty("role");
      f.system.publish({ appState: "background" });
      await render(false);
      expect(f.speech).toHaveLength(2);
    } finally {
      f.dispose();
    }
  });

  it("resolves labelled-by against committed text, preserves value text and explicit disabled precedence", async () => {
    const f = fixture();
    try {
      await f.render(
        createElement(
          View,
          {},
          createElement(Text, { nativeID: "caption" }, "Playback speed"),
          createElement(Pressable, {
            nativeID: "slider",
            role: "slider",
            "aria-labelledby": "caption",
            accessibilityLabel: "fallback",
            accessibilityValue: { min: 0, max: 2, now: 1 },
            "aria-valuetext": "Normal",
            disabled: false,
            "aria-disabled": true,
          }),
        ),
      );
      f.focus("slider");
      expect(f.speech.map((value) => value.message)).toEqual(["Playback speed, slider, Normal"]);
      expect(f.host.placement("slider")?.accessibility?.state.disabled).toBe(false);
      await f.render(
        createElement(Pressable, {
          nativeID: "slider",
          accessibilityRole: "adjustable",
          accessibilityLabel: "Volume",
          accessibilityValue: { min: 0, max: 100, now: 25 },
        }),
      );
      f.focus("slider");
      expect(f.speech.at(-1)?.message).toBe("Volume, slider, 25, range 0 to 100");
    } finally {
      f.dispose();
    }
  });

  it("queues polite live updates, interrupts assertive ones, coalesces duplicates and retires removed regions", async () => {
    const f = fixture();
    const render = (value: string, busy = false, live: "polite" | "assertive" | "off" = "polite") =>
      f.render(
        createElement(Text, { nativeID: "notice", "aria-live": live, "aria-busy": busy }, value),
      );
    try {
      await render("Loading", true);
      expect(f.speech).toEqual([]);
      await render("Ready");
      await render("Ready");
      expect(f.speech).toEqual([{ message: "Ready", queue: true }]);
      await render("Failed", false, "assertive");
      expect(f.speech.at(-1)).toEqual({ message: "Failed", queue: false });
      await render("Hidden", false, "off");
      expect(f.speech).toHaveLength(2);
      await f.render(null);
      await render("Ready");
      expect(f.speech).toHaveLength(3);
      f.system.publish({ screenReader: false });
      await render("Silent");
      expect(f.speech).toHaveLength(3);
    } finally {
      f.dispose();
    }
  });

  it("isolates the top modal, blocks background activation and restores exposure when it closes", async () => {
    const f = fixture();
    let presses = 0;
    const render = (modal: boolean) =>
      f.render(
        createElement(
          View,
          {},
          createElement(Pressable, {
            nativeID: "background",
            accessibilityLabel: "Background",
            onPress: () => presses++,
          }),
          modal
            ? createElement(
                View,
                {
                  nativeID: "dialog",
                  role: "dialog",
                  "aria-modal": true,
                  accessibilityLabel: "Preferences",
                },
                createElement(Pressable, {
                  nativeID: "radio",
                  accessibilityRole: "radio",
                  accessibilityState: { checked: true },
                  accessibilityLabel: "Dark",
                }),
              )
            : null,
        ),
      );
    try {
      await render(false);
      f.focus("background");
      await f.root.whenCommitted();
      await render(true);
      expect(f.host.placement("background")?.accessibilityHidden).toBe(true);
      expect(f.input.isTargetEnabled("background")).toBe(false);
      f.input.dispatch({ key: "select", phase: "down" });
      f.input.dispatch({ key: "select", phase: "up" });
      expect(presses).toBe(0);
      f.focus("radio");
      await f.root.whenCommitted();
      expect(f.speech.at(-1)?.message).toBe("Dark, radio, checked");
      await render(false);
      expect(f.host.placement("background")?.accessibilityHidden).toBe(false);
      f.focus("background");
      expect(f.speech.at(-1)?.message).toBe("Background");
    } finally {
      f.dispose();
    }
  });

  it("honors aria-hidden precedence, presentation roles, unmount and stale focus callbacks", async () => {
    const f = fixture();
    try {
      await f.render(
        createElement(
          View,
          { accessibilityElementsHidden: true, "aria-hidden": false },
          createElement(Pressable, {
            nativeID: "control",
            role: "button",
            accessibilityLabel: "Visible",
          }),
        ),
      );
      f.focus("control");
      expect(f.speech.at(-1)?.message).toBe("Visible, button");
      await f.render(
        createElement(Pressable, {
          nativeID: "control",
          role: "presentation",
          accessibilityLabel: "Silent",
        }),
      );
      expect(f.speech).toHaveLength(1);
      await f.render(null);
      f.host.announceFocus("control");
      expect(f.speech).toHaveLength(1);
      expect(f.input.targetCount).toBe(0);
    } finally {
      f.dispose();
    }
  });
});
