import { canonicalCatalogDraftJson, type CatalogProductTypeInput, type CatalogPublicationTransactions } from '@openlup/platform/catalog';
import type { CatalogPackInput } from '@openlup/platform/catalog/contracts';
import { createStarterCatalogueRegistry } from '../host/catalogue-registry.ts';
import { configurations, defaultConfigurationId } from './store.config.ts';
import type { StarterCatalogueSelection } from '../host/catalogue-selection.ts';
import type { StarterCatalogueOptions } from '../host/catalogue-binding.ts';
import { itemType, pack as supplements } from './catalog-packs/supplements/pack.ts';
import { fixtures, requiredChecks } from './catalog-packs/supplements/fixtures.ts';
import { offerVersion } from './catalog-packs/supplements/catalogue.ts';
import { policy } from './catalog-packs/supplements/policy.ts';

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

const supplementConfiguration = { ...configurations.supplements!, id: 'supplements-pack' };

export const starterCatalogue = createStarterCatalogueRegistry([
  { get configuration() { return configurations.supplements!; }, pack: demonstrationPack, draftType, offerVersion: 'classic' },
  { get configuration() { return configurations.coffee!; }, pack: demonstrationPack, draftType, offerVersion: 'classic' },
  { configuration: supplementConfiguration, pack: supplements, draftType: itemType, offerVersion, explicitOnly: true },
], defaultConfigurationId);

export const catalogueConformance = {
  packs: [{ pack: starterCatalogue.select(supplementConfiguration.id).pack, ...fixtures }],
  requiredChecks,
};

/** The explicit fixture selection seats the read lane with the host's verified runtime transaction. */
export function bindCatalogue(selection: StarterCatalogueSelection, transactions: CatalogPublicationTransactions): StarterCatalogueOptions {
  if (selection !== starterCatalogue.select(supplementConfiguration.id)) throw new Error('starter_catalogue_registration_invalid');
  return {
    registration: selection,
    readEnabled: () => true,
    writerEnabled: () => false,
    profilePolicies: [policy],
    publication: {
      transactions,
      rules: {
        canonicalizeDocument: canonicalCatalogDraftJson,
        validateProduct: product => supplements.types[0].validateContent(product.content).map(issue => issue.code),
        deriveSkuFacts: () => ({}),
        classifySkuChange: () => 'inconclusive',
      },
      readiness: async () => ({ ready: false, reasons: ['catalog_capability_unsupported'] }),
      verifyMedia: async () => false,
    },
  };
}
