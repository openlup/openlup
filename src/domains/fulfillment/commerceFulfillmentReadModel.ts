import {
  evaluateCommerceFulfillmentEligibility,
  mapOmsPaymentStatus,
  type OrderStatus,
} from "../commerce/types.js";
import type { SubscriptionCycleStatus } from "../subscription/types.js";
import {
  COMMERCE_FULFILLMENT_CONTRACT_VERSION,
  adminCommerceFulfillmentOrderDetailResponseSchema,
  adminCommerceFulfillmentOrdersListResponseSchema,
  type AdminCommerceFulfillmentOrderDetailResponse,
  type AdminCommerceFulfillmentOrdersListResponse,
  type CommerceFulfillmentOrder,
  type CommerceFulfillmentOperationType,
  type CommerceFulfillmentStatus,
} from "./commerceFulfillmentContracts.js";

export interface CommerceFulfillmentOrderRow {
  id: string;
  order_id: string;
  client_id: string | null;
  status: CommerceFulfillmentStatus;
  provider_kind: string | null;
  shipping_address_snapshot: CommerceFulfillmentOrder["shippingAddress"];
  created_at: string;
  updated_at: string;
}

export interface CommerceFulfillmentLineRow {
  id: string;
  fulfillment_order_id: string;
  order_item_id: string;
  sku_id: string;
  sku: string;
  title: string | null;
  quantity: number;
  inventory_reservation_ids: string[];
  product_snapshot: Record<string, unknown>;
}

export interface CommerceFulfillmentOperationRow {
  id: string;
  fulfillment_order_id: string;
  operation_type: CommerceFulfillmentOperationType;
  actor_user_id: string | null;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface CommerceFulfillmentOrderContextRow {
  id: string;
  status: OrderStatus;
  mode: "one_time" | "subscription_cycle";
  shipping_address_id: string | null;
  subscription_cycle_id: string | null;
}

export interface CommerceFulfillmentPaymentIntentRow {
  id: string;
  order_id: string;
  status: string;
  provider_payment_id: string | null;
}

export interface CommerceFulfillmentInventoryReservationRow {
  id: string;
  order_id: string;
  status: "reserved" | "released" | "consumed" | "expired";
  expires_at: string | null;
  location_id: string | null;
  inventory_locations?: { code?: string | null } | null;
}

export interface CommerceFulfillmentShipmentRefRow {
  order_id: string;
  provider_tracking_id: string;
  active: boolean;
  created_at?: string | null;
}

export function buildCommerceFulfillmentOrdersListResponse(input: {
  fulfillmentOrders: CommerceFulfillmentOrderRow[];
  lines: CommerceFulfillmentLineRow[];
  latestOperations: CommerceFulfillmentOperationRow[];
  orderContexts: CommerceFulfillmentOrderContextRow[];
  paymentIntents: CommerceFulfillmentPaymentIntentRow[];
  inventoryReservations: CommerceFulfillmentInventoryReservationRow[];
  shipmentRefs: CommerceFulfillmentShipmentRefRow[];
  activeHoldCounts: Record<string, number>;
  subscriptionCycleStatuses: Record<string, SubscriptionCycleStatus | null>;
  totalCount: number;
  page: number;
  pageSize: number;
}): AdminCommerceFulfillmentOrdersListResponse {
  return adminCommerceFulfillmentOrdersListResponseSchema.parse({
    contractVersion: COMMERCE_FULFILLMENT_CONTRACT_VERSION,
    orders: input.fulfillmentOrders.map((fulfillmentOrder) =>
      buildCommerceFulfillmentOrder({
        fulfillmentOrder,
        lines: input.lines.filter((line) => line.fulfillment_order_id === fulfillmentOrder.id),
        latestOperation:
          input.latestOperations.find((operation) => operation.fulfillment_order_id === fulfillmentOrder.id) ??
          null,
        orderContext: findRequired(input.orderContexts, fulfillmentOrder.order_id, "order context"),
        paymentIntent: findRequired(input.paymentIntents, fulfillmentOrder.order_id, "payment intent"),
        inventoryReservations: input.inventoryReservations.filter(
          (reservation) => reservation.order_id === fulfillmentOrder.order_id,
        ),
        shipmentRef: input.shipmentRefs.find((ref) => ref.order_id === fulfillmentOrder.order_id && ref.active) ?? null,
        activeHoldCount: input.activeHoldCounts[fulfillmentOrder.order_id] ?? 0,
        subscriptionCycleStatuses: input.subscriptionCycleStatuses,
      }),
    ),
    totalCount: input.totalCount,
    page: input.page,
    pageSize: input.pageSize,
  });
}

export function buildCommerceFulfillmentOrderDetailResponse(input: {
  fulfillmentOrder: CommerceFulfillmentOrderRow;
  lines: CommerceFulfillmentLineRow[];
  latestOperation: CommerceFulfillmentOperationRow | null;
  orderContext: CommerceFulfillmentOrderContextRow;
  paymentIntent: CommerceFulfillmentPaymentIntentRow;
  inventoryReservations: CommerceFulfillmentInventoryReservationRow[];
  shipmentRef: CommerceFulfillmentShipmentRefRow | null;
  activeHoldCount: number;
  subscriptionCycleStatus: SubscriptionCycleStatus | null;
}): AdminCommerceFulfillmentOrderDetailResponse {
  return adminCommerceFulfillmentOrderDetailResponseSchema.parse({
    contractVersion: COMMERCE_FULFILLMENT_CONTRACT_VERSION,
    order: buildCommerceFulfillmentOrder({
      fulfillmentOrder: input.fulfillmentOrder,
      lines: input.lines,
      latestOperation: input.latestOperation,
      orderContext: input.orderContext,
      paymentIntent: input.paymentIntent,
      inventoryReservations: input.inventoryReservations,
      shipmentRef: input.shipmentRef,
      activeHoldCount: input.activeHoldCount,
      subscriptionCycleStatuses: {
        [input.orderContext.subscription_cycle_id ?? ""]: input.subscriptionCycleStatus,
      },
    }),
  });
}

function buildCommerceFulfillmentOrder(input: {
  fulfillmentOrder: CommerceFulfillmentOrderRow;
  lines: CommerceFulfillmentLineRow[];
  latestOperation: CommerceFulfillmentOperationRow | null;
  orderContext: CommerceFulfillmentOrderContextRow;
  paymentIntent: CommerceFulfillmentPaymentIntentRow;
  inventoryReservations: CommerceFulfillmentInventoryReservationRow[];
  shipmentRef: CommerceFulfillmentShipmentRefRow | null;
  activeHoldCount: number;
  subscriptionCycleStatuses: Record<string, SubscriptionCycleStatus | null>;
}): CommerceFulfillmentOrder {
  const paymentStatus = mapOmsPaymentStatus(input.paymentIntent.status);
  const inventory = inventorySummary(input.inventoryReservations);
  return {
    id: input.fulfillmentOrder.id,
    orderId: input.fulfillmentOrder.order_id,
    clientId: input.fulfillmentOrder.client_id,
    status: input.fulfillmentOrder.status,
    providerKind: input.fulfillmentOrder.provider_kind,
    providerTrackingId: input.shipmentRef?.provider_tracking_id ?? null,
    shippingAddress: normalizeShippingAddressSnapshot(input.fulfillmentOrder.shipping_address_snapshot),
    lines: input.lines.map((line) => ({
      id: line.id,
      orderItemId: line.order_item_id,
      skuId: line.sku_id,
      sku: line.sku,
      title: line.title,
      quantity: line.quantity,
      inventoryReservationIds: line.inventory_reservation_ids,
      productSnapshot: line.product_snapshot,
    })),
    payment: {
      paymentIntentId: input.paymentIntent.id,
      paymentStatus,
      providerPaymentId: input.paymentIntent.provider_payment_id,
    },
    inventory,
    omsEligibility: evaluateCommerceFulfillmentEligibility({
      orderMode: input.orderContext.mode,
      orderStatus: input.orderContext.status,
      paymentStatus,
      subscriptionCycleStatus: input.orderContext.subscription_cycle_id
        ? input.subscriptionCycleStatuses[input.orderContext.subscription_cycle_id] ?? null
        : null,
      activeHoldCount: input.activeHoldCount,
      hasShippingAddress: Boolean(input.orderContext.shipping_address_id),
      inventoryStatus: inventory.status,
    }),
    latestOperation: input.latestOperation
      ? {
          id: input.latestOperation.id,
          type: input.latestOperation.operation_type,
          occurredAt: input.latestOperation.occurred_at,
          actorUserId: input.latestOperation.actor_user_id,
          payload: input.latestOperation.payload,
        }
      : null,
    createdAt: input.fulfillmentOrder.created_at,
    updatedAt: input.fulfillmentOrder.updated_at,
  };
}

function normalizeShippingAddressSnapshot(
  snapshot: CommerceFulfillmentOrderRow["shipping_address_snapshot"],
): CommerceFulfillmentOrder["shippingAddress"] {
  return {
    addressId: snapshot.addressId,
    clientId: snapshot.clientId,
    label: snapshot.label,
    line1: snapshot.line1,
    line2: snapshot.line2,
    city: snapshot.city,
    postalCode: snapshot.postalCode,
    country: snapshot.country,
  };
}

function inventorySummary(
  reservations: CommerceFulfillmentInventoryReservationRow[],
): CommerceFulfillmentOrder["inventory"] {
  const reservation = reservations[0] ?? null;
  if (!reservation) {
    return {
      status: "missing",
      reservationId: null,
      reservationStatus: null,
      expiresAt: null,
      locationId: null,
      locationCode: null,
    };
  }
  return {
    status: reservation.status === "reserved" ? "reserved" : reservation.status,
    reservationId: reservation.id,
    reservationStatus: reservation.status,
    expiresAt: reservation.expires_at,
    locationId: reservation.location_id,
    locationCode: reservation.inventory_locations?.code ?? null,
  };
}

function findRequired<T extends { order_id?: string; id?: string }>(
  rows: T[],
  orderId: string,
  label: string,
): T {
  const row = rows.find((candidate) => candidate.order_id === orderId || candidate.id === orderId);
  if (!row) throw new Error(`Missing commerce fulfillment ${label} for order ${orderId}`);
  return row;
}
