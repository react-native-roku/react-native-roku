export interface DeviceStorage {
  read(section: string, key: string): Promise<string | null>;
  write(section: string, key: string, value: string | null): Promise<void>;
}
export interface TextEntryRequest {
  readonly title: string;
  readonly text: string;
  readonly secure: boolean;
  readonly domain: "generic" | "numeric" | "email" | "password";
  readonly maxLength: number;
}
export interface TextEntrySession {
  /** Null ends editing without submission. Previously observed text changes
   * are not rolled back by cancellation. */
  readonly result: Promise<string | null>;
  /** True only for a port-observed dialog dismissal. Logical cancellation,
   * failed admission, disposal and missing acknowledgement settle false.
   * Omit when the port cannot supply native/DOM closure observations. */
  readonly closed?: Promise<boolean>;
  /** Replace an active draft without submitting it. False means the editor has
   * already closed; callers must fence its pending result. Optional for older
   * ports, which cannot admit active controlled/imperative text updates. */
  setText?(text: string): boolean;
  /** Observe user edits while the dialog is open. A late subscriber receives
   * the latest observed draft. Programmatic setText does not publish an edit.
   * Omit only for legacy ports that expose accepted text at submission. */
  subscribeText?(listener: (text: string) => void): () => void;
  /** Observe the editor's actual selection in UTF-16 offsets. Replay the latest
   * observation to a late subscriber; never infer a cursor from a text update.
   * Native keyboards may expose only a collapsed caret, while DOM ports can
   * report ranges. Omit when the port cannot observe selection. */
  subscribeSelection?(
    listener: (selection: Readonly<{ start: number; end: number }>) => void,
  ): () => void;
  close(): void;
}
export interface TextEntryPort {
  open(request: TextEntryRequest): TextEntrySession;
}
export interface DeviceServices {
  readonly textEntry?: TextEntryPort;
  /** Raw platform facts; shared playback code owns capability policy. */
  readonly nativeCapabilities?: {
    probe(request: Readonly<Record<string, unknown>>): Promise<unknown>;
    addListener(
      name: string,
      listener: (event: Readonly<Record<string, unknown>>) => void,
    ): { remove(): void };
  };
  readonly storage: DeviceStorage;
  randomUUID(): string;
  randomBytes(length: number): Uint8Array;
}
