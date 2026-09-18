import type { CustomerOrderDetailResponse } from "../../../src/domains/customers/accountV2Contracts.js";
import type {
  CanonicalOrderMoneyLine,
  OrderMoneyHeaderRow,
  OrderMoneyItemRow,
} from "../../../src/domains/commerce/types.js";
import {
  customerLineDisplayFields,
  resolveOrderLineProductSlug,
} from "./customerLineDisplayFields.js";
import { lineListTotalMinor } from "./customerOrderLinePricing.js";

export type CustomerOrderMoneyRow = Record<string, unknown>;

export function mapCustomerOrderLines(
  rows: readonly CustomerOrderMoneyRow[],
  moneyLines: readonly CanonicalOrderMoneyLine[],
  currency: string,
): CustomerOrderDetailResponse["order"]["lines"] {
  return rows.map((row, index) => {
    const snapshot = record(row.product_snapshot);
    const variant = record(row.variant_snapshot);
    const lineMoney = moneyLines[index];
    const totalMinor = lineMoney?.catalogTotal ?? Number(row.total_cents ?? 0);
    const listTotal = lineListTotalMinor(snapshot);
    const hasSaving = listTotal != null && listTotal > totalMinor;
    const title =
      firstText(variant, ["title", "name"]) ??
      firstText(snapshot, ["title", "name", "productName", "recipeName"]) ??
      "Produkt";
    const recipeName = firstText(snapshot, ["recipeName", "recipe_name"]) ?? firstText(variant, ["recipeName"]);
    const productSlug = resolveOrderLineProductSlug({ snapshot, variant, title, recipeName, firstText });
    return {
      lineId: text(row.id),
      skuId: nullableText(row.sku_id),
      title,
      quantity: Number(row.quantity),
      unitPrice: customerOrderMoney(lineMoney?.catalogUnit ?? row.unit_price_cents, currency),
      total: customerOrderMoney(totalMinor, currency),
      recipeName,
      variantName:
        firstText(snapshot, ["variantName", "variant_name", "size"]) ??
        firstText(variant, ["formatCode", "format_code"]),
      ...customerLineDisplayFields(productSlug),
      listTotal: hasSaving ? customerOrderMoney(listTotal, currency) : null,
      discount: hasSaving ? customerOrderMoney(listTotal - totalMinor, currency) : null,
    };
  });
}

export function toOrderMoneyHeader(order: CustomerOrderMoneyRow): OrderMoneyHeaderRow {
  return {
    id: text(order.id),
    currency: text(order.currency),
    subtotal_cents: Number(order.subtotal_cents),
    discount_cents: Number(order.discount_cents),
    shipping_cents: Number(order.shipping_cents),
    shipping_discount_cents: Number(order.shipping_discount_cents ?? 0),
    tax_cents: Number(order.tax_cents),
    total_cents: Number(order.total_cents),
  };
}

export function toOrderMoneyItem(item: CustomerOrderMoneyRow): OrderMoneyItemRow {
  return {
    id: text(item.id),
    quantity: Number(item.quantity),
    unit_price_cents: Number(item.unit_price_cents),
    total_cents: Number(item.total_cents),
    discount_allocated_cents: nullableNumber(item.discount_allocated_cents),
    effective_total_cents: nullableNumber(item.effective_total_cents),
    effective_net_cents: nullableNumber(item.effective_net_cents),
    vat_rate_bps: Number(item.vat_rate_bps),
  };
}

/**
 * Denominates a stored amount in **the currency stored with the order**, which the
 * caller reads off `CanonicalOrderMoney.currency` and therefore off
 * `commerce_orders.currency`.
 *
 * The currency is a parameter and not a literal because this is *history*. An order
 * placed in one currency has to keep displaying in that currency for as long as the
 * customer can open it, and a stamp that answered from the deployment's settlement
 * profile instead would relabel every past order the moment an operator changed what
 * the shop sells in - the same defect E2-F2 removed from the static quote lane, one
 * layer further from the customer and therefore quieter.
 *
 * A row that carries no currency cannot reach here through the supported path:
 * `commerce_orders.currency` has been `NOT NULL DEFAULT 'PLN' CHECK (char_length = 3)`
 * since the schema shell. If one somehow did, `text()` in {@link toOrderMoneyHeader}
 * yields `""`, `platformCurrencySchema` in `customerOrderDetailResponseSchema` refuses
 * it, and the handler answers `INVALID_RESPONSE`. Unknown surfaces as a named refusal;
 * it is never quietly renamed to the platform default.
 */
export function customerOrderMoney(value: unknown, currency: string) {
  return { amountMinor: Number(value ?? 0), currency };
}

function firstText(row: CustomerOrderMoneyRow, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function record(value: unknown): CustomerOrderMoneyRow {
  return value && typeof value === "object" && !Array.isArray(value) ? value as CustomerOrderMoneyRow : {};
}
