from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if text.count(old) != 1:
        raise SystemExit(f"expected one match in {path}, got {text.count(old)}")
    p.write_text(text.replace(old, new), encoding="utf-8")

replace_once(
    "src/market/usdRealtime.ts",
    '''export function createCoinbaseHeartbeatSubscription(): string {\n  return JSON.stringify({\n    type: "subscribe",\n    product_ids: [USD_REALTIME_MARKET_POLICY.productId],\n    channel: "heartbeats",\n  });\n}''',
    '''export function createCoinbaseHeartbeatSubscription(): string {\n  return JSON.stringify({\n    type: "subscribe",\n    channel: "heartbeats",\n  });\n}''',
)
replace_once(
    "src/market/usdRealtime.test.ts",
    '''    expect(JSON.parse(createCoinbaseHeartbeatSubscription())).toEqual({\n      type: "subscribe",\n      product_ids: ["BTC-USD"],\n      channel: "heartbeats",\n    });''',
    '''    expect(JSON.parse(createCoinbaseHeartbeatSubscription())).toEqual({\n      type: "subscribe",\n      channel: "heartbeats",\n    });''',
)
replace_once(
    "src/pricing/usd.ts",
    '"https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"',
    '"https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT"',
)
replace_once(
    "worker/usdPrice.test.ts",
    'http.get("https://api.binance.com/api/v3/ticker/price", ({ request }) => {',
    'http.get("https://data-api.binance.vision/api/v3/ticker/price", ({ request }) => {',
)
print("Refined public market endpoints.")
