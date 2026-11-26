import type { LayoutStyle } from "./flexLayout";

const unsupported = Symbol("uncacheable layout value");
const builtinObjectProperties = new Set([
  "constructor",
  "__defineGetter__",
  "__defineSetter__",
  "hasOwnProperty",
  "__lookupGetter__",
  "__lookupSetter__",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "valueOf",
  "__proto__",
  "toLocaleString",
]);

export function hasOnlyBuiltinObjectPrototypeFields() {
  for (const key of Object.getOwnPropertyNames(Object.prototype))
    if (!builtinObjectProperties.has(key)) return false;
  return true;
}

/** Preserve numeric/type distinctions and detached nested style values. JSON
 * would confuse null with NaN and could bypass the ordinary layout validator. */
function capture(value: unknown, depth = 0): unknown {
  if (depth > 16) return unsupported;
  if (value === null || ["undefined", "string", "number", "boolean"].includes(typeof value))
    return value;
  if (Array.isArray(value)) {
    const items = value.map((item) => capture(item, depth + 1));
    return items.includes(unsupported) ? unsupported : items;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value).map(
      ([key, item]) => [key, capture(item, depth + 1)] as const,
    );
    return entries.some(([, item]) => item === unsupported)
      ? unsupported
      : Object.fromEntries(entries);
  }
  return unsupported;
}

function same(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (depth > 16 || !left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => same(item, right[index], depth + 1))
    );
  if (
    Object.getPrototypeOf(left) !== Object.prototype ||
    Object.getPrototypeOf(right) !== Object.prototype
  )
    return false;
  const entries = Object.entries(left);
  return (
    entries.length === Object.keys(right).length &&
    entries.every(
      ([key, value]) =>
        Object.hasOwn(right, key) &&
        same(value, (right as Record<string, unknown>)[key], depth + 1),
    )
  );
}

// Views paint their background after Yoga. Text metric providers may inspect
// the complete text style, including its background.
export interface LayoutStyleSnapshot {
  readonly values: LayoutStyle;
  readonly count: number;
}
function plainStyle(style: LayoutStyle) {
  const proto = Object.getPrototypeOf(style);
  return proto === Object.prototype || proto === null;
}
export function captureLayoutStyle(
  style: LayoutStyle,
  view: boolean,
): LayoutStyleSnapshot | undefined {
  if (!plainStyle(style)) return undefined;
  const values: Record<string, unknown> = Object.create(null);
  let count = 0;
  for (const key of Object.getOwnPropertyNames(style)) {
    if (key === "opacity" || (view && key === "backgroundColor")) continue;
    const item = capture(style[key]);
    if (item === unsupported) return undefined;
    values[key] = item;
    count++;
  }
  return { values, count };
}
export function sameLayoutStyle(
  style: LayoutStyle,
  captured: LayoutStyleSnapshot,
  view: boolean,
): boolean {
  if (!plainStyle(style)) return false;
  let count = 0;
  for (const key of Object.getOwnPropertyNames(style)) {
    if (key === "opacity" || (view && key === "backgroundColor")) continue;
    const previous = captured.values[key];
    if (
      (previous === undefined && !Object.hasOwn(captured.values, key)) ||
      !same(style[key], previous)
    )
      return false;
    count++;
  }
  return count === captured.count;
}
