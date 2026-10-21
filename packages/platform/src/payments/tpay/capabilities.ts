import type { PaymentAdapterCapabilities } from "../contracts/index.js";

/** Bank-redirect, one-time-code and unattended Model O attempts are supported with host payer/method input; account availability remains verification_pending. */
export const tpayPaymentCapabilities: Readonly<PaymentAdapterCapabilities> = Object.freeze<PaymentAdapterCapabilities>({
  providerKind: "tpay",
  captureFlows: Object.freeze([
    Object.freeze({ kind: "bank_redirect", handoff: "redirect", methodFamilies: Object.freeze(["bank-redirect"] as const) }),
    Object.freeze({ kind: "one_time_code", handoff: "customer-authorization", methodFamilies: Object.freeze(["one-time-code"] as const) }),
  ]),
  requiresStoredMandateEvidence: true,
  assessMandate: snapshot => snapshot.recurringModel === "O" ? { chargeable: true }
    : { chargeable: false, blockReason: "mandate_model_unsupported_for_unattended_charge" },
  unattendedChargeFlow: "recurring_charge",
  payerContext: Object.freeze({ requiresPayerBlock: true, customerRefFallsBackToContactEmail: false }),
  methodHealth: Object.freeze({ requiresCustomerRef: false, requiredMethodKind: "blik_payid", requiresPayerContact: true }),
  terminalOutcomeReporting: Object.freeze({ kind: "attempt_records", silenceBecomesSuspectAfterMinutes: 360 }),
  mandateUpsertIsSubscriptionScoped: true,
  supportedCurrencies: Object.freeze(["PLN"]), unattended: "supported", readback: "supported", close: "unsupported",
  exactAbsence: "unsupported", refundObservation: "supported", refundCreate: "unsupported", authorizationCaptureSplit: "unsupported",
});

