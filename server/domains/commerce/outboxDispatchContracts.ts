export type { OutboxEventRow, OutboxHandlerOutcome, OutboxHandler, OutboxHandlerExecutionContext, OutboxHandlerRegistry, OutboxMarkFailedStatus, OutboxStore, OutboxQueueDiagnostics, Clock, OutboxDispatchRunResult, OutboxDispatchConfig } from "@openlup/outbox";
export { readOutboxDispatchConfig, OutboxHandlerExecutionTrace } from "@openlup/outbox";
export type { CheckoutEmailOutboxReconcileResult, CheckoutEmailOutboxReconcilePort, ReorderReminderEnqueueResult, ReorderReminderEnqueuePort, ReviewRequestEnqueuePort } from "@openlup/platform/commerce";

// Vercel kills the function at maxDuration; the visibility floor keeps a
// claimed row invisible for >= 5x that, so a dying invocation can never
// overlap the next claim of the same row. outbox-dispatch.ts must keep its
// `config = { maxDuration: 60 }` literal equal to this constant (asserted in
// outboxDispatchJob.test.ts).
export const OUTBOX_DISPATCH_CRON_MAX_DURATION_SECONDS = 60;
export const OUTBOX_DISPATCH_MIN_VISIBILITY_SECONDS =
  5 * OUTBOX_DISPATCH_CRON_MAX_DURATION_SECONDS;
