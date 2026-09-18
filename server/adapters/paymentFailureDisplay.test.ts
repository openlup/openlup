import { describe, expect, it } from "vitest";

import { KNOWN_UNMAPPED_FAILURE_REASONS, displayReasonFor } from "./paymentFailureDisplay.js";
import { PAYMENT_FAILURE_DISPLAY_REASONS } from "../../src/domains/commerce/paymentFailureDisplayContracts.js";
import { DECLINE_FAILURE_REASONS } from "../shared/finalizeDeclinedAttempt.js";
import { normalizeStripeIntent as normalize } from "./stripe/stripePaymentReconciliationProvider.js";

describe("paymentFailureDisplay", () => {
  it("preserves both stable synchronous-decline recovery reasons", () => {
    for (const reason of Object.values(DECLINE_FAILURE_REASONS)) {
      expect(displayReasonFor(reason)).toBe(reason);
    }
  });
  it("maps reservation expiry and the numbered-refusal family", () => {
    expect(displayReasonFor("reservation_window_elapsed")).toBe("expired");
    expect(displayReasonFor("tpay_decline_104")).toBe("provider_declined");
    expect(displayReasonFor("tpay_decline_103")).toBe("provider_declined");
  });

  it("does not call an unconfirmed intent an issuer decline", () => {
    const unconfirmed = normalize({ id: "pi_unconfirmed", status: "requires_payment_method" });
    expect(unconfirmed.failureReason).toBe("stripe_requires_payment_method");
    expect(unconfirmed.rawPayload).toMatchObject({ latestChargePresent: false, lastPaymentErrorCode: null });
    expect(displayReasonFor(unconfirmed.failureReason)).toBeNull();
  });

  // ⛔ The producer coupling this file depends on. The numbered-decline family is
  // matched by template, not enumerated, and that is only honest while the
  // producer still builds the template. A code nobody has seen yet must resolve
  // the same way, because the bucket describes the refusal and not the code.
  it("covers a numbered decline this deployment has never seen", () => {
    expect(displayReasonFor("tpay_decline_999")).toBe("provider_declined");
    expect(displayReasonFor("tpay_decline_")).toBeNull();
    expect(displayReasonFor("tpay_declined_104")).toBeNull();
  });

  it("says nothing about a refusal it cannot read", () => {
    // A recorded failure does not necessarily identify a supported display cause.
    for (const reason of KNOWN_UNMAPPED_FAILURE_REASONS) expect(displayReasonFor(reason)).toBeNull();
    expect(displayReasonFor("something_nobody_has_written_yet")).toBeNull();
    expect(displayReasonFor(null)).toBeNull();
    expect(displayReasonFor(undefined)).toBeNull();
    expect(displayReasonFor("   ")).toBeNull();
  });

  it("does not treat an inherited property as a mapping", () => {
    expect(displayReasonFor("constructor")).toBeNull();
    expect(displayReasonFor("toString")).toBeNull();
    expect(displayReasonFor("__proto__")).toBeNull();
  });

  it("only ever answers with a bucket the surfaces have copy for", () => {
    const vocabulary = new Set<string>(PAYMENT_FAILURE_DISPLAY_REASONS);
    for (const reason of [
      ...Object.values(DECLINE_FAILURE_REASONS),
      "reservation_window_elapsed",
      "tpay_decline_104",
      "tpay_decline_1",
    ]) {
      const bucket = displayReasonFor(reason);
      expect(bucket).not.toBeNull();
      expect(vocabulary.has(bucket!)).toBe(true);
    }
  });
});
