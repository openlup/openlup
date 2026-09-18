import { describe, expect, it } from "vitest";
import {
  canActivateReusablePaymentMethodRef,
  REUSABLE_PAYMENT_METHOD_KINDS,
  REUSABLE_PAYMENT_METHOD_STATUSES,
} from "./methodRefs.js";

describe("reusable payment method refs", () => {
  it("models provider-neutral cards, wallets, aliases, and BLIK PAYID refs", () => {
    expect(REUSABLE_PAYMENT_METHOD_KINDS).toEqual(["card", "blik_payid", "wallet", "alias"]);
    expect(REUSABLE_PAYMENT_METHOD_STATUSES).toContain("pending_verification");
    expect(REUSABLE_PAYMENT_METHOD_STATUSES).toContain("revoked");
  });

  it("allows activation only for active, non-expired refs", () => {
    const now = new Date("2026-06-06T12:00:00.000Z");

    expect(
      canActivateReusablePaymentMethodRef(
        { status: "active", expiresAt: "2026-06-07T12:00:00.000Z" },
        now,
      ),
    ).toBe(true);
    expect(canActivateReusablePaymentMethodRef({ status: "inactive", expiresAt: null }, now)).toBe(false);
    expect(
      canActivateReusablePaymentMethodRef(
        { status: "active", expiresAt: "2026-06-05T12:00:00.000Z" },
        now,
      ),
    ).toBe(false);
  });
});
