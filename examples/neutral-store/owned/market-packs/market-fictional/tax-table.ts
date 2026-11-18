/** Dated sandbox input owned by the fictional market. */
export const marketFixture = {
  country: 'ZZ',
  currency: 'XTS',
  currencyExponent: 2,
  rates: [{ taxClass: 'reduced-supplement', rateBps: 0, from: '2026-01-01', until: '2027-01-01' }],
} as const;
