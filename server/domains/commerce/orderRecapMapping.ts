import type { OrderRecapData } from "./commerceOrderRecapHandler.js";
import type {
  CanonicalOrderMoneyLine,
  OrderMoneyHeaderRow,
  OrderMoneyItemRow,
} from "../../../src/domains/commerce/orderMoney.js";
import { commerceSkuSchema } from "../../../src/domains/commerce/contractPrimitives.js";

export type OrderRecapRow = Record<string, unknown>;

/** One canonical precedence for customer-visible labels frozen on order lines. */
export function frozenOrderLineLabel(
  productSnapshot: unknown,
  variantSnapshot: unknown,
): string | null {
  const snapshot = recapRecord(productSnapshot);
  const variant = recapRecord(variantSnapshot);
  return firstText(variant, ["title", "name"])
    ?? firstText(snapshot, ["title", "name", "productName", "recipeName"]);
}

export function mapOrderRecapLines(
  rows: readonly OrderRecapRow[],
  moneyLines: readonly CanonicalOrderMoneyLine[],
  currency: string,
): OrderRecapData["items"] {
  return rows.map((row, index) => {
    const snapshot = recapRecord(row.product_snapshot);
    const variant = recapRecord(row.variant_snapshot);
    const moneyLine = moneyLines[index];
    const totalMinor = moneyLine?.catalogTotal ?? Number(row.total_cents ?? 0);
    const listTotalMinor = lineListTotalMinor(snapshot);
    return {
      title: frozenOrderLineLabel(snapshot, variant) ?? "Produkt",
      quantity: Number(row.quantity ?? 0),
      recipeName: firstText(snapshot, ["recipeName", "recipe_name"]) ?? firstText(variant, ["recipeName"]),
      variantName:
        firstText(snapshot, ["variantName", "variant_name", "size"]) ??
        firstText(variant, ["formatCode", "format_code"]),
      total: recapMoney(totalMinor, currency),
      listTotal: listTotalMinor != null && listTotalMinor > totalMinor
        ? recapMoney(listTotalMinor, currency)
        : null,
      discount:
        listTotalMinor != null && listTotalMinor > totalMinor
          ? recapMoney(listTotalMinor - totalMinor, currency)
          : null,
      sku: validSku(firstText(variant, ["sku"]) ?? firstText(snapshot, ["sku"])),
      variantCode: validVariantCode(firstText(variant, ["formatCode", "format_code"])),
      catalogUnitGross: moneyLine?.catalogUnit ?? Number(row.unit_price_cents ?? 0),
      catalogTotalGross: totalMinor,
      effectiveGross: moneyLine?.effectiveGross ?? totalMinor,
      effectiveNet: moneyLine?.effectiveNet ?? 0,
      discountAllocated: moneyLine?.discountAllocated ?? 0,
      vatRateBps: moneyLine?.vatRateBps ?? Number(row.vat_rate_bps ?? 0),
    };
  });
}

export function toOrderMoneyHeader(order: OrderRecapRow): OrderMoneyHeaderRow {
  return {
    id: recapText(order.id),
    currency: recapText(order.currency),
    subtotal_cents: Number(order.subtotal_cents),
    discount_cents: Number(order.discount_cents),
    shipping_cents: Number(order.shipping_cents),
    shipping_discount_cents: Number(order.shipping_discount_cents),
    tax_cents: Number(order.tax_cents),
    total_cents: Number(order.total_cents),
  };
}

export function toOrderMoneyItem(item: OrderRecapRow): OrderMoneyItemRow {
  return {
    id: recapText(item.id),
    quantity: Number(item.quantity),
    unit_price_cents: Number(item.unit_price_cents),
    total_cents: Number(item.total_cents),
    discount_allocated_cents: nullableNumber(item.discount_allocated_cents),
    effective_total_cents: nullableNumber(item.effective_total_cents),
    effective_net_cents: nullableNumber(item.effective_net_cents),
    vat_rate_bps: Number(item.vat_rate_bps),
  };
}

export function buildRecapAddress(address: OrderRecapRow): OrderRecapData["shippingAddress"] {
  const line1 = recapNullableText(address.line1);
  const city = recapNullableText(address.city);
  const postalCode = recapNullableText(address.postal_code);
  if (!line1 || !city || !postalCode) return null;
  return {
    line1,
    line2: recapNullableText(address.line2),
    city,
    postalCode,
    country: "PL",
  };
}

export function buildEffectiveRecapAddress(
  metadataValue: unknown,
  shippingAddressSnapshotValue: unknown,
  legacyAddressValue?: unknown,
): OrderRecapData["shippingAddress"] {
  const metadata = recapRecord(metadataValue);
  const runtimeFinalize = recapRecord(metadata.runtimeFinalize);
  const parcelSnapshot = recapRecord(shippingAddressSnapshotValue);
  const contact = firstPresentVersionedDeliveryContact([
    parcelSnapshot.deliveryContact,
    metadata.deliveryContactOverride,
    runtimeFinalize.deliveryContact,
  ]);
  if (contact === undefined) return buildRecapAddress(recapRecord(legacyAddressValue));
  if (!contact) return null;
  const line1 = recapNullableText(contact.line1);
  const city = recapNullableText(contact.city);
  const postalCode = recapNullableText(contact.postalCode);
  if (!line1 || !city || !postalCode || recapNullableText(contact.country) !== "PL") return null;
  return buildRecapAddress({
    line1,
    line2: recapNullableText(contact.line2),
    city,
    postal_code: postalCode,
  });
}

export function deriveRecapFirstName(invoiceSnapshot: OrderRecapRow): string | null {
  if (recapNullableText(invoiceSnapshot.companyName)) return null;
  const name = recapNullableText(invoiceSnapshot.name);
  if (!name) return null;
  return name.trim().split(/\s+/)[0] || null;
}

export function maskRecapEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return null;
  return `${email.slice(0, 1)}***@${email.slice(at + 1)}`;
}

/**
 * Denominates a recap amount in **the currency stored with the order**, which the
 * caller takes from `CanonicalOrderMoney.currency` - i.e. from
 * `commerce_orders.currency`, the column {@link toOrderMoneyHeader} above already
 * reads.
 *
 * Same reasoning as the customer order history's stamp: the recap is a record of a
 * purchase that has already happened. Answering its currency from the deployment's
 * settlement profile would re-denominate every past thank-you page and confirmation
 * the day an operator changed what the shop sells in.
 *
 * A recap for a row with no currency is refused rather than guessed: `recapText`
 * yields `""`, and `platformCurrencySchema` inside `orderRecapResponseSchema` rejects
 * it when the handler parses the response.
 */
export function recapMoney(value: unknown, currency: string) {
  return { amountMinor: Number(value ?? 0), currency };
}

export function recapPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function recapText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function recapNullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function recapRecord(value: unknown): OrderRecapRow {
  return value && typeof value === "object" && !Array.isArray(value) ? value as OrderRecapRow : {};
}

export function readQuoteContextFromMetadata(metadata: OrderRecapRow): OrderRecapRow {
  return recapRecord(recapRecord(recapRecord(metadata.quoteSnapshot).quote).context);
}

function lineListTotalMinor(snapshot: OrderRecapRow): number | null {
  const components = recapRecord(snapshot.quoteLine).pricingComponents;
  if (!Array.isArray(components)) return null;
  let base = 0;
  let sawBase = false;
  for (const raw of components) {
    const component = recapRecord(raw);
    if (component.componentType === "base_unit") {
      base += Number(component.amountMinor ?? 0);
      sawBase = true;
    }
  }
  return sawBase ? base : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function firstText(row: OrderRecapRow, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function firstPresentVersionedDeliveryContact(
  values: readonly unknown[],
): OrderRecapRow | null | undefined {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const contact = recapRecord(value);
    return contact.schemaVersion === 1 && recapPositiveInt(contact.revision) ? contact : null;
  }
  return undefined;
}

function validSku(value: string | null): string | null {
  const parsed = commerceSkuSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function validVariantCode(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return /^[a-z][a-z0-9_-]{0,79}$/.test(normalized) ? normalized : null;
}
