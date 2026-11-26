import React, { useState, useEffect } from "react";
import { Text, View, TextInput } from "react-native";
import { cssInterop, useColorScheme } from "react-native-css-interop";
import "./styles";
import { configureIntlTimeZone } from "react-native-roku/intl/en";

export function qualifyIntl() {
  configureIntlTimeZone("America/New_York");
  const currency = new Intl.NumberFormat("en", { style: "currency", currency: "USD" }).format(
    1234.5,
  );
  const numeric = new Intl.Collator("en", { numeric: true }).compare("item2", "item10");
  if (currency !== "$1,234.50" || numeric >= 0) throw Error("Metro lost required Intl data");
  return { currency, numeric };
}

const StyledView = cssInterop(View, { className: "style" });
const StyledInput = cssInterop(TextInput, { className: "style" });
export let update: (value: string) => void;
export let effectSetups = 0;
export let effectCleanups = 0;
export let observedLayout: { width: number; height: number } | undefined;

export default function App() {
  const [value, setValue] = useState("Metro cold start");
  update = setValue;
  useColorScheme();
  useEffect(() => {
    effectSetups++;
    return () => {
      effectCleanups++;
    };
  }, []);
  return (
    <StyledView
      nativeID="metro-box"
      className="metro-box"
      onLayout={(event) => {
        observedLayout = (event as { nativeEvent: { layout: { width: number; height: number } } })
          .nativeEvent.layout;
      }}
    >
      <Text>{value}</Text>
      <StyledInput
        nativeID="metro-focus-input"
        className="metro-input"
        defaultValue="Styled field"
      />
    </StyledView>
  );
}
