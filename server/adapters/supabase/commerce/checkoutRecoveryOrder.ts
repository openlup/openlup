import { formatCustomerOrderReference } from "../../../../src/lib/orderRef.js";
import {
  createQuoteResponseSchema,
  type CreateQuoteResponse,
} from "../../../../src/domains/commerce/contracts.js";
import {
  deriveOrderMoney,
  ORDER_HEADER_MONEY_COLUMNS,
  ORDER_ITEM_MONEY_COLUMNS,
  type OrderMoneyHeaderRow,
  type OrderMoneyItemRow,
} from "../../../../src/domains/commerce/orderMoney.js";
import {
  readLatestCheckoutRecoveryPayment,
} from "./checkoutRecoveryPaymentRead.js";
import type {
  CheckoutRecoveryOrderReadPort,
  CheckoutRecoveryOrderSnapshot,
} from "../../../domains/commerce/checkoutRecoveryOrderPort.js";
import type { CheckoutRecoveryMode } from "../../../../src/domains/commerce/checkoutRecoveryContracts.js";

/**
 * Reads the durable order facts the recovery pay-page needs (W4): the order
 * summary for the redeem response and the open payment intent + amount the pay
 * orchestration records a FRESH attempt against. Joins are done in code (no DB
 * view) mirroring the paymentStatus / resumableOrder adapters so the
 * route can pass a slim service-role client without importing the full
 * @supabase/supabase-js type into the domain layer.
 */

interface RpcError {
  message?: string;
}

interface OrderQueryResult<T> {
  data: T[] | null;
  error: RpcError | null;
}

interface OrderQuery<T> extends PromiseLike<OrderQueryResult<T>> {
  select(columns: string): OrderQuery<T>;
  eq(column: string, value: unknown): OrderQuery<T>;
  order(column: string, options: { ascending: boolean }): OrderQuery<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: RpcError | null }>;
  limit(count: number): PromiseLike<{ data: T[] | null; error: RpcError | null }>;
}

export interface CheckoutRecoveryOrderSupabaseClient {
  from<T = Record<string, unknown>>(table: string): OrderQuery<T>;
}

type Row = Record<string, unknown>;

const ORDER_SELECT =
  `id, order_number, client_id, shipping_address_id, pet_id, subscription_cycle_id, recovery_root_order_id, recreated_from_order_id, status, ${ORDER_HEADER_MONEY_COLUMNS}, created_at, metadata, mode, subscription_id`;
const ORDER_ITEM_SELECT = `id, quantity, ${ORDER_ITEM_MONEY_COLUMNS}`;

export function createSupabaseCheckoutRecoveryOrderPort(
  client: CheckoutRecoveryOrderSupabaseClient,
): CheckoutRecoveryOrderReadPort {
  async function read(orderId: string): Promise<CheckoutRecoveryOrderSnapshot | null> {
    const { data: order, error } = await client
      .from<Row>("commerce_orders")
      .select(ORDER_SELECT)
      .eq("id", orderId)
      .maybeSingle();
    if (error) throw new Error(`commerce_orders: ${error.message ?? "query failed"}`);
    if (!order) return null;
    return snapshotFromOrder(client, order);
  }

  return {
    async getRecoveryOrder({ orderId }): Promise<CheckoutRecoveryOrderSnapshot | null> {
      return read(orderId);
    },
    async getLatestRecoveryOrder({ orderId }): Promise<CheckoutRecoveryOrderSnapshot | null> {
      const original = await read(orderId);
      if (!original) return null;
      const rootOrderId = original.recoveryRootOrderId ?? original.orderId;
      const { data, error } = await client
        .from<Row>("commerce_orders")
        .select(ORDER_SELECT)
        .eq("recovery_root_order_id", rootOrderId)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(`commerce_orders: ${error.message ?? "query failed"}`);
      return data?.[0] ? snapshotFromOrder(client, data[0]) : original;
    },
  };
}

async function snapshotFromOrder(
  client: CheckoutRecoveryOrderSupabaseClient,
  order: Row,
): Promise<CheckoutRecoveryOrderSnapshot> {
      const id = text(order.id);
      const itemRows = await readOrderMoneyItems(client, id);
      const orderMoney = deriveOrderMoney(
        toOrderMoneyHeader(order),
        itemRows as unknown as OrderMoneyItemRow[],
      );
      if (!orderMoney.reconciled) {
        throw new Error(
          `checkout_recovery_order_money_unreconciled:${orderMoney.issueCodes.join(",")}`,
        );
      }

      const metadata = record(order.metadata);
      const quoteContext = readQuoteContextFromMetadata(metadata);
      const buyer = readBuyerSnapshot(metadata);
      const subscriptionId = nullableText(order.subscription_id);
      const isSubscription =
        Boolean(subscriptionId) ||
        text(order.mode) === "subscription_cycle" ||
        nullableText(quoteContext.mode) === "subscription";
      const mode: CheckoutRecoveryMode = isSubscription
        ? "subscription_cycle"
        : "one_time_order";

      const intent = await readLatestCheckoutRecoveryPayment(client, id);
      const quoteSnapshot = createQuoteResponseSchema.safeParse(metadata.quoteSnapshot);
      const runtimeMetadata = record(metadata.runtimeFinalize);
      const nestedInvoiceBuyerSnapshot = record(runtimeMetadata.invoiceBuyerSnapshot);
      const invoiceBuyerSnapshot = Object.keys(nestedInvoiceBuyerSnapshot).length > 0
        ? nestedInvoiceBuyerSnapshot
        : record(metadata.invoiceBuyerSnapshot);
      const status = text(order.status);

      return {
        orderId: id,
        orderRef: `order_${id}`,
        orderNumber: nullableText(order.order_number) ?? formatCustomerOrderReference(id),
        clientId: text(readOrderClientId(order)),
        status,
        mode,
        totalMinor: orderMoney.total,
        currency: orderMoney.currency,
        petName: nullableText(metadata.petName),
        cadenceDays:
          positiveInt(metadata.cadenceDays) ?? positiveInt(quoteContext.cadenceDays),
        createdAt: text(order.created_at),
        customerEmail: nullableText(buyer.email),
        customerName: nullableText(buyer.name),
        paymentIntentId: intent?.open ? intent.id : null,
        paymentIntentStatus: intent?.open ? intent.status : null,
        subscriptionId,
        subscriptionCycleId: nullableText(order.subscription_cycle_id) ?? intent?.subscriptionCycleId ?? null,
        shippingAddressId: nullableText(order.shipping_address_id),
        petId: nullableText(order.pet_id),
        quoteSnapshot: quoteSnapshot.success ? quoteSnapshot.data : null,
        runtimeMetadata,
        invoiceBuyerSnapshot,
        recoveryRootOrderId: nullableText(order.recovery_root_order_id) ?? id,
        recreatedFromOrderId: nullableText(order.recreated_from_order_id),
        technicallyExpired: isTechnicalExpiry(status, metadata),
        priorPaymentEvidence: intent?.priorPaymentEvidence ?? null,
      };
}

function isTechnicalExpiry(status: string, metadata: Row): boolean {
  const source = nullableText(metadata.source) ?? nullableText(record(metadata.runtimeFinalize).source);
  if (status === "expired") {
    return nullableText(metadata.paymentStatus) === "expired" &&
      (source === "commerce.reservation_sweep.v0" || source === "payment.control.v0");
  }
  if (status === "pending_payment") {
    return nullableText(metadata.paymentStatus) === "expired";
  }
  if (status !== "cancelled") return false;
  return (metadata.subscriptionActivation === "abandoned" || source === "subscription.sweep.v0") &&
    nullableText(metadata.paymentStatus) === "cancelled";
}

function toOrderMoneyHeader(order: Row): OrderMoneyHeaderRow {
  return {
    id: text(order.id),
    currency: text(order.currency),
    subtotal_cents: Number(order.subtotal_cents),
    discount_cents: Number(order.discount_cents),
    shipping_cents: Number(order.shipping_cents),
    shipping_discount_cents: Number(order.shipping_discount_cents),
    tax_cents: Number(order.tax_cents),
    total_cents: Number(order.total_cents),
  };
}

async function readOrderMoneyItems(
  client: CheckoutRecoveryOrderSupabaseClient,
  orderId: string,
): Promise<Row[]> {
  const { data, error } = await client
    .from<Row>("commerce_order_items")
    .select(ORDER_ITEM_SELECT)
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`commerce_order_items: ${error.message ?? "query failed"}`);
  return data ?? [];
}

function readOrderClientId(order: Row): unknown {
  return order.client_id ?? "";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}

function readQuoteContextFromMetadata(metadata: Row): Row {
  return record(record(record(metadata.quoteSnapshot).quote).context);
}

/**
 * Buyer contact captured at checkout. The finalize RPC nests the runtime metadata
 * under `runtimeFinalize`, so the snapshot lives at
 * `metadata.runtimeFinalize.invoiceBuyerSnapshot`; fall back to the top-level key
 * for orders finalized before that nesting (or pre-finalize rows).
 */
function readBuyerSnapshot(metadata: Row): { email: unknown; name: unknown } {
  const nested = record(record(metadata.runtimeFinalize).invoiceBuyerSnapshot);
  const flat = record(metadata.invoiceBuyerSnapshot);
  const snapshot = Object.keys(nested).length > 0 ? nested : flat;
  return { email: snapshot.email, name: snapshot.name };
}
