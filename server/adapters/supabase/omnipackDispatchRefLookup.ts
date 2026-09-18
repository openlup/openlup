import { parcelSequenceNo } from "../../../src/lib/currentFulfillmentParcel.js";
import { providerOrderNumberFor } from "./omnipackDispatchMappers.js";

export interface OmnipackDispatchRefLookupClient {
  from(table: string): OmnipackDispatchRefLookupQuery;
}

interface OmnipackDispatchRefLookupQuery extends PromiseLike<{ data: unknown; error: RpcError | null }> {
  select(columns: string): OmnipackDispatchRefLookupQuery;
  eq(column: string, value: unknown): OmnipackDispatchRefLookupQuery;
  order(column: string, options?: Record<string, unknown>): OmnipackDispatchRefLookupQuery;
  limit(count: number): OmnipackDispatchRefLookupQuery;
  maybeSingle(): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

interface RpcError {
  code?: string;
}

export interface OmnipackDispatchRefMatch {
  dispatchRefId: string;
  fulfillmentOrderId: string;
  orderId: string;
  providerOrderId: string | null;
}

// The parcel and its order ride along on the ref's own read, through the two foreign keys this
// table already declares — no column, no second statement, no SQL of ours. One round trip and one
// snapshot: a follow-up read could observe a later one, and the number we expect has to be the
// number of the very ref we just matched. Both lookups select it, so a null expected number means
// exactly one thing everywhere - the parcel did not resolve - rather than "this caller did not ask".
const DISPATCH_REF_SELECT =
  "id, fulfillment_order_id, order_id, provider_order_id, commerce_fulfillment_orders(sequence_no), commerce_orders(order_number)";

export async function findOmnipackDispatchRef(
  client: OmnipackDispatchRefLookupClient,
  evidence: { orderNumber?: string | null; providerOrderId?: string | null },
  source: "reconciliation" | "webhook",
): Promise<OmnipackDispatchRefMatch | null> {
  const providerOrderId = evidence.providerOrderId?.trim();
  const orderNumber = evidence.orderNumber?.trim();
  const providerMatch = providerOrderId
    ? await findByProviderOrderId(client, providerOrderId, source)
    : null;

  if (providerMatch) {
    // The provider order id names one parcel, and the number that parcel ships under is a pure
    // *function* of it: the original keeps the order's number, and a later parcel carries the
    // suffix the dispatch mapper mints. So the evidence's number is compared against the number
    // this parcel would have been dispatched under, recomputed by that same function. Nothing is
    // parsed, no suffix is stripped, and the foreign key stays the only linkage truth.
    //
    // This is strictly stronger than the order-level comparison it replaces. Evidence whose two
    // identities name two different orders still fails closed, because a different order mints a
    // different number. Evidence for a replacement, carrying the number we ourselves minted for
    // it, now correlates instead of failing on our own arithmetic. And evidence carrying a number
    // this parcel could never have been given - the original's number for a replacement, or a
    // replacement's for the original - now fails closed where the old comparison waved it through.
    //
    // A parcel the ref cannot resolve leaves nothing to expect, and fails closed for that reason:
    // the expected value is null, which no incoming number equals.
    if (orderNumber && orderNumber !== providerMatch.expectedProviderOrderNumber) {
      throw new Error(`omnipack_${source}_dispatch_ref_correlation_conflict`);
    }
    return publicMatch(providerMatch);
  }

  // Read only once the provider order id has resolved to nothing - it is globally unique per
  // provider, so no ref carries it - which leaves the merchant number as the sole surviving
  // identity. Under a resolved provider id it can no longer change the answer, so it is not read.
  const merchantMatch = orderNumber ? await findByMerchantOrderNumber(client, orderNumber, source) : null;
  if (merchantMatch) {
    // Deliberately unchanged. Evidence naming a provider order we have never seen, against an
    // order whose ref already carries a different one, stays unattributable and still fails closed.
    //
    // ⛔ The expected number is deliberately *not* compared here. This lookup answers with the
    // order's newest ref, which may be a replacement parcel, while the evidence carries the order's
    // own number - the exact pair R1 stopped treating as a conflict. The comparison belongs to the
    // branch that matched a ref by the parcel's own identity, and nowhere else.
    if (
      providerOrderId
      && merchantMatch.providerOrderId
      && merchantMatch.providerOrderId !== providerOrderId
    ) {
      throw new Error(`omnipack_${source}_dispatch_ref_correlation_conflict`);
    }
    return publicMatch(merchantMatch);
  }
  return null;
}

async function findByProviderOrderId(
  client: OmnipackDispatchRefLookupClient,
  providerOrderId: string,
  source: "reconciliation" | "webhook",
): Promise<DispatchRefRow | null> {
  const result = await client
    .from("omnipack_dispatch_refs")
    .select(DISPATCH_REF_SELECT)
    .eq("provider_kind", "omnipack")
    .eq("provider_order_id", providerOrderId)
    .maybeSingle();
  if (result.error) throw new Error(`omnipack_${source}_dispatch_ref_read_failed:${result.error.code ?? "unknown"}`);
  return dispatchRef(result.data);
}

async function findByMerchantOrderNumber(
  client: OmnipackDispatchRefLookupClient,
  orderNumber: string,
  source: "reconciliation" | "webhook",
): Promise<DispatchRefRow | null> {
  const order = await client.from("commerce_orders").select("id").eq("order_number", orderNumber).maybeSingle();
  if (order.error) throw new Error(`omnipack_${source}_order_lookup_failed:${order.error.code ?? "unknown"}`);
  const orderId = text((order.data as { id?: unknown } | null)?.id);
  if (!orderId) return null;
  // Newest-first is still right: an order number identifies an order, and the ref that
  // currently represents it is the most recently dispatched parcel's — a replacement
  // parcel's ref is by construction created after the parcel it replaces. What was
  // missing is the tie-break, which is what makes the answer deterministic once an order
  // can legitimately hold more than one ref. `created_at DESC, id DESC` is the same
  // selection `omnipack_dispatch_begin` uses on this table; ordering on the fulfilment
  // row's own `sequence_no` is not reachable from here, because the data API cannot order a
  // parent by an embedded resource. With one ref per order the tie-break never fires.
  const result = await client
    .from("omnipack_dispatch_refs")
    .select(DISPATCH_REF_SELECT)
    .eq("provider_kind", "omnipack")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (result.error) throw new Error(`omnipack_${source}_dispatch_ref_read_failed:${result.error.code ?? "unknown"}`);
  return dispatchRef(result.data);
}

// `expectedProviderOrderNumber` is internal: it is evidence *about* the row, not part of the match
// a caller acts on, and `publicMatch` is what keeps the two apart.
type DispatchRefRow = OmnipackDispatchRefMatch & { expectedProviderOrderNumber: string | null };

function dispatchRef(data: unknown): DispatchRefRow | null {
  const row = (data ?? {}) as Record<string, unknown>;
  const dispatchRefId = text(row.id);
  const fulfillmentOrderId = text(row.fulfillment_order_id);
  const orderId = text(row.order_id);
  return dispatchRefId && fulfillmentOrderId && orderId
    ? {
      dispatchRefId,
      fulfillmentOrderId,
      orderId,
      providerOrderId: text(row.provider_order_id) || null,
      expectedProviderOrderNumber: expectedProviderOrderNumber(row),
    }
    : null;
}

// The number this parcel would have been dispatched under, from the parcel's own ordinal and its
// order's number, minted by the one function that mints it for the request itself.
//
// `parcelSequenceNo` answers 0 for a row read *without* the column, which is right for a caller
// that did not select it and wrong here, where we always do: a missing ordinal means the parcel did
// not resolve, and calling it an original would accept a replacement's evidence under the wrong
// number. So the column's presence is established first, and the shared reader still does the read.
function expectedProviderOrderNumber(row: Record<string, unknown>): string | null {
  const parcel = embedded(row.commerce_fulfillment_orders);
  const orderNumber = text(embedded(row.commerce_orders)?.order_number);
  if (!parcel || typeof parcel.sequence_no !== "number" || !orderNumber) return null;
  return providerOrderNumberFor(orderNumber, parcelSequenceNo(parcel));
}

// A to-one embed arrives as the object itself; the array form is tolerated because the same
// relationship is serialized either way depending on how the read was planned.
function embedded(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

function publicMatch(row: DispatchRefRow): OmnipackDispatchRefMatch {
  return {
    dispatchRefId: row.dispatchRefId,
    fulfillmentOrderId: row.fulfillmentOrderId,
    orderId: row.orderId,
    providerOrderId: row.providerOrderId,
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
