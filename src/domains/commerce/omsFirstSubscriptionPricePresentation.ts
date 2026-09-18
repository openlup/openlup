import { deriveFirstSubscriptionPricePresentation } from "./firstSubscriptionPricePresentation.js";
import type { CanonicalOrderMoney } from "./orderMoney.js";
import type { OmsOrderDetail } from "./omsContracts.js";
import type { OmsOrderItemRow, OmsOrderRow } from "./omsReadModelRows.js";

export function omsFirstSubscriptionPricePresentation(
  order: OmsOrderRow,
  items: readonly OmsOrderItemRow[] | undefined,
  money: CanonicalOrderMoney,
): OmsOrderDetail["firstSubscriptionPricePresentation"] {
  const metadata = order.metadata ?? {};
  const runtimeFinalize = metadata.runtimeFinalize;
  const checkoutKind = runtimeFinalize && typeof runtimeFinalize === "object"
    ? (runtimeFinalize as Record<string, unknown>).checkoutKind
    : null;
  const presentation = deriveFirstSubscriptionPricePresentation({
    metadata,
    productSnapshots: (items ?? []).map((item) => item.product_snapshot),
    money,
    checkoutKind: checkoutKind === "subscription_initial" || checkoutKind === "one_time"
      ? checkoutKind
      : null,
  });
  if (!presentation) return null;
  const amount = (amountMinor: number) => ({ amountMinor, currency: order.currency });
  return {
    catalogProducts: amount(presentation.catalogProductsMinor),
    productDiscount: amount(presentation.productDiscountMinor),
    productPayable: amount(presentation.productPayableMinor),
    shipping: amount(presentation.shippingGrossMinor),
    shippingDiscount: amount(presentation.shippingDiscountMinor),
    shippingEffective: amount(presentation.shippingEffectiveMinor),
    total: amount(presentation.totalMinor),
    discountPercent: presentation.discountPercent,
  };
}
