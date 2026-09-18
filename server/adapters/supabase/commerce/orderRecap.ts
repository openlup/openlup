import type { OrderRecapData, OrderRecapReadPort } from "../../../domains/commerce/commerceOrderRecapHandler.js";
import { formatCustomerOrderReference } from "../../../../src/lib/orderRef.js";
import {
  deriveOrderMoney,
  ORDER_HEADER_MONEY_COLUMNS,
  ORDER_ITEM_MONEY_COLUMNS,
} from "../../../../src/domains/commerce/orderMoney.js";
import { deriveFirstSubscriptionPricePresentation } from "../../../../src/domains/commerce/firstSubscriptionPricePresentation.js";
import {
  buildEffectiveRecapAddress,
  deriveRecapFirstName,
  mapOrderRecapLines,
  maskRecapEmail,
  readQuoteContextFromMetadata,
  recapMoney,
  recapNullableText,
  recapPositiveInt,
  recapRecord,
  recapText,
  toOrderMoneyHeader,
  toOrderMoneyItem,
  type OrderRecapRow,
} from "../../../domains/commerce/orderRecapMapping.js";

/**
 * Structural Supabase surface used by the recap port. Mirrors the slim shape in
 * the `commerce/paymentStatus` adapter so the route can pass a service-role client without
 * importing the full `@supabase/supabase-js` type into the domain layer.
 */
export interface OrderRecapSupabaseClient {
  from<T = Record<string, unknown>>(table: string): OrderRecapQuery<T>;
}

interface OrderRecapQuery<T> {
  select(columns: string): OrderRecapQuery<T>;
  eq(column: string, value: unknown): OrderRecapQuery<T>;
  order(column: string, options: { ascending: boolean }): OrderRecapQuery<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: RpcError | null }>;
  then<R>(onfulfilled: (value: { data: T[] | null; error: RpcError | null }) => R): PromiseLike<R>;
}

interface RpcError {
  message?: string;
}

type Row = OrderRecapRow;

const ORDER_SELECT =
  `id, order_number, status, ${ORDER_HEADER_MONEY_COLUMNS}, created_at, metadata, subscription_id, mode, shipping_address_id, pet_id`;

const ORDER_ITEM_SELECT =
  `id, quantity, ${ORDER_ITEM_MONEY_COLUMNS}, product_snapshot, variant_snapshot`;

export function createSupabaseOrderRecapPort(
  client: OrderRecapSupabaseClient,
): OrderRecapReadPort {
  return {
    async getOrderRecap(input): Promise<OrderRecapData | null> {
      // Ownership guard: filter by BOTH the order id and the owning client id.
      // A non-owning pair returns no row → null → 404 (existence not leaked).
      const { data: order, error: orderError } = await client
        .from<Row>("commerce_orders")
        .select(ORDER_SELECT)
        .eq("id", input.orderId)
        .eq("client_id", input.clientId)
        .maybeSingle();
      if (orderError) {
        throw new Error(`commerce_orders: ${orderError.message ?? "query failed"}`);
      }
      if (!order) return null;

      const metadata = recapRecord(order.metadata);
      const runtimeFinalize = recapRecord(metadata.runtimeFinalize);
      const petSnapshot = recapRecord(metadata.petSnapshot);
      const invoiceSnapshot = recapRecord(metadata.invoiceBuyerSnapshot);
      const quoteContext = readQuoteContextFromMetadata(metadata);
      const subscriptionId = recapNullableText(order.subscription_id);

      // Mode is intentionally derived from several signals, not just
      // `metadata.cadenceDays`: the configurator persists its intent in the quote
      // snapshot (`context.mode`), the first subscription order keeps the column
      // default `one_time` until a cycle runs, and cadence only lives at the
      // metadata top level for some paths. Any one positive signal ⇒ subscription.
      const metaCadence = recapPositiveInt(metadata.cadenceDays) ?? recapPositiveInt(quoteContext.cadenceDays);
      const isSubscription =
        Boolean(subscriptionId) ||
        recapText(order.mode) === "subscription_cycle" ||
        recapNullableText(quoteContext.mode) === "subscription" ||
        metaCadence != null;
      const mode = isSubscription ? ("subscription" as const) : ("one_time" as const);

      const [itemRows, paymentStatus, subscription, fulfillmentRows] = await Promise.all([
        readLineRows(client, input.orderId),
        readLatestPaymentStatus(client, input.orderId),
        isSubscription ? readSubscription(client, subscriptionId) : Promise.resolve(null),
        readFulfillmentSnapshots(client, recapText(order.id)),
      ]);
      const shippingAddress = buildEffectiveRecapAddress(
        metadata,
        fulfillmentRows[0]?.shipping_address_snapshot,
        await readLegacyShippingAddressWhenNeeded(
          client,
          metadata,
          fulfillmentRows[0]?.shipping_address_snapshot,
          recapNullableText(order.shipping_address_id),
        ),
      );
      const orderMoney = deriveOrderMoney(
        toOrderMoneyHeader(order),
        itemRows.map(toOrderMoneyItem),
      );
      const items = mapOrderRecapLines(itemRows, orderMoney.lines, orderMoney.currency);

      const cadenceDays = metaCadence ?? subscription?.cadenceDays ?? null;
      const nextDeliveryAt = subscription?.nextDeliveryAt ?? null;

      const orderId = recapText(order.id);
      const runtimeCheckoutKind = recapNullableText(runtimeFinalize.checkoutKind);
      const checkoutKind =
        runtimeCheckoutKind === "one_time" || runtimeCheckoutKind === "subscription_initial"
          ? runtimeCheckoutKind
          : null;
      const firstSubscriptionPricePresentation = deriveFirstSubscriptionPricePresentation({
        metadata,
        productSnapshots: itemRows.map((item) => item.product_snapshot),
        money: orderMoney,
        checkoutKind,
      });
      return {
        orderId,
        orderRef: `order_${orderId}`,
        orderNumber: recapNullableText(order.order_number) ?? formatCustomerOrderReference(orderId),
        status: recapText(order.status),
        paymentStatus,
        mode,
        petId: recapNullableText(order.pet_id),
        petName:
          recapNullableText(metadata.petName) ??
          recapNullableText(runtimeFinalize.petName) ??
          recapNullableText(petSnapshot.name),
        customerFirstName: deriveRecapFirstName(invoiceSnapshot),
        maskedEmail: maskRecapEmail(recapNullableText(invoiceSnapshot.email)),
        cadenceDays,
        nextDeliveryAt,
        checkoutKind,
        moneyReconciled: orderMoney.reconciled,
        firstSubscriptionPricePresentation,
        items,
        // Every total is denominated in the order's own stored currency, which
        // `ORDER_SELECT` already asks for through `ORDER_HEADER_MONEY_COLUMNS`.
        totals: {
          subtotal: recapMoney(orderMoney.subtotal, orderMoney.currency),
          discount: recapMoney(orderMoney.productDiscount, orderMoney.currency),
          shipping: recapMoney(orderMoney.shippingGross, orderMoney.currency),
          shippingDiscount: recapMoney(orderMoney.shippingDiscount, orderMoney.currency),
          tax: recapMoney(orderMoney.tax, orderMoney.currency),
          total: recapMoney(orderMoney.total, orderMoney.currency),
        },
        shippingAddress,
        createdAt: recapText(order.created_at),
      };
    },
  };
}

async function readFulfillmentSnapshots(
  client: OrderRecapSupabaseClient,
  orderId: string,
): Promise<Row[]> {
  const { data, error } = await client
    .from<Row>("commerce_fulfillment_orders")
    .select("id, sequence_no, shipping_address_snapshot")
    .eq("order_id", orderId)
    .order("sequence_no", { ascending: false });
  if (error) {
    throw new Error(`commerce_fulfillment_orders: ${error.message ?? "query failed"}`);
  }
  return (data ?? []) as Row[];
}

async function readLegacyShippingAddressWhenNeeded(
  client: OrderRecapSupabaseClient,
  metadataValue: unknown,
  shippingAddressSnapshotValue: unknown,
  addressId: string | null,
): Promise<Row | null> {
  const metadata = recapRecord(metadataValue);
  const runtimeFinalize = recapRecord(metadata.runtimeFinalize);
  const parcelSnapshot = recapRecord(shippingAddressSnapshotValue);
  const canonicalKeyPresent = [
    parcelSnapshot.deliveryContact,
    metadata.deliveryContactOverride,
    runtimeFinalize.deliveryContact,
  ].some((value) => value !== undefined && value !== null);
  if (canonicalKeyPresent || !addressId) return null;
  const { data, error } = await client
    .from<Row>("addresses")
    .select("line1, line2, city, postal_code, country")
    .eq("id", addressId)
    .maybeSingle();
  if (error) throw new Error(`addresses: ${error.message ?? "query failed"}`);
  return data;
}

async function readLineRows(
  client: OrderRecapSupabaseClient,
  orderId: string,
): Promise<Row[]> {
  const { data, error } = await client
    .from<Row>("commerce_order_items")
    .select(ORDER_ITEM_SELECT)
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`commerce_order_items: ${error.message ?? "query failed"}`);
  }
  return (data ?? []) as Row[];
}

async function readLatestPaymentStatus(
  client: OrderRecapSupabaseClient,
  orderId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from<Row>("commerce_payments")
    .select("status, updated_at")
    .eq("order_id", orderId)
    .order("updated_at", { ascending: false });
  if (error) {
    throw new Error(`commerce_payments: ${error.message ?? "query failed"}`);
  }
  const rows = (data ?? []) as Row[];
  return rows.length > 0 ? recapNullableText(rows[0].status) : null;
}

async function readSubscription(
  client: OrderRecapSupabaseClient,
  subscriptionId: string | null,
): Promise<{ nextDeliveryAt: string | null; cadenceDays: number | null } | null> {
  if (!subscriptionId) return null;
  const { data, error } = await client
    .from<Row>("subscriptions")
    .select("next_cycle_at, cadence_days")
    .eq("id", subscriptionId)
    .maybeSingle();
  if (error) {
    throw new Error(`subscriptions: ${error.message ?? "query failed"}`);
  }
  if (!data) return null;
  return {
    nextDeliveryAt: recapNullableText(data.next_cycle_at),
    cadenceDays: recapPositiveInt(data.cadence_days),
  };
}
