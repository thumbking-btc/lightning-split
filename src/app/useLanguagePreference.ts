import { useEffect, useState } from "react";

import {
  initialLanguage,
  subscribeLanguage,
  type Language,
} from "./preferences";

export function useLanguagePreference(): Language {
  const [language, setLanguage] = useState<Language>(() =>
    typeof window === "undefined" ? "ko" : initialLanguage(),
  );

  useEffect(() => subscribeLanguage(setLanguage), []);

  return language;
}
