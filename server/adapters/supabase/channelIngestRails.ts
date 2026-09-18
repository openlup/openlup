import type {
  ChannelIngestOrderItemReadPort,
  ChannelIngestPaymentControlPort,
  ChannelIngestReservationPort,
  ChannelIngestReservationItem,
} from "../../../src/domains/channels/channelIngestStorePort.js";
import type { ChannelBundleReadPort } from "../../../src/domains/channels/bundleLineExpansion.js";
import { createManagedPaymentControlRuntimePort } from "../managed/commerce/paymentControlRuntimePort.js";
import { createChannelBundleRead } from "./channelBundleRead.js";
import { createManagedBundleCatalogStore } from "./bundleCatalogStore.js";
import type { BundleCatalogQueryClient } from "./bundleCatalogStore.js";

// The three rails the ingest saga borrows and the ledger binding does not resolve, bound for the
// managed chain. B5 named this gap out loud and refused to close it inside an entrypoint wave; this
// is the closure, and it is deliberately THIN.
//
// WHAT "THIN" MEANS HERE. Not one policy decision is taken in this file. Every refusal, every
// idempotency rule, every money identity and every stock arithmetic already lives in SQL, where a
// second caller cannot bypass it. What lives here is the argument mapping the saga's four narrow
// interfaces need, plus three judgments that had to be made SOMEWHERE and are made once, here,
// with their reasoning attached:
//
//   1. THE RESERVATION KIND IS `channel_order_window`. The checkout reservation port derives its
//      kind from an order MODE (`one_time` -> `checkout_payment_window`), and there is no mode that
//      produces the kind the ingest migration authored. Reusing that port would file a channel
//      order's hold under the checkout lane, where anything sweeping abandoned checkouts would be
//      entitled to release stock this shop has already been paid for. So the reservation rail calls
//      the reservation boundary directly with the kind its own migration widened the CHECK for.
//   2. THE RESERVATION'S PAYMENT STATE IS `succeeded`. The boundary admits four states and asks
//      which one justifies holding the stock. For a channel order the answer is not "a local
//      payment has been started" — nothing local has been started at that point in the saga, since
//      stock is taken BEFORE the intent — it is "the buyer has already been charged, on the far
//      side". `succeeded` is the only one of the four that says that, and saying `created` instead
//      would put this hold in the same class as an abandoned checkout for every reader downstream.
//      The order is still `draft` and the local intent still does not exist; this argument names
//      the settlement that justifies the hold, not a local object.
//   3. THE ATTEMPT IS RECORDED AS `processing`, NEVER `sent_to_provider`. No provider was called —
//      the saga's own response payload says `providerCall: false` — and the boundary's three
//      admissible execution states do not include a terminal one anyway: `apply_result` is what
//      settles an attempt, in the same run.
//
// WHY THE PAYMENT RAIL IS HALF DELEGATION AND HALF DIRECT CALL. `createIntent` and `applyResult`
// are delegated to the existing managed payment-control port, unchanged. The other two cannot be:
// `recordAttempt` types its provider as the closed union of PAYMENT BRANDS this deployment can
// execute against, and the settlement event port types its provider the same way — while a channel
// order's provider is the channel's declared settlement kind, which is deliberately not a payment
// brand. The SQL columns are open text and the boundaries validate them as non-blank strings, so
// the constraint is the TypeScript union rather than the database. Widening that union to admit
// marketplace settlement kinds would make every payment execution site accept a value it cannot
// execute against; calling the same two boundaries directly does not.

/** The reservation lane the ingest migration authored, and the state that justifies the hold. */
const CHANNEL_RESERVATION_KIND = "channel_order_window";
const CHANNEL_RESERVATION_PAYMENT_STATE = "succeeded";
/** No provider was called; the collection already happened on the far side. */
const CHANNEL_ATTEMPT_STATUS = "processing";
/** The one settlement event the control plane's allowlist has for money that arrived. */
const CHANNEL_SETTLEMENT_EVENT_TYPE = "payment.succeeded";

export interface ManagedChannelRailsClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RailsError | null }>;
  from(table: string): ManagedChannelRailsQuery;
}

export interface ManagedChannelRailsQuery {
  select(columns: string): ManagedChannelRailsQuery;
  eq(column: string, value: unknown): ManagedChannelRailsQuery;
  order(column: string, options?: { ascending?: boolean }): ManagedChannelRailsQuery;
  then<TResult1 = ManagedChannelRailsResult, TResult2 = never>(
    onfulfilled?: ((value: ManagedChannelRailsResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2>;
}

export interface ManagedChannelRailsResult {
  data: unknown;
  error: RailsError | null;
}

interface RailsError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

/**
 * The stock refusal must survive the trip back to the saga UNCHANGED, because the saga recognises
 * it structurally rather than by class. A wrapper that dropped the raised name would turn a
 * blocked-stock halt into a thrown fault, and the order would be retried forever instead of waiting
 * for an operator to find stock.
 */
function railFailure(rpcName: string, error: RailsError): Error & { code?: string } {
  const detail = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  const failure = new Error(`${rpcName}_failed: ${detail || error.code || "unknown"}`) as Error & {
    code?: string;
  };
  failure.code = error.code;
  return failure;
}

function readObject(value: unknown, key: string, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`channel_rails_response_invalid: ${path}`);
  const nested = (value as Record<string, unknown>)[key];
  if (!nested || typeof nested !== "object") throw new Error(`channel_rails_response_invalid: ${path}`);
  return nested as Record<string, unknown>;
}

function readString(value: Record<string, unknown>, key: string, path: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`channel_rails_response_invalid: ${path}`);
  }
  return raw;
}

/**
 * The order items the saga reserves, read back from the order the RPC just wrote rather than
 * carried from the wire. That is the point of the read: after a bundle line is exploded, the wire
 * order and the order's items no longer have the same shape, and stock must be held against what
 * was actually written.
 */
export function createManagedChannelIngestOrderItemRead(
  client: ManagedChannelRailsClient,
): ChannelIngestOrderItemReadPort {
  return {
    async readOrderItems(orderId) {
      const { data, error } = await client
        .from("commerce_order_items")
        .select("id, sku_id, quantity")
        .eq("order_id", orderId)
        .order("allocation_ordinal", { ascending: true });
      if (error) throw railFailure("commerce_order_items_read", error);
      const rows = Array.isArray(data) ? data : [];
      return rows.map((row, index) => {
        if (!row || typeof row !== "object") {
          throw new Error(`channel_rails_response_invalid: orderItems[${index}]`);
        }
        const record = row as Record<string, unknown>;
        const skuId = record.sku_id;
        if (typeof skuId !== "string" || skuId.length === 0) {
          // An item without a SKU cannot be reserved, and silently skipping it would ship an order
          // whose stock was never held. The ingest RPC never writes one; a schema that starts to is
          // a defect this refusal surfaces immediately.
          throw new Error(`channel_rails_order_item_without_sku: ${orderId}`);
        }
        return {
          orderItemId: readString(record, "id", `orderItems[${index}].id`),
          skuId,
          quantity: Number(record.quantity),
        } satisfies ChannelIngestReservationItem;
      });
    },
  };
}

export function createManagedChannelIngestReservations(
  client: ManagedChannelRailsClient,
): ChannelIngestReservationPort {
  return {
    async reserveChannelOrderItems(input) {
      const { data, error } = await client.rpc("inventory_reserve_order_items", {
        p_idempotency_key: input.idempotencyKey,
        p_order_id: input.orderId,
        p_subscription_cycle_id: null,
        p_items: input.items.map((item) => ({
          orderItemId: item.orderItemId,
          skuId: item.skuId,
          quantity: item.quantity,
        })),
        p_kind: CHANNEL_RESERVATION_KIND,
        p_payment_status: CHANNEL_RESERVATION_PAYMENT_STATE,
        // NULL, and the boundary decides. The ingest migration's own prose records what it decides:
        // the lease is the CRASH window rather than a payment window, because there is no payment
        // window left to wait out.
        p_expires_at: null,
        p_metadata: input.metadata ?? {},
        // The surface's declared selection, verbatim. Was hardcoded NULL, which made every
        // marketplace reservation draw on local balances while the identical storefront sale drew
        // on the provider's stock oracle; the boundary stamps the stock authority from this value,
        // so passing it is all that was needed to put both on one authority.
        p_provider_kind: input.providerKind,
      });
      if (error) throw railFailure("inventory_reserve_order_items", error);
      const reservations = (data as Record<string, unknown> | null)?.reservations;
      return { reservedItemCount: Array.isArray(reservations) ? reservations.length : 0 };
    },
  };
}

export function createManagedChannelIngestPayments(
  client: ManagedChannelRailsClient,
): ChannelIngestPaymentControlPort {
  const control = createManagedPaymentControlRuntimePort(client);
  return {
    async createIntent(input) {
      const intent = await control.createIntent({
        idempotencyKey: input.idempotencyKey,
        targetKind: "one_time_order",
        orderId: input.orderId,
        subscriptionId: null,
        subscriptionCycleId: null,
        amountMinor: input.amountMinor,
        // The channel row is the currency authority; the saga read it there and passes it through.
        currency: input.currency as Parameters<typeof control.createIntent>[0]["currency"],
        metadata: input.metadata,
      });
      return { paymentIntentId: intent.paymentIntentId };
    },

    async recordAttempt(input) {
      const { data, error } = await client.rpc("commerce_payment_control_record_attempt", {
        p_idempotency_key: input.idempotencyKey,
        p_payment_intent_id: input.paymentIntentId,
        p_provider: input.provider,
        p_provider_attempt_id: input.providerAttemptId,
        p_provider_session_id: null,
        p_attempt_status: CHANNEL_ATTEMPT_STATUS,
        p_next_action_kind: null,
        p_request_payload: input.requestPayload,
        p_response_payload: input.responsePayload,
      });
      if (error) throw railFailure("commerce_payment_control_record_attempt", error);
      const attempt = readObject(data, "paymentAttempt", "recordAttempt");
      return { paymentAttemptId: readString(attempt, "id", "recordAttempt.id") };
    },

    async ingestSettlementEvent(input) {
      const { data, error } = await client.rpc("commerce_payment_control_ingest_event", {
        p_provider: input.provider,
        p_provider_event_id: input.providerEventId,
        p_event_type: CHANNEL_SETTLEMENT_EVENT_TYPE,
        p_provider_payment_id: input.providerPaymentId,
        p_payment_intent_id: input.paymentIntentId,
        p_payment_attempt_id: null,
        p_amount_cents: input.amountMinor,
        p_currency: input.currency,
        // TRUE, and it is not a shortcut. The trust boundary for a channel delivery was crossed at
        // the connector, which verified the far side's signature before anything was normalized;
        // the boundary refuses an unverified event outright, and an event this deployment
        // synthesised from an already-verified delivery is exactly what it is verifying.
        p_signature_verified: true,
        p_payload: input.payload,
      });
      if (error) throw railFailure("commerce_payment_control_ingest_event", error);
      const event = readObject(data, "paymentEvent", "ingestSettlementEvent");
      return { paymentEventId: readString(event, "id", "ingestSettlementEvent.id") };
    },

    async applySucceeded(input) {
      const result = await control.applyResult({
        idempotencyKey: input.idempotencyKey,
        orderId: input.orderId,
        paymentIntentId: input.paymentIntentId,
        paymentEventId: input.paymentEventId,
        resultStatus: "succeeded",
        occurredAt: input.occurredAt,
      });
      return { orderId: result.orderId };
    },
  };
}

export interface ManagedChannelIngestRails {
  reservations: ChannelIngestReservationPort;
  orderItems: ChannelIngestOrderItemReadPort;
  payments: ChannelIngestPaymentControlPort;
  bundles: ChannelBundleReadPort;
}

/** The three rails, bound together, for a deployment whose data capability is the managed chain. */
export function createManagedChannelIngestRails(
  client: ManagedChannelRailsClient,
): ManagedChannelIngestRails {
  return {
    reservations: createManagedChannelIngestReservations(client),
    orderItems: createManagedChannelIngestOrderItemRead(client),
    payments: createManagedChannelIngestPayments(client),
    // The SAME catalogue read the storefront's sellable feed uses, narrowed to the two facts the
    // expansion needs. A channel must not be able to sell a bundle the storefront would refuse to.
    bundles: createChannelBundleRead(
      createManagedBundleCatalogStore(client as unknown as BundleCatalogQueryClient),
    ),
  };
}
