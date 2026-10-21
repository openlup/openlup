// A single neutral settlement fixture with the same amounts, tax rate and floor.
export function readSettlementProfile() {
  return {
    defaultCurrency: "XXX", acceptedCurrencies: ["XXX"], exponent: 2,
    regionCode: "ZZ", minimumProductPayableMinor: 100,
    fiscalProfile: { included: true as const, country: "ZZ", category: "example_category", vatRateBps: 800, legalBasis: "Example VAT rule" },
  };
}
