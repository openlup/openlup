import { describe, expect, it } from "vitest";

import {
  walletSettlementFromConfirmError,
  walletSettlementFromConfirmPaymentIntentStatus,
} from "./walletExpressSettlement";

const context = {
  orderId: "order-id",
  orderRef: "order-ref",
  paymentIntentId: "intent-id",
  clientId: "client-id",
};

describe("wallet express settlement", () => {
  it.each(["succeeded", "processing", "requires_action", "requires_capture", null, "future_provider_status"]) (
    "keeps Stripe payment-intent status %s on the authoritative status-readback path",
    (status) => {
      expect(walletSettlementFromConfirmPaymentIntentStatus(status, context)).toEqual({
        kind: "processing",
        ...context,
      });
    },
  );

  it.each(["canceled", "requires_payment_method", "requires_confirmation"]) (
    "treats Stripe payment-intent status %s as a deterministic retryable failure",
    (status) => {
      expect(walletSettlementFromConfirmPaymentIntentStatus(status, context)).toEqual({
        kind: "failed",
        reason: status === "canceled" ? "cancelled" : "technical",
        forceFailurePage: true,
        ...context,
      });
    },
  );

  it.each(["api_connection_error", "api_error", "idempotency_error", undefined, "future_provider_error"])(
    "keeps Stripe confirm error type %s on the authoritative status-readback path",
    (type) => {
      expect(walletSettlementFromConfirmError({ type }, context)).toEqual({
        kind: "failed",
        reason: "technical",
        ...context,
      });
    },
  );

  it.each(["validation_error", "invalid_request_error", "authentication_error", "rate_limit_error"])(
    "keeps known local Stripe error type %s on the live wallet form",
    (type) => {
      expect(walletSettlementFromConfirmError({ type }, context)).toEqual({ kind: "retryable" });
    },
  );

  it("forces a retry route only for an explicit issuer/card decision", () => {
    expect(walletSettlementFromConfirmError({ type: "card_error", code: "card_declined" }, context)).toEqual({
      kind: "failed",
      reason: "card_declined",
      forceFailurePage: true,
      ...context,
    });
  });
});
