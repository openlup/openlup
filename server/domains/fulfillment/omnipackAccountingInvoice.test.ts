import { describe, expect, it } from "vitest";
import { omnipackHandoffAccountingInvoiceIdempotencyKey } from "./omnipackAccountingInvoice.js";

describe("OmniPack handoff accounting identity", () => {
  it("keeps webhook and reconciliation on the established stable key", () => {
    expect(omnipackHandoffAccountingInvoiceIdempotencyKey("fulfillment-1"))
      .toBe("omnipack:webhook:fulfillment-1:accounting-invoice");
  });
});
