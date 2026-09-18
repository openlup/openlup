import type { PaymentWebhookAfterProcessed } from "./paymentWebhookHandlers.js";

export type PaidEmailOutboxScope = {
  orderId: string;
  subscriptionId: string | null;
};

export type PaidEmailOutboxDispatchScope =
  | { aggregateType: "commerce_order"; aggregateId: string }
  | { aggregateType: "subscription"; aggregateId: string };

export function createPaidEmailOutboxAfterProcessed(deps: {
  enabled: () => boolean;
  readScope: (paymentIntentId: string) => Promise<PaidEmailOutboxScope | null>;
  dispatchAggregate: (scope: PaidEmailOutboxDispatchScope) => Promise<void>;
  warn?: (message: string, detail: Record<string, unknown>) => void;
}): PaymentWebhookAfterProcessed {
  const warn = deps.warn ?? ((message, detail) => console.warn(message, JSON.stringify(detail)));
  return async ({ ingested, resultStatus }) => {
    if (!deps.enabled()) return;
    if (resultStatus !== "succeeded" || !ingested.paymentIntentId) return;

    try {
      const scope = await deps.readScope(ingested.paymentIntentId);
      if (!scope) return;
      const dispatches: Promise<void>[] = [
        deps.dispatchAggregate({ aggregateType: "commerce_order", aggregateId: scope.orderId }),
      ];
      if (scope.subscriptionId) {
        dispatches.push(
          deps.dispatchAggregate({ aggregateType: "subscription", aggregateId: scope.subscriptionId }),
        );
      }
      await Promise.all(dispatches);
    } catch (error) {
      warn("paid_email_immediate_dispatch_failed", {
        paymentIntentId: ingested.paymentIntentId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
