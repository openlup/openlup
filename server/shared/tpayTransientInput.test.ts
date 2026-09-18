import { describe, expect, it } from "vitest";

import { tpayTransientInput } from "./tpayTransientInput.js";

describe("tpayTransientInput", () => {
  it("collapses the saved-mandate checkout flow onto the adapter's charge flow", () => {
    // `blik_recurring_saved` is checkout vocabulary; the adapter only knows it as
    // a charge against a stored alias.
    expect(tpayTransientInput({
      provider: "tpay",
      flow: "blik_recurring_saved",
      savedMethodId: "11111111-1111-4111-8111-111111111111",
      recurringModel: "M",
    })).toEqual({ provider: "tpay", flow: "recurring_charge" });
  });

  it("drops any client-supplied recurring model", () => {
    // The model belongs to the mandate that was registered, not to whatever the
    // browser sends now — otherwise a caller could contradict the agreement the
    // payer actually gave. The charge path reads it back from stored consent.
    const mapped = tpayTransientInput({
      provider: "tpay",
      flow: "blik_recurring_saved",
      savedMethodId: "11111111-1111-4111-8111-111111111111",
      recurringModel: "O",
    });

    expect(mapped).not.toHaveProperty("recurringModel");
  });

  it("collapses one-click onto its charge flow without the saved id", () => {
    expect(tpayTransientInput({
      provider: "tpay",
      flow: "blik_one_click",
      savedMethodId: "22222222-2222-4222-8222-222222222222",
    })).toEqual({ provider: "tpay", flow: "blik_one_click" });
  });

  it("passes other Tpay flows through untouched", () => {
    const oneOff = { provider: "tpay", flow: "blik_one_time", blikToken: "123456" } as const;
    expect(tpayTransientInput(oneOff)).toBe(oneOff);
  });

  it("returns null for a non-Tpay or absent execution", () => {
    expect(tpayTransientInput(undefined)).toBeNull();
    expect(tpayTransientInput({ provider: "hidden_rehearsal" })).toBeNull();
  });
});
