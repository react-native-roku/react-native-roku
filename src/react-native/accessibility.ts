/** One normalization owner for the RN/ARIA aliases used by all host primitives.
 * These are host semantics, never invented SceneGraph node fields. */
export interface AccessibilityProps {
  readonly role?: string;
  readonly accessible?: boolean;
  readonly accessibilityRole?: string;
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly accessibilityLabelledBy?: string | readonly string[];
  readonly accessibilityState?: {
    readonly disabled?: boolean;
    readonly selected?: boolean;
    readonly checked?: boolean | "mixed";
    readonly busy?: boolean;
    readonly expanded?: boolean;
  };
  readonly accessibilityValue?: {
    readonly min?: number;
    readonly max?: number;
    readonly now?: number;
    readonly text?: string;
  };
  readonly accessibilityLiveRegion?: "none" | "polite" | "assertive";
  readonly accessibilityViewIsModal?: boolean;
  readonly accessibilityElementsHidden?: boolean;
  readonly importantForAccessibility?: string;
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
  readonly "aria-describedby"?: string;
  readonly "aria-hidden"?: boolean;
  readonly "aria-modal"?: boolean;
  readonly "aria-live"?: "off" | "polite" | "assertive";
  readonly "aria-disabled"?: boolean;
  readonly "aria-selected"?: boolean;
  readonly "aria-checked"?: boolean | "mixed";
  readonly "aria-pressed"?: boolean | "mixed";
  readonly "aria-busy"?: boolean;
  readonly "aria-expanded"?: boolean;
  readonly "aria-valuemin"?: number;
  readonly "aria-valuemax"?: number;
  readonly "aria-valuenow"?: number;
  readonly "aria-valuetext"?: string;
  readonly "aria-current"?: boolean | string;
  readonly "aria-invalid"?: boolean | string;
  readonly "aria-haspopup"?: boolean | string;
  readonly "aria-roledescription"?: string;
  readonly "aria-level"?: number;
  readonly "aria-orientation"?: "horizontal" | "vertical";
}

type CurrentKind = "page" | "step" | "location" | "date" | "time";
type PopupKind = "menu" | "listbox" | "tree" | "grid" | "dialog";
const currentKinds = new Set<string>(["page", "step", "location", "date", "time"]);
const popupKinds = new Set<string>(["menu", "listbox", "tree", "grid", "dialog"]);
// Concrete RN/ARIA roles admitted by this host. A description changes speech,
// never the underlying role or the control's focus/input behavior.
const describedRoles = new Set(
  `alert alertdialog application article banner blockquote button caption cell checkbox code
  columnheader combobox complementary contentinfo definition deletion dialog directory document
  emphasis feed figure form grid gridcell group heading img insertion link list listbox listitem
  log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation note
  option paragraph progressbar radio radiogroup region row rowgroup rowheader scrollbar search
  searchbox separator slider spinbutton status strong subscript superscript switch tab table
  tablist tabpanel term time timer toolbar tooltip tree treegrid treeitem
  adjustable dropdownlist header image imagebutton keyboardkey summary tabbar text togglebutton`.split(
    /\s+/,
  ),
);

function currentState(value: unknown): boolean | CurrentKind | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (value === "" || value === "false") return false;
  return currentKinds.has(value) ? (value as CurrentKind) : true;
}

function invalidState(value: unknown): boolean | "grammar" | "spelling" | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (value === "" || value === "false") return false;
  return value === "grammar" || value === "spelling" ? value : true;
}

function popupKind(value: unknown): PopupKind | false | undefined {
  if (value == null) return undefined;
  if (value === true || value === "true") return "menu";
  return typeof value === "string" && popupKinds.has(value) ? (value as PopupKind) : false;
}

export interface AccessibilitySemantics {
  readonly role?: string;
  readonly roleDescription?: string;
  readonly level?: number;
  readonly orientation?: "horizontal" | "vertical";
  readonly popup?: PopupKind | false;
  readonly label?: string;
  readonly hint?: string;
  readonly labelledBy: readonly string[];
  readonly describedBy: readonly string[];
  readonly state: NonNullable<AccessibilityProps["accessibilityState"]> & {
    readonly pressed?: boolean | "mixed";
    readonly current?: boolean | CurrentKind;
    readonly invalid?: boolean | "grammar" | "spelling";
  };
  readonly value: NonNullable<AccessibilityProps["accessibilityValue"]>;
  readonly live: "none" | "polite" | "assertive";
  readonly modal: boolean;
}

const emptyReferences: readonly string[] = Object.freeze([]);
const emptyState: AccessibilitySemantics["state"] = Object.freeze({
  busy: undefined,
  checked: undefined,
  disabled: undefined,
  expanded: undefined,
  selected: undefined,
  pressed: undefined,
  current: undefined,
  invalid: undefined,
});
const emptyValue: AccessibilitySemantics["value"] = Object.freeze({
  min: undefined,
  max: undefined,
  now: undefined,
  text: undefined,
});

export function normalizeAccessibility(
  props: AccessibilityProps,
  disabled?: boolean,
): AccessibilitySemantics {
  const role = props.role ?? props.accessibilityRole;
  // ARIA IDREF lists use HTML whitespace, not commas. The RN alias supplies
  // explicit native identities (a string is one ID); never tokenize that alias.
  const labelledBy =
    props["aria-labelledby"]?.split(/[\t\n\f\r ]+/).filter(Boolean) ??
    props.accessibilityLabelledBy;
  const live = props["aria-live"];
  const description = props["aria-roledescription"];
  const level = props["aria-level"];
  const orientation = props["aria-orientation"];
  const state = props.accessibilityState;
  const busy = props["aria-busy"] ?? state?.busy;
  const checked = props["aria-checked"] ?? state?.checked;
  const inactive = disabled ?? props["aria-disabled"] ?? state?.disabled;
  const expanded = props["aria-expanded"] ?? state?.expanded;
  const selected = props["aria-selected"] ?? state?.selected;
  const pressed = props["aria-pressed"];
  const current = currentState(props["aria-current"]);
  const invalid = invalidState(props["aria-invalid"]);
  const value = props.accessibilityValue;
  const min = props["aria-valuemin"] ?? value?.min;
  const max = props["aria-valuemax"] ?? value?.max;
  const now = props["aria-valuenow"] ?? value?.now;
  const text = props["aria-valuetext"] ?? value?.text;
  return Object.freeze({
    role,
    roleDescription:
      role && describedRoles.has(role) && typeof description === "string"
        ? description.trim() || undefined
        : undefined,
    level:
      typeof level === "number" && Number.isSafeInteger(level) && level > 0 ? level : undefined,
    orientation:
      orientation === "horizontal" || orientation === "vertical" ? orientation : undefined,
    popup: popupKind(props["aria-haspopup"]),
    label: props["aria-label"] ?? props.accessibilityLabel,
    hint: props.accessibilityHint,
    labelledBy:
      labelledBy == null
        ? emptyReferences
        : Object.freeze(typeof labelledBy === "string" ? [labelledBy] : [...labelledBy]),
    describedBy:
      props["aria-describedby"] == null
        ? emptyReferences
        : Object.freeze(props["aria-describedby"].split(/[\t\n\f\r ]+/).filter(Boolean)),
    state:
      busy === undefined &&
      checked === undefined &&
      inactive === undefined &&
      expanded === undefined &&
      selected === undefined &&
      pressed === undefined &&
      current === undefined &&
      invalid === undefined
        ? emptyState
        : Object.freeze({
            busy,
            checked,
            disabled: inactive,
            expanded,
            selected,
            pressed,
            current,
            invalid,
          }),
    value:
      min === undefined && max === undefined && now === undefined && text === undefined
        ? emptyValue
        : Object.freeze({ min, max, now, text }),
    live:
      live === "off"
        ? "none"
        : (live ??
          props.accessibilityLiveRegion ??
          (role === "alert" ? "assertive" : role === "status" ? "polite" : "none")),
    modal: props["aria-modal"] ?? props.accessibilityViewIsModal ?? false,
  });
}

/** English speech profile over the documented Audio Guide service. Structural
 * roles remain in the committed semantics; firmware speech needs device review. */
export function accessibilitySpeech(semantics: AccessibilitySemantics, fallbackLabel = ""): string {
  const { role, state, value } = semantics;
  if (role === "none" || role === "presentation") return "";
  const words = [semantics.label ?? fallbackLabel];
  if (role)
    words.push(
      semantics.roleDescription ??
        (
          {
            img: "image",
            header: "heading",
            adjustable: "slider",
            progressbar: "progress",
            combobox: "combo box",
          } as Record<string, string>
        )[role] ??
        role,
    );
  if (semantics.level !== undefined) words.push(`level ${semantics.level}`);
  if (semantics.orientation) words.push(semantics.orientation);
  if (state.checked !== undefined)
    words.push(state.checked === "mixed" ? "mixed" : state.checked ? "checked" : "not checked");
  if (state.pressed !== undefined)
    words.push(state.pressed === "mixed" ? "mixed" : state.pressed ? "pressed" : "not pressed");
  if (state.selected) words.push("selected");
  if (state.expanded !== undefined) words.push(state.expanded ? "expanded" : "collapsed");
  if (state.disabled) words.push("disabled");
  if (state.busy) words.push("busy");
  if (state.current) words.push(state.current === true ? "current" : `current ${state.current}`);
  if (state.invalid)
    words.push(
      state.invalid === "grammar"
        ? "grammatical error"
        : state.invalid === "spelling"
          ? "spelling error"
          : "invalid entry",
    );
  if (semantics.popup)
    words.push(`has popup ${semantics.popup === "listbox" ? "list box" : semantics.popup}`);
  if (value.text !== undefined) words.push(value.text);
  else if (value.now !== undefined && Number.isFinite(value.now)) {
    words.push(String(value.now));
    if (
      value.min !== undefined &&
      value.max !== undefined &&
      Number.isFinite(value.min) &&
      Number.isFinite(value.max)
    )
      words.push(`range ${value.min} to ${value.max}`);
  }
  if (semantics.hint) words.push(semantics.hint);
  return words.filter((word) => word.trim().length > 0).join(", ");
}
