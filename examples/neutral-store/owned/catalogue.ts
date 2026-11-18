import type { CatalogProductTypeInput } from '@openlup/platform/catalog';
import type { CatalogPackInput } from '@openlup/platform/catalog/contracts';
import { createStarterCatalogueRegistry } from '../host/catalogue-registry.ts';
import { configurations, defaultConfigurationId } from './store.config.ts';

const validateContent: CatalogProductTypeInput['validateContent'] = content => content !== null && typeof content === 'object'
  && 'title' in content && typeof content.title === 'string' && content.title.trim()
  ? [] : [{ path: 'title', code: 'title_required' }];
const validatorRef = 'sha256:3833a12b67f874c6d23ef91ffd9924b6141d3aa03b96363bc7ca63aa290d2230';
const legacyType: CatalogProductTypeInput = {
  key: 'starter:item', version: 1, dimensions: [],
  units: [{ code: 'starter:each', dimension: 'count', integral: true }], netContentUnits: ['starter:each'],
  validatorRef, validateContent,
};
const draftType: CatalogProductTypeInput = {
  key: legacyType.key, version: 2, dimensions: [],
  units: [{ code: 'openlup:g', dimension: 'mass', integral: false }], netContentUnits: ['openlup:g'],
  validatorRef, validateContent,
};
const demonstrationPack: CatalogPackInput = {
  id: 'starter:demonstration', namespace: 'starter', version: 1, openlupRange: '0.43.x',
  capabilities: { publish: false }, types: [legacyType, draftType], taxClasses: [],
};

export const starterCatalogue = createStarterCatalogueRegistry([
  { configuration: configurations.supplements!, pack: demonstrationPack, draftType, offerVersion: 'classic' },
  { configuration: configurations.coffee!, pack: demonstrationPack, draftType, offerVersion: 'classic' },
], defaultConfigurationId);
