/** Direct truth graph only; unsupported operations require a separate store. */
export const paymentSchemaDescriptor = {
  truth: "supported",
  settlement: "supported",
  laterOnlyCycle: "supported",
  preparedDurableStore: "unsupported",
  methodSetup: "unsupported",
  absenceReopen: "unsupported",
  cumulativeRefund: "unsupported",
} as const;
