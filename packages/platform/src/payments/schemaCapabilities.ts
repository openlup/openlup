/** Installed native payment capabilities; provider composition remains explicit. */
export const paymentSchemaDescriptor = {
  truth: "supported",
  settlement: "supported",
  laterOnlyCycle: "supported",
  preparedDurableStore: "supported",
  methodSetup: "unsupported",
  absenceReopen: "supported",
  cumulativeRefund: "supported",
} as const;
