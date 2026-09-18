// Neutral port owned by the commerce.order.paid dispatch handler. Concrete
// persistence and provider adapters live under server/adapters.

export type OrderPaidFulfillmentResult =
  | { kind: "completed" | "skipped"; detail?: Record<string, unknown> }
  | { kind: "retryable"; reason: string }
  | { kind: "snooze"; reason: string }
  | { kind: "fatal"; reason: string }
  // Paid order that cannot be auto-fulfilled and was routed to an observable
  // manual-review state (an active fulfillment_exception hold). Terminal but
  // NOT a silent discard: the hold is the durable signal. No fulfillment order
  // or label is created for this outcome.
  | { kind: "manual_review"; reason: string; detail?: Record<string, unknown> };

export interface OrderPaidFulfillmentPort {
  ensureFulfilledFromPaidOrder(input: {
    orderUuid: string;
    outboxEventId: string;
    signal: AbortSignal;
  }): Promise<OrderPaidFulfillmentResult>;
}
