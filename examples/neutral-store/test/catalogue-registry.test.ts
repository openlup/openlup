import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { configurations } from '../owned/store.config.ts';
import { starterCatalogue, selectCatalogueConfiguration } from '../host/catalogue-selection.ts';
import { createStarterCatalogueRegistry } from '../host/catalogue-registry.ts';
import { installStarterCatalogueDefinitions } from '../installation/install.ts';
import { starterQuoteCatalogue } from '../host/editor-catalogue.ts';
import { catalogPackIssues } from '@openlup/platform/catalog';
import type { StarterCatalogueRegistration } from '../host/catalogue-registry.ts';

const articleType = { key: 'synthetic:article', version: 1, dimensions: [],
  units: [{ code: 'openlup:piece', dimension: 'count' as const, integral: true }], netContentUnits: ['openlup:piece'],
  validatorRef: `sha256:${'a'.repeat(64)}`, validateContent: () => [] };

for (const trial of ['valid', 'invalid pack', 'duplicate configuration', 'unknown configuration'] as const) {
  test(`G1-D1 starter registry admits one independent registration: ${trial}`, () => {
    const source = starterCatalogue.select().configuration;
    const first: StarterCatalogueRegistration = { configuration: source,
      pack: { id: 'starter:test', namespace: 'starter', version: 1, openlupRange: '0.43.x', capabilities: {}, taxClasses: [],
        types: [{ ...articleType, key: 'starter:test' }] }, draftType: { key: 'starter:test', version: 1 }, offerVersion: 'classic' };
    const second: StarterCatalogueRegistration = { configuration: { ...source, id: trial === 'duplicate configuration' ? source.id : 'synthetic-articles' },
      pack: { id: 'synthetic:articles', namespace: trial === 'invalid pack' ? 'unrelated' : 'synthetic', version: 1,
        openlupRange: '0.43.x', capabilities: {}, taxClasses: [], types: [articleType] }, draftType: articleType, offerVersion: 'synthetic:offer' };
    const register = () => createStarterCatalogueRegistry([first, second], first.configuration.id);
    if (trial === 'invalid pack' || trial === 'duplicate configuration') {
      if (trial === 'invalid pack') assert.equal(catalogPackIssues(second.pack)[0]?.code, 'pack_type_namespace_mismatch');
      assert.throws(register, { message: 'starter_catalogue_registration_invalid' });
      return;
    }
    const registry = register();
    if (trial === 'unknown configuration') {
      assert.throws(() => registry.select('absent'), { message: 'starter_configuration_unknown' });
      return;
    }
    assert.deepEqual(catalogPackIssues(second.pack), []);
    assert.equal(registry.select(second.configuration.id).pack, second.pack);
    assert.equal(registry.select(second.configuration.id).types.resolve(articleType)?.key, articleType.key);
  });
}

for (const entry of starterCatalogue.list()) test(`MC5-N-005 ${entry.configuration.id} drives boot, authoring, install and read composition`, async () => {
  const { configuration, draftType } = entry;
  assert.equal(selectCatalogueConfiguration(configuration.id), configuration);
  const replacement = structuredClone(configuration);
  replacement.offer.shippingMinor++;
  try {
    configurations[configuration.id] = replacement;
    assert.equal(selectCatalogueConfiguration(configuration.id), replacement);
  } finally { configurations[configuration.id] = configuration; }
  if (entry.pack === null) {
    assert.equal(entry.scope, null);
    assert.ok(entry.types.resolve(draftType)?.netContentUnits.includes('starter:each'));
    assert.throws(() => installStarterCatalogueDefinitions({ async query() { throw new Error('unexpected SQL'); } }, configuration.id),
      { message: 'starter_catalogue_upgrade_required' });
    return;
  }
  const { pack, scope } = entry;
  const queries: string[] = [];
  const executor = { async query(sql: string, values?: unknown[]) {
    queries.push(sql);
    const payload = JSON.parse(String(values?.[2]));
    const manifest = JSON.parse(payload.manifest);
    assert.equal(manifest.id, pack.id);
    assert.deepEqual(manifest.types.map(({ key, version }: { key: string; version: number }) => [key, version]),
      pack.types.map(type => [type.key, type.version]));
    return { rows: [{ receipt: { manifestDigest: createHash('sha256').update(payload.manifest).digest('hex') } }] };
  } };
  assert.equal(starterQuoteCatalogue(executor, configuration, entry).registration, entry);
  const explicitConfig = { ...configuration, id: 'programmatic' };
  assert.equal(starterQuoteCatalogue(executor, explicitConfig).registration, undefined);
  assert.throws(() => starterQuoteCatalogue(executor, explicitConfig, entry), { message: 'starter_catalogue_registration_invalid' });
  assert.ok(entry.types.resolve(draftType)?.netContentUnits.includes('openlup:g'));
  assert.ok(entry.types.resolve({ key: draftType.key, version: 1 }));
  await installStarterCatalogueDefinitions(executor, configuration.id);
  assert.deepEqual(queries, ['SELECT public.catalog_definition_install($1::text, $2::integer, $3::jsonb) AS receipt']);
  assert.throws(() => installStarterCatalogueDefinitions(executor, 'unregistered'), { message: 'starter_configuration_unknown' });
  assert.throws(() => createStarterCatalogueRegistry([{ ...entry, offerVersion: scope.offerVersion }, { ...entry, offerVersion: scope.offerVersion }], configuration.id),
    { message: 'starter_catalogue_registration_invalid' });
});
