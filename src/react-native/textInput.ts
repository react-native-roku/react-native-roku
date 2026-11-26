import {
  createElement,
  forwardRef,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Text, type NativeElementProps } from "./primitives";
import { aliasNativeViewHandle, type NativeViewHandle } from "./nativeViewHandle";
import { RokuHostError } from "../scene/sceneGraph.types";
import { useNativeHost } from "./nativeHostContext";
import type { TextEntrySession } from "../services/DeviceServices";
import { AppState } from "./environment";
import { prepareKeyboardFocus, trackKeyboardSession } from "./keyboard";

export interface NativeTextInputProps extends NativeElementProps {
  readonly value?: string;
  readonly defaultValue?: string;
  readonly editable?: boolean;
  readonly placeholder?: string;
  readonly placeholderTextColor?: string;
  readonly secureTextEntry?: boolean;
  readonly multiline?: boolean;
  readonly allowFontScaling?: boolean;
  readonly onChangeText?: (text: string) => void;
  readonly onSelectionChange?: (event: {
    nativeEvent: { selection: { start: number; end: number } };
  }) => void;
  readonly keyboardType?: string;
  readonly maxLength?: number;
  readonly onFocus?: (event: unknown) => void;
  readonly onBlur?: (event: unknown) => void;
  readonly onSubmitEditing?: (event: { nativeEvent: { text: string } }) => void;
}
export interface NativeTextInputHandle extends NativeViewHandle {
  focus(): void;
  blur(): void;
  clear(): void;
  isFocused(): boolean;
}

/** Text-backed input with an optional, explicitly admitted platform dialog. */
export const TextInput = forwardRef<NativeTextInputHandle, NativeTextInputProps>((props, ref) => {
  const host = useNativeHost();
  const label = useRef<NativeViewHandle>(null);
  const [text, setText] = useState(props.defaultValue ?? "");
  const [editCount, setEditCount] = useState(0);
  const value = props.value ?? text;
  const latestValue = useRef(value);
  latestValue.current = value;
  const mounted = useRef(true);
  const current = useRef(props);
  current.current = props;
  const session = useRef<TextEntrySession | undefined>(undefined);
  const requestEpoch = useRef(0);
  const editorText = useRef("");
  const textRelease = useRef<(() => void)[]>([]);
  const releaseText = () => {
    const releases = textRelease.current;
    textRelease.current = [];
    let failure: unknown;
    for (const release of releases) {
      try {
        release();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  };
  const keyboardRelease = useRef<(() => void) | undefined>(undefined);
  const releaseKeyboard = () => {
    keyboardRelease.current?.();
    keyboardRelease.current = undefined;
  };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestEpoch.current++;
      const pending = session.current;
      session.current = undefined;
      editorText.current = "";
      try {
        releaseKeyboard();
      } finally {
        try {
          releaseText();
        } finally {
          pending?.close();
        }
      }
    };
  }, []);
  const blur = () => {
    const pending = session.current;
    if (!pending) return;
    requestEpoch.current++;
    session.current = undefined;
    editorText.current = "";
    try {
      releaseKeyboard();
    } finally {
      try {
        releaseText();
      } finally {
        pending.close();
      }
    }
    current.current.onBlur?.({ nativeEvent: {} });
  };
  const updateEditor = (next: string) => {
    const pending = session.current;
    if (!pending) return;
    try {
      if (!pending.setText)
        throw new RokuHostError(
          "C07_TEXT_ENTRY",
          "The keyboard port cannot update an active editor",
        );
      editorText.current = next.slice(0, current.current.maxLength ?? 4096);
      if (pending.setText(next) === false) blur();
    } catch (error) {
      // An uncertain update cannot later submit the preceding draft.
      blur();
      throw error;
    }
  };
  useLayoutEffect(() => {
    if (props.editable === false) blur();
  }, [props.editable]);
  useLayoutEffect(() => {
    if (props.value !== undefined) updateEditor(props.value);
  }, [props.value, editCount]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background" || state === "inactive") blur();
    });
    return subscription.remove;
  }, []);
  useImperativeHandle(
    ref,
    () =>
      aliasNativeViewHandle(
        {
          get nativeID() {
            return label.current?.nativeID ?? "";
          },
          measure: (callback) => label.current?.measure(callback),
          measureInWindow: (callback) => label.current?.measureInWindow(callback),
          measureLayout: (relative, success, failure) =>
            label.current?.measureLayout(relative, success, failure),
          requestTVFocus: () => label.current?.requestTVFocus(),
          setNativeProps(values) {
            if (!mounted.current || !host.active)
              throw new RokuHostError(
                "RETIRED_VIEW",
                "A retired input cannot receive native props",
              );
            const { text: next, ...rest } = values;
            if (next !== undefined) {
              if (typeof next !== "string")
                throw new RokuHostError("C04_INPUT_TEXT", "Text input updates require a string");
              updateEditor(next);
              host.runSync(() => setText(next));
            }
            if (Object.keys(rest).length) label.current?.setNativeProps(rest);
          },
          clear() {
            if (!mounted.current || !host.active) return;
            updateEditor("");
            host.runSync(() => setText(""));
          },
          focus() {
            const input = current.current;
            if (
              !mounted.current ||
              !host.active ||
              input.editable === false ||
              session.current ||
              AppState.currentState === "background" ||
              AppState.currentState === "inactive"
            )
              return;
            const port = host.textEntry;
            if (!port)
              throw new RokuHostError(
                "C07_TEXT_ENTRY",
                "An editable input requires the native keyboard port",
              );
            const ownsRequest = prepareKeyboardFocus();
            if (!ownsRequest() || !mounted.current || !host.active || session.current) return;
            host.cancelInput();
            // Press-out/cancel callbacks may have admitted a newer editor.
            if (!ownsRequest() || !mounted.current || !host.active || session.current) return;
            const epoch = ++requestEpoch.current;
            const pending = port.open({
              title:
                input["aria-label"] ??
                input.accessibilityLabel ??
                input.placeholder ??
                "Enter text",
              text: latestValue.current,
              secure: input.secureTextEntry === true,
              domain: input.secureTextEntry
                ? "password"
                : input.keyboardType === "email-address"
                  ? "email"
                  : ["number-pad", "numeric", "decimal-pad", "phone-pad"].includes(
                        input.keyboardType ?? "",
                      )
                    ? "numeric"
                    : "generic",
              maxLength: input.maxLength ?? 4096,
            });
            if (!ownsRequest() || !mounted.current || !host.active) {
              pending.close();
              return;
            }
            session.current = pending;
            editorText.current = latestValue.current.slice(0, input.maxLength ?? 4096);
            const currentRequest = () =>
              mounted.current && host.active && requestEpoch.current === epoch;
            void pending.result.then((result) => {
              if (!currentRequest() || session.current !== pending) return;
              const next = result?.slice(0, current.current.maxLength ?? 4096);
              const changed = next !== editorText.current;
              session.current = undefined;
              editorText.current = "";
              releaseKeyboard();
              releaseText();
              host.runSync(() => {
                if (next !== undefined) {
                  setText(next);
                  if (current.current.value === undefined) latestValue.current = next;
                  if (changed) current.current.onChangeText?.(next);
                  if (!currentRequest()) return;
                  current.current.onSubmitEditing?.({ nativeEvent: { text: next } });
                }
                if (currentRequest()) current.current.onBlur?.({ nativeEvent: {} });
              });
            });
            keyboardRelease.current = trackKeyboardSession(
              pending,
              () => {
                if (session.current === pending) blur();
              },
              () => mounted.current && host.active,
            );
            try {
              current.current.onFocus?.({ nativeEvent: {} });
              if (!currentRequest() || session.current !== pending) return;
              const retain = (remove: (() => void) | undefined) => {
                // A synchronous replay may retire this input before subscribe
                // returns its remover. Never attach it to a successor.
                if (!currentRequest() || session.current !== pending) {
                  remove?.();
                  return false;
                }
                if (remove) textRelease.current.push(remove);
                return true;
              };
              const removeText = pending.subscribeText?.((text) => {
                if (!currentRequest() || session.current !== pending) return;
                const next = text.slice(0, current.current.maxLength ?? 4096);
                if (next === editorText.current) return;
                editorText.current = next;
                host.runSync(() => {
                  setText(next);
                  setEditCount((count) => count + 1);
                  if (current.current.value === undefined) latestValue.current = next;
                  current.current.onChangeText?.(next);
                });
              });
              if (!retain(removeText)) return;
              let lastSelection: { start: number; end: number } | undefined;
              retain(
                pending.subscribeSelection?.(({ start, end }) => {
                  if (!currentRequest() || session.current !== pending) return;
                  if (
                    !Number.isSafeInteger(start) ||
                    !Number.isSafeInteger(end) ||
                    start < 0 ||
                    end < start ||
                    end > editorText.current.length ||
                    (lastSelection?.start === start && lastSelection.end === end)
                  )
                    return;
                  lastSelection = { start, end };
                  if (current.current.onSelectionChange)
                    host.runSync(() =>
                      current.current.onSelectionChange?.({
                        nativeEvent: { selection: { start, end } },
                      }),
                    );
                }),
              );
            } catch (error) {
              if (session.current === pending) {
                try {
                  blur();
                } catch {
                  /* Retain the original focus/subscription failure. */
                }
              }
              throw error;
            }
          },
          blur,
          isFocused: () => mounted.current && session.current !== undefined,
        },
        () => label.current,
      ),
    [host],
  );
  const display = value || props.placeholder || "";
  return createElement(
    Text,
    {
      ...props,
      ref: label,
      focusable: false,
      numberOfLines: props.multiline ? 0 : 1,
      style: [
        props.style,
        !value && props.placeholderTextColor ? { color: props.placeholderTextColor } : undefined,
      ],
    },
    props.secureTextEntry && value ? "•".repeat(value.length) : display,
  );
});
TextInput.displayName = "RokuTextInput";
