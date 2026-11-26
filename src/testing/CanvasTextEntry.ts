import type { TextEntryPort } from "../services/DeviceServices";
import { validateTextEntryRequest, validateTextEntryText } from "../services/textEntryRequest";
import { RokuHostError } from "../scene/sceneGraph.types";

export interface CanvasTextEntryPort extends TextEntryPort {
  isOpen(): boolean;
  dispose(): void;
}

/** Browser IO adapter; the application retains validation and focus policy. */
export function createCanvasTextEntry(owner: Document = document): CanvasTextEntryPort {
  const editors = new Set<{ dialog: HTMLDialogElement; abandon(): void }>();
  let disposed = false;
  return {
    isOpen: () => [...editors].some((entry) => entry.dialog.open),
    open(request) {
      if (disposed || [...editors].some((entry) => entry.dialog.open) || editors.size >= 32)
        throw new RokuHostError("C07_TEXT_ENTRY", "Text entry is unavailable or already active");
      validateTextEntryRequest(request);
      const dialog = owner.createElement("dialog"),
        form = owner.createElement("form"),
        label = owner.createElement("label"),
        input = owner.createElement("input"),
        accept = owner.createElement("button"),
        cancel = owner.createElement("button");
      form.method = "dialog";
      // keyboardType selects an editor domain; product validation stays in React.
      form.noValidate = true;
      label.textContent = request.title;
      input.value = request.text;
      input.maxLength = request.maxLength;
      input.type = request.secure ? "password" : request.domain === "email" ? "email" : "text";
      input.inputMode =
        request.domain === "numeric" ? "numeric" : request.domain === "email" ? "email" : "text";
      input.autocomplete = "off";
      label.append(input);
      accept.textContent = "OK";
      accept.type = "submit";
      cancel.textContent = "Cancel";
      cancel.type = "button";
      form.append(label, accept, cancel);
      dialog.append(form);
      let resolveResult!: (text: string | null) => void,
        resolveClosed!: (observed: boolean) => void;
      const result = new Promise<string | null>((resolve) => {
        resolveResult = resolve;
      });
      const closed = new Promise<boolean>((resolve) => {
        resolveClosed = resolve;
      });
      let closing = false,
        finished = false,
        settled = false;
      const textListeners = new Set<(text: string) => void>();
      type Selection = Readonly<{ start: number; end: number }>;
      const selectionListeners = new Set<(selection: Selection) => void>();
      let currentText = input.value,
        observedText: string | undefined,
        observedSelection: Selection | undefined,
        selectionRevision = 0,
        revision = 0;
      const settle = (text: string | null) => {
        if (!settled) {
          settled = true;
          resolveResult(text);
        }
      };
      const removers: (() => void)[] = [];
      const finish = (observed: boolean) => {
        if (finished) return;
        finished = true;
        textListeners.clear();
        selectionListeners.clear();
        observedSelection = undefined;
        currentText = "";
        observedText = undefined;
        settle(null);
        input.value = "";
        for (const remove of removers) remove();
        editors.delete(entry);
        dialog.remove();
        resolveClosed(observed);
      };
      const close = (text: string | null) => {
        if (finished || closing) return;
        closing = true;
        textListeners.clear();
        selectionListeners.clear();
        observedSelection = undefined;
        currentText = "";
        observedText = undefined;
        settle(text);
        input.value = "";
        try {
          dialog.close();
        } catch (error) {
          finish(false);
          throw error;
        }
      };
      const entry = {
        dialog,
        abandon() {
          try {
            close(null);
          } finally {
            finish(false);
          }
        },
      };
      const listen = (target: EventTarget, name: string, handler: EventListener) => {
        target.addEventListener(name, handler);
        removers.push(() => target.removeEventListener(name, handler));
      };
      const notify = <Value>(listener: (value: Value) => void, value: Value) => {
        try {
          listener(value);
        } catch (error) {
          try {
            close(null);
          } catch {
            /* Preserve the observer failure after attempting retirement. */
          }
          throw error;
        }
      };
      const publishSelection = () => {
        if (finished || closing || input.value !== currentText) return;
        const start = input.selectionStart,
          end = input.selectionEnd;
        // Email and other DOM input types may not expose selection. Never
        // synthesize an end-of-text cursor for those editors.
        if (start === null || end === null || start < 0 || end < start || end > currentText.length)
          return;
        const previous = observedSelection;
        observedSelection = { start, end };
        if (previous?.start === start && previous.end === end) return;
        const publication = ++selectionRevision,
          textRevision = revision;
        for (const listener of [...selectionListeners]) {
          if (finished || closing || textRevision !== revision || publication !== selectionRevision)
            break;
          if (selectionListeners.has(listener)) notify(listener, { start, end });
        }
      };
      listen(input, "input", () => {
        if (finished || closing) return;
        const text = input.value.slice(0, request.maxLength);
        if (text !== currentText) {
          currentText = text;
          observedText = text;
          observedSelection = undefined;
          const publication = ++revision;
          for (const listener of [...textListeners]) {
            if (finished || closing || revision !== publication) break;
            if (textListeners.has(listener)) notify(listener, text);
          }
        }
        publishSelection();
      });
      for (const name of ["select", "selectionchange", "keyup", "click"])
        listen(input, name, publishSelection);
      listen(owner, "selectionchange", publishSelection);
      listen(form, "submit", (event) => {
        event.preventDefault();
        close(input.value.slice(0, request.maxLength));
      });
      listen(cancel, "click", () => close(null));
      listen(dialog, "cancel", (event) => {
        event.preventDefault();
        close(null);
      });
      listen(dialog, "keydown", (event) => event.stopPropagation());
      listen(dialog, "keyup", (event) => event.stopPropagation());
      listen(dialog, "close", () => finish(true));
      editors.add(entry);
      try {
        owner.body.append(dialog);
        dialog.showModal();
        input.focus();
        publishSelection();
      } catch (error) {
        finish(false);
        throw error;
      }
      return {
        result,
        closed,
        setText(text) {
          validateTextEntryText(text);
          if (finished || closing) return false;
          text = text.slice(0, request.maxLength);
          if (text === input.value) {
            if (text !== currentText) observedText = undefined;
            currentText = text;
            publishSelection();
            return true;
          }
          currentText = text;
          observedText = undefined;
          observedSelection = undefined;
          revision++;
          input.value = text;
          publishSelection();
          return true;
        },
        subscribeText(listener) {
          if (finished || closing) return () => {};
          textListeners.add(listener);
          if (observedText !== undefined) notify(listener, observedText);
          return () => textListeners.delete(listener);
        },
        subscribeSelection(listener) {
          if (finished || closing) return () => {};
          selectionListeners.add(listener);
          if (observedSelection !== undefined) notify(listener, { ...observedSelection });
          return () => selectionListeners.delete(listener);
        },
        close: () => close(null),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      let failure: unknown;
      for (const entry of [...editors]) {
        try {
          entry.abandon();
        } catch (error) {
          failure ??= error;
        }
      }
      editors.clear();
      if (failure) throw failure;
    },
  };
}
