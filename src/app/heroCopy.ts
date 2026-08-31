import type { InputMode } from "../domain/models";
import { uiCopy } from "./i18n";
import type { Language } from "./preferences";

export function heroLine1For(inputMode: InputMode, language: Language): string {
  if (language === "ko" && inputMode === "krw") return "원화 더치페이를";
  return uiCopy(language).heroLine1;
}
