import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { CoreUiFixture } from "./coreUiFixture";

export default function Clipping() {
  const [square, setSquare] = useState(false);
  const [step, setStep] = useState(0);
  const onEvent = useCallback((event: string) => {
    if (event.startsWith("commit:")) setStep(Number(event.slice(7)));
    if (event === "press:2") setSquare((previous) => !previous);
  }, []);
  return (
    <View style={{ flex: 1, backgroundColor: "#101014" }}>
      <CoreUiFixture left={96} top={64} clipRadius={square ? 0 : 18} onEvent={onEvent} />
      <View
        style={{
          position: "absolute",
          left: 304,
          top: 64,
          width: 32,
          height: 32,
          backgroundColor: square ? "#d8d8d8" : "#484848",
        }}
      />
      <Text
        nativeID="clip-mode"
        style={{ position: "absolute", left: 304, top: 112, width: 420, height: 44 }}
      >
        {`${square ? "Square control" : "Rounded test"} ${step}`}
      </Text>
    </View>
  );
}
