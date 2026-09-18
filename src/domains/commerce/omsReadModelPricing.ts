import type { OmsOrderDetail } from "./omsContracts.js";
import type { OmsOrderItemRow, OmsOrderRow } from "./omsReadModelRows.js";
import {
  deriveOrderMoney,
  type CanonicalOrderMoney,
} from "./orderMoney.js";
import type { CommerceCurrency } from "./types.js";

export function deriveOmsOrderMoney(
  order: OmsOrderRow,
  items?: readonly OmsOrderItemRow[],
): CanonicalOrderMoney {
  return deriveOrderMoney(
    {
      id: order.id,
      currency: order.currency,
      subtotal_cents: order.subtotal_cents ?? order.total_cents,
      discount_cents: order.discount_cents ?? 0,
      shipping_cents: order.shipping_cents ?? 0,
      shipping_discount_cents: order.shipping_discount_cents ?? 0,
      tax_cents: order.tax_cents ?? 0,
      total_cents: order.total_cents,
    },
    items?.map((item) => ({
      id: item.id,
      quantity: item.quantity,
      unit_price_cents: item.unit_price_cents ?? 0,
      total_cents: item.total_cents ?? 0,
      discount_allocated_cents: item.discount_allocated_cents,
      effective_total_cents: item.effective_total_cents,
      effective_net_cents: item.effective_net_cents,
      vat_rate_bps: item.vat_rate_bps ?? 0,
    })),
  );
}

export function pricingSummaryForOrder(
  order: OmsOrderRow,
  items?: readonly OmsOrderItemRow[],
  orderMoney: CanonicalOrderMoney = deriveOmsOrderMoney(order, items),
): OmsOrderDetail["pricingSummary"] {
  return {
    subtotal: money(orderMoney.subtotal, order.currency),
    productDiscount: money(orderMoney.productDiscount, order.currency),
    shipping: money(orderMoney.shippingEffective, order.currency),
    shippingDiscount: money(orderMoney.shippingDiscount, order.currency),
    discountTotal: money(
      orderMoney.productDiscount + orderMoney.shippingDiscount,
      order.currency,
    ),
    finalTotal: money(orderMoney.total, order.currency),
    source: "order_columns",
  };
}

function money(amountMinor: number, currency: CommerceCurrency): OmsOrderDetail["total"] {
  return { amountMinor, currency };
}
