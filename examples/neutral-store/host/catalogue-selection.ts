import type { StoreConfig } from '../shared/config.ts';
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
  const entry = (configuration: StoreConfig): Legacy => ({ configuration, types, draftType, pack: null, scope: null });
  return {
    list: () => Object.values(configurations).map(entry),
    select(id: string = defaultConfigurationId) {
      const configuration = Object.hasOwn(configurations, id) ? configurations[id] : undefined;
      if (configuration?.id !== id) throw new Error('starter_configuration_unknown');
      return entry(configuration);
    },
  };
}

function registeredCatalogue() {
  if (!Object.hasOwn(authored, 'starterCatalogue')) return retainedRegistry(authored.catalogDraftRegistry);
  const registry = authored.starterCatalogue;
  if (typeof registry?.list !== 'function' || typeof registry.select !== 'function') throw new Error('starter_catalogue_registration_invalid');
  return registry;
}

export const starterCatalogue = registeredCatalogue();
export type StarterCatalogueSelection = ReturnType<typeof starterCatalogue.select>;
export const selectCatalogueConfiguration = (id?: string) => starterCatalogue.select(id).configuration;
