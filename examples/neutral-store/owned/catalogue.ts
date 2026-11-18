import { createCatalogProductTypeRegistry, type CatalogProductTypeInput } from '@openlup/platform/catalog';
import { itemType, pack as supplements } from './catalog-packs/supplements/pack.ts';
import { fixtures, requiredChecks } from './catalog-packs/supplements/fixtures.ts';
import { offerVersion } from './catalog-packs/supplements/catalogue.ts';

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

/** Registration inputs for a host that explicitly selects the sample catalogue. */
export const supplementsCatalogueRegistration = { pack: supplements, draftType: itemType, offerVersion } as const;
export const catalogueConformance = { packs: [{ pack: supplementsCatalogueRegistration.pack, ...fixtures }], requiredChecks };
