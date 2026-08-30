import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Nip57ReceiptRelay,
  matchesReceiptFilter,
  normalizeNip57ReceiptEvent,
  normalizePaymentSessionInitialization,
  type Nip57ReceiptEvent,
  type PaymentSessionInitialization,
} from "./nostrRelay";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const INVOICE = `lnbc920n1${"q".repeat(120)}`;
const RECIPIENT = "c".repeat(64);

function session(
  overrides: Partial<PaymentSessionInitialization> = {},
): PaymentSessionInitialization {
  return {
    expiresAtMs: Date.now() + 60_000,
    providerMetadata: '[["text/plain","Pay to test user"]]',
    amountMsat: "92000",
    invoice: INVOICE,
    note: "8/30 고깃집 저녁",
    ...overrides,
  };
}

function receipt(
  overrides: Partial<Nip57ReceiptEvent> = {},
): Nip57ReceiptEvent {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: Math.floor(Date.now() / 1_000),
    kind: 9735,
    tags: [
      ["p", RECIPIENT],
      ["bolt11", INVOICE],
      ["description", "{}"],
    ],
    content: "",
    sig: "d".repeat(128),
    ...overrides,
  };
}

function relayNamespace(): DurableObjectNamespace<Nip57ReceiptRelay> {
  return (
    env as unknown as {
      readonly NIP57_RECEIPTS: DurableObjectNamespace<Nip57ReceiptRelay>;
    }
  ).NIP57_RECEIPTS;
}

function nextRelayMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      cleanup();
      try {
        resolve(JSON.parse(String(event.data)) as unknown);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Relay WebSocket failed before a message arrived."));
    };
    const cleanup = (): void => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });
}

async function connect(
  stub: DurableObjectStub<Nip57ReceiptRelay>,
): Promise<WebSocket> {
  const response = await stub.fetch("https://relay.example/channel", {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("Missing upgraded WebSocket.");
  socket.accept();
  return socket;
}

describe("NIP-57 receipt relay validation", () => {
  it("accepts only a bounded canonical payment session", () => {
    expect(
      normalizePaymentSessionInitialization(
        session({ expiresAtMs: NOW + 60_000 }),
        NOW,
      ),
    ).toEqual({
      expiresAtMs: NOW + 60_000,
      providerMetadata: '[["text/plain","Pay to test user"]]',
      amountMsat: "92000",
      invoice: INVOICE,
      note: "8/30 고깃집 저녁",
    });
    expect(() =>
      normalizePaymentSessionInitialization(
        session({ expiresAtMs: NOW, note: "x" }),
        NOW,
      ),
    ).toThrow("Invalid payment session initialization");
    expect(() =>
      normalizePaymentSessionInitialization(
        session({ expiresAtMs: NOW + 60_000, amountMsat: "092000" }),
        NOW,
      ),
    ).toThrow("Invalid payment session initialization");
    expect(() =>
      normalizePaymentSessionInitialization(
        session({ expiresAtMs: NOW + 60_000, note: "가".repeat(145) }),
        NOW,
      ),
    ).toThrow("Invalid payment session initialization");
  });

  it("accepts only bounded kind 9735 envelopes and applies NIP-01 filters", () => {
    const event = normalizeNip57ReceiptEvent(receipt());
    expect(event).not.toBeNull();
    expect(
      matchesReceiptFilter(event!, {
        ids: [event!.id.slice(0, 12)],
        authors: [event!.pubkey.slice(0, 12)],
        kinds: [9735],
        "#p": [RECIPIENT],
      }),
    ).toBe(true);
    expect(matchesReceiptFilter(event!, { "#p": ["e".repeat(64)] })).toBe(
      false,
    );
    expect(normalizeNip57ReceiptEvent({ ...receipt(), kind: 1 })).toBeNull();
    expect(
      normalizeNip57ReceiptEvent({ ...receipt(), content: "x".repeat(8_193) }),
    ).toBeNull();
  });
});

describe("Nip57ReceiptRelay Durable Object", () => {
  afterEach(() => vi.useRealTimers());

  it("initializes once, treats an identical retry as idempotent, and expires by alarm", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const stub = relayNamespace().getByName(crypto.randomUUID());
    const input = session({ expiresAtMs: NOW + 60_000 });

    await expect(stub.initialize(input)).resolves.toEqual(input);
    await expect(stub.initialize(input)).resolves.toEqual(input);
    const mismatchedError = await runInDurableObject(
      stub,
      async (instance: Nip57ReceiptRelay) => {
        try {
          await instance.initialize({ ...input, amountMsat: "93000" });
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    );
    expect(mismatchedError).toContain("already initialized");
    await expect(stub.getPaymentSession()).resolves.toEqual(input);
    await expect(stub.getReceipt()).resolves.toBeNull();

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(stub.getPaymentSession()).resolves.toEqual(input);

    vi.setSystemTime(NOW + 60_000);
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(stub.getPaymentSession()).resolves.toBeNull();
    await expect(stub.getReceipt()).resolves.toBeNull();
  });

  it("implements bounded REQ/EVENT/EOSE/OK/CLOSE handling and rejects an unbound receipt", async () => {
    const stub = relayNamespace().getByName(crypto.randomUUID());
    await stub.initialize(session());
    const subscriber = await connect(stub);
    const publisher = await connect(stub);

    const eose = nextRelayMessage(subscriber);
    subscriber.send(
      JSON.stringify(["REQ", "payment", { kinds: [9735], "#p": [RECIPIENT] }]),
    );
    await expect(eose).resolves.toEqual(["EOSE", "payment"]);

    await evictDurableObject(stub);

    const event = receipt();
    const acknowledged = nextRelayMessage(publisher);
    publisher.send(JSON.stringify(["EVENT", event]));
    await expect(acknowledged).resolves.toEqual([
      "OK",
      event.id,
      false,
      "invalid: receipt does not match this payment",
    ]);
    await expect(stub.getReceipt()).resolves.toBeNull();

    subscriber.send(JSON.stringify(["CLOSE", "payment"]));
    const unsupported = nextRelayMessage(publisher);
    publisher.send(JSON.stringify(["AUTH", {}]));
    await expect(unsupported).resolves.toEqual([
      "NOTICE",
      "unsupported: relay command",
    ]);

    subscriber.close(1000, "test complete");
    publisher.close(1000, "test complete");
  });

  it("rejects malformed or non-9735 events without consuming the channel", async () => {
    const stub = relayNamespace().getByName(crypto.randomUUID());
    await stub.initialize(session());
    const publisher = await connect(stub);

    const rejected = nextRelayMessage(publisher);
    publisher.send(JSON.stringify(["EVENT", { ...receipt(), kind: 1 }]));
    await expect(rejected).resolves.toEqual([
      "OK",
      "a".repeat(64),
      false,
      "invalid: malformed kind 9735 event",
    ]);
    await expect(stub.getReceipt()).resolves.toBeNull();

    publisher.close(1000, "test complete");
  });
});
