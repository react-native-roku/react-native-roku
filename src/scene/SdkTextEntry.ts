import type { DomNode, TmValue } from "@roku-sdk/interfaces";
import { tmTransaction } from "@roku-sdk/solid";
import { transactionManager } from "@roku-sdk/common/transaction";
import type { TextEntryPort, TextEntryRequest, TextEntrySession } from "../services/DeviceServices";
import { RokuHostError } from "./sceneGraph.types";
import { validateTextEntryRequest, validateTextEntryText } from "../services/textEntryRequest";

type Selection = Readonly<{ start: number; end: number }>;
type Entry = {
  id: number;
  maxLength: number;
  closing: boolean;
  revision: number;
  sequence: number;
  text: string;
  observedText?: string;
  listeners: Set<(text: string) => void>;
  selection?: Selection;
  selectionListeners: Set<(selection: Selection) => void>;
  timer: ReturnType<typeof setTimeout>;
  result(value: string | null): void;
  finish(value: string | null, observed: boolean): void;
};

/** Logical cancellation and observed native dismissal have separate lifetimes. */
export class SdkTextEntry implements TextEntryPort {
  private sequence = 0;
  private disposed = false;
  private current?: Entry;
  private readonly pending = new Map<number, Entry>();
  private readonly uncertain = new Set<number>();
  private readonly reply = (value: unknown) => {
    if (this.disposed || value === "") return;
    this.set("textEntryReply", "");
    if (typeof value !== "string" || value.length > 65536) return;
    let packet: {
      version?: number;
      id?: number;
      text?: unknown;
      closed?: boolean;
      revision?: number;
      draft?: boolean;
      caret?: boolean;
      prefix?: unknown;
      sequence?: number;
    } | null;
    try {
      packet = JSON.parse(value);
    } catch {
      return;
    }
    if (
      packet?.version !== 2 ||
      !Number.isSafeInteger(packet.id) ||
      packet.id! < 1 ||
      (packet.revision !== undefined &&
        (!Number.isSafeInteger(packet.revision) || packet.revision < 0))
    )
      return;
    const id = packet.id!;
    const entry = this.pending.get(id);
    if (packet.draft !== undefined || packet.caret !== undefined) {
      const isDraft = packet.draft === true && packet.caret === undefined;
      const isCaret = packet.caret === true && packet.draft === undefined;
      if (
        (!isDraft && !isCaret) ||
        !entry ||
        entry !== this.current ||
        entry.closing ||
        packet.revision !== entry.revision ||
        !Number.isSafeInteger(packet.sequence) ||
        packet.sequence! <= entry.sequence ||
        typeof packet.text !== "string" ||
        packet.text.length > 4096
      )
        return;
      const prefix = packet.prefix;
      if (prefix !== undefined || isCaret) {
        if (typeof prefix !== "string" || !packet.text.startsWith(prefix)) return;
        // Native supplies the actual prefix rather than a platform-specific
        // character index. JS length converts that prefix to RN UTF-16 units.
        const last = prefix.charCodeAt(prefix.length - 1);
        const next = packet.text.charCodeAt(prefix.length);
        if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) return;
      }
      if (isCaret && packet.text !== entry.text) return;
      entry.sequence = packet.sequence!;
      const text = packet.text.slice(0, entry.maxLength);
      const ownsPublication = () =>
        !entry.closing &&
        this.current === entry &&
        this.pending.has(id) &&
        entry.sequence === packet.sequence &&
        entry.revision === packet.revision;
      if (isDraft && text !== entry.text) {
        entry.text = text;
        entry.observedText = text;
        entry.selection = undefined;
        for (const listener of [...entry.listeners]) {
          if (!ownsPublication()) break;
          if (entry.listeners.has(listener)) this.notify(entry, listener, text);
        }
      }
      if (ownsPublication() && typeof prefix === "string" && packet.text === entry.text) {
        const selection = { start: prefix.length, end: prefix.length };
        const previous = entry.selection;
        entry.selection = selection;
        if (previous?.start === selection.start && previous.end === selection.end) return;
        for (const listener of [...entry.selectionListeners]) {
          if (!ownsPublication()) break;
          if (entry.selectionListeners.has(listener))
            this.notify(entry, listener, { ...selection });
        }
      }
      return;
    }
    if (typeof packet.closed !== "boolean") return;
    // A late acknowledgement may restore transport certainty, but cannot revive
    // an expired session or manufacture a late keyboard event.
    this.uncertain.delete(id);
    if (!entry) return;
    entry.finish(
      packet.closed && (packet.revision ?? 0) === entry.revision && typeof packet.text === "string"
        ? packet.text.slice(0, entry.maxLength)
        : null,
      packet.closed,
    );
  };
  constructor(private readonly node: DomNode) {
    this.set("onTextEntryReply", this.reply as TmValue);
  }
  private set(name: string, value: TmValue, previous?: TmValue) {
    transactionManager.startTransaction();
    tmTransaction.setProperty(this.node, name, value, previous);
  }
  private notify<Value>(entry: Entry, listener: (value: Value) => void, value: Value) {
    try {
      listener(value);
    } catch (error) {
      try {
        this.cancel(entry);
      } catch {
        /* Preserve the subscriber failure; cancellation retains uncertainty. */
      }
      throw error;
    }
  }
  private cancel(entry: Entry) {
    if (!this.pending.has(entry.id) || entry.closing) return;
    entry.closing = true;
    entry.text = "";
    entry.observedText = undefined;
    entry.listeners.clear();
    entry.selection = undefined;
    entry.selectionListeners.clear();
    if (this.current === entry) this.current = undefined;
    clearTimeout(entry.timer);
    entry.result(null);
    entry.timer = setTimeout(() => {
      this.uncertain.add(entry.id);
      entry.finish(null, false);
      // A queued successor cannot be admitted behind an unconfirmed dialog.
      for (const other of [...this.pending.values()]) {
        try {
          this.cancel(other);
        } catch {
          /* closed=false and uncertainty retain the failure */
        }
      }
    }, 10000);
    try {
      this.set("textEntryRequest", JSON.stringify({ version: 2, id: entry.id, close: true }));
    } catch (error) {
      this.uncertain.add(entry.id);
      entry.finish(null, false);
      throw error;
    }
  }
  open(request: TextEntryRequest): TextEntrySession {
    if (this.disposed || this.current || this.uncertain.size || this.pending.size >= 32)
      throw new RokuHostError("C07_TEXT_ENTRY", "Text entry is unavailable or already active");
    validateTextEntryRequest(request);
    const id = ++this.sequence;
    let resolveResult!: (value: string | null) => void,
      resolveClosed!: (observed: boolean) => void,
      settled = false;
    const result = new Promise<string | null>((resolve) => {
      resolveResult = resolve;
    });
    const closed = new Promise<boolean>((resolve) => {
      resolveClosed = resolve;
    });
    const entry: Entry = {
      id,
      maxLength: request.maxLength,
      closing: false,
      revision: 0,
      sequence: 0,
      text: request.text.slice(0, request.maxLength),
      listeners: new Set(),
      selectionListeners: new Set(),
      timer: setTimeout(() => {
        try {
          this.cancel(entry);
        } catch {
          /* closed=false reports the lost acknowledgement */
        }
      }, 600000),
      result(value) {
        if (!settled) {
          settled = true;
          resolveResult(value);
        }
      },
      finish: (value, observed) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(entry.timer);
        entry.text = "";
        entry.observedText = undefined;
        entry.listeners.clear();
        entry.selection = undefined;
        entry.selectionListeners.clear();
        if (this.current === entry) this.current = undefined;
        // Accepted text must reach TextInput before a hide callback can blur it.
        entry.result(value);
        resolveClosed(observed);
      },
    };
    this.pending.set(id, entry);
    this.current = entry;
    try {
      this.set(
        "textEntryRequest",
        JSON.stringify({
          ...request,
          version: 2,
          id,
          revision: 0,
          observeChanges: true,
          observeSelection: true,
        }),
      );
    } catch (error) {
      this.uncertain.add(id);
      entry.finish(null, false);
      throw error;
    }
    return {
      result,
      closed,
      setText: (text) => {
        validateTextEntryText(text);
        if (this.disposed || !this.pending.has(id) || entry.closing) return false;
        text = text.slice(0, entry.maxLength);
        // React commonly echoes an observed draft into its controlled value.
        // An unchanged echo must not invalidate a pending native submission.
        if (text === entry.text && entry.observedText === text) return true;
        entry.text = text;
        entry.observedText = undefined;
        entry.selection = undefined;
        entry.revision++;
        try {
          this.set(
            "textEntryRequest",
            JSON.stringify({
              version: 2,
              id,
              update: true,
              revision: entry.revision,
              text,
            }),
          );
        } catch (error) {
          try {
            this.cancel(entry);
          } catch {
            /* cancellation retains uncertainty */
          }
          throw error;
        }
        return true;
      },
      subscribeText: (listener) => {
        if (this.disposed || !this.pending.has(id) || entry.closing) return () => {};
        entry.listeners.add(listener);
        if (entry.observedText !== undefined) this.notify(entry, listener, entry.observedText);
        return () => entry.listeners.delete(listener);
      },
      subscribeSelection: (listener) => {
        if (this.disposed || !this.pending.has(id) || entry.closing) return () => {};
        entry.selectionListeners.add(listener);
        if (entry.selection !== undefined) this.notify(entry, listener, { ...entry.selection });
        return () => entry.selectionListeners.delete(listener);
      },
      close: () => this.cancel(entry),
    };
  }
  dismiss() {
    if (this.current) this.cancel(this.current);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    let failure: unknown;
    for (const entry of [...this.pending.values()]) {
      try {
        this.cancel(entry);
      } catch (error) {
        failure ??= error;
      }
      entry.finish(null, false);
    }
    this.uncertain.clear();
    try {
      this.set("onTextEntryReply", null as unknown as TmValue, this.reply as TmValue);
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }
}
