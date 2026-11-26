import type { TextEntryRequest } from "./DeviceServices";
import { RokuHostError } from "../scene/sceneGraph.types";

export function validateTextEntryText(text: string): void {
  if (typeof text !== "string" || text.length > 4096)
    throw new RokuHostError("C07_TEXT_ENTRY", "Text entry update exceeds the supported contract");
}

export function validateTextEntryRequest(request: TextEntryRequest): void {
  if (
    typeof request.title !== "string" ||
    request.title.length > 256 ||
    typeof request.text !== "string" ||
    request.text.length > 4096 ||
    typeof request.secure !== "boolean" ||
    !["generic", "numeric", "email", "password"].includes(request.domain) ||
    !Number.isInteger(request.maxLength) ||
    request.maxLength < 1 ||
    request.maxLength > 4096
  )
    throw new RokuHostError("C07_TEXT_ENTRY", "Text entry request exceeds the supported contract");
}
