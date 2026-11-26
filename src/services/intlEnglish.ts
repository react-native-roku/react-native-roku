// Opt-in English locale data. Dependency order is part of the FormatJS contract.
import "@formatjs/intl-getcanonicallocales/polyfill.js";
import "@formatjs/intl-locale/polyfill.js";
import "@formatjs/intl-pluralrules/polyfill.js";
import "@formatjs/intl-pluralrules/locale-data/en.js";
import "@formatjs/intl-numberformat/polyfill.js";
import "@formatjs/intl-numberformat/locale-data/en.js";
import "@formatjs/intl-datetimeformat/polyfill.js";
import { shouldPolyfill as shouldPolyfillCollator } from "@formatjs/intl-collator/should-polyfill.js";
import { RokuHostError } from "../scene/sceneGraph.types";

// Upstream locale/collation modules decode data before checking native support.
// Keep those modules lazy so a native host preserves its constructors without
// allocating fallback tables. A missing runtime receives the same full data.
const dateTimeFormat = Intl.DateTimeFormat as typeof Intl.DateTimeFormat & {
  readonly __addLocaleData?: unknown;
};
if (typeof dateTimeFormat.__addLocaleData === "function") {
  require("@formatjs/intl-datetimeformat/locale-data/en.js");
  require("@formatjs/intl-datetimeformat/add-golden-tz.js");
}
if (shouldPolyfillCollator()) require("@formatjs/intl-collator/polyfill.js");

// Roku names that are not IANA identifiers; standard aliases pass through the
// formatter's own validation. Never infer a zone from a model or current offset.
const timeZones: Readonly<Record<string, string>> = Object.freeze({
  "US/Puerto Rico-Virgin Islands": "America/Puerto_Rico",
  "US/Guam": "Pacific/Guam",
  "US/Samoa": "Pacific/Pago_Pago",
});

/** Call before application formatting. Native Intl keeps its own system zone;
 * the polyfill requires an explicit observed device zone or fixture zone. */
export function configureIntlTimeZone(timeZone?: string): {
  source: "native" | "polyfill";
  timeZone: string;
} {
  const formatter = Intl.DateTimeFormat as typeof Intl.DateTimeFormat & {
    __setDefaultTimeZone?: (zone: string) => void;
  };
  if (typeof formatter.__setDefaultTimeZone !== "function")
    return { source: "native", timeZone: new formatter().resolvedOptions().timeZone };
  if (!timeZone?.trim())
    throw new RokuHostError(
      "C23_TIME_ZONE",
      "Intl requires an observed device time zone before application startup",
    );
  const zone = timeZones[timeZone.trim()] ?? timeZone.trim();
  // Validate before changing the process default so a rejected observation cannot
  // corrupt existing formatting. The constructor also canonicalizes aliases.
  const canonical = new formatter("en", { timeZone: zone }).resolvedOptions().timeZone;
  formatter.__setDefaultTimeZone(canonical);
  return { source: "polyfill", timeZone: canonical };
}
