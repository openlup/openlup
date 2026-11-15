import { createCatalogProductTypeRegistry, type CatalogProductTypeInput } from '@openlup/platform/catalog';

/** Fictional authoring type, shared by both configurations; no publication authority. */
const types: CatalogProductTypeInput[] = [{
  key: 'starter:item', version: 1, dimensions: [],
  units: [{ code: 'starter:each', dimension: 'count', integral: true }],
  netContentUnits: ['starter:each'],
  validateContent: content => content !== null && typeof content === 'object'
    && 'title' in content && typeof content.title === 'string' && content.title.trim()
    ? [] : [{ path: 'title', code: 'title_required' }],
}];
export const catalogDraftRegistry = createCatalogProductTypeRegistry(types);
export default { packs: [{ pack: { id: 'starter', namespace: 'starter', version: 1, openlupRange: '^0.44.0', capabilities: {}, taxClasses: [], types } }] };
