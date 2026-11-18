import type { CatalogProductTypeRegistry } from '@openlup/platform/catalog/contracts';
import * as owned from '../owned/catalogue.ts';
import { configurations, defaultConfigurationId } from '../owned/store.config.ts';
import type { StarterCatalogueRegistry } from './catalogue-registry.ts';

type Registered = ReturnType<StarterCatalogueRegistry['select']>;
type Legacy = Omit<Registered, 'pack' | 'scope'> & { pack: null; scope: null };
const authored = owned as Partial<{ starterCatalogue: StarterCatalogueRegistry; catalogDraftRegistry: CatalogProductTypeRegistry }>;

/** A managed-file upgrade retains the predecessor's owned draft API until its explicit migration. */
function retainedRegistry(types: CatalogProductTypeRegistry | undefined) {
  const draftType = { key: 'starter:item', version: 1 };
  if (!types?.resolve(draftType)) throw new Error('starter_catalogue_upgrade_required');
  const entries = new Map(Object.values(configurations).map(configuration => [configuration.id,
    { configuration, types, draftType, pack: null, scope: null } satisfies Legacy]));
  return {
    list: () => [...entries.values()],
    select(id: string = defaultConfigurationId) {
      const entry = entries.get(id);
      if (!entry) throw new Error('starter_configuration_unknown');
      return entry;
    },
  };
}

export const starterCatalogue = authored.starterCatalogue ?? retainedRegistry(authored.catalogDraftRegistry);
export type StarterCatalogueSelection = ReturnType<typeof starterCatalogue.select>;
export const selectCatalogueConfiguration = (id?: string) => starterCatalogue.select(id).configuration;
