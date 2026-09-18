import {
  CUSTOMER_JOURNEY_CONTRACT_VERSION,
  type CustomerJourneySearchResult,
  type CustomerJourneySnapshotResponse,
} from "../../../../src/domains/support/customerJourneyContracts.js";
import {
  getCommerceOmsOrderDetails,
} from "../commerce/oms/readQueries.js";
import type { CommerceOmsSupabaseClient } from "../commerce/oms/types.js";
import type { CustomerJourneySnapshotPort } from "../../../domains/support/customerJourneySnapshot.js";
import {
  compact,
  customerName,
  displayLookup,
  nameFromOms,
  stringOrNull,
} from "../../../domains/support/customerJourneyCommon.js";
import {
  firstClientForOrders,
  readCandidateOrders,
  readClientById,
  readTrackingForOrder,
  resolveLookup,
  subscriptionIdsFrom,
} from "./customerJourneyLookup.js";
import {
  readCheckoutEvidence,
  readPaymentProviderRefs,
  readSubscriptions,
} from "./customerJourneyEvidenceReads.js";
import {
  buildTimeline,
  firstTrace,
  mapOrderSnapshot,
  nextChecks,
  timelineWindowWarning,
} from "../../../domains/support/customerJourneyProjection.js";

export function createSupabaseCustomerJourneySnapshotPort(
  client: CommerceOmsSupabaseClient,
): CustomerJourneySnapshotPort {
  return {
    async search(request) {
      const resolved = await resolveLookup(client, request);
      const query = displayLookup(request);
      const warnings = resolved.warnings;
      const orders = await readCandidateOrders(client, resolved, request.pageSize);
      const clients = resolved.client ? [resolved.client] : [];
      const candidates: CustomerJourneySearchResult["candidates"] = await Promise.all(
        orders.map(async (order) => {
          const customer = clients.find((row) => row.id === order.client_id)
            ?? (order.client_id ? await readClientById(client, String(order.client_id)) : null);
          const tracking = await readTrackingForOrder(client, String(order.id));
          return {
            matchedBy: resolved.matchedBy,
            confidence: resolved.confidence,
            clientId: stringOrNull(order.client_id ?? customer?.id),
            email: stringOrNull(customer?.email),
            name: customerName(customer),
            orderId: String(order.id),
            orderNumber: stringOrNull(order.order_number),
            subscriptionId: stringOrNull(order.subscription_id),
            trackingNumber: stringOrNull(tracking?.provider_tracking_id),
            status: stringOrNull(order.status),
            lastActivityAt: stringOrNull(order.updated_at ?? order.created_at),
            snapshotLookup: { orderId: String(order.id) },
          };
        }),
      );

      if (!candidates.length && resolved.client) {
        candidates.push({
          matchedBy: resolved.matchedBy,
          confidence: resolved.confidence,
          clientId: String(resolved.client.id),
          email: stringOrNull(resolved.client.email),
          name: customerName(resolved.client),
          orderId: null,
          orderNumber: null,
          subscriptionId: stringOrNull(resolved.subscriptionId),
          trackingNumber: null,
          status: stringOrNull(resolved.client.lifecycle_stage),
          lastActivityAt: stringOrNull(resolved.client.updated_at ?? resolved.client.created_at),
          snapshotLookup: { clientId: String(resolved.client.id) },
        });
      }

      return { contractVersion: CUSTOMER_JOURNEY_CONTRACT_VERSION, query, candidates: candidates.slice(0, request.pageSize), warnings };
    },

    async snapshot(request) {
      const resolved = await resolveLookup(client, request);
      const orders = await readCandidateOrders(client, resolved, request.pageSize);
      const orderDetails = await getCommerceOmsOrderDetails(client, orders.map((order) => String(order.id)));
      if (orderDetails.length !== orders.length || orderDetails.some((detail) => !detail)) throw new Error("customer_journey_order_hydration_unavailable");
      const hydratedOrders = orderDetails.filter((detail): detail is NonNullable<typeof detail> => Boolean(detail));
      const customer = resolved.client
        ?? await firstClientForOrders(client, orders)
        ?? (hydratedOrders[0]?.order.customer?.id ? await readClientById(client, String(hydratedOrders[0].order.customer.id)) : null);
      const clientId = stringOrNull(customer?.id ?? hydratedOrders[0]?.order.clientId);
      const subscriptionIds = subscriptionIdsFrom(resolved, orders);
      const [checkout, subscriptions, paymentRefs] = await Promise.all([
        readCheckoutEvidence(client, clientId, orders),
        readSubscriptions(client, clientId, subscriptionIds),
        readPaymentProviderRefs(client, orders),
      ]);
      const mappedOrders = hydratedOrders.map((detail) => mapOrderSnapshot(detail.order));
      const gaps = [...resolved.gaps, ...mappedOrders.flatMap((order) => order.gaps), ...subscriptions.value.flatMap((subscription) => subscription.gaps)];
      const timelineInput = { customer, checkout: checkout.value, orders: mappedOrders, subscriptions: subscriptions.value };
      const timeline = buildTimeline(timelineInput);
      const candidateWindowWarning = !resolved.orderIds.length && orders.length >= request.pageSize
        ? "evidence_window_limited:candidate_orders"
        : null;
      const timelineWarning = timelineWindowWarning(timelineInput);
      const shipmentLinkWarning = gaps.some((entry) => entry.code === "shipment_email_identity_unconfirmed")
        ? "evidence_unavailable:shipment_communication_linkage" : null;

      const snapshot: CustomerJourneySnapshotResponse = {
        contractVersion: CUSTOMER_JOURNEY_CONTRACT_VERSION,
        lookup: { query: displayLookup(request), matchedBy: resolved.matchedBy, confidence: resolved.confidence, warnings: [...resolved.warnings, ...checkout.warnings, ...subscriptions.warnings, ...paymentRefs.warnings, ...[candidateWindowWarning, timelineWarning, shipmentLinkWarning].filter((warning): warning is string => Boolean(warning))] },
        customer: {
          clientId,
          email: stringOrNull(customer?.email ?? hydratedOrders[0]?.order.customer?.email),
          name: customerName(customer) ?? nameFromOms(hydratedOrders[0]?.order.customer),
          authUserLinked: Boolean(customer?.auth_user_id),
          lifecycleStage: stringOrNull(customer?.lifecycle_stage ?? hydratedOrders[0]?.order.customer?.lifecycleStage),
        },
        firstTrace: firstTrace(customer, orders, checkout.value),
        checkout: checkout.value,
        payment: {
          status: stringOrNull(hydratedOrders[0]?.order.payment?.status ?? orders[0]?.status),
          intents: hydratedOrders.map((detail) => ({
            orderId: detail.order.orderId,
            intentId: detail.order.payment.intentId,
            paymentId: detail.order.payment.paymentId,
            status: detail.order.payment.status,
            activeAttemptId: detail.order.payment.activeAttemptId,
            updatedAt: detail.order.payment.updatedAt,
          })),
          attempts: hydratedOrders.flatMap((detail) => detail.order.paymentAttempts.map((attempt) => ({
            orderId: detail.order.orderId,
            id: attempt.id,
            status: attempt.status,
            provider: attempt.provider,
            nextActionKind: attempt.nextActionKind,
            updatedAt: attempt.updatedAt,
          }))),
          transitions: hydratedOrders.flatMap((detail) => detail.order.paymentTransitions.map((transition) => ({
            orderId: detail.order.orderId,
            id: transition.id,
            transitionKind: transition.transitionKind,
            fromStatus: transition.fromStatus,
            toStatus: transition.toStatus,
            reason: transition.reason,
            occurredAt: transition.occurredAt,
          }))),
          providerRefs: paymentRefs.value,
        },
        orders: mappedOrders,
        subscriptions: subscriptions.value,
        timeline,
        gaps,
        nextChecks: nextChecks({ gaps, hasOrders: mappedOrders.length > 0, hasCustomer: Boolean(clientId), subscriptions: subscriptions.value }),
      };
      return snapshot;
    },
  };
}
