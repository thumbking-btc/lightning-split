import type { InputMode } from "../domain/models";

export type Language = "ko" | "en";
export type CurrencyPreference = InputMode;

const LANGUAGE_KEY = "lightning-split:language";
const CURRENCY_KEY = "lightning-split:currency";

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function initialLanguage(): Language {
  const saved = storage()?.getItem(LANGUAGE_KEY);
  if (saved === "ko" || saved === "en") return saved;
  if (typeof navigator !== "undefined") {
    const languages = navigator.languages.length
      ? navigator.languages
      : [navigator.language];
    if (languages.some((value) => value.toLowerCase().startsWith("ko")))
      return "ko";
  }
  return "en";
}

export function initialCurrency(language: Language): CurrencyPreference {
  const saved = storage()?.getItem(CURRENCY_KEY);
  if (saved === "krw" || saved === "usd" || saved === "sats") return saved;
  return language === "ko" ? "krw" : "usd";
}

export function saveLanguage(language: Language): void {
  try {
    storage()?.setItem(LANGUAGE_KEY, language);
  } catch {
    // Preferences are optional; the app remains usable without localStorage.
  }
}

export function saveCurrency(currency: CurrencyPreference): void {
  try {
    storage()?.setItem(CURRENCY_KEY, currency);
  } catch {
    // Preferences are optional; the app remains usable without localStorage.
  }
}

export function localeFor(language: Language): string {
  return language === "ko" ? "ko-KR" : "en-US";
}

export function sanitizeIntegerInput(value: string): string {
  return value.replace(/\D/gu, "");
}

export function sanitizeUsdInput(value: string): string {
  const normalized = value.replace(/,/gu, "").replace(/[^0-9.]/gu, "");
  const dot = normalized.indexOf(".");
  if (dot < 0) return normalized;
  const whole = normalized.slice(0, dot);
  const fraction = normalized
    .slice(dot + 1)
    .replace(/\./gu, "")
    .slice(0, 2);
  return `${whole || "0"}.${fraction}`;
}

export function usdInputToCents(value: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(value)) return "";
  const [whole, fraction = ""] = value.split(".");
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  return cents > 0n ? cents.toString() : "";
}

export function formatUsdCents(
  cents: bigint,
  language: Language,
  includeSymbol = true,
): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  const formattedWhole = new Intl.NumberFormat(localeFor(language), {
    maximumFractionDigits: 0,
  }).format(Number(whole));
  return `${negative ? "−" : ""}${includeSymbol ? "$" : ""}${formattedWhole}.${fraction}`;
}
