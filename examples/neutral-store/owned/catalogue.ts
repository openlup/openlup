import type { CatalogProductTypeInput } from '@openlup/platform/catalog';

/** Fictional draft type shared by the two starter configurations. */
export const catalogDraftType = {
  key: 'starter:item', version: 1, dimensions: [],
  units: [{ code: 'starter:each', dimension: 'count', integral: true,
    factor: { canonicalUnit: 'openlup:piece', unscaled: '1', scale: 0 } }],
  netContentUnits: ['starter:each'],
} satisfies Omit<CatalogProductTypeInput, 'validateContent'>;
