import type { CatalogProductTypeInput } from '@openlup/platform/catalog';

/** Fictional draft type shared by the two starter configurations. */
export const catalogDraftType = {
  key: 'starter:item', version: 1, dimensions: [],
  units: [{ code: 'starter:each', dimension: 'count', integral: true }],
  netContentUnits: ['starter:each'],
} satisfies Omit<CatalogProductTypeInput, 'validateContent'>;
