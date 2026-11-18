import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { starterCatalogue, selectCatalogueConfiguration } from '../host/catalogue-selection.ts';
import { createStarterCatalogueRegistry } from '../host/catalogue-registry.ts';
import { installStarterCatalogueDefinitions } from '../installation/install.ts';
import { starterQuoteCatalogue } from '../host/editor-catalogue.ts';

for (const entry of starterCatalogue.list()) test(`MC5-N-005 ${entry.configuration.id} drives boot, authoring, install and read composition`, async () => {
  const { configuration, draftType } = entry;
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
  assert.equal(selectCatalogueConfiguration(configuration.id), configuration);
  assert.equal(starterQuoteCatalogue(executor, configuration).registration, entry);
  assert.ok(entry.types.resolve(draftType)?.netContentUnits.includes('openlup:g'));
  assert.ok(entry.types.resolve({ key: draftType.key, version: 1 }));
  await installStarterCatalogueDefinitions(executor, configuration.id);
  assert.deepEqual(queries, ['SELECT public.catalog_definition_install($1::text, $2::integer, $3::jsonb) AS receipt']);
  assert.throws(() => installStarterCatalogueDefinitions(executor, 'unregistered'), { message: 'starter_configuration_unknown' });
  assert.throws(() => createStarterCatalogueRegistry([{ ...entry, offerVersion: scope.offerVersion }, { ...entry, offerVersion: scope.offerVersion }], configuration.id),
    { message: 'starter_catalogue_registration_invalid' });
});
