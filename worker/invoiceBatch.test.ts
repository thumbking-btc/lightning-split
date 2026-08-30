import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { BatchInvoiceResponseDto } from "../src/api/contracts";
import {
  fingerprintInvoiceBatchInput,
  type InvoiceBatchCoordinator,
  type ParsedInvoiceBatchInput,
} from "./invoiceBatch";

const STORED_RESPONSE: BatchInvoiceResponseDto = {
  ok: true,
  provider: { domain: "wallet.example", commentAllowed: 80 },
  slots: [
    {
      status: "pending",
      slotNumber: 1,
      krwShare: "4000",
      targetSats: "25",
      attempt: 1,
      invoice: {
        bolt11: "lnbc250n1storedinvoice",
        paymentHash: "22".repeat(32),
        timestampSeconds: 1_893_456_000,
        expirySeconds: 3_600,
        expiresAt: "2030-01-01T01:00:00.000Z",
        payeeNodeId: `02${"33".repeat(32)}`,
        featureBits: [9, 14],
        providerDomain: "wallet.example",
      },
    },
  ],
  completedCount: 1,
  failedCount: 0,
};

function input(requestId: string): ParsedInvoiceBatchInput {
  return {
    requestId,
    address: "alice@wallet.example",
    slots: [
      {
        slotNumber: 1,
        krwShare: 4_000n,
        targetSats: 25n,
        attempt: 1,
      },
    ],
    excludedPaymentHashes: ["44".repeat(32)],
    providerComment: "정산 테스트",
  };
}

function coordinator(
  requestId: string,
): DurableObjectStub<InvoiceBatchCoordinator> {
  const namespace = (
    env as unknown as {
      readonly INVOICE_BATCHES: DurableObjectNamespace<InvoiceBatchCoordinator>;
    }
  ).INVOICE_BATCHES;
  return namespace.getByName(requestId);
}

describe("invoice batch fingerprint", () => {
  it("is deterministic for equivalent bigint-bearing input and changes with input", async () => {
    const requestId = `fingerprint-${crypto.randomUUID()}`;
    const first = await fingerprintInvoiceBatchInput(input(requestId));
    const equivalent = await fingerprintInvoiceBatchInput(input(requestId));
    const changed = await fingerprintInvoiceBatchInput({
      ...input(requestId),
      providerComment: "다른 정산",
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(equivalent).toBe(first);
    expect(changed).not.toBe(first);
  });
});

describe("InvoiceBatchCoordinator", () => {
  it("replays the stored response for the same requestId and fingerprint", async () => {
    const requestId = `replay-${crypto.randomUUID()}`;
    const parsed = input(requestId);
    const fingerprint = await fingerprintInvoiceBatchInput(parsed);
    const stub = coordinator(requestId);

    const replayed = await runInDurableObject(stub, async (instance, state) => {
      const coordinatorInstance = instance as InvoiceBatchCoordinator;
      await state.storage.put("fingerprint", fingerprint);
      await state.storage.put("response", STORED_RESPONSE);
      const first = await coordinatorInstance.issue(fingerprint, parsed);
      const second = await coordinatorInstance.issue(fingerprint, parsed);
      const inFlight = (
        coordinatorInstance as unknown as { readonly inFlight?: unknown }
      ).inFlight;
      return { first, second, inFlight };
    });

    expect(replayed.first).toEqual(STORED_RESPONSE);
    expect(replayed.second).toEqual(STORED_RESPONSE);
    expect(replayed.inFlight).toBeUndefined();
  });

  it("rejects reuse of a requestId with a different fingerprint", async () => {
    const requestId = `conflict-${crypto.randomUUID()}`;
    const parsed = input(requestId);
    const fingerprint = await fingerprintInvoiceBatchInput(parsed);
    const differentFingerprint = await fingerprintInvoiceBatchInput({
      ...parsed,
      providerComment: "충돌 입력",
    });
    const stub = coordinator(requestId);

    const error = await runInDurableObject(stub, async (instance, state) => {
      const coordinatorInstance = instance as InvoiceBatchCoordinator;
      await state.storage.put("fingerprint", fingerprint);
      try {
        await coordinatorInstance.issue(differentFingerprint, parsed);
        return null;
      } catch (cause) {
        if (!(cause instanceof Error)) return { message: String(cause) };
        return {
          message: cause.message,
          code:
            "code" in cause && typeof cause.code === "string"
              ? cause.code
              : undefined,
        };
      }
    });

    expect(error).toEqual({
      code: "INVALID_INPUT",
      message: "The invoice request key was reused with different input.",
    });
  });

  it("never reissues after a callbacks-started journal without a response", async () => {
    const requestId = `interrupted-${crypto.randomUUID()}`;
    const parsed = input(requestId);
    const fingerprint = await fingerprintInvoiceBatchInput(parsed);
    const stub = coordinator(requestId);

    const recovered = await runInDurableObject(
      stub,
      async (instance, state) => {
        await state.storage.put("fingerprint", fingerprint);
        await state.storage.put("phase", "callbacksStarted");
        return (instance as InvoiceBatchCoordinator).issue(fingerprint, parsed);
      },
    );

    expect(recovered).toMatchObject({
      ok: true,
      completedCount: 0,
      failedCount: 1,
      slots: [
        {
          status: "failed",
          failure: { code: "ISSUANCE_UNKNOWN", retryable: false },
        },
      ],
    });
  });

  it("deletes replay state when its retention alarm runs", async () => {
    const requestId = `alarm-${crypto.randomUUID()}`;
    const parsed = input(requestId);
    const fingerprint = await fingerprintInvoiceBatchInput(parsed);
    const stub = coordinator(requestId);

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("fingerprint", fingerprint);
      await state.storage.put("response", STORED_RESPONSE);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    const stored = await runInDurableObject(stub, async (_instance, state) => ({
      fingerprint: await state.storage.get("fingerprint"),
      response: await state.storage.get("response"),
      alarm: await state.storage.getAlarm(),
    }));

    expect(stored).toEqual({
      fingerprint: undefined,
      response: undefined,
      alarm: null,
    });
  });
});
