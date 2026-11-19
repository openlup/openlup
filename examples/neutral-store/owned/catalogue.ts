import { canonicalCatalogDraftJson, type CatalogProductTypeInput, type CatalogPublicationTransactions } from '@openlup/platform/catalog';
import { defineCatalogPack } from '@openlup/platform/catalog/contracts';
import { createStarterCatalogueRegistry, type StarterCatalogueRegistration } from '../host/catalogue-registry.ts';
import { configurations, defaultConfigurationId } from './store.config.ts';
import type { StarterCatalogueSelection } from '../host/catalogue-selection.ts';
import type { StarterCatalogueOptions } from '../host/catalogue-binding.ts';
import { demoIdentifier } from '../host/editor-catalogue.ts';
import type { StoreConfig } from '../shared/config.ts';
import { itemType, pack as supplements, swapGroupKey } from './catalog-packs/supplements/pack.ts';
import { requiredChecks, supplementsFixtures } from './catalog-packs/supplements/fixtures.ts';
import { offerVersion, supplementsCatalogue } from './catalog-packs/supplements/catalogue.ts';
import { demandFor, policy } from './catalog-packs/supplements/policy.ts';

const validateContent: CatalogProductTypeInput['validateContent'] = content => content !== null && typeof content === 'object'
  && 'title' in content && typeof content.title === 'string' && content.title.trim()
  ? [] : [{ path: 'title', code: 'title_required' }];
const validatorRef = 'sha256:3833a12b67f874c6d23ef91ffd9924b6141d3aa03b96363bc7ca63aa290d2230';
const legacyType = {
  key: 'starter:item', version: 1, dimensions: [],
  units: [{ code: 'starter:each', dimension: 'count', integral: true }], netContentUnits: ['starter:each'],
  validatorRef, validateContent,
} as const satisfies CatalogProductTypeInput;
const draftType = {
  key: legacyType.key, version: 2, dimensions: [],
  units: [{ code: 'openlup:g', dimension: 'mass', integral: false }], netContentUnits: ['openlup:g'],
  validatorRef, validateContent,
} as const satisfies CatalogProductTypeInput;
const demonstrationPack = defineCatalogPack({
  id: 'starter:demonstration', namespace: 'starter', version: 1, openlupRange: '0.43.x',
  capabilities: { publish: false }, types: [legacyType, draftType], taxClasses: [],
});

const supplementConfigurationId = 'supplements-pack';
let supplementConfiguration: StoreConfig | undefined;
const supplementRegistration: StarterCatalogueRegistration = {
  configurationId: supplementConfigurationId,
  get configuration() {
    if (supplementConfiguration) return supplementConfiguration;
    const demo = configurations.supplements;
    if (!demo) throw new Error('starter_catalogue_registration_invalid');
    supplementConfiguration = {
      ...demo,
      id: supplementConfigurationId,
      offer: { ...demo.offer, subscriptionDiscountBps: 0 },
      quote: { ...demo.quote, acquisition: {
        ...demo.quote.acquisition,
        // Both acquisition steps use the smallest engine-supported rate, which rounds to zero on this fixture.
        initialDiscountBps: 1,
        delivery2DiscountBps: 1,
      } },
    };
    return supplementConfiguration;
  },
  pack: supplements,
  draftType: itemType,
  offerVersion,
  explicitOnly: true,
};

export const starterCatalogue = createStarterCatalogueRegistry([
  { get configuration() { return configurations.supplements!; }, pack: demonstrationPack, draftType, offerVersion: 'classic' },
  { get configuration() { return configurations.coffee!; }, pack: demonstrationPack, draftType, offerVersion: 'classic' },
  ...(Object.hasOwn(configurations, 'supplements') ? [supplementRegistration] : []),
], defaultConfigurationId);

const priceListFor = (config: StoreConfig) => demoIdentifier(config, 'price-list', config.market.currency);

function requireSupplementSelection(selection: StarterCatalogueSelection) {
  if (selection.pack !== supplements || selection.configuration.id !== supplementConfigurationId
    || selection !== starterCatalogue.select(supplementConfigurationId)) {
    throw new Error('starter_catalogue_registration_invalid');
  }
}

/** Build the recipe for the explicit application configuration selected by the host. */
export function supplementsCatalogueFor(selection: StarterCatalogueSelection) {
  requireSupplementSelection(selection);
  return supplementsCatalogue(priceListFor(selection.configuration));
}

export const catalogueConformance = {
  get packs() {
    const selection = starterCatalogue.select(supplementConfigurationId);
    return [{ pack: selection.pack, ...supplementsFixtures(priceListFor(selection.configuration)).fixtures }];
  },
  requiredChecks,
};

/** The explicit fixture selection uses the host's verified runtime transaction. */
export function bindCatalogue(selection: StarterCatalogueSelection, transactions: CatalogPublicationTransactions): StarterCatalogueOptions {
  requireSupplementSelection(selection);
  return {
    registration: selection,
    readEnabled: () => true,
    writerEnabled: () => false,
    profilePolicies: [policy],
    profileLine(_line, { netContent }) {
      if (netContent.unit === 'supplements:capsule') {
        return { demand: demandFor('capsule', netContent), swapGroupKey };
      }
      if (netContent.unit === 'openlup:g') return { demand: demandFor('powder', netContent) };
      return {};
    },
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
