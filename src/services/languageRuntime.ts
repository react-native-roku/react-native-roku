/** Small standard-language gaps used by the shared graph on older Hermes VMs. */
export function relativeIndex(this: unknown, index: number) {
  if (this == null) throw new TypeError("at requires a receiver");
  const receiver = Object(this) as { length: unknown; [key: number]: unknown };
  const length = Math.min(
    Math.max(Math.trunc(+(receiver.length as number)) || 0, 0),
    Number.MAX_SAFE_INTEGER,
  );
  const integer = Math.trunc(+index) || 0;
  const position = integer < 0 ? length + integer : integer;
  return position >= 0 && position < length ? receiver[position] : undefined;
}
function stringAt(this: unknown, index: number) {
  if (this == null) throw new TypeError("at requires a receiver");
  return relativeIndex.call(`${this}`, index);
}
function hasOwn(value: unknown, key: PropertyKey) {
  if (value == null) throw new TypeError("hasOwn requires an object");
  return Object.prototype.hasOwnProperty.call(value, key);
}
const leases = new WeakMap<
  object,
  Map<PropertyKey, { references: number; value: unknown; previous?: PropertyDescriptor }>
>();

/** Native implementations win. Missing methods are leased across mounted hosts. */
export function installLanguageRuntime(
  target: Pick<typeof globalThis, "Array" | "String" | "Object"> = globalThis,
) {
  const releases: Array<() => void> = [];
  for (const [owner, key, value] of [
    [target.Array.prototype, "at", relativeIndex],
    [target.String.prototype, "at", stringAt],
    [target.Object, "hasOwn", hasOwn],
  ] as const) {
    let entries = leases.get(owner),
      entry = entries?.get(key);
    if (!entry && typeof owner[key as keyof typeof owner] === "function") continue;
    if (!entry) {
      const previous = Object.getOwnPropertyDescriptor(owner, key);
      Object.defineProperty(owner, key, {
        value,
        writable: true,
        configurable: true,
      });
      if (!entries) leases.set(owner, (entries = new Map()));
      entries.set(key, (entry = { references: 0, value, previous }));
    }
    entry.references++;
    releases.push(() => {
      if (--entry!.references) return;
      if (Object.getOwnPropertyDescriptor(owner, key)?.value === entry!.value) {
        if (entry!.previous) Object.defineProperty(owner, key, entry!.previous);
        else Reflect.deleteProperty(owner, key);
      }
      entries!.delete(key);
    });
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const release of releases) release();
  };
}
