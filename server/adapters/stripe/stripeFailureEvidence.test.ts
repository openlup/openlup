import { describe, expect, it } from "vitest";
import { normalizeStripeFailureEvidence, stripeFailureEvidence } from "./stripeFailureEvidence.js";

function refusal(overrides: Record<string, unknown> = {}) {
  return { id: "pi_example", status: "requires_payment_method", latest_charge: "ch_current",
    last_payment_error: { code: "card_declined", decline_code: "insufficient_funds",
      advice_code: "try_again_later", charge: "ch_current", payment_method: { type: "card" } }, ...overrides };
}

describe("Stripe diagnostic normalization", () => {
  it("produces cause and scoped advice from correlated facts without retaining provider prose", () => {
    const evidence = stripeFailureEvidence(refusal(), { source: "readback" })!;
    expect(normalizeStripeFailureEvidence(evidence)).toEqual({
      refusalVerified: true, cause: "insufficient_funds", certainty: "verified", disclosure: "safe",
      method: { kind: "card", recoveryMethodKey: "card", interaction: "new_instrument" },
      operation: null, advice: { code: "try_again_later", scope: "instrument" },
    });
  });

  it("uses actual BLIK method evidence, not provider identity or card-only fallback", () => {
    const evidence = stripeFailureEvidence(refusal({ setup_future_usage: "off_session",
      last_payment_error: { code: "payment_failed", payment_method: { type: "blik" } },
    }), { source: "readback", knownCardOnlyRequest: true })!;
    // A refused registration names its operation; only a consent refusal the
    // provider proves may name the setup cause, and payment_failed proves none.
    expect(normalizeStripeFailureEvidence(evidence)).toMatchObject({
      cause: "generic_decline", certainty: "unknown", operation: "recurring_setup",
      method: { kind: "blik", recoveryMethodKey: "blik", interaction: "new_instrument" },
    });
    expect(evidence.methodSource).toBe("provider");
  });

  it("does not guess method from rail, opaque method ID, or a multiple-method capability list", () => {
    const evidence = stripeFailureEvidence(refusal({ payment_method: "pm_hidden",
      payment_method_types: ["card", "blik"], last_payment_error: { code: "card_declined" },
    }), { source: "readback" })!;
    expect(evidence.method).toBeNull();
    expect(evidence.methodSource).toBe("unknown");
  });

  it("retains the known card-only construction fallback without claiming an instrument identity", () => {
    const evidence = stripeFailureEvidence(refusal({ last_payment_error: { code: "card_declined" } }),
      { source: "execution", knownCardOnlyRequest: true })!;
    expect(evidence).toMatchObject({ method: { kind: "card" }, methodSource: "execution_contract" });
  });

  it("does not let a previous charge explain the current one", () => {
    const evidence = stripeFailureEvidence(refusal({ latest_charge: "ch_different" }), { source: "readback" })!;
    expect(evidence).toMatchObject({ refusalVerified: false, disposition: "unreadable", code: null, declineCode: null, adviceCode: null, method: null });
    expect(normalizeStripeFailureEvidence(evidence)).toMatchObject({ cause: "generic_decline", certainty: "unknown", advice: null });
  });

  it.each(["fraudulent", "lost_card", "stolen_card", "highest_risk_level"])("conceals sensitive finding %s", (code) => {
    const evidence = stripeFailureEvidence(refusal({ last_payment_error: { decline_code: code } }), { source: "readback" })!;
    expect(normalizeStripeFailureEvidence(evidence)).toMatchObject({ cause: "generic_decline", disclosure: "restricted" });
  });

  it.each(["do_not_honor", "generic_decline", "new_unknown_code"])("does not invent semantics for %s", (code) => {
    const evidence = stripeFailureEvidence(refusal({ last_payment_error: { decline_code: code } }), { source: "readback" })!;
    expect(normalizeStripeFailureEvidence(evidence)).toMatchObject({ cause: "generic_decline", certainty: "unknown" });
  });

  it("does not turn processing, an old error, or an unconfirmed intent into a refusal", () => {
    const pending = stripeFailureEvidence(refusal({ status: "processing" }), { source: "readback" })!;
    expect(normalizeStripeFailureEvidence(pending)).toMatchObject({ refusalVerified: false, cause: "generic_decline", advice: null });
    expect(stripeFailureEvidence({ id: "pi_new", status: "requires_payment_method" }, { source: "readback" })).toBeNull();
    const invalid = stripeFailureEvidence({ id: "pi_invalid", status: "requires_payment_method",
      last_payment_error: { type: "invalid_request_error", code: "invalid_request" } }, { source: "readback" })!;
    expect(normalizeStripeFailureEvidence(invalid)).toMatchObject({ refusalVerified: false, cause: "generic_decline" });
  });

  it("keeps renewal operation distinct from setup_future_usage", () => {
    const evidence = stripeFailureEvidence(refusal({ metadata: { providerFlow: "off_session_payment" }, setup_future_usage: "off_session" }), { source: "readback" })!;
    expect(evidence).toMatchObject({ operation: "stored_method_payment", method: { interaction: "stored_instrument" } });
  });
});


it.each([
  ["insufficient_funds", "insufficient_funds", "safe"],
  ["fraudulent", "generic_decline", "restricted"],
])("preserves specific or restricted findings over BLIK setup context: %s", (code, cause, disclosure) => {
  const evidence = stripeFailureEvidence(refusal({ setup_future_usage: "off_session",
    last_payment_error: { decline_code: code, payment_method: { type: "blik" } },
  }), { source: "readback" })!;
  expect(normalizeStripeFailureEvidence(evidence)).toMatchObject({ cause, disclosure });
});
