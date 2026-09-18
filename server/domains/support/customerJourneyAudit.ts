import { createHash } from "node:crypto";
import type { CustomerJourneySnapshotResponse } from "../../../src/domains/support/customerJourneyContracts.js";

type EntityKind = "subject" | "order" | "subscription" | "dunning_case";
type Row = Record<string, unknown>;
export type CustomerJourneyAuditEvent = {
  eventId: string;
  occurredAt: string;
  action: string;
  outcome: string;
  entity: { kind: EntityKind; id: string };
};

export function portableTimelineAuditEvent(event: CustomerJourneySnapshotResponse["timeline"][number], subjectId: string): CustomerJourneyAuditEvent[] {
  if (!event.occurredAt) return [];
  const refs = event.entityRef as Row;
  const orderId = text(refs.orderId);
  const subscriptionId = text(refs.subscriptionId);
  const entity = orderId
    ? { kind: "order" as const, id: orderId }
    : subscriptionId
      ? { kind: "subscription" as const, id: subscriptionId }
      : { kind: "subject" as const, id: subjectId };
  const outcome = text(refs.outcome) ?? (event.kind === "customer.created" ? "created" : "observed");
  const rowId = text(refs.communicationId) ?? text(refs.recoveryTokenId)
    ?? text(refs.outboxEventId) ?? text(refs.cycleId) ?? text(refs.observationId);
  const key = rowId
    ? `${event.kind}:${event.source ?? ""}:${entity.kind}:${entity.id}:${rowId}`
    : `${event.kind}:${event.source ?? ""}:${event.occurredAt}:${entity.kind}:${entity.id}:${text(refs.observationKey) ?? ""}`;
  return [{
    eventId: createHash("sha256").update(key).digest("hex").slice(0, 32),
    occurredAt: event.occurredAt,
    action: actionFor(event.kind),
    outcome,
    entity,
  }];
}

export function boundedCustomerJourneyAudit(events: CustomerJourneyAuditEvent[]) {
  const newest = [...events].sort((a, b) =>
    instant(b.occurredAt) - instant(a.occurredAt) || a.eventId.localeCompare(b.eventId));
  return {
    events: newest.slice(0, 80).sort((a, b) =>
      instant(a.occurredAt) - instant(b.occurredAt) || a.eventId.localeCompare(b.eventId)),
    windowed: newest.length > 80,
  };
}

function actionFor(kind: string) {
  const actions: Record<string, string> = {
    "customer.created": "clients.customer.created",
    "checkout.order_draft": "commerce_orders.checkout.order_draft",
    "checkout.recovery_token": "checkout_recovery_tokens.checkout.recovery_token",
    "checkout.outbox": "outbox_events.checkout.outbox",
    "fulfillment.status": "fulfillment.fulfillment.status",
    "communication.email": "communication_deliveries.communication.email",
    "subscription.cycle": "subscription_cycles.subscription.cycle",
    "payment.failed": "payment.payment.failed",
  };
  return actions[kind] ?? "customer_journey.observed";
}

function instant(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
