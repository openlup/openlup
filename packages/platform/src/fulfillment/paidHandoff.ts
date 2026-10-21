import { z } from "zod";


const COMMERCE_ORDER_PAID_EVENT_TYPE = "commerce.order.paid";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
} from "@openlup/core/outbox";
import type { OrderPaidFulfillmentPort } from "./paidHandoffPorts.js";

const HANDLER_TIMEOUT_MS = 15_000;

const outboxOrderPaidFulfillmentDescriptor = Object.freeze({
  eventType: COMMERCE_ORDER_PAID_EVENT_TYPE, timeoutMs: HANDLER_TIMEOUT_MS,
});

// Risk seam (optional): assess a paid order BEFORE fulfillment. Declared here so
// this handler never imports the server risk port; the impl
// (server/domains/risk/orderPaidRiskPort) is structurally assignable.
interface OrderPaidRiskAssessmentPort {
  assessPaidOrder(input: {
    orderUuid: string;
    outboxEventId: string;
    signal: AbortSignal;
  }): Promise<
    | { kind: "allow"; detail?: Record<string, unknown> }
    | { kind: "review" | "block"; detail?: Record<string, unknown> }
    | { kind: "retryable"; reason: string }
    | { kind: "fatal"; reason: string }
  >;
}

// Frozen minimal parse (mirror outboxOrderDraftEmailHandler): validate ONLY the
// orderUuid this handler forwards to the fulfillment RPCs, with a schema owned
// HERE so a producer-side payload change never retro-DLQs in-flight events.
const payloadSubsetSchema = z
  .object({
    orderUuid: z.guid(),
  })
  .passthrough();

export function createOutboxOrderPaidFulfillmentHandler(deps: {
  fulfillmentPort: OrderPaidFulfillmentPort;
  // Optional risk seam. When set AND enabled, a paid order is risk-assessed
  // before fulfillment; a review/block holds the order (no dispatch).
  riskPort?: OrderPaidRiskAssessmentPort;
  isRiskEnabled?: () => boolean;
}): OutboxHandler<AbortSignal> {
  return {
    ...outboxOrderPaidFulfillmentDescriptor,
    async handle(row: OutboxEventRow, signal: AbortSignal): Promise<OutboxHandlerOutcome> {
      const parsed = parseOutboxPayload(payloadSubsetSchema, row.payload);
      if (parsed.ok === false) {
        return parsed.outcome;
      }

      // Risk gate (flag-OFF by default): assess the paid order before any
      // fulfillment work. review/block → hold (ack without dispatch, the case is
      // persisted for manual review); retryable/fatal map to the worker ladder.
      if (deps.riskPort && deps.isRiskEnabled?.()) {
        const risk = await deps.riskPort.assessPaidOrder({
          orderUuid: parsed.data.orderUuid,
          outboxEventId: row.id,
          signal,
        });
        switch (risk.kind) {
          case "allow":
            break;
          case "review":
          case "block":
            return {
              kind: "processed",
              detail: { skipped: "risk_review_hold", risk: risk.detail ?? {} },
            };
          case "retryable":
            return { kind: "retry", reason: truncateReason(risk.reason) };
          case "fatal":
            return { kind: "discard", reason: truncateReason(risk.reason) };
        }
      }

      const result = await deps.fulfillmentPort.ensureFulfilledFromPaidOrder({
        orderUuid: parsed.data.orderUuid,
        outboxEventId: row.id,
        signal,
      });

      switch (result.kind) {
        case "completed":
        case "skipped":
          return { kind: "processed", detail: result.detail };
        case "manual_review":
          // Terminal but NOT a silent discard: the port already placed the
          // durable observable signal (an active fulfillment_exception hold).
          // Settle the event as processed so it is not parked in the discard/
          // error queue, and record why in the outbox metadata.
          return {
            kind: "processed",
            detail: {
              ...result.detail,
              outcome: "manual_review",
              reason: truncateReason(result.reason),
            },
          };
        case "retryable":
          return { kind: "retry", reason: truncateReason(result.reason) };
        case "snooze":
          return { kind: "snooze", reason: truncateReason(result.reason) };
        case "fatal":
          return { kind: "discard", reason: truncateReason(result.reason) };
      }
    },
  };
}

function truncateReason(value: string): string { return value.length <= 300 ? value : `${value.slice(0, 300)}…`; }
function parseOutboxPayload<T>(schema: import("zod").ZodType<T>, payload: unknown):
  { ok: true; data: T } | { ok: false; outcome: OutboxHandlerOutcome } {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { ok: true, data: parsed.data };
  const detail = parsed.error.issues.map(issue => `${issue.path.join(".") || "payload"}: ${issue.message}`).join("; ");
  return { ok: false, outcome: { kind: "discard", reason: `contract_parse_failed: ${truncateReason(detail)}` } };
}
