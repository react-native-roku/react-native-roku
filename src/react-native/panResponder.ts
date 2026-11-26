type Event = {
  nativeEvent: {
    pageX?: number;
    pageY?: number;
    locationX?: number;
    locationY?: number;
    timestamp?: number;
    touches?: readonly unknown[];
  };
};
interface Gesture {
  stateID: number;
  moveX: number;
  moveY: number;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  vx: number;
  vy: number;
  numberActiveTouches: number;
}
type Config = Readonly<Record<string, ((event: Event, gesture: Gesture) => unknown) | undefined>>;
let sequence = 0;
/** Pure responder normalization. It does not advertise a native touch source on Roku. */
export const PanResponder = Object.freeze({
  create(config: Config) {
    let at = 0,
      gesture: Gesture = {
        stateID: ++sequence,
        moveX: 0,
        moveY: 0,
        x0: 0,
        y0: 0,
        dx: 0,
        dy: 0,
        vx: 0,
        vy: 0,
        numberActiveTouches: 0,
      };
    const update = (event: Event, start = false) => {
      const x = event.nativeEvent.pageX ?? event.nativeEvent.locationX ?? 0,
        y = event.nativeEvent.pageY ?? event.nativeEvent.locationY ?? 0,
        now = event.nativeEvent.timestamp ?? Date.now(),
        elapsed = now - at;
      if (start) gesture = { ...gesture, x0: x, y0: y, dx: 0, dy: 0, vx: 0, vy: 0 };
      gesture = {
        ...gesture,
        vx: elapsed > 0 ? (x - gesture.moveX) / elapsed : 0,
        vy: elapsed > 0 ? (y - gesture.moveY) / elapsed : 0,
        moveX: x,
        moveY: y,
        dx: x - gesture.x0,
        dy: y - gesture.y0,
        numberActiveTouches: event.nativeEvent.touches?.length ?? 1,
      };
      at = now;
    };
    const handlers: Record<string, (event: Event) => unknown> = {};
    for (const [name, callback] of Object.entries(config))
      if (callback) {
        const mapped = name.replace("PanResponder", "Responder");
        handlers[mapped] = (event) => {
          update(event, name === "onStartShouldSetPanResponder" || name === "onPanResponderGrant");
          const result = callback(event, gesture);
          if (name === "onPanResponderRelease" || name === "onPanResponderTerminate")
            gesture.numberActiveTouches = 0;
          return result;
        };
      }
    return { panHandlers: handlers };
  },
});
