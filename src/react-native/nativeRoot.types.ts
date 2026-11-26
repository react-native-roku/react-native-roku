import type { TextRasterProvider } from "../graphics/textRaster.types";
import type { DeviceServices, TextEntryPort } from "../services/DeviceServices";
import type { SvgAtlas } from "../vector/svg.types";
import type { NativeGraphics } from "../graphics/surfaces";
import type { NativeSystemState } from "./NativeSystemState";
import type { NativeInput } from "./NativeInput";
import type { TextMetricProvider } from "../layout/textLayout";
export interface NativeRootOptions {
  readonly strictMode?: boolean;
  readonly textRaster?: TextRasterProvider;
  readonly services?: DeviceServices;
  readonly textEntry?: TextEntryPort;
  readonly svgAtlas?: SvgAtlas;
  readonly graphics?: NativeGraphics;
  readonly system?: NativeSystemState;
  readonly platformVersion?: string | number;
  readonly requestExit?: () => void;
  readonly input?: NativeInput;
  readonly viewport: { width: number; height: number };
  readonly text: TextMetricProvider;
  onError?(error: Error, kind: "uncaught" | "caught" | "recoverable"): void;
}
