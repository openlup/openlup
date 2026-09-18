import {
  CUSTOMER_JOURNEY_CONTRACT_VERSION,
  type CustomerJourneyGap,
  type CustomerJourneyLookupRequest,
  type CustomerJourneySnapshotResponse,
} from "../../../src/domains/support/customerJourneyContracts.js";
import { currentParcelFor } from "../../../src/lib/currentFulfillmentParcel.js";
import {
  customerSafeEvidenceToken,
  customerStepFromTimedSignals,
  timelineLabelForStep,
  type CustomerFulfillmentStep,
} from "../../../src/domains/fulfillment/types.js";
import {
  compact,
  customerName,
  datetimeOrNull,
  displayLookup,
  editBlockedReason,
  gap,
  mapCommunication,
  stringOrNull,
  type Row,
} from "./customerJourneyCommon.js";
import { buildTimeline, firstTrace, nextChecks, orderGaps, subscriptionGaps, timelineWindowWarning } from "./customerJourneyProjection.js";

export function buildCustomerJourneySnapshotFromRows(input: {
  lookup: CustomerJourneyLookupRequest;
  client: Row | null;
  testers?: Row[];
  waitlist?: Row[];
  orders: Row[];
  subscriptions: Row[];
  cycles: Row[];
  paymentIntents: Row[];
  paymentAttempts: Row[];
  paymentTransitions: Row[];
  fulfillmentOrders: Row[];
  shipmentRefs: Row[];
  statusEvidence: Row[];
  inboundEvents: Row[];
  outboxEvents: Row[];
  communicationDeliveries: Row[];
  recoveryTokens: Row[];
}): CustomerJourneySnapshotResponse {
  const orders = input.orders.map((order) => {
    const orderId = String(order.id);
    const fulfillment = currentParcelFor(input.fulfillmentOrders, order.id);
    const currentFulfillmentId = stringOrNull(fulfillment?.id);
    const trackingRefs = input.shipmentRefs.filter((row) => row.order_id === order.id);
    const evidence = input.statusEvidence.filter((row) =>
      row.order_id === order.id || (fulfillment?.id && row.fulfillment_order_id === fulfillment.id)
    );
    const communications = input.communicationDeliveries
      .filter((row) => row.aggregate_id === order.id)
      .map(mapCommunication);
    const currentParcelCommunications = input.communicationDeliveries
      .filter((row) => currentFulfillmentId !== null && row.aggregate_id === order.id && row.fulfillment_order_id === currentFulfillmentId)
      .map(mapCommunication);
    const customerStep = customerStepFromTimedSignals(
      [stringOrNull(order.status), stringOrNull(fulfillment?.status)],
      [
        ...(fulfillment?.delivered_at
          ? [{ token: "delivered", occurredAt: stringOrNull(fulfillment.delivered_at) }]
          : []),
        ...evidence.map((row) => ({
          token: customerSafeEvidenceToken(
            stringOrNull(row.local_status),
            stringOrNull(row.provider_status),
          ),
          occurredAt: stringOrNull(row.occurred_at),
        })),
      ],
    );
    const hasWebhook = evidence.some((row) => row.evidence_kind === "webhook") || input.inboundEvents.some((row) => row.order_id === order.id);
    const hasReconciliation = evidence.some((row) => row.evidence_kind === "reconciliation");
    const gaps: CustomerJourneyGap[] = [];
    if (hasReconciliation && !hasWebhook) {
      gaps.push(gap(
        "webhook_missing_reconciliation_present",
        "warning",
        "Provider state is backed by reconciliation, but no inbound webhook evidence is linked.",
        "Ask provider for exact callback timestamp, URL, event type, request id, HTTP response and body.",
      ));
    }
    const shipmentEvidenceObserved = currentParcelCommunications.length > 0;
    gaps.push(...orderGaps({ fulfillment: { status: stringOrNull(fulfillment?.status), providerTrackingId: stringOrNull(trackingRefs[0]?.provider_tracking_id) } } as never, currentParcelCommunications, [], shipmentEvidenceObserved));
    return {
      orderId,
      orderNumber: stringOrNull(order.order_number),
      mode: stringOrNull(order.mode),
      status: stringOrNull(order.status),
      customerStep,
      customerLabel: timelineLabelForStep(customerStep as CustomerFulfillmentStep),
      customerAccountProjection: {
        status: order.status ?? null,
        fulfillmentStatus: fulfillment?.status ?? null,
        trackingNumbers: compact(trackingRefs.map((row) => stringOrNull(row.provider_tracking_id))),
        trackingReferences: trackingRefs.map((row) => ({
          providerKind: row.provider_kind ?? null,
          trackingNumber: row.provider_tracking_id ?? null,
          trackingUrl: row.tracking_url ?? null,
          active: row.active ?? null,
          updatedAt: row.updated_at ?? null,
        })),
      },
      omsProjection: {
        status: order.status ?? null,
        fulfillmentStatus: fulfillment?.status ?? null,
        paymentStatus: input.paymentIntents.find((row) => row.order_id === order.id)?.status ?? null,
        updatedAt: order.updated_at ?? order.created_at ?? null,
      },
      fulfillment: {
        fulfillmentOrderId: fulfillment?.id ?? null,
        status: fulfillment?.status ?? null,
        providerKind: fulfillment?.provider_kind ?? null,
        providerTrackingId: trackingRefs[0]?.provider_tracking_id ?? null,
        trackingUrl: trackingRefs[0]?.tracking_url ?? null,
        trackingTimeline: evidence.map((row) => ({
          observationId: row.id ?? null,
          eventType: row.provider_status ?? row.local_status ?? null,
          label: row.provider_status ?? row.local_status ?? null,
          occurredAt: row.occurred_at ?? null,
          source: row.evidence_kind ?? "provider_evidence",
          outcome: row.local_status ?? null,
        })),
      },
      communications,
      providerEvidence: evidence.map((row) => ({
        status: row.local_status ?? null,
        providerStatus: row.provider_status ?? null,
        providerSubStatus: row.provider_sub_status ?? null,
        evidenceKind: row.evidence_kind ?? null,
        occurredAt: row.occurred_at ?? null,
      })),
      gaps,
    };
  });
  const subscriptions = input.subscriptions.map((subscription) => {
    const subscriptionCycles = input.cycles.filter((cycle) => cycle.subscription_id === subscription.id);
    return {
      subscriptionId: String(subscription.id),
      status: stringOrNull(subscription.status),
      nextCycleAt: datetimeOrNull(subscription.next_cycle_at),
      templateVersion: typeof subscription.template_version === "number" ? subscription.template_version : null,
      editBlockedReason: editBlockedReason(subscription),
      paymentMethodStatus: stringOrNull(subscription.payment_method_status ?? subscription.payment_method_ref),
      cycles: subscriptionCycles.map((cycle) => ({
        cycleId: cycle.id,
        orderId: cycle.order_id,
        cycleNumber: cycle.cycle_number,
        status: cycle.status,
        scheduledAt: cycle.scheduled_at ?? cycle.planned_charge_at ?? null,
        paidAt: cycle.paid_at ?? cycle.charged_at ?? null,
      })),
      renewalOrders: input.orders.filter((order) => order.subscription_id === subscription.id).map((order) => ({
        orderId: order.id,
        orderNumber: order.order_number ?? null,
        status: order.status ?? null,
        createdAt: order.created_at ?? null,
      })),
      renewalCommunications: input.communicationDeliveries.filter((row) => row.aggregate_id === subscription.id).map(mapCommunication),
      gaps: subscriptionGaps(subscription, subscriptionCycles, null),
    };
  });
  const checkout = {
    orderDrafts: input.orders
      .filter((order) => ["draft", "pending_payment", "expired", "failed"].includes(String(order.status)))
      .map((order) => ({ orderId: order.id, orderNumber: order.order_number ?? null, status: order.status ?? null, createdAt: order.created_at ?? null })),
    recoveryTokens: input.recoveryTokens.map((token) => ({
      recoveryTokenId: token.id,
      orderId: token.order_id,
      expiresAt: token.expires_at ?? null,
      usedAt: token.used_at ?? null,
      createdAt: token.created_at ?? null,
    })),
    abandonedCartEvents: input.outboxEvents
      .filter((eventRow) => String(eventRow.event_type ?? "").includes("checkout") || String(eventRow.event_type ?? "").includes("order_draft"))
      .map((eventRow) => ({
        id: eventRow.id,
        eventType: eventRow.event_type,
        status: eventRow.status,
        createdAt: eventRow.created_at,
      })),
  };
  const gaps = [...orders.flatMap((order) => order.gaps), ...subscriptions.flatMap((subscription) => subscription.gaps)];
  const timelineInput = { customer: input.client, checkout, orders, subscriptions };
  const timeline = buildTimeline(timelineInput);
  return {
    contractVersion: CUSTOMER_JOURNEY_CONTRACT_VERSION,
    lookup: {
      query: displayLookup(input.lookup),
      matchedBy: input.lookup.orderId ? "orderId" : input.lookup.orderNumber ? "orderNumber" : input.lookup.email ? "email" : "query",
      confidence: input.client || input.orders.length || input.subscriptions.length ? "exact" : "none",
      warnings: [timelineWindowWarning(timelineInput)].filter((value): value is string => Boolean(value)),
    },
    customer: {
      clientId: stringOrNull(input.client?.id),
      email: stringOrNull(input.client?.email),
      name: customerName(input.client),
      authUserLinked: Boolean(input.client?.auth_user_id),
      lifecycleStage: stringOrNull(input.client?.lifecycle_stage),
    },
    firstTrace: firstTrace(input.client, input.orders, checkout),
    checkout,
    payment: {
      status: stringOrNull(input.paymentIntents[0]?.status),
      intents: input.paymentIntents,
      attempts: input.paymentAttempts,
      transitions: input.paymentTransitions,
      providerRefs: input.paymentIntents.map((intent) => ({
        orderId: intent.order_id ?? null,
        providerPaymentId: intent.provider_payment_id ?? null,
        status: intent.status ?? null,
      })),
    },
    orders,
    subscriptions,
    timeline,
    gaps,
    nextChecks: nextChecks({ gaps, hasOrders: orders.length > 0, hasCustomer: Boolean(input.client), subscriptions }),
  };
}

// An order may hold more than one fulfilment row once it carries a replacement parcel:
// the original at `sequence_no` 0 and the replacement at 1, 2, … A support agent
// diagnosing a delivery must be shown the parcel that currently represents the order —
// the highest `sequence_no`, tie-broken by `id` — not whichever row the read happened to
// return first. With one row the winner is that row, so the snapshot is unchanged.
