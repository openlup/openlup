import { createCatalogProductTypeRegistry } from '@openlup/platform/catalog';

/** Fictional authoring type, shared by both configurations; no publication authority. */
export const catalogDraftRegistry = createCatalogProductTypeRegistry([{
  key: 'starter:item', version: 1, dimensions: [],
  units: [{ code: 'starter:each', dimension: 'count', integral: true }],
  netContentUnits: ['starter:each'],
  validateContent: content => content !== null && typeof content === 'object'
    && 'title' in content && typeof content.title === 'string' && content.title.trim()
    ? [] : [{ path: 'title', code: 'title_required' }],
}]);
