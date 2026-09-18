import { describe, expect, it } from "vitest";
import { sanitizeOperationalEvent } from "./operationalEvents.js";
import { PROMOTION_QUOTE_MISMATCH_FIELDS } from "../../domains/commerce/promotionQuoteBinding.js";

describe("operational events", () => {
  it("emits allowlisted shape and drops non-approved detail keys", () => {
    expect(
      sanitizeOperationalEvent({
        name: "public_tester_signup_consent_rejected",
        domain: "clients",
        surface: "public",
        details: {
          reason: "invalid_consent",
          eventType: "customer.profile_updated",
          email: "jan@example.com",
          phone: "+48123456789",
          "bad key": "ignored",
        },
      }),
    ).toEqual({
      event: "operational_event",
      name: "public_tester_signup_consent_rejected",
      domain: "clients",
      surface: "public",
      details: {
        reason: "invalid_consent",
        eventType: "customer.profile_updated",
      },
    });
  });

  it("redacts email-like values even on approved detail keys", () => {
    expect(
      sanitizeOperationalEvent({
        name: "public_tester_signup_consent_rejected",
        domain: "clients",
        surface: "public",
        details: { reason: "jan@example.com" },
      }).details,
    ).toEqual({ reason: "redacted" });
  });

  it("carries the out-of-band payment reconciliation fields on the payment/webhook surface", () => {
    expect(
      sanitizeOperationalEvent({
        name: "provider_payment_unmatched_out_of_band",
        domain: "payment",
        surface: "webhook",
        details: {
          provider: "tpay",
          providerPaymentId: "tr_ABC123",
          eventType: "payment.succeeded",
          resultStatus: "succeeded",
          amountMinor: 4980,
          currency: "PLN",
          occurredAt: "2026-07-13T10:00:00.000Z",
        },
      }),
    ).toEqual({
      event: "operational_event",
      name: "provider_payment_unmatched_out_of_band",
      domain: "payment",
      surface: "webhook",
      details: {
        provider: "tpay",
        providerPaymentId: "tr_ABC123",
        eventType: "payment.succeeded",
        resultStatus: "succeeded",
        amountMinor: 4980,
        currency: "PLN",
        occurredAt: "2026-07-13T10:00:00.000Z",
      },
    });
  });

  it("carries the terminal-decline codes and drops the provider's own prose", () => {
    const event = sanitizeOperationalEvent({
      name: "payment_decline_terminal",
      domain: "payment",
      surface: "hidden",
      details: {
        provider: "provider-a",
        failureClass: "mandate_dead",
        failureReason: "blik_recurring_unsupported_bank",
        resultStatus: "failed",
        occurredAt: "2026-08-26T09:14:00.000Z",
        // The adapter's free-form message and the payer's identity are exactly
        // what may not reach a log drain, whatever a future caller passes.
        errorMessage: "SENTINEL-PROSE",
        customerEmail: "SENTINEL@example.com",
      },
    });

    expect(event.details).toEqual({
      provider: "provider-a",
      failureClass: "mandate_dead",
      failureReason: "blik_recurring_unsupported_bank",
      resultStatus: "failed",
      occurredAt: "2026-08-26T09:14:00.000Z",
    });
    expect(JSON.stringify(event)).not.toContain("SENTINEL");
  });

  // The public checkout sink is unauthenticated, so this allowlist is the second
  // lock behind the route's strict schema: even if a widened schema let an
  // identifier through, the recorder still refuses to write it down.
  it("carries only the stage and code of a checkout client event", () => {
    const event = sanitizeOperationalEvent({
      name: "checkout_client_event",
      domain: "commerce",
      surface: "public",
      details: {
        stage: "payment_form",
        clientEventCode: "payment_element_not_ready",
        orderId: "SENTINEL-ORDER",
        visitorId: "SENTINEL-VISITOR",
        message: "SENTINEL-PROSE",
        userAgent: "SENTINEL-UA",
      },
    });

    expect(event.details).toEqual({
      stage: "payment_form",
      clientEventCode: "payment_element_not_ready",
    });
    expect(JSON.stringify(event)).not.toContain("SENTINEL");
  });

  // ⛔ The qualified key is not cosmetic. This allowlist is global, and the
  // promotion event above depends on the bare `code` staying out of it: there
  // that key is the raw promotion code a customer typed.
  it("still drops a bare code key on the checkout client event", () => {
    const event = sanitizeOperationalEvent({
      name: "checkout_client_event",
      domain: "commerce",
      surface: "public",
      details: { stage: "payment_form", code: "SENTINEL-BARE-CODE" },
    });

    expect(event.details).toEqual({ stage: "payment_form" });
    expect(JSON.stringify(event)).not.toContain("SENTINEL");
  });

  it("allows only aggregate promotion acceptance dimensions and drops token/code probes", () => {
    const event = sanitizeOperationalEvent({
      name: "commerce_promotion_acceptance_outcome",
      domain: "commerce",
      surface: "hidden",
      details: {
        stage: "checkout_verify",
        outcome: "rejected",
        reason: "expired",
        keySlot: "previous",
        purchaseScope: "subscription_initial",
        expiryBucket: "expired",
        promotionEngineVersion: "promotion-engine.v2",
        mismatchField: "discounts",
        promotionAcceptanceToken: "SENTINEL-TOKEN",
        code: "SENTINEL-CODE",
      },
    });

    expect(event.details).toEqual({
      stage: "checkout_verify",
      outcome: "rejected",
      reason: "expired",
      keySlot: "previous",
      purchaseScope: "subscription_initial",
      expiryBucket: "expired",
      promotionEngineVersion: "promotion-engine.v2",
      mismatchField: "discounts",
    });
    expect(JSON.stringify(event)).not.toContain("SENTINEL");
  });

  it("drops a mismatchField value outside the closed money-section vocabulary", () => {
    const event = sanitizeOperationalEvent({
      name: "commerce_promotion_acceptance_outcome",
      domain: "commerce",
      surface: "hidden",
      details: { stage: "checkout_verify", mismatchField: "SENTINEL-$.discounts.0.label" },
    });

    expect(event.details).toEqual({ stage: "checkout_verify" });
    expect(JSON.stringify(event)).not.toContain("SENTINEL");
  });

  // The sanitizer cannot import a commerce domain, so it repeats the vocabulary.
  // This pins the copy to its owner instead of trusting the comment beside it.
  it("accepts exactly the promotion money sections the binding module defines", () => {
    for (const field of PROMOTION_QUOTE_MISMATCH_FIELDS) {
      const event = sanitizeOperationalEvent({
        name: "commerce_promotion_acceptance_outcome",
        domain: "commerce",
        surface: "hidden",
        details: { mismatchField: field },
      });
      expect(event.details).toEqual({ mismatchField: field });
    }
  });
});
