import { RokuHostError } from "../scene/sceneGraph.types";

function component(name: string) {
  const unavailable = (): never => {
    throw new RokuHostError("C03_COMPONENT", `${name} has no admitted Roku implementation`);
  };
  unavailable.displayName = `RokuUnsupported${name}`;
  return unavailable;
}
// Interop libraries register all core component identities during initialization.
// Unimplemented identities remain importable and fail explicitly if rendered.
export const Image = component("Image"),
  ImageBackground = component("ImageBackground");
export const ScrollView = component("ScrollView"),
  FlatList = component("FlatList"),
  VirtualizedList = component("VirtualizedList");
export const Switch = component("Switch"),
  TextInput = component("TextInput"),
  ActivityIndicator = component("ActivityIndicator");
export const TouchableHighlight = component("TouchableHighlight"),
  TouchableOpacity = component("TouchableOpacity"),
  TouchableWithoutFeedback = component("TouchableWithoutFeedback");
export const StatusBar = component("StatusBar"),
  Modal = component("Modal"),
  KeyboardAvoidingView = component("KeyboardAvoidingView");
