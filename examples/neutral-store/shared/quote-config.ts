/** Application values; protocols and money algorithms remain package-owned. */
export interface QuoteConfiguration {
  policy: { revisionNo: number; effectiveFrom: string; channel: 'D2C' };
  document: { schemaId: string; revisionNo: number; sourceRef: string };
  acquisition: {
    revision: string; label: string; enabled: boolean; effectiveFrom: string; effectiveTo: string | null;
    initialDiscountBps: number; delivery2DiscountBps: number; minimumProductPayableMinor: number;
    graduationCadenceDays: number;
  };
}

export function assertQuoteConfiguration(config: QuoteConfiguration, cadences: readonly number[]): void {
  const { policy, document, acquisition: offer } = config;
  if (policy.channel !== 'D2C' || !Number.isSafeInteger(policy.revisionNo) || policy.revisionNo < 1
    || !Number.isFinite(Date.parse(policy.effectiveFrom)) || !document.schemaId.trim() || !document.sourceRef.trim()
    || !Number.isSafeInteger(document.revisionNo) || document.revisionNo < 1
    || !offer.revision.trim() || !offer.label.trim() || typeof offer.enabled !== 'boolean'
    || !Number.isFinite(Date.parse(offer.effectiveFrom))
    || (offer.effectiveTo !== null && (!Number.isFinite(Date.parse(offer.effectiveTo)) || Date.parse(offer.effectiveTo) <= Date.parse(offer.effectiveFrom)))
    || !Number.isSafeInteger(offer.initialDiscountBps) || offer.initialDiscountBps <= 0 || offer.initialDiscountBps >= 10000
    || !Number.isSafeInteger(offer.delivery2DiscountBps) || offer.delivery2DiscountBps < 0 || offer.delivery2DiscountBps > 10000
    || !Number.isSafeInteger(offer.minimumProductPayableMinor) || offer.minimumProductPayableMinor < 1
    || !cadences.includes(offer.graduationCadenceDays)) throw new Error('starter_quote_configuration_invalid');
}
