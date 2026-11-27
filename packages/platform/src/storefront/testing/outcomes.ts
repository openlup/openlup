// Internal: the outcome kinds the runner knows, with one meaning each. The testing
// entry does not re-export this module, so it stays out of the API report.

/** The outcome kinds this runner knows. Each implies a payment attempt in the ledger after it is produced. */
export const knownOutcomes = ["declined", "pending", "settled", "settled_after_pending", "activation_pending"] as const;

/** One line per known outcome kind. A known outcome without a meaning does not compile. */
export const outcomeMeanings: Readonly<Record<(typeof knownOutcomes)[number], string>> = Object.freeze({
  declined: "The payment attempt is declined and captures nothing.",
  pending: "The payment attempt stays pending and captures nothing yet.",
  settled: "The payment attempt settles and captures the payment.",
  settled_after_pending: "The attempt an earlier outcome left pending settles and captures the payment.",
  activation_pending: "The payment settles and is captured, and the purchase still awaits activation.",
});
