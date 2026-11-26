import type { NativeRemoteEvent, NativeRemoteKey } from "../react-native/NativeInput";
const keys: Readonly<Record<string, NativeRemoteKey>> = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  OK: "select",
  enter: "select",
  back: "back",
  play: "playPause",
  rewind: "rewind",
  fastforward: "fastForward",
  options: "options",
};
/** Firmware reports repeated presses without a separate repeat flag. */
export class RokuKeySession {
  private readonly held = new Set<NativeRemoteKey>();
  handle(key: string, press: boolean, dispatch: (event: NativeRemoteEvent) => boolean): boolean {
    const mapped = keys[key];
    if (!mapped) return false;
    const phase = press ? (this.held.has(mapped) ? "repeat" : "down") : "up";
    if (press) this.held.add(mapped);
    else this.held.delete(mapped);
    return dispatch({ key: mapped, phase });
  }
  reset(): void {
    this.held.clear();
  }
}
