import { RokuHostError } from "../scene/sceneGraph.types";

export type AppStateStatus = "active" | "inactive" | "background";
export type ColorSchemeName = "light" | "dark" | null;
export interface SystemSnapshot {
  readonly appState: AppStateStatus | null;
  readonly colorScheme: ColorSchemeName;
  readonly reduceMotion?: boolean;
  readonly screenReader?: boolean;
  readonly timeZone?: string;
}
export type SystemEvent = {
  readonly type:
    "appState" | "appearance" | "reduceMotion" | "screenReader" | "memoryWarning" | "timeZone";
  readonly value: unknown;
};

/** Facts are published by a lifecycle/accessibility adapter, never inferred from renderer identity. */
export class NativeSystemState {
  private snapshot: SystemSnapshot;
  private override: ColorSchemeName = null;
  private readonly listeners = new Set<(event: SystemEvent) => void>();
  constructor(
    initial: Partial<SystemSnapshot> = {},
    private readonly announce?: (message: string, options?: { queue?: boolean }) => void,
  ) {
    this.snapshot = Object.freeze({
      appState: null,
      colorScheme: null,
      ...initial,
    });
  }
  getSnapshot(): SystemSnapshot {
    return this.snapshot;
  }
  getColorScheme(): ColorSchemeName {
    return this.override ?? this.snapshot.colorScheme;
  }
  subscribe(listener: (event: SystemEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
  publish(next: Partial<SystemSnapshot>): void {
    const previousColor = this.getColorScheme();
    const previous = this.snapshot;
    this.snapshot = Object.freeze({ ...previous, ...next });
    if (previous.appState !== this.snapshot.appState)
      this.emit({ type: "appState", value: this.snapshot.appState });
    if (previousColor !== this.getColorScheme())
      this.emit({ type: "appearance", value: this.getColorScheme() });
    if (previous.reduceMotion !== this.snapshot.reduceMotion)
      this.emit({ type: "reduceMotion", value: this.snapshot.reduceMotion });
    if (previous.screenReader !== this.snapshot.screenReader)
      this.emit({ type: "screenReader", value: this.snapshot.screenReader });
    if (previous.timeZone !== this.snapshot.timeZone)
      this.emit({ type: "timeZone", value: this.snapshot.timeZone });
  }
  setColorScheme(scheme: ColorSchemeName | "unspecified"): void {
    const before = this.getColorScheme();
    this.override = scheme === "unspecified" ? null : scheme;
    if (before !== this.getColorScheme())
      this.emit({ type: "appearance", value: this.getColorScheme() });
  }
  async isReduceMotionEnabled(): Promise<boolean> {
    return this.known(this.snapshot.reduceMotion, "reduced motion");
  }
  async isScreenReaderEnabled(): Promise<boolean> {
    return this.known(this.snapshot.screenReader, "screen reader");
  }
  announceForAccessibility(message: string, options?: { queue?: boolean }): void {
    if (!this.announce)
      throw new RokuHostError(
        "C25_ANNOUNCE",
        "The host has no accessibility announcement capability",
      );
    this.announce(message, options);
  }
  publishMemoryWarning(): void {
    this.emit({ type: "memoryWarning", value: undefined });
  }
  private known(value: boolean | undefined, name: string): boolean {
    if (value === undefined)
      throw new RokuHostError(
        "C25_PREFERENCE_PENDING",
        `The device ${name} preference has not been supplied`,
      );
    return value;
  }
  private emit(event: SystemEvent) {
    for (const listener of [...this.listeners]) listener(event);
  }
}
