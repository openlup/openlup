import type { PurchaseOrder, PurchaseSuppressionReason } from "../contracts/analytics.js";
export type { PurchaseOrder, PurchaseSuppressionReason } from "../contracts/analytics.js";
import type { AnalyticsEventMap, AnalyticsPurchaseItem } from "./noop.js";

const MAX_ITEMS = 200;

export function projectPaidPurchase(recap: PurchaseOrder,
  suppressPurchase: (reason: PurchaseSuppressionReason) => null = () => null,
): AnalyticsEventMap["purchase"] | null {
  if (recap.status !== "paid") return suppressPurchase("order_not_paid");
  if (recap.paymentStatus !== "succeeded") return suppressPurchase("payment_not_succeeded");
  if (recap.checkoutKind !== "one_time" && recap.checkoutKind !== "subscription_initial"
    && recap.checkoutKind !== "subscription_renewal") return suppressPurchase("checkout_kind_unsupported");
  if (!recap.moneyReconciled) return suppressPurchase("money_unreconciled");
  if (recap.items.length === 0) return suppressPurchase("items_empty");
  let effectiveNet = 0;
  const items: AnalyticsPurchaseItem[] = [];
  for (const item of recap.items) {
    if (!item.sku) return suppressPurchase("sku_missing");
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) return suppressPurchase("quantity_invalid");
    if (item.quantity > MAX_ITEMS) return suppressPurchase("item_limit_exceeded");
    if (!isNonNegativeSafeInteger(item.catalogTotalGross) || !isNonNegativeSafeInteger(item.effectiveNet)
      || !isNonNegativeSafeInteger(item.vatRateBps) || item.vatRateBps > 10_000) return suppressPurchase("line_money_invalid");
    const catalogNet = netFromGross(item.catalogTotalGross, item.vatRateBps);
    const netDiscount = catalogNet - item.effectiveNet;
    if (netDiscount < 0) return suppressPurchase("net_discount_invalid");
    const projected = allocateLineItems({ sku: item.sku, variantCode: item.variantCode,
      quantity: item.quantity, effectiveNet: item.effectiveNet, netDiscount });
    if (items.length + projected.length > MAX_ITEMS) return suppressPurchase("item_limit_exceeded");
    items.push(...projected);
    effectiveNet += item.effectiveNet;
  }
  const tax = recap.totals.tax.amountMinor;
  const total = recap.totals.total.amountMinor;
  const effectiveShippingNet = total - tax - effectiveNet;
  if (!isNonNegativeSafeInteger(effectiveShippingNet)) return suppressPurchase("shipping_net_invalid");
  return { transaction_id: recap.orderId, currency: recap.totals.total.currency, value: effectiveNet / 100,
    shipping: effectiveShippingNet / 100, tax: tax / 100,
    checkout_mode: recap.checkoutKind === "one_time" ? "one_time" : "subscription", items };
}
function allocateLineItems(input: { sku: string; variantCode: string | null; quantity: number;
  effectiveNet: number; netDiscount: number }): AnalyticsPurchaseItem[] {
  const priceBase = Math.floor(input.effectiveNet / input.quantity);
  const priceRemainder = input.effectiveNet % input.quantity;
  const discountBase = Math.floor(input.netDiscount / input.quantity);
  const discountRemainder = input.netDiscount % input.quantity;
  const grouped = new Map<string, { priceMinor: number; discountMinor: number; quantity: number }>();
  for (let position = 0; position < input.quantity; position += 1) {
    const priceMinor = priceBase + (position < priceRemainder ? 1 : 0);
    const discountMinor = discountBase + (position < discountRemainder ? 1 : 0);
    const key = `${priceMinor}:${discountMinor}`;
    const current = grouped.get(key);
    if (current) current.quantity += 1;
    else grouped.set(key, { priceMinor, discountMinor, quantity: 1 });
  }
  return [...grouped.values()].map(group => ({ item_id: input.sku,
    ...(input.variantCode ? { item_variant: input.variantCode } : {}), price: group.priceMinor / 100,
    discount: group.discountMinor / 100, quantity: group.quantity }));
}
function netFromGross(grossMinor: number, vatRateBps: number): number {
  return Math.round(grossMinor * 10_000 / (10_000 + vatRateBps));
}
function isNonNegativeSafeInteger(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
