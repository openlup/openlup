import type { PaymentProviderCapabilityDescriptor } from "@openlup/core/payment";
import { PROVIDER_KIND } from "../../../src/payments/tpay/tpayPaymentExecutionAdapter.js";
export const unattendedChargeCapability: PaymentProviderCapabilityDescriptor = {
  providerKind: PROVIDER_KIND,
  // The mandate model is local DB evidence, read before a durable provider
  // attempt exists so a consent that cannot be charged unattended enters
  // customer repair instead of being mislabelled an indeterminate charge.
  requiresStoredMandateEvidence: true,
  // Only a model O mandate permits a variable amount without the payer
  // confirming each charge. Absent or unknown is NOT model O: fail closed.
  assessMandate: (snapshot) => snapshot.recurringModel === "O"
    ? { chargeable: true }
    : { chargeable: false, blockReason: "mandate_model_unsupported_for_unattended_charge" },
  // Re-registering this rail's alias needs the payer to type a short-lived
  // authorisation code. Declared because the rail can do it, not because any
  // client drives it today: the repair surface offers only handoffs it
  // implements, so this one is filtered rather than rendered.
  captureFlows: [{ kind: "scheme_alias_registration", handoff: "payer_supplied_code" }],
  unattendedChargeFlow: "recurring_charge",
  payerContext: { requiresPayerBlock: true, customerRefFallsBackToContactEmail: true },
  methodHealth: {
    requiresCustomerRef: false,
    requiredMethodKind: "blik_payid",
    requiresPayerContact: true,
  },
  mandateUpsertIsSubscriptionScoped: true,
  // Measured, not assumed: a refused charge on this rail leaves the readback's
  // own status non-terminal and reports the refusal per attempt, which is how a
  // production renewal polled as pending for 33h on 2026-08-12 with the reason
  // available the whole time. Six hours is a deliberately quiet first value for
  // a rail whose unattended charges normally settle in seconds; it is a
  // suspicion threshold for a human, never grounds to terminalize.
  terminalOutcomeReporting: { kind: "attempt_records", silenceBecomesSuspectAfterMinutes: 360 },
};
