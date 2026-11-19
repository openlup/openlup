import { catalogPackIssues, createCatalogProductTypeRegistry, type CatalogServingScopeV2 } from '@openlup/platform/catalog';
import type { CatalogPackInput } from '@openlup/platform/catalog/contracts';
import { createPostgresCommercePriceAuthorityReadPort } from '@openlup/platform/commerce/server/postgres';
import type { StoreConfig } from '../shared/config.ts';

export interface StarterCatalogueRegistration {
  /** Supply the ID separately when resolving the configuration should wait for selection. */
  configurationId?: string;
  configuration: StoreConfig;
  pack: CatalogPackInput;
  draftType: CatalogServingScopeV2['types'][number];
  offerVersion: string;
  explicitOnly?: true;
}

export function createStarterCatalogueRegistry(registrations: readonly StarterCatalogueRegistration[], defaultId: string) {
  const entries = new Map(registrations.map(registration => {
    if (!registration || typeof registration !== 'object') throw new Error('starter_catalogue_registration_invalid');
    const { configurationId, pack, draftType, offerVersion, explicitOnly } = registration;
    const id = configurationId === undefined ? registration.configuration?.id : configurationId;
    if (typeof id !== 'string' || id.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)
      || typeof offerVersion !== 'string' || !offerVersion || offerVersion.length > 240 || offerVersion.trim() !== offerVersion
      || !draftType || catalogPackIssues(pack).length) {
      throw new Error('starter_catalogue_registration_invalid');
    }
    const types = createCatalogProductTypeRegistry(pack.types);
    if (!types.resolve(draftType)) throw new Error('starter_catalogue_registration_invalid');
    const type = { key: draftType.key, version: draftType.version };
    const current = () => {
      const selected = registration.configuration;
      if (selected?.id !== id) throw new Error('starter_catalogue_registration_invalid');
      return selected;
    };
    return [id, { get configuration() { return current(); }, pack, types, draftType: type, ...(explicitOnly && { explicitOnly }),
      get scope(): CatalogServingScopeV2 {
        const { country, currency } = current().market;
        return { types: [type], offerVersion, priceContext: {
          regionCode: country, currency, channel: 'D2C', readPrices: createPostgresCommercePriceAuthorityReadPort,
        } };
      } }];
  }));
  if (entries.size !== registrations.length || !entries.has(defaultId)) throw new Error('starter_catalogue_registration_invalid');
  return {
    list: () => [...entries.values()],
    select(id: string = defaultId) {
      const entry = entries.get(id);
      if (!entry) throw new Error('starter_configuration_unknown');
      // Resolve the selected configuration and validate its ID against the registration.
      void entry.configuration;
      return entry;
    },
  };
}

export type StarterCatalogueRegistry = ReturnType<typeof createStarterCatalogueRegistry>;
