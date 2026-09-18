import { currentParcelFirst, type FulfillmentParcelRow } from "../../../../../src/lib/currentFulfillmentParcel.js";
import type { CommerceOmsClient, RpcError } from "./types.js";

const SHIPMENT_EXTERNAL_REF_BASE_COLUMNS = "order_id, provider_tracking_id, active";
// `fulfillment_order_id` rides the rich list: it is what narrows an order's references to the
// parcel currently representing it, and a deployment that predates the column falls back to the
// base list, where every reference answers for every parcel exactly as it did before.
const SHIPMENT_EXTERNAL_REF_COLUMNS = `${SHIPMENT_EXTERNAL_REF_BASE_COLUMNS}, fulfillment_order_id, provider_kind, tracking_url, carrier_kind, service, created_at, updated_at`;
// Kept out of the shared provider-evidence matcher on purpose: that one also guards the
// fulfillment-order reads, and `fulfillment_order_id` is a column half the schema carries, so
// folding it in there would silently downgrade an unrelated read on any error naming it.
function isMissingParcelAttributionError(error: RpcError | null): boolean {
  if (!error) return false;
  return `${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`.toLowerCase().includes("fulfillment_order_id");
}

function shipmentRefReadDegrades(error: RpcError | null): boolean {
  return isOptionalProviderEvidenceColumnError(error) || isMissingParcelAttributionError(error);
}

export async function readShipmentRefsByOrderIds(client: CommerceOmsClient, orderIds: string[]) {
  if (!orderIds.length) return { data: [], error: null };
  const result = await client.from("shipment_external_refs").select(SHIPMENT_EXTERNAL_REF_COLUMNS).in("order_id", orderIds).eq("active", true);
  if (!shipmentRefReadDegrades(result.error)) return result;
  return client.from("shipment_external_refs").select(SHIPMENT_EXTERNAL_REF_BASE_COLUMNS).in("order_id", orderIds).eq("active", true);
}

export async function readShipmentRefsByOrderId(client: CommerceOmsClient, orderId: string) {
  const result = await client.from("shipment_external_refs").select(SHIPMENT_EXTERNAL_REF_COLUMNS).eq("order_id", orderId).eq("active", true);
  if (!shipmentRefReadDegrades(result.error)) return result;
  return client.from("shipment_external_refs").select(SHIPMENT_EXTERNAL_REF_BASE_COLUMNS).eq("order_id", orderId).eq("active", true);
}

// `sequence_no` rides the BASE list, not the rich one: it is what resolves which parcel
// currently represents an order, so the degraded read that drops provider evidence must still
// be able to answer that question deterministically.
const FULFILLMENT_ORDER_BASE_COLUMNS = "id, order_id, sequence_no, status, shipping_address_snapshot, handed_over_at, delivered_at, created_at, updated_at";
// `handed_over_at` rides the query that already reads the row, and is the only durable witness of
// which side of handover a provider exception happened on - the FSM's `exception` no longer says.
// `replaces_fulfillment_order_id` and `replacement_reason` ride the rich list with
// `provider_kind`: they are what tells an operator that the parcel on their screen IS a
// replacement and why, and a deployment that predates them degrades to the base list, where
// every parcel reads as the original exactly as it did before the columns existed.
const FULFILLMENT_ORDER_COLUMNS = `${FULFILLMENT_ORDER_BASE_COLUMNS}, provider_kind, replaces_fulfillment_order_id, replacement_reason`;

// A deployment that predates the optional provider-evidence columns answers the rich select with
// a missing-column error; every read here retries on the base list rather than failing.
export function isOptionalProviderEvidenceColumnError(error: { code?: string; message?: string; details?: string; hint?: string } | null): boolean {
  if (!error) return false;
  const text = `${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`.toLowerCase();
  return ["fulfillment_provider_stock_current", "provider_kind", "tracking_url", "carrier_kind", "service", "replaces_fulfillment_order_id", "replacement_reason"].some((column) => text.includes(column)); // Only columns the BASE list OMITS belong here: created_at/updated_at are in it, so they could never be recovered - they only widened the silent downgrade.
}

// Deliberately no `.maybeSingle()`: PostgREST *errors* (PGRST116) when a single-object read
// matches two rows, and an order carrying a replacement parcel holds two.
//
// ⚠️ This returns EVERY parcel of the order, current one first, where it used to return the
// current one alone. That is what stopped the original parcel's tracking from vanishing from
// the operator's screen the moment a replacement existed. Callers that need exactly one row
// take `[0]`, which `currentParcelFirst` guarantees is the current parcel; nothing downstream
// widens its attribution, because the provider-evidence reads are still keyed on that one id.
export async function readFulfillmentParcelsByOrderId(client: CommerceOmsClient, orderId: string): Promise<{ data: unknown[]; error: RpcError | null }> {
  const rich = await client.from("commerce_fulfillment_orders").select(FULFILLMENT_ORDER_COLUMNS).eq("order_id", orderId);
  const result = isOptionalProviderEvidenceColumnError(rich.error)
    ? await client.from("commerce_fulfillment_orders").select(FULFILLMENT_ORDER_BASE_COLUMNS).eq("order_id", orderId)
    : rich;
  if (result.error) return { data: [], error: result.error };
  return { data: currentParcelFirst((result.data ?? []) as FulfillmentParcelRow[]), error: null };
}

// The list read hands every order's rows to one builder, which narrows per order and then takes
// the first of what is left (`omsReadModelList.ts` filter -> `omsFulfillmentSummary.ts` [0]), so
// each order's rows must arrive with its current parcel first.
export async function readFulfillmentOrdersByOrderIds(client: CommerceOmsClient, orderIds: string[]): Promise<{ data: unknown[]; error: RpcError | null }> {
  if (!orderIds.length) return { data: [], error: null };
  const rich = await client.from("commerce_fulfillment_orders").select(FULFILLMENT_ORDER_COLUMNS).in("order_id", orderIds);
  const result = isOptionalProviderEvidenceColumnError(rich.error)
    ? await client.from("commerce_fulfillment_orders").select(FULFILLMENT_ORDER_BASE_COLUMNS).in("order_id", orderIds)
    : rich;
  if (result.error) return { data: [], error: result.error };
  return { data: currentParcelFirst((result.data ?? []) as FulfillmentParcelRow[]), error: null };
}
