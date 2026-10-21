import type { PaymentProviderCapabilityDescriptor } from "@openlup/core/payment";
import { PROVIDER_KIND } from "../../../src/payments/stripe/stripeSandboxPaymentExecutionAdapter.js";
export const unattendedChargeCapability: PaymentProviderCapabilityDescriptor = {
  providerKind: PROVIDER_KIND,
  // No local consent evidence is read before the charge: this provider's stored
  // method is chargeable unattended by virtue of existing, and a refusal is
  // reported by the provider inside the confirmed call.
  requiresStoredMandateEvidence: false,
  assessMandate: () => ({ chargeable: true }),
  // A payer repairs this rail by entering a card into provider-hosted fields
  // bound to a setup secret this deployment mints per repair attempt.
  captureFlows: [{ kind: "card_on_file_setup", handoff: "embedded_client_secret" }],
  unattendedChargeFlow: "off_session_payment",
  payerContext: { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false },
  methodHealth: {
    requiresCustomerRef: true,
    requiredMethodKind: null,
    requiresPayerContact: false,
  },
  mandateUpsertIsSubscriptionScoped: false,  // This rail turns its own readback status terminal, so silence means the
  // attempt never resolved rather than that the outcome landed elsewhere. Six
  // hours matches the other rail's first value; both are tunable per rail once
  // real settled cases are observed.
  terminalOutcomeReporting: { kind: "status_field", silenceBecomesSuspectAfterMinutes: 360 },
};

