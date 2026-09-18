import { describe, expect, it, vi } from "vitest";
import { customerCauseForFailureClass, type PaymentFailureClass } from "@openlup/core/payment";

const { retrieve } = vi.hoisted(() => ({ retrieve: vi.fn() }));
vi.mock("stripe", () => ({ default: class { paymentIntents = { retrieve }; } }));

import { createStripeApiClient } from "../infra/stripe/stripeApiClient.js";
import { normalizeStripeIntent } from "./stripe/stripePaymentReconciliationProvider.js";
import { normalizeTpayTransaction } from "./tpay/tpayPaymentReconciliationProvider.js";
import { classifyDecline } from "../shared/finalizeDeclinedAttempt.js";
import { declineFromError, declinedExecutionFacts } from "./stripe/executionDecline.js";
import { displayReasonFor } from "./paymentFailureDisplay.js";
import { classificationOf } from "../domains/payment/paymentProviderReconciliationEvidence.js";

describe("diagnostic enrichment leaves shared policy unchanged", () => {
  it.each(["insufficient_funds", "expired_card", "restricted_card", "lost_card", "generic_decline", "unpublished_code"])(
    "preserves real readback classification and recovery display for %s, even with conflicting advice", async (declineCode) => {
      retrieve.mockResolvedValueOnce({ id: "pi_current", status: "requires_payment_method", amount: 1000,
        latest_charge: "ch_current", payment_method: "pm_current",
        last_payment_error: { type: "card_error", code: "card_declined", decline_code: declineCode,
          advice_code: "do_not_try_again", message: "private payer text" },
      });
      const mapped = await createStripeApiClient({ secretKey: "sk_test_fixture" }).retrievePaymentIntent("pi_current");
      const enriched = normalizeStripeIntent(mapped);
      const legacy = normalizeStripeIntent({ ...mapped, diagnosticFailureEvidence: undefined });
      const { failureEvidence, ...legacyPayload } = enriched.rawPayload;
      expect(failureEvidence).toMatchObject({ declineCode, adviceCode: "do_not_try_again" });
      expect({ ...enriched, rawPayload: legacyPayload }).toEqual(legacy);
      expect(classificationOf("failed", enriched)).toEqual({ failureClassification: { failureClass: "indeterminate", decidedBy: "default" } });
      expect(customerCauseForFailureClass(enriched.rawPayload.failureClass as PaymentFailureClass)).toBe("unknown");
      expect(displayReasonFor(enriched.failureReason)).toBeNull();
    },
  );

  it.each([
    ["insufficient_funds", "soft_retryable"], ["expired_card", "hard_do_not_retry"],
    ["restricted_card", "hard_do_not_retry"], ["generic_decline", "indeterminate"],
  ])("preserves synchronous renewal's already-classified %s", (code, expectedClass) => {
    const declined = declineFromError({ type: "StripeCardError", code: "card_declined", decline_code: code,
      payment_intent: { id: "pi_current", status: "requires_payment_method" } })!;
    expect(classifyDecline(declined.decline).failureClass).toBe(expectedClass);
    const facts = declinedExecutionFacts(declined);
    expect(facts.providerAttemptId).toBeNull();
    expect(facts.webhookExpected).toBe(false);
    expect(facts.responsePayload).toMatchObject({ providerErrorCodes: ["card_declined", code],
      failureEvidence: { declineCode: code, refusalVerified: true } });
  });

  it.each([
    ["100", "indeterminate"], ["102", "indeterminate"], ["103", "soft_retryable"],
    ["105", "indeterminate"], ["106", "soft_retry_delayed"], ["107", "hard_do_not_retry"],
  ])("keeps existing Tpay classification for %s without promoting inferred advice", (code, expectedClass) => {
    const result = normalizeTpayTransaction({ transactionId: "01HX", status: "pending",
      payments: { attempts: [{ paymentErrorCode: code }] } });
    expect(result).toMatchObject({ status: "failed", failureReason: `tpay_decline_${code}`,
      rawPayload: { declineCode: code, failureClass: expectedClass,
        failureEvidence: { declineCode: code, operation: null, method: null } } });
    expect(displayReasonFor(result.failureReason)).toBe("provider_declined");
  });


});
