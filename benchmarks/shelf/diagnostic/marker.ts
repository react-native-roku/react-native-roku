type Value = string | number | boolean;
type Fields = Readonly<Record<string, Value>>;
type Device = typeof globalThis & {
  __shelfFocus?: { input: number; generation: number; card: string };
  __shelfInput?: number;
  roku?: { perfetto?: { instantEvent?: (name: string, params: Fields) => void } };
};

let input = 0;
let revision = 0;
type Focus = { input: number; generation: number; card: string };
const keys = new Map<string, number>();
const requests = new Map<string, Focus>();
const nodes = new WeakMap<object, string>();

export function mark(event: string, fields: Fields = {}): void {
  const trace = (globalThis as Device).roku?.perfetto;
  if (!trace?.instantEvent) return;
  const focus = (globalThis as Device).__shelfFocus;
  trace.instantEvent("shelf.mark", {
    event,
    input: (globalThis as Device).__shelfInput || focus?.input || 0,
    generation: focus?.generation ?? 0,
    card: focus?.card ?? "",
    jsMs: performance.now(),
    ...fields,
  });
}

export function currentInput(): number {
  return (globalThis as Device).__shelfInput ?? 0;
}

export function withInput<T>(sequence: number, work: () => T): T {
  const old = currentInput();
  (globalThis as Device).__shelfInput = sequence;
  try {
    return work();
  } finally {
    (globalThis as Device).__shelfInput = old;
  }
}

export function keyEvent<T>(key: string, press: boolean, work: () => T): T {
  const sequence = press ? (keys.get(key) ?? ++input) : (keys.get(key) ?? 0);
  if (press) keys.set(key, sequence);
  else keys.delete(key);
  return withInput(sequence, () => {
    mark("key.delivery", { key, press });
    return work();
  });
}

export function requestFocus(card: string): void {
  if (!card.startsWith("shelf-")) return;
  const record = { input: currentInput(), generation: ++revision, card };
  requests.set(card, record);
  mark("focus.request", record);
}

export function deliverFocus(card: string, focused: boolean): void {
  if (!card.startsWith("shelf-") || !focused) return;
  const focus = requests.get(card) ?? { input: currentInput(), generation: ++revision, card };
  (globalThis as Device).__shelfFocus = focus;
  requests.delete(card);
  mark("focus.delivery", focus);
}

export function field(
  node: object,
  parent: object | undefined,
  name: string,
  value: unknown,
): void {
  if (name === "id" && typeof value === "string") nodes.set(node, value);
  const card = nodes.get(node) ?? (parent ? nodes.get(parent) : undefined);
  if (
    !card ||
    (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
  )
    return;
  if (
    (card === "selection" && name === "text") ||
    (card.startsWith("shelf-") && (name === "color" || name === "gainFocus"))
  )
    mark("field.submit", { node: card, field: name, data: String(value) });
}
