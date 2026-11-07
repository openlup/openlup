import type { QuoteConfiguration } from '../shared/quote-config.ts';

/** Fictional install inputs. An initialized policy is immutable; edits require a fresh demo. */
export const quoteConfigurations: Record<'supplements' | 'coffee', QuoteConfiguration> = {
  supplements: {
    policy: { revisionNo: 1, effectiveFrom: '2000-01-01T00:00:00.000Z', channel: 'D2C' },
    document: { schemaId: 'neutral-store-product.v1', revisionNo: 1, sourceRef: 'demonstration-catalogue-v1' },
    acquisition: { revision: 'demo-acquisition-v1', label: 'First subscription offer', enabled: true,
      effectiveFrom: '2000-01-01T00:00:00.000Z', effectiveTo: null,
      initialDiscountBps: 2400, delivery2DiscountBps: 1200, minimumProductPayableMinor: 1, graduationCadenceDays: 28 },
  },
  coffee: {
    policy: { revisionNo: 1, effectiveFrom: '2000-01-01T00:00:00.000Z', channel: 'D2C' },
    document: { schemaId: 'neutral-store-product.v1', revisionNo: 1, sourceRef: 'demonstration-catalogue-v1' },
    acquisition: { revision: 'demo-acquisition-v1', label: 'First subscription offer', enabled: true,
      effectiveFrom: '2000-01-01T00:00:00.000Z', effectiveTo: null,
      initialDiscountBps: 2400, delivery2DiscountBps: 1200, minimumProductPayableMinor: 1, graduationCadenceDays: 28 },
  },
};
