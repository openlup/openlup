import type { OutboxHandler as KernelHandler } from "@openlup/core/outbox";
export type { OutboxEventRow, OutboxHandlerOutcome, OutboxHandlerExecutionContext, OutboxHandlerDescriptor } from "@openlup/core/outbox";
export type OutboxHandler = KernelHandler<AbortSignal>;
export type OutboxHandlerRegistry = ReadonlyMap<string, OutboxHandler>;
export interface CheckoutEmailOutboxReconcileResult {
  checked: { paid: number; failed: number; expired: number };
  inserted: {
    commerceOrderPaid: number;
    commerceOrderPaidEmail: number;
    commercePaymentFailed: number;
    commerceCheckoutExpired: number;
  };
}

export interface CheckoutEmailOutboxReconcilePort {
  reconcile(limit: number): Promise<CheckoutEmailOutboxReconcileResult>;
}

export interface ReorderReminderEnqueueResult {
  enqueued: number;
}

export interface ReorderReminderEnqueuePort {
  enqueue(limit: number): Promise<ReorderReminderEnqueueResult>;
}

export interface ReviewRequestEnqueuePort {
  enqueueRequests(limit: number): Promise<number>;
  enqueueEffects(limit: number): Promise<number>;
}
