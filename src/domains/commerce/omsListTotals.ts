import { PLATFORM_DEFAULT_CURRENCY } from "../../lib/currency/platformCurrency.js";
import type { AdminCommerceOrdersListResponse } from "./omsContracts.js";

/**
 * A paid set that spans more than one currency has no single GMV and no single
 * average order value. Adding the minor units across currencies produces a
 * figure that is money in none of them, and labelling it with one of the codes
 * makes it look actionable. The operator gets a named refusal instead.
 */
export class CommerceOmsMixedCurrencyTotalsError extends Error {
  readonly currencies: readonly string[];

  constructor(currencies: readonly string[]) {
    super("commerce_oms_summary_mixed_currency");
    this.name = "CommerceOmsMixedCurrencyTotalsError";
    this.currencies = currencies;
  }
}

export function summarizeOmsListTotals(
  orders: AdminCommerceOrdersListResponse["orders"],
): AdminCommerceOrdersListResponse["summaryTotals"] {
  const paidOrders = orders.filter((order) => order.paymentStatus === "succeeded");
  const currencies = [...new Set(paidOrders.map((order) => order.total.currency))].sort();
  if (currencies.length > 1) throw new CommerceOmsMixedCurrencyTotalsError(currencies);
  const amountMinor = paidOrders.reduce((sum, order) => sum + order.total.amountMinor, 0);
  const orderCount = paidOrders.length;
  // No paid order means no order named a currency, so the platform default is
  // the only honest label for a zero total - and it is read from one module.
  const currency = currencies[0] ?? PLATFORM_DEFAULT_CURRENCY;
  return {
    gmv: { amountMinor, currency },
    aov: { amountMinor: orderCount > 0 ? Math.round(amountMinor / orderCount) : 0, currency },
    orderCount,
    paidSubscriptionCycleCount: paidOrders.filter((order) => order.mode === "subscription_cycle").length,
  };
}
