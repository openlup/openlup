import type { CustomerJourneyGap, CustomerJourneyLookupRequest, CustomerJourneySnapshotResponse } from "../../../../src/domains/support/customerJourneyContracts.js";
import type { CommerceOmsSupabaseClient } from "../commerce/oms/types.js";
import {
  CLIENT_COLUMNS,
  ORDER_COLUMNS,
  compact,
  gap,
  isUuid,
  maybeSingle,
  stringOrNull,
  rows,
  type Row,
} from "../../../domains/support/customerJourneyCommon.js";

export interface ResolvedLookup {
  matchedBy: CustomerJourneySnapshotResponse["lookup"]["matchedBy"];
  confidence: CustomerJourneySnapshotResponse["lookup"]["confidence"];
  warnings: string[];
  gaps: CustomerJourneyGap[];
  orderIds: string[];
  client: Row | null;
  clientId: string | null;
  subscriptionId: string | null;
  trackingNumber: string | null;
}

export async function resolveLookup(client: CommerceOmsSupabaseClient, request: CustomerJourneyLookupRequest): Promise<ResolvedLookup> {
  const base = (matchedBy: ResolvedLookup["matchedBy"], confidence: ResolvedLookup["confidence"]): ResolvedLookup => ({
    matchedBy,
    confidence,
    warnings: [],
    gaps: [],
    orderIds: [],
    client: null,
    clientId: null,
    subscriptionId: null,
    trackingNumber: null,
  });

  if (request.orderId) return { ...base("orderId", "exact"), orderIds: [request.orderId] };
  if (request.orderNumber) {
    const order = await maybeSingle<Row>(client.from("commerce_orders").select(ORDER_COLUMNS).eq("order_number", request.orderNumber));
    return order ? { ...base("orderNumber", "exact"), orderIds: [String(order.id)], clientId: stringOrNull(order.client_id), subscriptionId: stringOrNull(order.subscription_id) } : notFound("orderNumber");
  }
  if (request.trackingNumber) {
    const ref = await maybeSingle<Row>(
      client.from("shipment_external_refs").select("order_id, provider_tracking_id").eq("provider_tracking_id", request.trackingNumber).eq("active", true),
    );
    return ref ? { ...base("trackingNumber", "derived"), orderIds: [String(ref.order_id)], trackingNumber: request.trackingNumber } : notFound("trackingNumber");
  }
  if (request.subscriptionId) return { ...base("subscriptionId", "exact"), subscriptionId: request.subscriptionId };
  if (request.clientId) {
    const customer = await readClientById(client, request.clientId);
    return { ...base("clientId", customer ? "exact" : "none"), client: customer, clientId: request.clientId };
  }
  if (request.email) {
    const customer = await maybeSingle<Row>(client.from("clients").select(CLIENT_COLUMNS).eq("email", request.email.toLowerCase()));
    return { ...base("email", customer ? "exact" : "none"), client: customer, clientId: stringOrNull(customer?.id) };
  }

  const normalized = (request.query ?? "").trim();
  if (isUuid(normalized)) {
    const order = await readOrderById(client, normalized);
    if (order) return { ...base("orderId", "exact"), orderIds: [String(order.id)], clientId: stringOrNull(order.client_id), subscriptionId: stringOrNull(order.subscription_id) };
    const customer = await readClientById(client, normalized);
    if (customer) return { ...base("clientId", "exact"), client: customer, clientId: String(customer.id) };
    return { ...base("subscriptionId", "loose"), subscriptionId: normalized, warnings: ["UUID did not match order/client; treating it as possible subscriptionId"] };
  }
  if (normalized.includes("@")) {
    const customer = await maybeSingle<Row>(client.from("clients").select(CLIENT_COLUMNS).eq("email", normalized.toLowerCase()));
    if (customer) return { ...base("email", "exact"), client: customer, clientId: String(customer.id) };
  }
  const order = await maybeSingle<Row>(client.from("commerce_orders").select(ORDER_COLUMNS).eq("order_number", normalized));
  if (order) return { ...base("orderNumber", "exact"), orderIds: [String(order.id)], clientId: stringOrNull(order.client_id), subscriptionId: stringOrNull(order.subscription_id) };
  const ref = await maybeSingle<Row>(client.from("shipment_external_refs").select("order_id, provider_tracking_id").eq("provider_tracking_id", normalized).eq("active", true));
  if (ref) return { ...base("trackingNumber", "derived"), orderIds: [String(ref.order_id)], trackingNumber: normalized };

  return {
    ...base("query", "loose"),
    warnings: ["Loose query did not resolve to an exact key; search results may be incomplete"],
  };
}

export async function readCandidateOrders(client: CommerceOmsSupabaseClient, resolved: ResolvedLookup, pageSize: number): Promise<Row[]> {
  if (resolved.orderIds.length) return readOrdersByIds(client, resolved.orderIds);
  if (resolved.subscriptionId) return rows<Row>(client.from("commerce_orders").select(ORDER_COLUMNS).eq("subscription_id", resolved.subscriptionId).order("created_at", { ascending: false }).range(0, pageSize - 1));
  const clientId = resolved.clientId ?? stringOrNull(resolved.client?.id);
  if (clientId) return rows<Row>(client.from("commerce_orders").select(ORDER_COLUMNS).eq("client_id", clientId).order("created_at", { ascending: false }).range(0, pageSize - 1));
  return [];
}

export async function readOrdersByIds(client: CommerceOmsSupabaseClient, orderIds: string[]): Promise<Row[]> {
  if (!orderIds.length) return [];
  return rows<Row>(client.from("commerce_orders").select(ORDER_COLUMNS).in("id", orderIds));
}

export async function readOrderById(client: CommerceOmsSupabaseClient, orderId: string): Promise<Row | null> {
  return maybeSingle<Row>(client.from("commerce_orders").select(ORDER_COLUMNS).eq("id", orderId));
}

export async function readClientById(client: CommerceOmsSupabaseClient, clientId: string): Promise<Row | null> {
  return maybeSingle<Row>(client.from("clients").select(CLIENT_COLUMNS).eq("id", clientId));
}

export async function firstClientForOrders(client: CommerceOmsSupabaseClient, orders: Row[]): Promise<Row | null> {
  const clientId = stringOrNull(orders.find((order) => order.client_id)?.client_id);
  return clientId ? readClientById(client, clientId) : null;
}

export async function readTrackingForOrder(client: CommerceOmsSupabaseClient, orderId: string): Promise<Row | null> {
  return maybeSingle<Row>(
    client.from("shipment_external_refs").select("order_id, provider_kind, provider_tracking_id, active, updated_at").eq("order_id", orderId).eq("active", true).order("updated_at", { ascending: false }),
  );
}

function notFound(matchedBy: ResolvedLookup["matchedBy"]): ResolvedLookup {
  return {
    matchedBy,
    confidence: "none",
    warnings: [`No ${matchedBy} match found`],
    gaps: [gap("lookup_not_found", "warning", `No row matched ${matchedBy}`, "Try support__customer_journey_search with email/order number/tracking number")],
    orderIds: [],
    client: null,
    clientId: null,
    subscriptionId: null,
    trackingNumber: null,
  };
}

export function subscriptionIdsFrom(resolved: ResolvedLookup, orders: Row[]): string[] {
  return compact([resolved.subscriptionId, ...orders.map((order) => stringOrNull(order.subscription_id))]);
}
