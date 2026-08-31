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
]);

await replaceInFile("src/app/session.ts", [
  [
    "  readonly payerShareUsdCents: bigint | null;",
    "  readonly payerShareUsdCents?: bigint | null;",
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
