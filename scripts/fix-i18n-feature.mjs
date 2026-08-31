import { readFile, writeFile } from "node:fs/promises";

async function replaceInFile(path, replacements) {
  let content = await readFile(path, "utf8");
  for (const [from, to] of replacements) {
    if (content.includes(from)) content = content.replace(from, to);
  }
  await writeFile(path, content);
}

await replaceInFile("src/App.tsx", [
  [
    `            {information
              ? usingUsd
                ? formatUsdCents(
                    BigInt(
                      (information as UsdMarketInformationState["information"] extends infer T
                        ? never
                        : never) ?? 0,
                    ),
                    language,
                  )
                : ""
              : c.checking}`,
    `            {information
              ? usingUsd
                ? formatUsdCents(
                    BigInt(
                      usdMarket?.information?.snapshot.priceUsdCents ?? "0",
                    ),
                    language,
                  )
                : \`${'${formatInteger(BigInt(market.information?.snapshot.priceKrw ?? "0"), language)}'}${'${language === "ko" ? "원" : " KRW"}'}\`
              : c.checking}`,
  ],
  ["preview.payerShareUsdCents !== null", "preview.payerShareUsdCents != null"],
  [
    `  const retryOperationRef = useRef<string | undefined>(undefined);
  const c = uiCopy(language);`,
    `  const retryOperationRef = useRef<string | undefined>(undefined);
  const languageRef = useRef(language);
  const c = uiCopy(language);`,
  ],
  [
    `  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);`,
    `  useEffect(() => {
    languageRef.current = language;
    document.documentElement.lang = language;
  }, [language]);`,
  ],
  [
    `      .catch(() =>
        setPersistenceError(
          language === "ko"
            ? "저장된 정산을 불러오지 못했습니다. 이 브라우저에서는 자동 복구가 제한될 수 있습니다."
            : "Could not load the saved settlement. Automatic recovery may be limited in this browser.",
        ),
      )
      .finally(() => setRestoring(false));
  }, [language]);`,
    `      .catch(() =>
        setPersistenceError(
          languageRef.current === "ko"
            ? "저장된 정산을 불러오지 못했습니다. 이 브라우저에서는 자동 복구가 제한될 수 있습니다."
            : "Could not load the saved settlement. Automatic recovery may be limited in this browser.",
        ),
      )
      .finally(() => setRestoring(false));
  }, []);`,
  ],
  [
    `  const { market, refreshLockedSnapshot } = useMarketInformation();
  const { market: usdMarket, refreshLockedSnapshot: refreshLockedUsdSnapshot } =
    useUsdMarketInformation();
  const [session, setSession] = useState<SettlementSession | null>(null);`,
    `  const [session, setSession] = useState<SettlementSession | null>(null);
  const { market, refreshLockedSnapshot } = useMarketInformation();
  const { market: usdMarket, refreshLockedSnapshot: refreshLockedUsdSnapshot } =
    useUsdMarketInformation(inputMode === "usd" || session?.inputMode === "usd");`,
  ],
]);

await replaceInFile("src/app/session.ts", [
  [
    "  readonly payerShareUsdCents: bigint | null;",
    "  readonly payerShareUsdCents?: bigint | null;",
  ],
  [
    `    ...(preview.payerShareUsdCents === null
      ? {}
      : { payerShareUsdCents: preview.payerShareUsdCents.toString() }),`,
    `    ...(preview.payerShareUsdCents == null
      ? {}
      : { payerShareUsdCents: preview.payerShareUsdCents.toString() }),`,
  ],
  [
    `    slots: session.slots.map((slot): ClientSlot =>
      slot.slotNumber === slotNumber
        ? {
            ...slot,
            annotation: {`,
    `    slots: session.slots.map((slot): ClientSlot =>
      slot.slotNumber === slotNumber &&
      (slot.status === "settled" || slot.status === "manuallyConfirmed")
        ? {
            ...slot,
            annotation: {`,
  ],
]);

await replaceInFile("src/lightning/settlement.ts", [
  [
    `export function selectSettlementCapability(input: {
  readonly verifyUrl?: string;
}): SettlementCapability {
  return input.verifyUrl === undefined
    ? Object.freeze({ method: "manual" })
    : Object.freeze({ method: "lud21", verifyUrl: input.verifyUrl });
}`,
    `export function selectSettlementCapability(input: object): SettlementCapability {
  const verifyUrl =
    "verifyUrl" in input && typeof input.verifyUrl === "string"
      ? input.verifyUrl
      : undefined;
  return verifyUrl === undefined
    ? Object.freeze({ method: "manual" })
    : Object.freeze({ method: "lud21", verifyUrl });
}`,
  ],
]);
