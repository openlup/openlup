import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";

export type ExpiredCheckoutPaymentSafety = "safe" | "paid" | "unavailable";

export interface ExpiredCheckoutPaymentSafetyPort {
  verifyPriorPayment(order: CheckoutRecoveryOrderSnapshot): Promise<ExpiredCheckoutPaymentSafety>;
}

interface PriorPaymentStatus {
  status: "succeeded" | "failed" | "pending" | "unknown";
  providerStatus: string;
  amountMinor: number | null;
  currency: string | null;
}

interface PriorPaymentProvider {
  readPayment(input: { providerPaymentId: string }): Promise<PriorPaymentStatus>;
  closePayment?(input: { providerPaymentId: string }): Promise<PriorPaymentStatus>;
}

/**
 * A fresh payment is safe only after the PSP confirms that the last provider
 * object did not settle. Local expiry alone cannot rule out a delayed webhook.
 */
export function createExpiredCheckoutPaymentSafetyPort(
  providers: Partial<Record<"stripe" | "tpay", PriorPaymentProvider>>,
): ExpiredCheckoutPaymentSafetyPort {
  return {
    async verifyPriorPayment(order) {
      const evidence = order.priorPaymentEvidence;
      if (!evidence?.providerPaymentId) return "unavailable";
      if (evidence.provider !== "stripe" && evidence.provider !== "tpay") return "unavailable";
      const provider = providers[evidence.provider];
      if (!provider) return "unavailable";
      try {
        let status = await provider.readPayment({
          providerPaymentId: evidence.providerPaymentId,
        });
        if (status.status === "succeeded") return "paid";
        if (status.status !== "failed") return "unavailable";
        if (evidence.provider === "stripe" && status.providerStatus !== "canceled") {
          if (!provider.closePayment) return "unavailable";
          status = await provider.closePayment({ providerPaymentId: evidence.providerPaymentId });
          if (status.status === "succeeded") return "paid";
          if (status.status !== "failed" || status.providerStatus !== "canceled") {
            return "unavailable";
          }
        }
        if (status.amountMinor !== order.totalMinor || status.currency !== order.currency) {
          return "unavailable";
        }
        return "safe";
      } catch {
        return "unavailable";
      }
    },
  };
}
