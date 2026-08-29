import { describe, expect, it } from "vitest";

import {
  isLightningInvoiceInput,
  LIGHTNING_INVOICE_INPUT_MESSAGE,
} from "./lightningInput";

describe("Lightning Address input classification", () => {
  it.each(["lnbc1example", " LNBC1EXAMPLE ", "lightning:lnbc1example"])(
    "recognizes %s as an invoice input",
    (value) => expect(isLightningInvoiceInput(value)).toBe(true),
  );

  it("does not classify a Lightning Address as an invoice", () => {
    expect(isLightningInvoiceInput("thumbking@oksu.su")).toBe(false);
    expect(LIGHTNING_INVOICE_INPUT_MESSAGE).toContain("Lightning Address");
  });
});
