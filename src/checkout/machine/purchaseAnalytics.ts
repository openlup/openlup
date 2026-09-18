import type {
  OrderRecapV3Response,
  OrderRecapV4Response,
} from "@/domains/commerce/orderRecapContracts";

type AnalyticsOrderRecap = OrderRecapV3Response | OrderRecapV4Response;
import {
  emitAnalyticsEvent,
  isAnalyticsLoaderReady,
  type AnalyticsEventMap,
  type AnalyticsPurchaseItem,
} from "@/lib/analytics/dataLayer";

const PURCHASE_DEDUPE_PREFIX = "openlup-ga4-v1-purchase-tracked-";
const DEPLOYMENT_PURCHASE_DEDUPE_PREFIX = "deployment-analytics-v1-purchase-tracked-";
const admittedDeploymentPurchaseKeys = new Set<string>();
const MAX_GA4_ITEMS = 200;

type PurchaseSuppressionReason =
  | "order_not_paid"
  | "payment_not_succeeded"
  | "checkout_kind_unsupported"
  | "money_unreconciled"
  | "items_empty"
  | "sku_missing"
  | "quantity_invalid"
  | "line_money_invalid"
  | "net_discount_invalid"
  | "item_limit_exceeded"
  | "shipping_net_invalid";

/**
 * Admit purchase independently to the deployment projection and, once ready,
 * GTM. Neither admission is a transport or business acknowledgement.
 */
export function trackPurchaseOnce(recap: AnalyticsOrderRecap): void {
  const payload = buildPurchasePayload(recap);
  if (!payload) return;

  const optionalDedupeKey = `${PURCHASE_DEDUPE_PREFIX}${recap.orderId}`;
  const deploymentDedupeKey = `${DEPLOYMENT_PURCHASE_DEDUPE_PREFIX}${recap.orderId}`;
  const deploymentSeen =
    admittedDeploymentPurchaseKeys.has(deploymentDedupeKey) ||
    hasSessionDedupe(deploymentDedupeKey);
  const optionalSeen = hasSessionDedupe(optionalDedupeKey);
  const attempts = {
    deployment: !deploymentSeen,
    optional: isOptionalReady() && !optionalSeen,
  };
  if (!attempts.deployment && !attempts.optional) return;

  const admitted = emitAnalyticsEvent("purchase", payload, attempts);
  if (admitted.deployment) {
    admittedDeploymentPurchaseKeys.add(deploymentDedupeKey);
    writeSessionDedupe(deploymentDedupeKey);
  }
  if (admitted.optional) writeSessionDedupe(optionalDedupeKey);
}

function isOptionalReady(): boolean {
  try {
    return isAnalyticsLoaderReady();
  } catch {
    return false;
  }
}

function hasSessionDedupe(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeSessionDedupe(key: string): void {
  try {
    sessionStorage.setItem(key, "1");
  } catch {
    // Deployment has a document-local fallback; GTM keeps its prior best-effort
    // behavior when browser session storage is unavailable.
  }
}

export function buildPurchasePayload(
  recap: AnalyticsOrderRecap,
): AnalyticsEventMap["purchase"] | null {
  if (recap.status !== "paid") return suppressPurchase("order_not_paid");
  if (recap.paymentStatus !== "succeeded") {
    return suppressPurchase("payment_not_succeeded");
  }
  if (recap.checkoutKind !== "one_time" && recap.checkoutKind !== "subscription_initial") {
    return suppressPurchase("checkout_kind_unsupported");
  }
  if (!recap.moneyReconciled) return suppressPurchase("money_unreconciled");
  if (recap.items.length === 0) return suppressPurchase("items_empty");

  let effectiveNet = 0;
  const ga4Items: AnalyticsPurchaseItem[] = [];

  for (const item of recap.items) {
    if (!item.sku) return suppressPurchase("sku_missing");
    if (
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0
    ) {
      return suppressPurchase("quantity_invalid");
    }
    if (item.quantity > MAX_GA4_ITEMS) return suppressPurchase("item_limit_exceeded");
    if (
      !isNonNegativeSafeInteger(item.catalogTotalGross) ||
      !isNonNegativeSafeInteger(item.effectiveNet) ||
      !isNonNegativeSafeInteger(item.vatRateBps) ||
      item.vatRateBps > 10_000
    ) {
      return suppressPurchase("line_money_invalid");
    }

    const catalogNet = netFromGross(item.catalogTotalGross, item.vatRateBps);
    const netDiscount = catalogNet - item.effectiveNet;
    if (netDiscount < 0) return suppressPurchase("net_discount_invalid");

    const projectedItems = allocateLineItems({
      sku: item.sku,
      variantCode: item.variantCode,
      quantity: item.quantity,
      effectiveNet: item.effectiveNet,
      netDiscount,
    });
    if (ga4Items.length + projectedItems.length > MAX_GA4_ITEMS) {
      return suppressPurchase("item_limit_exceeded");
    }

    ga4Items.push(...projectedItems);
    effectiveNet += item.effectiveNet;
  }

  const tax = recap.totals.tax.amountMinor;
  const total = recap.totals.total.amountMinor;
  const effectiveShippingNet = total - tax - effectiveNet;
  if (!isNonNegativeSafeInteger(effectiveShippingNet)) {
    return suppressPurchase("shipping_net_invalid");
  }

  return {
    transaction_id: recap.orderId,
    currency: recap.totals.total.currency,
    value: effectiveNet / 100,
    shipping: effectiveShippingNet / 100,
    tax: tax / 100,
    checkout_mode: recap.checkoutKind === "subscription_initial" ? "subscription" : "one_time",
    items: ga4Items,
  };
}

function allocateLineItems(input: {
  sku: string;
  variantCode: string | null;
  quantity: number;
  effectiveNet: number;
  netDiscount: number;
}): AnalyticsPurchaseItem[] {
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
    if (current) {
      current.quantity += 1;
    } else {
      grouped.set(key, { priceMinor, discountMinor, quantity: 1 });
    }
  }

  return [...grouped.values()].map((group) => ({
    item_id: input.sku,
    ...(input.variantCode ? { item_variant: input.variantCode } : {}),
    price: group.priceMinor / 100,
    discount: group.discountMinor / 100,
    quantity: group.quantity,
  }));
}

function suppressPurchase(reason: PurchaseSuppressionReason): null {
  if (import.meta.env.DEV || isPurchaseSuppressionDiagnosticHost()) {
    console.warn(`[analytics] purchase suppressed: ${reason}`);
  }
  return null;
}

function isPurchaseSuppressionDiagnosticHost(): boolean {
  if (typeof window === "undefined") return false;
  const { hostname } = window.location;
  return hostname === "staging.openlup.com" || /^openlup-hidden-preview-[a-z0-9-]+\.vercel\.app$/.test(hostname);
}

function netFromGross(grossMinor: number, vatRateBps: number): number {
  return Math.round(grossMinor * 10_000 / (10_000 + vatRateBps));
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
