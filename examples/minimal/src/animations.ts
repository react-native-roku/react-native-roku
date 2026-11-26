import { createElement } from "react";
import { createNativeRoot } from "react-native-roku";
import { View } from "react-native";
import { RecordingSceneGraph } from "react-native-roku/testing";
import {
  Easing,
  makeMutable,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
} from "react-native-reanimated";

/** Exercise the installed public animation adapter with an explicit host clock. */
export async function qualifyAnimations() {
  let time = 0,
    sequence = 0;
  const pending = new Map<number, () => void>();
  const clock = {
    now: () => time,
    request(callback: () => void) {
      const id = ++sequence;
      pending.set(id, callback);
      return id;
    },
    cancel(handle: unknown) {
      pending.delete(handle as number);
    },
  };
  const value = makeMutable(0, clock);
  const canceled: number[] = [];
  try {
    value.value = withTiming(1, { duration: 100, easing: Easing.linear }, (finished) => {
      if (!finished)
        value.value = withTiming(
          3,
          { duration: 100, easing: Easing.linear },
          (complete, current) => {
            if (!complete) canceled.push(Number(current));
          },
        );
    });
    value.value = withTiming(2, { duration: 100, easing: Easing.linear });
    if (pending.size !== 1) throw Error("Packed animation retained two replacement clocks");
    time = 50;
    const frame = [...pending.values()];
    pending.clear();
    frame.forEach((callback) => callback());
    if (Number(value.value) !== 1.5) throw Error("Packed animation lost the reentrant replacement");
    value.cancel();
    if (Number(pending.size) !== 0 || JSON.stringify(canceled) !== "[1.5]")
      throw Error("Packed animation failed exact replacement retirement");
    const observed: number[] = [];
    const release = value.subscribe(() => {
      if (value.value === 1) value.value = 2;
    });
    value.addListener(1, (next) => observed.push(next));
    value.value = 1;
    release();
    value.removeListener(1);
    if (JSON.stringify(observed) !== "[2]")
      throw Error("Packed animation delivered an obsolete publication after replacement");
  } finally {
    value.cancel();
    pending.clear();
  }
  const scene = new RecordingSceneGraph();
  const root = createNativeRoot(scene, {
    strictMode: true,
    viewport: { width: 400, height: 100 },
    text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 10 }) },
  });
  const first = makeMutable(0.25),
    second = makeMutable(0.4),
    clockSource = makeMutable(0);
  const timingCalls: Array<[string, boolean, number]> = [];
  function Consumer({ multiplier, alternate }: { multiplier: number; alternate: boolean }) {
    const derived = useDerivedValue(() => (alternate ? second.value : first.value) * multiplier);
    const style = useAnimatedStyle(() => ({ width: 100, height: 50, opacity: derived.value }));
    return createElement(View, { style });
  }
  const render = async (multiplier: number, alternate = false) => {
    root.render(createElement(Consumer, { multiplier, alternate }));
    await root.whenCommitted();
  };
  function TimingConsumer({ label }: { label: string }) {
    const derived = useDerivedValue(() =>
      withTiming(
        clockSource.value,
        {
          duration: 80,
          easing: (progress) => progress,
        },
        (finished, current) => timingCalls.push([label, finished, Number(current)]),
      ),
    );
    const style = useAnimatedStyle(() => ({ width: 100, height: 50, opacity: derived.value }));
    return createElement(View, { style });
  }
  try {
    await render(1);
    await render(2);
    if (Number(scene.root.children[0].fields.opacity) !== 0.5)
      throw Error("Packed derived style ignored committed React props");
    await render(2, true);
    root.runSync(() => {
      first.value = 0.1;
      second.value = 0.2;
    });
    if (Number(scene.root.children[0].fields.opacity) !== 0.4)
      throw Error("Packed derived style did not reconcile conditional subscriptions");
    root.render(createElement(TimingConsumer, { label: "old" }));
    await root.whenCommitted();
    root.runSync(() => {
      clockSource.value = 1;
    });
    timingCalls.length = 0;
    root.render(createElement(TimingConsumer, { label: "new" }));
    await root.whenCommitted();
    const deadline = Date.now() + 2000;
    while (Number(scene.root.children[0].fields.opacity) < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await root.whenCommitted();
    }
    if (
      Number(scene.root.children[0].fields.opacity) !== 1 ||
      JSON.stringify(timingCalls) !== '[["new",true,1]]'
    )
      throw Error("Packed derived timing restarted its clock or used an obsolete callback");
  } finally {
    root.unmount();
  }
  const retired = scene.operations.length;
  first.value = 0;
  second.value = 0;
  clockSource.value = 0;
  if (scene.nodes.size !== 1 || scene.operations.length !== retired)
    throw Error("Packed derived mapper retained retired listeners");
  return {
    reentrantReplacement: true,
    exactClockRetirement: true,
    publicationFencing: true,
    committedReactProps: true,
    conditionalDependencies: true,
    mapperRetirement: true,
    stableTimingClosure: true,
  };
}
