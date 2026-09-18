import { describe, expect, it } from "vitest";
import { noIssuerWasAsked } from "./stripeIntentConfirmationEvidence.js";
import type { StripeIntentLike } from "./stripeSandboxPaymentExecutionAdapter.js";

/**
 * The predicate is asserted by two rails — the execution adapter, deciding what a
 * durable attempt row may claim, and the reconciliation rail, deciding what a
 * payer still standing in the checkout is told. Both readings turn on all four
 * conjuncts holding, so each one is pinned here directly rather than through
 * whichever caller happens to exercise it.
 *
 * Every `false` leg below is a state in which an issuer MAY have been asked. The
 * predicate must stay narrow: widening any leg would let a live charge be called
 * idle, which is the expensive direction of this error.
 */
function intent(overrides: Partial<StripeIntentLike> = {}): StripeIntentLike {
  return { id: "pi_evidence", status: "requires_payment_method", ...overrides };
}

describe("noIssuerWasAsked", () => {
  it("holds for a created intent the payer never confirmed", () => {
    expect(noIssuerWasAsked(intent())).toBe(true);
  });

  it("tolerates the absences being expressed as null rather than missing", () => {
    expect(noIssuerWasAsked(intent({
      payment_method: null,
      latest_charge: null,
      last_payment_error: null,
    }))).toBe(true);
  });

  it.each([
    ["a payment method is attached, so a charge may be seconds from moving", { payment_method: "pm_123" }],
    ["a charge exists, so money has already moved", { latest_charge: "ch_123" }],
    ["an issuer answered with a refusal", { last_payment_error: { code: "card_declined" } }],
  ])("fails when %s", (_label, overrides) => {
    expect(noIssuerWasAsked(intent(overrides))).toBe(false);
  });

  // The status leg. Only `requires_payment_method` describes an intent waiting
  // for an instrument; every other provider status means the object has moved
  // past that point in one direction or the other.
  it.each([
    "requires_confirmation",
    "requires_action",
    "processing",
    "requires_capture",
    "succeeded",
    "canceled",
    "some_status_the_provider_added_later",
  ])("fails for provider status %s", (status) => {
    expect(noIssuerWasAsked(intent({ status }))).toBe(false);
  });
});
