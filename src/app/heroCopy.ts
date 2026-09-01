import type { InputMode } from "../domain/models";
import { uiCopy } from "./i18n";
import type { Language } from "./preferences";

export function heroLine1For(inputMode: InputMode, language: Language): string {
  void inputMode;
  return uiCopy(language).heroLine1;
}
