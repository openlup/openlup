import { createCatalogProductTypeRegistry, type CatalogProductTypeInput } from '@openlup/platform/catalog';

/** Fictional authoring type, shared by both configurations; no publication authority. */
const types: CatalogProductTypeInput[] = [{
  key: 'starter:item', version: 1, dimensions: [],
  units: [{ code: 'starter:each', dimension: 'count', integral: true,
    factor: { canonicalUnit: 'openlup:piece', unscaled: '1', scale: 0 } }],
  netContentUnits: ['starter:each'],
  validateContent: content => content !== null && typeof content === 'object'
    && 'title' in content && typeof content.title === 'string' && content.title.trim()
    ? [] : [{ path: 'title', code: 'title_required' }],
}];
export const catalogDraftRegistry = createCatalogProductTypeRegistry(types);
