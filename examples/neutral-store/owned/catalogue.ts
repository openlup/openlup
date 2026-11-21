import { createCatalogProductTypeRegistry, type CatalogPackInput, type CatalogProductTypeInput } from '@openlup/platform/catalog';

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
const pack = { id: 'starter', namespace: 'starter', version: 1, openlupRange: '1.x',
  types, capabilities: {}, taxClasses: [] } satisfies CatalogPackInput;

export const catalogueConformance = {
  packs: [{ pack, drafts: [{ schemaVersion: 1, product: {
    id: '00000000-0000-4000-8000-000000000001', type: { key: types[0]!.key, version: types[0]!.version },
    dimensions: [], sharedContent: { title: 'Example item' },
  }, skus: [] }] }],
  requiredChecks: ['draft-content'],
};

let registry: ReturnType<typeof createCatalogProductTypeRegistry> | undefined;
export const catalogDraftRegistry = {
  get resolve() {
    return (registry ??= createCatalogProductTypeRegistry(catalogueConformance.packs.flatMap(entry => entry.pack.types))).resolve;
  },
};
