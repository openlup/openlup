import { describe, expect, it } from "vitest";
import { settlementFields } from "./invoiceSettlement.js";

describe("invoice settlement", () => {
  it("marks the document settled for the exact amount it charges", () => {
    // Anything below the document total is reported by the provider as a
    // partial payment, which reads as deliberate and is worse than silence.
    expect(settlementFields(149.9, "2026-07-11")).toEqual({
      status: "paid",
      paid: 149.9,
      paid_date: "2026-07-11",
      payment_to_kind: "off",
    });
  });

  it("suppresses the payment deadline a settled sale cannot have", () => {
    expect(settlementFields(10, "2026-07-11").payment_to_kind).toBe("off");
  });
});
