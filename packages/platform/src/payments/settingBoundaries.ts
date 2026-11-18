/** @experimental Informational catalogue entries owned by payments. */
export const paymentsSettingBoundaries: readonly (readonly [key: string, kind: "cap" | "invariant", goal: string, reason: string])[] = [
  ["providerProfiles", "cap", "Register a payment provider capability profile for reconciliation.", "Native recovery uses a fixed set of qualified provider profiles."],
  ["deferredCapture", "cap", "Authorize a payment now and capture it later.", "The current payment adapter contract has no separate capture operation."],
  ["paymentRefunds", "cap", "Request a refund through the payment rail.", "The current payment adapter contract has no funds-refund operation."],
  ["declineNoticeTiming", "cap", "Choose the delay and link lifetime for a payment decline notice.", "Native decline notices wait three minutes and issue links for 24 hours."],
  ["verifiedPaymentEvidence", "invariant", "Require verified signature, attempt, amount and currency for payment evidence.", "Settlement relies on verified provider evidence tied to the charged attempt."],
];
