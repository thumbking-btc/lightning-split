import { readFile, writeFile } from "node:fs/promises";

const appPath = "src/App.tsx";
let app = await readFile(appPath, "utf8");

const brokenMarketPrice = `            {information
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
              : c.checking}`;

const fixedMarketPrice = `            {information
              ? usingUsd
                ? formatUsdCents(
                    BigInt(
                      usdMarket?.information?.snapshot.priceUsdCents ?? "0",
                    ),
                    language,
                  )
                : \`${'${formatInteger(BigInt(market.information?.snapshot.priceKrw ?? "0"), language)}'}${'${language === "ko" ? "원" : " KRW"}'}\`
              : c.checking}`;

if (app.includes(brokenMarketPrice)) {
  app = app.replace(brokenMarketPrice, fixedMarketPrice);
}

await writeFile(appPath, app);
