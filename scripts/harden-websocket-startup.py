from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one match in {path}, got {count}")
    p.write_text(text.replace(old, new), encoding="utf-8")

replace_once(
    "src/app/useMarketInformation.ts",
    '''      const nextSocket = new WebSocket(REALTIME_MARKET_POLICY.websocketUrl);\n      nextSocket.binaryType = "arraybuffer";\n      socket = nextSocket;''',
    '''      let nextSocket: WebSocket;\n      try {\n        nextSocket = new WebSocket(REALTIME_MARKET_POLICY.websocketUrl);\n      } catch {\n        setStreamActive(false);\n        scheduleReconnect();\n        return;\n      }\n      nextSocket.binaryType = "arraybuffer";\n      socket = nextSocket;''',
)

replace_once(
    "src/app/useUsdMarketInformation.ts",
    '''      const nextSocket = new WebSocket(USD_REALTIME_MARKET_POLICY.websocketUrl);\n      socket = nextSocket;''',
    '''      let nextSocket: WebSocket;\n      try {\n        nextSocket = new WebSocket(USD_REALTIME_MARKET_POLICY.websocketUrl);\n      } catch {\n        setStreamActive(false);\n        scheduleReconnect();\n        return;\n      }\n      socket = nextSocket;''',
)

print("Hardened KRW and USD WebSocket startup failures.")
