import type { StoreConfig } from '../shared/config.ts';
import { catalogDefinitionDigest, type CatalogPublicationTransactions } from '@openlup/platform/catalog';
import type { CatalogProductTypeRegistry } from '@openlup/platform/catalog/contracts';
import * as owned from '../owned/catalogue.ts';
import { configurations, defaultConfigurationId } from '../owned/store.config.ts';
import type { StarterCatalogueRegistry } from './catalogue-registry.ts';
import { isRecord } from '../shared/offer.ts';
import type { StarterCatalogueOptions } from './catalogue-binding.ts';

type Registered = ReturnType<StarterCatalogueRegistry['select']>;
type Legacy = Omit<Registered, 'pack' | 'scope'> & { pack: null; scope: null };
const authored = owned as Partial<{ starterCatalogue: StarterCatalogueRegistry; catalogDraftRegistry: CatalogProductTypeRegistry;
  bindCatalogue(selection: Registered | Legacy, transactions: CatalogPublicationTransactions): StarterCatalogueOptions | Promise<StarterCatalogueOptions> }>;

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

/** Invoke for explicit host opt-in and only for the selected registry entry. */
export function bindRegisteredCatalogue(selection: StarterCatalogueSelection, transactions: CatalogPublicationTransactions,
  enabled?: true, bind?: typeof authored.bindCatalogue): Promise<StarterCatalogueOptions>;
export function bindRegisteredCatalogue(selection: StarterCatalogueSelection, transactions: CatalogPublicationTransactions,
  enabled: boolean, bind?: typeof authored.bindCatalogue): Promise<StarterCatalogueOptions | undefined>;
export async function bindRegisteredCatalogue(selection: StarterCatalogueSelection, transactions: CatalogPublicationTransactions,
  enabled = true, bind = authored.bindCatalogue): Promise<StarterCatalogueOptions | undefined> {
  if (!enabled) return;
  if (!bind || !selection.pack || !selection.scope) throw new Error('starter_catalogue_registration_invalid');
  const options = await bind(selection, transactions);
  if (options.registration !== selection) throw new Error('starter_catalogue_registration_invalid');
  const publish = selection.pack.capabilities.publish !== false;
  const selectedType = selection.draftType;
  async function installedType(db: import('@openlup/platform/data').PgQueryExecutor, ref: typeof selectedType) {
    const type = selection.types.resolve(ref);
    if (!type) return false;
    const { rows } = await db.query(`SELECT definition_digest FROM public.catalog_type_versions
      WHERE type_key=$1 AND version=$2`, [type.key, type.version]);
    return rows.length === 1 && rows[0]?.definition_digest === catalogDefinitionDigest(type);
  }
  return {
    ...options,
    writerEnabled: () => publish,
    ...(publish && { observePublication: db => installedType(db, selectedType) }),
    publication: publish ? {
      ...options.publication,
      async bindHumanTransaction(db, actorId) {
        await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),
          set_config('request.jwt.claims',jsonb_build_object('sub',$1::text,'role','authenticated')::text,true)`, [actorId]);
      },
      async readiness(db, { product }) {
        const ready = await installedType(db, product.type);
        return { ready, reasons: ready ? [] : ['catalog_definition_drift'] };
      },
      async globalReadiness(db) {
        const value = (await db.query('SELECT public.commerce_offer_policy_v2_readiness() AS evidence')).rows[0]?.evidence;
        if (!isRecord(value) || typeof value.ready !== 'boolean' || !Array.isArray(value.reasons)
          || !value.reasons.every(reason => typeof reason === 'string')) throw new Error('catalog_publication_readiness_unavailable');
        return { ready: value.ready, reasons: value.reasons as string[] };
      },
    } : options.publication,
  };
}
