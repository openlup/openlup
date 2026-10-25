import type { OrderPaidPricePresentation } from "./outboxOrderDraftEmailPorts.js";
import type { OrderEmailTotals } from "./outboxOrderDraftEmailPorts.js";
import { formatMoney } from "./orderEmailLines.js";
export function totalsFromFirstSubscription(data: {
  currency: string;
  firstSubscriptionPricePresentation: OrderPaidPricePresentation;
}): OrderEmailTotals {
  const presentation = data.firstSubscriptionPricePresentation;
  return {
    subtotalLabel: formatMoney(presentation.catalogProductsMinor, data.currency),
    discountLabel: `−${formatMoney(presentation.productDiscountMinor, data.currency)}`,
    totalLabel: formatMoney(presentation.totalMinor, data.currency),
    firstSubscription: {
      discountPercent: presentation.discountPercent,
      catalogLabel: formatMoney(presentation.catalogProductsMinor, data.currency),
      productPayableLabel: formatMoney(presentation.productPayableMinor, data.currency),
      shippingLabel: presentation.shippingEffectiveMinor > 0
        ? formatMoney(presentation.shippingEffectiveMinor, data.currency)
        : null,
      shippingFree: presentation.shippingGrossMinor > 0
        && presentation.shippingEffectiveMinor === 0,
    },
  };
}
