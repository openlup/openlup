// Reads a PAID order's frozen line items + totals for the confirmation email.
// Catalog line totals remain customer-visible and the product discount remains a
// separate summary row; canonical effective values are validated, never rendered
// in place of the existing catalog amounts.

import {
  deriveOrderMoney,
  ORDER_HEADER_MONEY_COLUMNS,
  ORDER_ITEM_MONEY_COLUMNS,
  type OrderMoneyHeaderRow,
  type OrderMoneyItemRow,
} from "../../../../src/domains/commerce/orderMoney.js";
import { deriveFirstSubscriptionPricePresentation } from "../../../../src/domains/commerce/firstSubscriptionPricePresentation.js";
import { frozenOrderLineLabel } from "../../../domains/commerce/orderRecapMapping.js";

import type {
  OrderPaidLinesPort,
  OrderPaidRawData,
  OrderPaidRawLine,
} from "../../../domains/commerce/outboxOrderDraftEmailPorts.js";

interface QueryResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

interface OrderPaidLinesQueryBuilder extends PromiseLike<QueryResult> {
  select(columns: string): OrderPaidLinesQueryBuilder;
  eq(column: string, value: unknown): OrderPaidLinesQueryBuilder;
  order(column: string, options: { ascending: boolean }): OrderPaidLinesQueryBuilder;
  maybeSingle(): PromiseLike<QueryResult>;
}

export interface OrderPaidLinesSupabaseClient {
  from(table: string): OrderPaidLinesQueryBuilder;
}

const ITEM_SELECT_COLUMNS = `quantity, product_snapshot, variant_snapshot, ${ORDER_ITEM_MONEY_COLUMNS}`;

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function createSupabaseOrderPaidEmailLinesPort(
  client: OrderPaidLinesSupabaseClient,
): OrderPaidLinesPort {
  return {
    // Signal accepted per the port contract but not wired into queries (the repo's
    // supabase usage never passes abortSignal; the worker timeout is the backstop).
    async read(orderUuid: string, _signal: AbortSignal): Promise<OrderPaidRawData | null> {
      const orderResult = await client
        .from("commerce_orders")
        .select(`${ORDER_HEADER_MONEY_COLUMNS}, metadata`)
        .eq("id", orderUuid)
        .maybeSingle();
      if (orderResult.error) {
        throw new Error(
          `order_paid_lines_order_read_failed: ${orderResult.error.message ?? orderResult.error.code ?? "unknown"}`,
        );
      }
      const order = record(orderResult.data);
      const currency = nonEmptyString(order.currency);
      if (orderResult.data === null || currency === null) return null;

      const itemsResult = await client
        .from("commerce_order_items")
        .select(ITEM_SELECT_COLUMNS)
        .eq("order_id", orderUuid)
        .order("created_at", { ascending: true });
      if (itemsResult.error) {
        throw new Error(
          `order_paid_lines_items_read_failed: ${itemsResult.error.message ?? itemsResult.error.code ?? "unknown"}`,
        );
      }
      const rawItems = (Array.isArray(itemsResult.data) ? itemsResult.data : [])
        .map((value) => record(value))
        .filter((row) => typeof row.quantity === "number" && row.quantity > 0)
        .map((row) => ({
          snapshot: record(row.product_snapshot),
          variant: record(row.variant_snapshot),
          money: row as unknown as OrderMoneyItemRow,
        }));

      const money = deriveOrderMoney({
        id: orderUuid,
        currency,
        subtotal_cents: asNumber(order.subtotal_cents),
        discount_cents: asNumber(order.discount_cents),
        shipping_cents: asNumber(order.shipping_cents),
        shipping_discount_cents: asNumber(order.shipping_discount_cents),
        tax_cents: asNumber(order.tax_cents),
        total_cents: asNumber(order.total_cents),
      } satisfies OrderMoneyHeaderRow, rawItems.map((item) => item.money));
      const metadata = record(order.metadata);
      const checkoutKind = record(metadata.runtimeFinalize).checkoutKind;
      const firstSubscriptionPricePresentation = deriveFirstSubscriptionPricePresentation({
        metadata,
        productSnapshots: rawItems.map((item) => item.snapshot),
        money,
        checkoutKind: checkoutKind === "subscription_initial" || checkoutKind === "one_time"
          ? checkoutKind
          : null,
      });

      const lines: OrderPaidRawLine[] = money.lines.map((line, index) => ({
        label: frozenOrderLineLabel(
          rawItems[index]?.snapshot ?? {},
          rawItems[index]?.variant ?? {},
        ),
        quantity: line.quantity ?? 0,
        lineTotalMinor: line.catalogTotal,
      }));

      return {
        currency: money.currency,
        subtotalMinor: money.subtotal,
        discountMinor: money.productDiscount,
        totalMinor: money.total,
        firstSubscriptionPricePresentation,
        lines,
      };
    },
  };
}
