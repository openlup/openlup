import { expect, it } from "vitest";
import type { OutboxEventRow } from "@openlup/core/outbox";
import { collectPaidFulfillmentRecoveryCandidates, createOutboxOrderPaidFulfillmentHandler } from "../../src/fulfillment/index.js";

it("retains the paid handler's parse/risk/fulfillment/outcome ladder without early acknowledgement", async () => {
  const trace: string[] = [];
  const row: OutboxEventRow = { id: "event-a", payload: { orderUuid: "00000000-0000-4000-8000-000000000001" },
    created_at: "2026-10-21T10:00:00Z", available_at: "2026-10-21T10:00:00Z", processed_at: null, aggregate_type: "order", aggregate_id: "order-a",
    event_type: "commerce.order.paid", idempotency_key: "event-key", status: "pending", attempts: 0, error: null, metadata: {} };
  const controller = new AbortController();
  const handler = createOutboxOrderPaidFulfillmentHandler({
    fulfillmentPort: { async ensureFulfilledFromPaidOrder(input) {
      expect(input).toEqual({ orderUuid: row.payload.orderUuid, outboxEventId: row.id, signal: controller.signal });
      // Host/P4 owns paid truth and inventory. Its injected port completes the
      // obligation before returning; only then may the outbox settle the event.
      trace.push("paid-truth", "obligation"); return { kind: "completed" };
    } },
    riskPort: { async assessPaidOrder() { trace.push("risk"); return { kind: "allow" }; } }, isRiskEnabled: () => true,
  });
  expect(handler).toMatchObject({ eventType: "commerce.order.paid", timeoutMs: 15000 });
  expect(await handler.handle(row, controller.signal)).toEqual({ kind: "processed", detail: undefined });
  trace.push("ACK"); expect(trace).toEqual(["risk", "paid-truth", "obligation", "ACK"]);
  expect(await handler.handle({ ...row, payload: {} }, controller.signal)).toMatchObject({ kind: "discard", reason: expect.stringContaining("contract_parse_failed") });
  for (const kind of ["completed", "skipped", "manual_review", "retryable", "snooze", "fatal"] as const) {
    const h = createOutboxOrderPaidFulfillmentHandler({ fulfillmentPort: { async ensureFulfilledFromPaidOrder() { return { kind, reason: "synthetic-reason", detail: { witness: true } }; } } });
    expect((await h.handle(row, controller.signal)).kind).toBe(({ completed: "processed", skipped: "processed", manual_review: "processed", retryable: "retry", snooze: "snooze", fatal: "discard" })[kind]);
  }
  for (const kind of ["review", "block", "retryable", "fatal"] as const) {
    const h = createOutboxOrderPaidFulfillmentHandler({ fulfillmentPort: { async ensureFulfilledFromPaidOrder() { throw new Error("risk must precede fulfillment"); } },
      riskPort: { async assessPaidOrder() { return { kind, reason: "synthetic-risk" }; } }, isRiskEnabled: () => true });
    expect((await h.handle(row, controller.signal)).kind).toBe(kind === "retryable" ? "retry" : kind === "fatal" ? "discard" : "processed");
  }
});

it("preserves missing-paid-effect, stale submission, uncertain and terminal recovery classification with injected provider identity", () => {
  const now = new Date("2026-10-21T12:00:00Z"), old = "2026-10-21T09:00:00Z";
  const result = collectPaidFulfillmentRecoveryCandidates({ providerRef: "warehouse-a", now,
    orders: [{ id: "missing", status: "paid", created_at: old }, { id: "dispatch", status: "fulfillment_pending", created_at: old }],
    fulfillmentOrders: ["draft", "submitting", "uncertain", "failed", "created", "cancelled", "other"].map(status => ({ id: status, order_id: "dispatch", provider_kind: "warehouse-a", created_at: old })),
    dispatchRefs: ["draft", "submitting", "uncertain", "failed", "created", "cancelled", "other"].map(status => ({ id: `ref-${status}`, fulfillment_order_id: status, status, updated_at: old })),
    orderPaidOutboxEvents: [{ id: "event-a", aggregate_id: "missing", event_type: "commerce.order.paid", status: "discarded" }],
  });
  expect(result.checkedOrders).toBe(2);
  expect(result.candidates.map(x => x.recommendedAction)).toEqual(["monitor_dispatch", "inspect_stale_dispatch_submission", "inspect_uncertain_dispatch", "inspect_failed_dispatch", "inspect_created_dispatch_without_provider_order_id", "inspect_terminal_dispatch", "inspect_unknown_dispatch_status", "requeue_discarded_order_paid_outbox"]);
  expect(result.candidates.at(-1)!.recoveryPosture).toBe("automatic_local_requeue_safe");
  expect(result.candidates.slice(1, -1).every(x => x.recoveryPosture === "operator_review_required")).toBe(true);
});
