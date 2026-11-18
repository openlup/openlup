import type { StoreConfig } from '../shared/config.ts';
import type { CatalogProductTypeRegistry } from '@openlup/platform/catalog/contracts';
import * as owned from '../owned/catalogue.ts';
import { configurations, defaultConfigurationId } from '../owned/store.config.ts';
import type { StarterCatalogueRegistry } from './catalogue-registry.ts';
import type { StarterCatalogueOptions } from './catalogue-binding.ts';

type Registered = ReturnType<StarterCatalogueRegistry['select']>;
type Legacy = Omit<Registered, 'pack' | 'scope'> & { pack: null; scope: null };
const authored = owned as Partial<{ starterCatalogue: StarterCatalogueRegistry; catalogDraftRegistry: CatalogProductTypeRegistry;
  bindCatalogue(selection: Registered | Legacy, databaseUrl: string): StarterCatalogueOptions | Promise<StarterCatalogueOptions> }>;

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

export const starterCatalogue = authored.starterCatalogue ?? retainedRegistry(authored.catalogDraftRegistry);
export type StarterCatalogueSelection = ReturnType<typeof starterCatalogue.select>;
export const selectCatalogueConfiguration = (id?: string) => starterCatalogue.select(id).configuration;

export async function bindRegisteredCatalogue(selection: StarterCatalogueSelection, databaseUrl: string): Promise<StarterCatalogueOptions> {
  if (!authored.bindCatalogue) throw new Error('starter_catalogue_registration_invalid');
  const options = await authored.bindCatalogue(selection, databaseUrl);
  if (options.registration !== selection) throw new Error('starter_catalogue_registration_invalid');
  return options;
}
