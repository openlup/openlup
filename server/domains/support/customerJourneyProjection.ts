import type {
  CustomerJourneyGap,
  CustomerJourneySnapshotResponse,
  CustomerJourneyTimelineEvent,
} from "../../../src/domains/support/customerJourneyContracts.js";
import {
  customerSafeEvidenceToken,
  customerStepFromTimedSignals,
  timelineLabelForStep,
  type CustomerFulfillmentStep,
} from "../../../src/domains/fulfillment/types.js";
import {
  datetimeOrNull,
  gap,
  isConfirmedShipmentCommunication,
  mapCommunication,
  stringOrNull,
  timestamp,
  type Row,
} from "./customerJourneyCommon.js";

type SupportOmsOrderProjection = {
  orderId: string;
  orderNumber?: string | null;
  mode?: string | null;
  status: string | null;
  updatedAt: string | null;
  attentionReason: unknown;
  nextAction: unknown;
  fulfillmentEligibility: unknown;
  accounting: unknown;
  activeHoldCount: number;
  subscription: unknown;
  payment: { status: unknown };
  communicationDeliveries: Array<Partial<{
    id: unknown; purpose: unknown; templateSlug: unknown; triggerSource: unknown;
    status: unknown; providerKind: unknown; providerMessageId: unknown;
    queuedAt: unknown; sentAt: unknown; deliveredAt: unknown; terminalAt: unknown;
    outboxEventId: unknown; emailSendId: unknown;
  }>>;
  fulfillment: {
    fulfillmentOrderId?: unknown; status?: string | null; providerKind?: unknown;
    providerTrackingId?: unknown; trackingUrl?: unknown; carrierKind?: unknown;
    latestOperationType?: unknown; latestOperationAt?: unknown;
    trackingReferences?: unknown;
    trackingTimeline: Array<Partial<{ eventType: string; occurredAt: string | null }>>;
    providerEvidence: Array<Partial<{
      evidenceType: string; status: string | null; providerStatus: string | null;
      providerOrderId: unknown; evidenceKind: unknown; occurredAt: string | null;
      updatedAt: unknown; summary: unknown;
    }>>;
  };
};

export function mapOrderSnapshot(order: SupportOmsOrderProjection): CustomerJourneySnapshotResponse["orders"][number] {
  const timedEvidence = [
    ...order.fulfillment.providerEvidence
      .filter((evidence) => evidence.evidenceType === "status_evidence")
      .map((evidence) => ({
        token: customerSafeEvidenceToken(evidence.status ?? null, evidence.providerStatus ?? null),
        occurredAt: evidence.occurredAt ?? null,
      })),
    ...order.fulfillment.trackingTimeline.map((event) => ({
      token: event.eventType ?? "",
      occurredAt: event.occurredAt ?? null,
    })),
  ];
  const customerStep = customerStepFromTimedSignals(
    [order.status, order.fulfillment.status ?? null],
    timedEvidence,
  );
  const communications = order.communicationDeliveries.map((delivery) => ({
    id: delivery.id,
    purpose: delivery.purpose,
    templateSlug: delivery.templateSlug,
    triggerSource: delivery.triggerSource,
    status: delivery.status,
    providerKind: delivery.providerKind,
    providerMessageId: delivery.providerMessageId,
    queuedAt: delivery.queuedAt,
    sentAt: delivery.sentAt,
    deliveredAt: delivery.deliveredAt,
    terminalAt: delivery.terminalAt,
    outboxEventId: delivery.outboxEventId,
    emailSendId: delivery.emailSendId,
  }));
  const providerEvidence = order.fulfillment.providerEvidence.map((evidence) => ({
    evidenceType: evidence.evidenceType,
    status: evidence.status,
    providerStatus: evidence.providerStatus,
    providerOrderId: evidence.providerOrderId,
    evidenceKind: evidence.evidenceKind,
    occurredAt: evidence.occurredAt,
    updatedAt: evidence.updatedAt,
    summary: evidence.summary,
  }));
  return {
    orderId: order.orderId,
    orderNumber: order.orderNumber ?? null,
    mode: order.mode ?? null,
    status: order.status,
    customerStep,
    customerLabel: timelineLabelForStep(customerStep as CustomerFulfillmentStep),
    customerAccountProjection: {
      status: order.status,
      fulfillmentStatus: order.fulfillment.status,
      trackingReferences: order.fulfillment.trackingReferences,
      subscription: order.subscription,
    },
    omsProjection: {
      attentionReason: order.attentionReason,
      nextAction: order.nextAction,
      paymentStatus: order.payment.status,
      fulfillmentEligibility: order.fulfillmentEligibility,
      accounting: order.accounting,
      activeHoldCount: order.activeHoldCount,
      updatedAt: order.updatedAt,
    },
    fulfillment: {
      fulfillmentOrderId: order.fulfillment.fulfillmentOrderId,
      status: order.fulfillment.status,
      providerKind: order.fulfillment.providerKind,
      providerTrackingId: order.fulfillment.providerTrackingId,
      trackingUrl: order.fulfillment.trackingUrl,
      carrierKind: order.fulfillment.carrierKind,
      latestOperationType: order.fulfillment.latestOperationType,
      latestOperationAt: order.fulfillment.latestOperationAt,
      trackingTimeline: order.fulfillment.trackingTimeline,
    },
    communications,
    providerEvidence,
    gaps: orderGaps(order, communications, providerEvidence, false),
  };
}

export function orderGaps(
  order: SupportOmsOrderProjection,
  communications: CustomerJourneySnapshotResponse["orders"][number]["communications"],
  providerEvidence: Row[],
  shipmentEvidenceObserved = true,
): CustomerJourneyGap[] {
  const gaps: CustomerJourneyGap[] = [];
  if (order.fulfillment.status && !order.fulfillment.providerTrackingId) {
    gaps.push(gap("tracking_missing", "warning", "Fulfillment status exists but no active shipment tracking reference is present", "Check shipment_external_refs for this order"));
  }
  const hasWebhook = providerEvidence.some((entry) => entry.evidenceKind === "webhook");
  const hasReconciliation = providerEvidence.some((entry) => entry.evidenceKind === "reconciliation");
  if (!hasWebhook && hasReconciliation) {
    gaps.push(gap("webhook_missing", "warning", "Latest provider movement is backed by reconciliation, not an inbound webhook", "Check omnipack_status_evidence and inbound_provider_events"));
  }
  if (!shipmentEvidenceObserved && ["handed_over", "in_transit", "delivered"].includes(String(order.fulfillment.status))) {
    gaps.push(gap("shipment_email_identity_unconfirmed", "info", "Order communications do not identify the current parcel", "Read the communication evidence for the selected fulfillment"));
  }
  if (shipmentEvidenceObserved && ["handed_over", "in_transit", "delivered"].includes(String(order.fulfillment.status)) && !communications.some(isConfirmedShipmentCommunication)) {
    gaps.push(gap("shipment_email_not_confirmed", "warning", "Shipment state advanced but no sent/delivered shipment communication is visible in the order projection", "Check communication_email_deliveries for aggregate_type=commerce_order"));
  }
  return gaps;
}

export function subscriptionGaps(subscription: Row, cycles: Row[], paymentMethod: Row | null): CustomerJourneyGap[] {
  const gaps: CustomerJourneyGap[] = [];
  if (subscription.status === "active" && !subscription.next_cycle_at) {
    gaps.push(gap("subscription_next_cycle_missing", "warning", "Active subscription has no next_cycle_at", "Check subscriptions and subscription_cycles"));
  }
  if (subscription.status === "active" && !paymentMethod && !subscription.payment_method_ref) {
    gaps.push(gap("subscription_payment_method_missing", "critical", "Active subscription has no linked payment method evidence", "Check commerce_payment_method_refs"));
  }
  if (subscription.next_cycle_at && !cycles.length) {
    gaps.push(gap("subscription_cycles_missing", "info", "Subscription has next_cycle_at but no cycle rows in the snapshot window", "Check subscription_cycles by subscription_id"));
  }
  return gaps;
}

export function buildTimeline(input: {
  customer: Row | null;
  checkout: CustomerJourneySnapshotResponse["checkout"];
  orders: CustomerJourneySnapshotResponse["orders"];
  subscriptions: CustomerJourneySnapshotResponse["subscriptions"];
}): CustomerJourneyTimelineEvent[] {
  return timelineEvents(input)
    .filter((item) => item.occurredAt)
    .sort((a, b) => timestamp(b.occurredAt) - timestamp(a.occurredAt) || timelineKey(a).localeCompare(timelineKey(b)))
    .slice(0, 80)
    .sort((a, b) => timestamp(a.occurredAt) - timestamp(b.occurredAt) || timelineKey(a).localeCompare(timelineKey(b)));
}

export function timelineWindowWarning(input: Parameters<typeof buildTimeline>[0]): string | null {
  return timelineEvents(input).filter((item) => item.occurredAt).length > 80
    ? "evidence_window_limited:customer_journey_timeline"
    : null;
}

function timelineEvents(input: {
  customer: Row | null;
  checkout: CustomerJourneySnapshotResponse["checkout"];
  orders: CustomerJourneySnapshotResponse["orders"];
  subscriptions: CustomerJourneySnapshotResponse["subscriptions"];
}): CustomerJourneyTimelineEvent[] {
  const events: CustomerJourneyTimelineEvent[] = [];
  if (input.customer?.created_at) {
    events.push(event(input.customer.created_at, "customer.created", "Pierwszy rekord klienta", "clients", { clientId: stringOrNull(input.customer.id), outcome: "created" }));
  }
  for (const draft of input.checkout.orderDrafts) {
    events.push(event(draft.createdAt, "checkout.order_draft", `Checkout ${draft.status ?? "draft"}`, "commerce_orders", { orderId: stringOrNull(draft.orderId), outcome: stringOrNull(draft.status) }));
  }
  for (const token of input.checkout.recoveryTokens) {
    events.push(event(token.createdAt, "checkout.recovery_token", "Token recovery utworzony", "commerce_checkout_recovery_tokens", { orderId: stringOrNull(token.orderId), recoveryTokenId: stringOrNull(token.recoveryTokenId ?? token.id), outcome: "created" }));
  }
  for (const outbox of input.checkout.abandonedCartEvents) {
    events.push(event(outbox.createdAt, "checkout.outbox", String(outbox.eventType ?? "checkout event"), "outbox_events", { outboxEventId: stringOrNull(outbox.id), outcome: stringOrNull(outbox.status) }));
  }
  for (const order of input.orders) {
    for (const item of order.fulfillment.trackingTimeline as Row[]) {
      events.push(event(item.occurredAt, "fulfillment.status", String(item.label ?? item.eventType ?? "fulfillment event"), String(item.source ?? "fulfillment"), { orderId: order.orderId, fulfillmentOrderId: stringOrNull(order.fulfillment.fulfillmentOrderId), observationId: stringOrNull(item.observationId), observationKey: stringOrNull(item.eventType), outcome: stringOrNull(item.outcome) }));
    }
    for (const communication of order.communications) {
      events.push(event(communication.deliveredAt ?? communication.sentAt ?? communication.queuedAt, "communication.email", `${communication.templateSlug ?? communication.purpose ?? "email"}: ${communication.status ?? "unknown"}`, "communication_email_deliveries", { orderId: order.orderId, communicationId: stringOrNull(communication.id), outcome: stringOrNull(communication.status) }));
    }
  }
  for (const subscription of input.subscriptions) {
    for (const cycle of subscription.cycles) {
      events.push(event(cycle.paidAt, "subscription.cycle", `Cykl ${cycle.cycleNumber ?? ""}: ${cycle.status ?? "unknown"}`, "subscription_cycles", { subscriptionId: subscription.subscriptionId, cycleId: stringOrNull(cycle.cycleId), outcome: stringOrNull(cycle.status) }));
    }
  }
  return events;
}

export function firstTrace(customer: Row | null, orders: Row[], checkout: CustomerJourneySnapshotResponse["checkout"]): CustomerJourneySnapshotResponse["firstTrace"] {
  const candidates: CustomerJourneySnapshotResponse["firstTrace"][] = [];
  if (customer?.created_at) candidates.push({ kind: "customer", source: "clients", occurredAt: datetimeOrNull(customer.created_at), sourceRef: { clientId: stringOrNull(customer.id) } });
  for (const order of orders) candidates.push({ kind: "order", source: "commerce_orders", occurredAt: datetimeOrNull(order.created_at), sourceRef: { orderId: stringOrNull(order.id) } });
  for (const token of checkout.recoveryTokens) candidates.push({ kind: "checkout_recovery", source: "commerce_checkout_recovery_tokens", occurredAt: datetimeOrNull(token.createdAt), sourceRef: { orderId: stringOrNull(token.orderId) } });
  const datedCandidates = candidates.filter((value) => value.occurredAt);
  return datedCandidates.sort((a, b) => timestamp(a.occurredAt) - timestamp(b.occurredAt))[0] ?? {
    kind: null,
    source: null,
    occurredAt: null,
    sourceRef: {},
  };
}

export function nextChecks(input: {
  gaps: CustomerJourneyGap[];
  hasOrders: boolean;
  hasCustomer: boolean;
  subscriptions: CustomerJourneySnapshotResponse["subscriptions"];
}): string[] {
  const checks = new Set<string>();
  if (!input.hasCustomer) checks.add("Run support__customer_journey_search with exact email or clientId to confirm identity.");
  if (!input.hasOrders) checks.add("Check checkout/order draft evidence; no paid/renewal order was linked by this lookup.");
  if (input.gaps.some((gapItem) => gapItem.code === "webhook_missing" || gapItem.code === "webhook_missing_reconciliation_present")) {
    checks.add("Ask provider for exact callback timestamp, target URL, event type, request id, HTTP response and body; compare with inbound_provider_events.");
  }
  if (input.gaps.some((gapItem) => gapItem.code === "shipment_email_not_confirmed")) checks.add("Read communication_email_deliveries for shipment templates and provider_message_id delivery state.");
  if (input.subscriptions.length) checks.add("For renewal incidents, compare subscriptions.next_cycle_at, subscription_cycles.status, renewal order status, and renewal communications.");
  checks.add("Use SQL fallback only as operator emergency evidence path; MCP/BFF snapshot is the primary read.");
  return [...checks];
}

function event(occurredAt: unknown, kind: string, label: string, source: string, entityRef: Record<string, string | null>): CustomerJourneyTimelineEvent {
  return { occurredAt: datetimeOrNull(occurredAt), kind, label, source, entityRef };
}

function timelineKey(event: CustomerJourneyTimelineEvent): string {
  return `${event.kind}:${event.source ?? ""}:${Object.entries(event.entityRef).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value ?? ""}`).join(":")}`;
}

export { mapCommunication };
