import type { CanonicalOrderMoney } from "./orderMoney.js";

export interface FirstSubscriptionPricePresentation {
  catalogProductsMinor: number;
  productDiscountMinor: number;
  productPayableMinor: number;
  shippingGrossMinor: number;
  shippingDiscountMinor: number;
  shippingEffectiveMinor: number;
  totalMinor: number;
  discountPercent: 50;
}

/**
 * Customer/operator-facing explanation of a settled initial-subscription offer.
 *
 * The frozen snapshot supplies only the crossed-out catalogue anchor and stable
 * offer semantic. Settled money always comes from CanonicalOrderMoney. Returning
 * null is intentional: receipts must never reconstruct a catalogue price from
 * today’s promotion configuration or from an incomplete historical snapshot.
 */
export function deriveFirstSubscriptionPricePresentation(input: {
  metadata: unknown;
  productSnapshots: readonly unknown[];
  money: CanonicalOrderMoney;
  checkoutKind: "subscription_initial" | "one_time" | null;
}): FirstSubscriptionPricePresentation | null {
  if (
    input.checkoutKind !== "subscription_initial"
    || !input.money.reconciled
    || !hasFirstSubscriptionSemantic(input.metadata)
    || input.productSnapshots.length === 0
    || input.productSnapshots.length !== input.money.lines.length
  ) {
    return null;
  }

  const anchors = input.productSnapshots.map(baseUnitAnchor);
  if (anchors.some((anchor) => anchor === null)) return null;
  const catalogProductsMinor = anchors.reduce<number>((sum, anchor) => sum + (anchor ?? 0), 0);
  const productPayableMinor = input.money.subtotal - input.money.productDiscount;

  if (
    catalogProductsMinor <= 0
    || productPayableMinor <= 0
    || productPayableMinor + input.money.shippingEffective !== input.money.total
    || catalogProductsMinor !== productPayableMinor * 2
  ) {
    return null;
  }

  return {
    catalogProductsMinor,
    productDiscountMinor: catalogProductsMinor - productPayableMinor,
    productPayableMinor,
    shippingGrossMinor: input.money.shippingGross,
    shippingDiscountMinor: input.money.shippingDiscount,
    shippingEffectiveMinor: input.money.shippingEffective,
    totalMinor: input.money.total,
    discountPercent: 50,
  };
}

function hasFirstSubscriptionSemantic(metadata: unknown): boolean {
  const root = record(metadata);
  const draft = record(root.orderDraftSnapshot);
  const quote = record(record(root.quoteSnapshot).quote);
  return [draft.discounts, quote.discounts].some((discounts) =>
    Array.isArray(discounts) && discounts.some((discount) =>
      record(discount).customerSemantic === "first_subscription_50",
    ),
  );
}

function baseUnitAnchor(snapshot: unknown): number | null {
  const quoteLine = record(record(snapshot).quoteLine);
  const components = quoteLine.pricingComponents;
  if (!Array.isArray(components)) return null;
  const baseUnits = components.filter((component) => {
    const value = record(component);
    return value.componentType === "base_unit"
      && value.scope === "line"
      && Number.isSafeInteger(value.amountMinor)
      && (value.amountMinor as number) > 0;
  });
  return baseUnits.length === 1 ? baseUnits[0]!.amountMinor as number : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
