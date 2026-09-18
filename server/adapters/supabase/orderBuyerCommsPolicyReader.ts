import type {
  OrderBuyerCommsPolicy,
  OrderInvoicePolicy,
} from "../../../src/domains/channels/ports.js";
import type { OrderBuyerCommsPolicyReader } from "../../domains/commerce/outboxDispatchRegistry.js";
import type {
  InvoicePolicyLookup,
  OrderInvoicePolicyReader,
} from "../../domains/accounting/channelInvoicePolicyGate.js";

// Managed adapters for the two outbound-effect policy reads of wave B6. Both
// answer the same question from the same join — "which selling surface sold this
// order, and what did the operator say that surface owns" — so they live in one
// file and share one row shape rather than duplicating the embed twice.
//
// The read is LIVE on every event and deliberately uncached. An operator who
// flips `buyer_comms_owner` or `invoice_policy` is usually answering a live
// complaint, and a cached policy would keep the old behaviour for the rest of
// the process lifetime.
//
// `sales_channels(...)` is embedded through `commerce_orders.source_channel_id`,
// the only foreign key between the two tables, exactly as the OMS read does. A
// storefront order has no channel row, so the embed is null and both readers
// answer `null` — which the pure resolvers read as "unchanged".

export interface OrderPolicySupabaseClient {
  from(table: string): OrderPolicyQuery;
}

export interface OrderPolicyQuery {
  select(columns: string): OrderPolicyQuery;
  eq(column: string, value: unknown): OrderPolicyQuery;
  maybeSingle(): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

const ORDER_POLICY_COLUMNS =
  "source_kind, sales_channels(buyer_comms_owner, invoice_policy)";

const FULFILLMENT_ORDER_POLICY_COLUMNS =
  "commerce_orders(source_kind, sales_channels(buyer_comms_owner, invoice_policy))";

type ChannelPolicyRow = {
  source_kind?: unknown;
  sales_channels?: { buyer_comms_owner?: unknown; invoice_policy?: unknown } | null;
};

function readFailure(scope: string, error: { code?: string; message?: string }): Error {
  const failure = new Error(
    `order_channel_policy_read_failed: ${scope}: ${error.message ?? error.code ?? "unknown"}`,
  ) as Error & { code?: string };
  failure.code = error.code;
  return failure;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The embed arrives as an object for a to-one relation, but PostgREST has
 * historically produced a one-element array for the same shape, so both are
 * accepted rather than trusting one and crashing on the other.
 */
function channelOf(row: ChannelPolicyRow | null): {
  buyer_comms_owner?: unknown;
  invoice_policy?: unknown;
} | null {
  const embedded = row?.sales_channels as unknown;
  if (Array.isArray(embedded)) return (embedded[0] as Record<string, unknown> | undefined) ?? null;
  return (embedded as Record<string, unknown> | null) ?? null;
}

function commsPolicyOf(row: ChannelPolicyRow | null): OrderBuyerCommsPolicy | null {
  const channel = channelOf(row);
  const owner = text(channel?.buyer_comms_owner);
  if (owner === null) return null;
  return { sourceKind: text(row?.source_kind) ?? "storefront", buyerCommsOwner: owner };
}

function invoicePolicyOf(row: ChannelPolicyRow | null): OrderInvoicePolicy | null {
  const channel = channelOf(row);
  const policy = text(channel?.invoice_policy);
  if (policy === null) return null;
  return { sourceKind: text(row?.source_kind) ?? "storefront", invoicePolicy: policy };
}

async function readOrderRow(
  client: OrderPolicySupabaseClient,
  orderUuid: string,
): Promise<ChannelPolicyRow | null> {
  const result = await client
    .from("commerce_orders")
    .select(ORDER_POLICY_COLUMNS)
    .eq("id", orderUuid)
    .maybeSingle();
  if (result.error) throw readFailure("commerce_orders", result.error);
  return (result.data as ChannelPolicyRow | null) ?? null;
}

async function readFulfillmentOrderRow(
  client: OrderPolicySupabaseClient,
  fulfillmentOrderId: string,
): Promise<ChannelPolicyRow | null> {
  const result = await client
    .from("commerce_fulfillment_orders")
    .select(FULFILLMENT_ORDER_POLICY_COLUMNS)
    .eq("id", fulfillmentOrderId)
    .maybeSingle();
  if (result.error) throw readFailure("commerce_fulfillment_orders", result.error);
  const data = result.data as { commerce_orders?: unknown } | null;
  const embedded = data?.commerce_orders as unknown;
  if (Array.isArray(embedded)) return (embedded[0] as ChannelPolicyRow | undefined) ?? null;
  return (embedded as ChannelPolicyRow | null) ?? null;
}

export function createSupabaseOrderBuyerCommsPolicyReader(
  client: OrderPolicySupabaseClient,
): OrderBuyerCommsPolicyReader {
  return {
    async readOrderBuyerCommsPolicy(orderUuid: string): Promise<OrderBuyerCommsPolicy | null> {
      return commsPolicyOf(await readOrderRow(client, orderUuid));
    },
  };
}

export function createSupabaseOrderInvoicePolicyReader(
  client: OrderPolicySupabaseClient,
): OrderInvoicePolicyReader {
  return {
    async readOrderInvoicePolicy(lookup: InvoicePolicyLookup): Promise<OrderInvoicePolicy | null> {
      const row = lookup.by === "order"
        ? await readOrderRow(client, lookup.orderUuid)
        : await readFulfillmentOrderRow(client, lookup.fulfillmentOrderId);
      return invoicePolicyOf(row);
    },
  };
}
