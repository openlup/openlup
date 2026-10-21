import type { PaymentServices, PaymentServicesOptions } from "./contracts/repair.js";

/** One host-owned scope per runtime unit; no driver or environment discovery. */
export function createPaymentServices(options: PaymentServicesOptions): PaymentServices | null {
  if (options.schema?.truth !== "supported" || !options.openTruth) return null;
  const openTruth = options.openTruth;
  return {
    async run(work) {
      const scope = await openTruth();
      try {
        return await work(scope.port);
      } finally {
        await scope.close();
      }
    },
  };
}
