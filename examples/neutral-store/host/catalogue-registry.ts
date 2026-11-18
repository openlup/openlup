import { createCatalogProductTypeRegistry, type CatalogServingScopeV2 } from '@openlup/platform/catalog';
import type { CatalogPackInput } from '@openlup/platform/catalog/contracts';
import type { StoreConfig } from '../shared/config.ts';

export interface StarterCatalogueRegistration {
  configuration: StoreConfig;
  pack: CatalogPackInput;
  draftType: CatalogServingScopeV2['types'][number];
  offerVersion: string;
  explicitOnly?: true;
}

export function createStarterCatalogueRegistry(registrations: readonly StarterCatalogueRegistration[], defaultId: string) {
  const entries = new Map(registrations.map(registration => {
    const { configuration, pack, draftType, offerVersion, explicitOnly } = registration;
    if (!configuration?.id || !offerVersion || offerVersion.length > 240 || offerVersion.trim() !== offerVersion) {
      throw new Error('starter_catalogue_registration_invalid');
    }
    const types = createCatalogProductTypeRegistry(pack.types);
    if (!types.resolve(draftType)) throw new Error('starter_catalogue_registration_invalid');
    const type = { key: draftType.key, version: draftType.version };
    const id = configuration.id;
    return [id, { get configuration() {
      const selected = registration.configuration;
      if (selected?.id !== id) throw new Error('starter_catalogue_registration_invalid');
      return selected;
    }, pack, types, draftType: type, ...(explicitOnly && { explicitOnly }),
      scope: { types: [type], offerVersion } satisfies CatalogServingScopeV2 }];
  }));
  if (entries.size !== registrations.length || !entries.has(defaultId)) throw new Error('starter_catalogue_registration_invalid');
  return {
    list: () => [...entries.values()],
    select(id: string = defaultId) {
      const entry = entries.get(id);
      if (!entry) throw new Error('starter_configuration_unknown');
      return entry;
    },
  };
}

export type StarterCatalogueRegistry = ReturnType<typeof createStarterCatalogueRegistry>;
