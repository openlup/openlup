/** @experimental Informational catalogue entries owned by pricing. */
export const pricingSettingBoundaries: readonly (readonly [key: string, kind: "cap" | "invariant", goal: string, reason: string])[] = [
  ["currencyExponent", "cap", "Format money using the currency exponent.", "Some starter views assume two decimal places. The platform already provides a currency-aware formatter."],
  ["salesChannels", "cap", "Choose a sales channel for strict quotes and price lists.", "The native strict quote and base-price writer currently use one fixed channel."],
  ["mixedTaxRates", "cap", "Quote a basket with mixed tax rates.", "The strict quote contract rejects mixed tax rates in one quote."],
  ["quantityPriceBreaks", "cap", "Apply quantity price breaks in a strict quote.", "The native strict quote selects base prices only."],
  ["subscriptionPriceRounding", "cap", "Select the subscription price rounding rule.", "The current subscription price policy rounds down to the configured quantum."],
  ["indivisibleOfferTotals", "cap", "Quote an offer total that cannot be divided evenly by quantity.", "The offer pricing contract needs an allocation that reconciles each line."],
  ["reconciledQuoteLines", "invariant", "Keep line totals equal to unit price times quantity in the same currency.", "Financial evidence must reconcile."],
];
