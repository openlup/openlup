import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCatalogReleaseDraftV3, canonicalCatalogDraftJson, catalogPackManifest, withCatalogPublicationRules,
  type CatalogDefinitionInstallReceipt, type CatalogPackInput } from '@openlup/platform/catalog';
import { configurations, selectConfiguration } from '../owned/store.config.ts';
import { readStarterDiagnostic, starterDiagnosticCode } from '../shared/refusals.ts';
import { assertConfig } from '../shared/config.ts';
import { catalogueConformance } from '../owned/catalogue.ts';
import { buildDemoSeed } from '../owned/demo-seed.ts';
import { editorProducts, readStarterCatalogueRules, stagePackBuild, starterCatalogue, starterCataloguePack } from '../host/editor-catalogue.ts';
import { acquisitionAddresses } from '../owned/acquisition-addresses.ts';
import { applyDemoSeed, demonstrationMarker, installDemonstration, provisionDemonstrationPublicationPassword,
  type DemonstrationInstallation } from '../installation/install.ts';
import { installationReport } from '../installation/refusals.ts';

const buildPacks = catalogueConformance.packs as { pack: CatalogPackInput; drafts: unknown[] }[];
test.beforeEach(context => {
  // Synthetic seeds add their own adopter packs. Keep the app's actual packs for the installed recipe.
  const declared = [...buildPacks];
  const starter = declared.filter(({ pack }) => pack.id === 'starter');
  if (starter.length === declared.length) return;
  buildPacks.splice(0, buildPacks.length, ...starter);
  assert.ok('after' in context);
  context.after(() => { buildPacks.splice(0, buildPacks.length, ...declared); });
});

test('publication provisioning sends a verifier and keeps the password in the private file', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'starter-publication-'));
  try {
    const path = resolve(directory, 'password');
    let statement = '';
    const password = await provisionDemonstrationPublicationPassword({ async query(sql) {
      statement = sql;
      return { rows: [] };
    } }, path);
    assert.equal((await readFile(path, 'utf8')).trim(), password);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(statement.includes(password), false);
    assert.ok(/^ALTER ROLE openlup_catalog_publication PASSWORD 'SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*'$/u.test(statement));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('container demo startup privately creates a key once, reuses it, and refuses a customer database', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(resolve(root, '.context'), { recursive: true });
  const directory = await mkdtemp(resolve(root, '.context/demo-start-'));
  try {
    for (const path of ['lifecycle.mjs', 'lifecycle-refusals.mjs', 'browser-groups.mjs', 'host', 'shared', 'owned', 'installation']) {
      await cp(resolve(root, path), resolve(directory, path), { recursive: true });
    }
    await writeFile(resolve(directory, 'package.json'), '{"type":"module"}');
    await mkdir(resolve(directory, 'node_modules/pg'), { recursive: true });
    await writeFile(resolve(directory, 'node_modules/pg/package.json'), '{"type":"module","exports":"./index.js"}');
    await writeFile(resolve(directory, 'node_modules/pg/index.js'), `import { readFileSync } from 'node:fs';
    export default { Client: class {
      async connect() {} async end() {}
      async query() { return { rows: [{ marker: JSON.parse(readFileSync(new URL('./marker.json', import.meta.url))) }] }; }
    } };`);
    // Observe the actual host handoff without starting HTTP or exposing the private value.
    await writeFile(resolve(directory, 'host/server.ts'), 'console.log(JSON.stringify(process.argv));');
    const argv = ['lifecycle.mjs', 'serve-demo', '--configuration', selectConfiguration().id, '--port', '4319',
      '--listen', '0.0.0.0', '--database-url', 'postgresql://starter_runtime@database/neutral_store'];
    async function start(marker: string) {
      await writeFile(resolve(directory, 'node_modules/pg/marker.json'), JSON.stringify(marker));
      const child = spawn(process.execPath, argv, { cwd: directory, stdio: 'pipe' });
      let output = '';
      child.stdout.on('data', bytes => { output += String(bytes); });
      child.stderr.on('data', bytes => { output += String(bytes); });
      return { code: (await once(child, 'exit'))[0], output };
    }
    const first = await start(demonstrationMarker);
    assert.equal(first.code, 0);
    const path = resolve(directory, '.context/quote-acceptance-keyring.json');
    const bytes = await readFile(path, 'utf8');
    const keyring = JSON.parse(bytes);
    assert.deepEqual(Object.keys(keyring), ['current']);
    assert.equal(typeof keyring.current, 'string');
    assert.ok(keyring.current.length >= 32);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(resolve(directory, '.context'))).mode & 0o777, 0o700);
    const hostArguments = JSON.parse(first.output);
    assert.equal(hostArguments[hostArguments.indexOf('--quote-acceptance-key-file') + 1], path);
    const restart = await start(demonstrationMarker);
    assert.equal(restart.code, 0);
    assert.equal(await readFile(path, 'utf8'), bytes);
    await writeFile(path, bytes + 'invalid');
    const corrupt = await start(demonstrationMarker);
    assert.equal(corrupt.code, 2);
    assert.equal(corrupt.output.trim(), 'starter_demo_start_failed');
    await writeFile(path, bytes);
    const customer = await start('customer-database');
    assert.equal(customer.code, 2);
    assert.equal(customer.output.trim(), 'starter_seed_demonstration_database_required');
    assert.equal(await readFile(path, 'utf8'), bytes);
    for (const output of [first.output, restart.output, corrupt.output, customer.output, JSON.stringify(argv)]) {
      assert.equal(output.includes(keyring.current), false);
    }
    await rm(resolve(directory, '.context'), { recursive: true });
    assert.equal((await start('customer-database')).code, 2);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const upsertPolicySetting = `INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
        ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`;
const installReminderSchedule = 'SELECT public.commerce_install_checkout_recovery_reminder_schedule($1::text, $2::jsonb)';

// The platform's PostgreSQL tests prove replace-on-conflict for the upsert.
// The second reminder statement belongs to the separately reviewed guard installer.
// That change's PostgreSQL tests prove replace-on-conflict for the guard call.
// A new installer statement needs a new entry in the corresponding list.
const inventoryProtectionStatements = [upsertPolicySetting];
const reminderScheduleStatements = [upsertPolicySetting, installReminderSchedule];

const seedPriceCount = (config: typeof configurations[string]) => editorProducts(config).reduce((sum, product) => sum + product.permittedPurchaseModes.length, 0);

function installation(identity = { login: 'demo_install', role: 'demo_install', marker: demonstrationMarker }) {
  const calls: Array<{ text: string; values: unknown[] | undefined }> = [];
  let closed = 0;
  const prices = new Map<string, Record<string, unknown>>();
  const stockCalls: unknown[] = [];
  const digests = new Map<string, unknown>();
  const policies = new Map<string, { id: unknown; digest: unknown }>();
  const promotions = new Map<string, Record<string, unknown>>();
  const binding: DemonstrationInstallation = {
    installRole: 'demo_install', runtimeRole: 'demo_runtime',
    stock: { async recordProviderStockCurrent(input) { stockCalls.push(input); return { replayed: false,readBack: true }; } },
    connection: { query: async (text, values) => {
      calls.push({ text, values });
      if (text.startsWith('SELECT public.catalog_definition_install')) {
        const { manifest } = JSON.parse(String(values?.[2]));
        const { id: packId, version: packVersion, types, subscriptionProfileDefinitions } = JSON.parse(manifest);
        return { rows: [{ receipt: { packId, packVersion, installedAt: '2000-01-01T00:00:00.000Z',
          manifestDigest: createHash('sha256').update(manifest).digest('hex'), types,
          ...(subscriptionProfileDefinitions === undefined ? {} : { canonicalManifest: manifest, subscriptionProfileDefinitions }) } }] };
      }
      if (text.startsWith('SELECT 1 FROM public.catalog_definition_installs')) return { rows: [] };
      if (text.startsWith('SELECT public.fulfillment_record_stock_current')) return { rows: [{ response: { status: 'recorded' } }] };
      if (text.startsWith('INSERT INTO public.subscription_price_policy_revisions') && values) { digests.set(String(values[0]), values[11]); policies.set(String(values[2]), { id: values[0],digest: values[11] }); }
      if (text.startsWith('SELECT id,digest')) return { rows: policies.has(String(values?.[0])) ? [policies.get(String(values?.[0]))!] : [] };
      if (text.startsWith('SELECT p.primary_sku_id')) return { rows: [{ primary_sku_id: null,current_document_revision_id: null,net_weight_g: 0 }] };
      if (text.startsWith('INSERT INTO public.catalog_product_document_revisions') && values) digests.set(String(values[0]), values[7]);
      if (text.startsWith('SELECT digest')) return { rows: [{ digest: digests.get(String(values?.[0])) }] };
      if (text.startsWith('INSERT INTO public.commerce_promotion_definitions') && values) promotions.set(String(values[0]), { definition: values[1], active: values[2] });
      if (text.startsWith('SELECT definition,active')) return { rows: [promotions.get(String(values?.[0]))!] };
      if (text.startsWith('INSERT INTO public.price_entries') && values) prices.set(String(values[0]),
        Object.fromEntries(['id','price_list_id','variant_id','mode','min_qty','unit_price_minor','amount_kind','active','valid_from'].map((key,i) => [key, values[i]])));
      if (text.startsWith('SELECT id, price_list_id')) return { rows: [prices.get(String(values?.[0]))!] };
      return { rows: text.startsWith('SELECT provenance')
        ? [{ provenance: acquisitionAddresses[0]!.addressReference.provenance, active: true }]
        : text.startsWith('SELECT') ? [identity] : [] };
    } },
    close: async () => { closed++; },
  };
  return { binding, calls, stockCalls, closed: () => closed };
}

test('local rules run before installation and derive an immutable product type on demo startup', async context => {
  const bytes = readStarterCatalogueRules();
  if (!bytes) return context.skip('This starter has kept its existing draft validator.');
  const root = fileURLToPath(new URL('../', import.meta.url));
  // Start a standalone invocation, without inheriting the parent Node test runner context.
  const output = execFileSync(process.execPath, ['--test', 'owned/catalogue-rules.test.cjs'],
    { cwd: root, env: {}, encoding: 'utf8' });
  assert.match(output, /pass 1\b/u);
  async function installed(bytes: Buffer) {
    const fixture = installation();
    fixture.binding.catalogueRules = bytes;
    const directory = await mkdtemp(resolve(tmpdir(), 'starter-catalogue-build-'));
    try {
      fixture.binding.catalogueBuildDirectory = directory;
      await installDemonstration(Object.values(configurations)[0]!, async () => fixture.binding);
      const install = fixture.calls.find(entry => entry.text.startsWith('SELECT public.catalog_definition_install'));
      assert.ok(install);
      const serialized = await readFile(resolve(directory, `${install.values?.[1]}.json`), 'utf8');
      const build = JSON.parse(serialized);
      const { validateContent: _validate, ...type } = starterCataloguePack(bytes).types[0]!;
      const installed = JSON.parse(JSON.parse(String(install.values?.[2])).manifest).types[0];
      assert.equal(serialized, canonicalCatalogDraftJson({ type, asset: bytes.toString('base64'), installed }));
      assert.equal(build.installed.version, install.values?.[1]);
      assert.equal(build.asset, bytes.toString('base64'));
    } finally { await rm(directory, { recursive: true, force: true }); }
    const call = fixture.calls.find(entry => entry.text.startsWith('SELECT public.catalog_definition_install'));
    assert.ok(call);
    const { types } = JSON.parse(String(call.values?.[2]));
    return JSON.parse(types[0].canonicalDefinition);
  }
  const first = await installed(bytes);
  assert.deepEqual(await installed(bytes), first);
  assert.equal(first.validatorRef, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  assert.ok(first.version > 1);
  assert.notEqual((await installed(Buffer.concat([bytes, Buffer.from('// Changed rules asset')]))).version, first.version);
});

test('operator_example_uses_builder', async context => {
  const bytes = readStarterCatalogueRules();
  if (!bytes) return context.skip('This starter has kept its existing draft validator.');
  const root = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(resolve(root, '.context'), { recursive: true });
  const directory = await mkdtemp(resolve(root, '.context/operator-example-'));
  try {
    for (const path of ['host', 'shared', 'owned']) await cp(resolve(root, path), resolve(directory, path), { recursive: true });
    const moduleUrl = pathToFileURL(resolve(directory, 'host/operator-composition.ts')).href;
    const { composeOperatorCapabilities }: typeof import('../host/operator-composition.ts') = await import(moduleUrl);
    const config = Object.values(configurations)[0]!;
    const request = { commandKey: 'example', config, actor: { operatorRef: 'operator', customerRef: null } };
    const fixture = installation();
    fixture.binding.catalogueRules = bytes;
    fixture.binding.catalogueBuildDirectory = resolve(directory, '.context/catalogue-builds');
    const version = starterCatalogue(fixture.binding.catalogueBuildDirectory).current!.version;
    async function example() {
      const composed = composeOperatorCapabilities({
        executor: { async query() { throw new Error('The example must not query the database'); } },
        connectionString: 'postgresql://localhost/example',
      });
      try { return await composed.actions['operator.catalogDrafts']!({ action: 'example' }, request); }
      finally { await composed.close?.(); }
    }
    assert.deepEqual(await example(), { ok: false, code: 'starter_catalogue_rules_required', issues: [
      { path: 'product.type', code: 'type_not_installed', message: `rules version ${version} is not installed; run ./lifecycle up` },
    ] });
    await installDemonstration(config, async () => fixture.binding);
    const installed = starterCatalogue(fixture.binding.catalogueBuildDirectory).readInstalled({ key: 'starter:item', version })!.type;
    const title = 'Fictional item';
    const { release } = buildCatalogReleaseDraftV3({ namespace: 'starter', type: { key: installed.key, version: installed.version },
      slug: 'fictional-item', name: title, presentation: { title }, skus: [
        { code: 'STARTER-EXAMPLE', title, options: {}, netContent: { dimension: 'mass', unit: 'openlup:g', unscaled: '100', scale: 0 },
          identifiers: [{ scheme: 'gs1:gtin', issuer: 'starter:example', value: '5901234123457', packagingLevel: 'unit' }],
          sell: { oneTime: true, subscription: false } },
      ] });
    assert.deepEqual(await example(), { ok: true, value: release.payload });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a retained build conflict rolls back definition installation before commit', async context => {
  const bytes = readStarterCatalogueRules();
  if (!bytes) return context.skip('This starter has kept its existing draft validator.');
  const directory = await mkdtemp(resolve(tmpdir(), 'starter-catalogue-conflict-'));
  try {
    const config = Object.values(configurations)[0]!;
    const first = installation();
    first.binding.catalogueRules = bytes;
    first.binding.catalogueBuildDirectory = directory;
    await installDemonstration(config, async () => first.binding);
    const change = first.calls.find(row => row.text.startsWith('SELECT public.catalog_definition_install'));
    assert.ok(change);
    const conflictingBuild = resolve(directory, `${change.values?.[1]}.json`);
    await writeFile(conflictingBuild, 'conflicting build');
    const retry = installation();
    retry.binding.catalogueRules = bytes;
    retry.binding.catalogueBuildDirectory = directory;
    await assert.rejects(installDemonstration(config, async () => retry.binding), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'EEXIST');
      assert.equal(error.message, 'starter_catalogue_build_conflict');
      return starterDiagnosticCode(error) === 'starter_catalogue_build_conflict';
    });
    assert.equal(retry.calls.at(-1)?.text, 'ROLLBACK');
    assert.ok(!retry.calls.some(row => row.text === 'COMMIT'));
    assert.equal(await readFile(conflictingBuild, 'utf8'), 'conflicting build');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a running reader exposes only committed rules builds across a failed commit', async context => {
  const bytes = readStarterCatalogueRules();
  if (!bytes) return context.skip('This starter has kept its existing draft validator.');
  const directory = await mkdtemp(resolve(tmpdir(), 'starter-catalogue-rollback-'));
  try {
    const config = Object.values(configurations)[0]!;
    const reader = starterCatalogue(directory);
    assert.ok(reader.current);
    const ref = reader.current;
    assert.equal(reader.readInstalled(ref), undefined);
    const fixture = installation();
    fixture.binding.catalogueRules = bytes;
    fixture.binding.catalogueBuildDirectory = directory;
    const query = fixture.binding.connection.query;
    const failure = new Error('synthetic commit failure');
    let target: string | undefined, committed = false;
    fixture.binding.connection.query = async (text, values) => {
      const result = await query(text, values);
      if (text.startsWith('SELECT public.catalog_definition_install')) target = resolve(directory, `${values?.[1]}.json`);
      if (text === 'COMMIT') {
        assert.ok(target);
        if (committed) assert.ok(reader.readInstalled(ref));
        else {
          await assert.rejects(stat(target), { code: 'ENOENT' });
          assert.equal(reader.readInstalled(ref), undefined);
          assert.equal(reader.registry.resolve(ref), undefined);
        }
        throw failure;
      }
      return result;
    };
    await assert.rejects(installDemonstration(config, async () => fixture.binding), infrastructureCause(failure));
    assert.equal(fixture.calls.at(-1)?.text, 'ROLLBACK');
    assert.ok(target);
    await assert.rejects(stat(target), { code: 'ENOENT' });
    assert.equal(reader.readInstalled(ref), undefined);
    const successful = installation();
    await installDemonstration(config, async () => ({ ...successful.binding, catalogueRules: bytes, catalogueBuildDirectory: directory }));
    const installed = await readFile(target);
    committed = true;
    assert.ok(reader.readInstalled(ref));
    await assert.rejects(installDemonstration(config, async () => fixture.binding), infrastructureCause(failure));
    assert.deepEqual(await readFile(target), installed);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


for (const config of Object.values(configurations)) {
  test(`${config.id}: fictional catalog and prices come from one configuration deterministically`, () => {
    const seed = buildDemoSeed(config);
    assert.deepEqual(buildDemoSeed(structuredClone(config)), seed);
    assert.equal(seed.products.length, new Set(editorProducts(config).map(product => product.groupKey)).size);
    assert.equal(seed.priceLists[0]!.currency, config.market.currency);
    const ids = [...seed.products, ...seed.skus, ...seed.priceLists, ...seed.prices].map(row => row.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const [index, product] of config.offer.products.entries()) {
      assert.equal(seed.products[index]!.name, product.name[config.market.defaultLocale]);
      assert.equal(seed.products[index]!.description, product.description[config.market.defaultLocale]);
      const sku = seed.skus.find(row => row.sku === product.sku)!;
      assert.equal(sku.product_id, seed.products[index]!.id);
      const oneTime = seed.prices.find(row => row.variant_id === sku.id && row.mode === 'one_time')!;
      assert.equal(oneTime.unit_price_minor, product.unitPrice.amountMinor);
      assert.equal(oneTime.price_list_id, seed.priceLists[0]!.id);
      assert.equal(seed.prices.filter(row => row.variant_id === sku.id).length, product.permittedPurchaseModes.length);
    }
    const changed = structuredClone(config);
    changed.offer.products[0]!.unitPrice.amountMinor++;
    const updated = buildDemoSeed(changed);
    assert.equal(updated.prices[0]!.id, seed.prices[0]!.id);
    assert.equal(updated.prices[0]!.unit_price_minor, seed.prices[0]!.unit_price_minor + 1);
  });

  test(`${config.id}: install composes one transactional idempotent catalogue and address registry seed and closes its connection`, async () => {
    const first = installation();
    let bootstraps = 0;
    await installDemonstration(config, async () => { bootstraps++; return first.binding; });
    assert.equal(bootstraps, 1);
    assert.equal(first.closed(), 1);
    assert.equal(first.calls[0]!.text, 'BEGIN ISOLATION LEVEL READ COMMITTED');
    assert.equal(first.calls.at(-1)!.text, 'COMMIT');
    for (const { text } of first.calls.slice(1, -1)) {
      assert.doesNotMatch(text, /\b(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END|SAVEPOINT|RELEASE|ABORT|PREPARE\s+TRANSACTION)\b/i);
    }
    const protection = first.calls.filter(call => call.values?.[0] === 'inventory_renewal_protection');
    const reminders = first.calls.filter(call => call.values?.[0] === 'checkout_recovery_reminders');
    const settlement = first.calls.filter(call => ['settlement_region', 'settlement_currency'].includes(String(call.values?.[0])));
    assert.deepEqual(settlement.map(call => call.values), [
      ['settlement_region', config.market.country], ['settlement_currency', config.market.currency],
    ]);
    const inserts = first.calls.filter(call => !protection.includes(call) && !reminders.includes(call)
      && !settlement.includes(call) && call.text.startsWith('INSERT INTO public.'));
    assert.equal(inserts.length, buildDemoSeed(config).products.length + buildDemoSeed(config).skus.length * 2 + buildDemoSeed(config).documents.length + buildDemoSeed(config).settings.length + seedPriceCount(config) + 3);
    for (const call of inserts) {
      assert.match(call.text, /ON CONFLICT/);
      assert.match(call.text, /INSERT INTO public\.(catalog_products|catalog_skus|price_lists|price_entries|catalog_product_document_revisions|catalog_sku_identifiers|commerce_settings|subscription_price_policy_revisions|commerce_promotion_definitions)\b/);
      assert.ok(call.values?.length);
    }
    for (const [calls, statements, value] of [
      [protection, inventoryProtectionStatements, config.inventory.renewalProtection],
      [reminders, reminderScheduleStatements, config.checkoutRecoveryReminders],
    ] as const) {
      assert.equal(calls.length, 1);
      const { text, values } = calls[0]!;
      assert.ok(statements.includes(text), 'policy installation must issue an allowed write');
      assert.equal(values?.length, 2);
      assert.deepEqual(JSON.parse(String(values?.[1])), value);
    }
    const registry = first.calls.filter(call => call.text.startsWith('INSERT INTO acquisition_private.'));
    assert.equal(registry.length, acquisitionAddresses.length);
    assert.match(registry[0]!.text, /\(source, reference, revision, provenance, active\)/);
    assert.match(registry[0]!.text, /ON CONFLICT \(source, reference, revision\) DO NOTHING/);
    assert.equal(first.calls.filter(call => call.text.startsWith('SELECT provenance')).length, acquisitionAddresses.length);
    const second = installation();
    await applyDemoSeed(config, second.binding);
    assert.deepEqual(second.calls, first.calls);
  });
}

// Captured from the shipped predecessor before changing the owned physical input.
type PredecessorVariant = readonly [skuId: string, sku: string,
  physical: { netWeightG: number; issuer: string; unitGtin: string }, demandPerUnit: number, exclusions: readonly string[]];
type PredecessorDocument = readonly [revisionId: string, productId: string, slug: string, digest: string,
  variants: readonly PredecessorVariant[]];

const supplementsDocuments: readonly PredecessorDocument[] = [
  [
    '4bb524d2-0029-5bb0-ad59-2683ffd47809', 'f4030056-e764-555d-a6d0-73447dd6b125', 'demo-supplements-dawn',
    '5f88dbaf973ba18dc89d7a9b3fc3d9e3e29189c80ebfd4414dda2c1c733ec858', [
      ['abc28ceb-4456-5701-a746-d504acee557a', 'ASTER-DAWN-60', { netWeightG: 250, unitGtin: '0000000000017', issuer: 'demo' }, 40, []],
      ['02a436dc-112f-598e-a88b-d917f215229e', 'ASTER-DAWN-60-L', { netWeightG: 500, issuer: 'starter:demo', unitGtin: '3511105362001' }, 80, []],
    ],
  ],
  [
    'c3e02131-3aff-5faf-a283-bedd90ff3c1e', '259a54d5-1152-5f5a-a418-57f4e39d6bf4', 'demo-supplements-noon',
    'a9e29cac35022c09c5fd1a629da4d4900ed6e13d5c9b4e1139b46e67b7b55221', [
      ['92a4a977-0457-5d65-aeea-a75ef3256a48', 'ASTER-NOON-60', { netWeightG: 250, unitGtin: '0000000000024', issuer: 'demo' }, 40, []],
      ['6c7a3072-af43-590b-a8b7-d7193536d09b', 'ASTER-NOON-60-L', { netWeightG: 500, issuer: 'starter:demo', unitGtin: '1441910664033' }, 80, []],
    ],
  ],
  [
    'f21b01d8-4384-5362-a4ca-404dbf687c8e', 'd5d1c8d6-84e0-529d-ae72-8925b2fddabc', 'demo-supplements-dusk',
    '0940621d19799179e92bc43da770cb6c7203b17c1b6eb69256a877cdf6a89522', [
      ['fb38d08c-07fb-5ff7-a133-e359daf206ec', 'ASTER-DUSK-30', { netWeightG: 250, unitGtin: '0000000000031', issuer: 'demo' }, 40, ['demo-restricted']],
      ['fde3789e-fbba-53da-a25e-8a77646a1a08', 'ASTER-DUSK-30-L', { netWeightG: 500, issuer: 'starter:demo', unitGtin: '3374757808057' }, 80, ['demo-restricted']],
    ],
  ],
  [
    '0fdd9fef-88f0-5dee-ad31-2c600debc7dd', '94a58685-d89d-561f-a8f7-beea1054cf3d', 'demo-supplements-dawn-extra',
    '47917635fe1b088a243de89e0bf66bc597055a92fec9b3f6a03028a5df46c59e', [
      ['65dd6a34-9d9e-5bc3-aad5-80b2f5735575', 'ASTER-DAWN-60-EXTRA', { netWeightG: 100, issuer: 'starter:demo', unitGtin: '1354016792848' }, 10, []],
    ],
  ],
];

const coffeeDocuments: readonly PredecessorDocument[] = [
  [
    '4659d826-df86-58b0-ae0d-eeeab9225950', '4645faf2-aa6b-536a-aeb9-4ad9e69c2e75', 'demo-coffee-light-roast',
    '840ff13d545f84c6932c43ba5eb2cc57f5a173588811c280d2b840d52bbb2dd1', [
      ['aa97fa15-f04f-5b88-ab0b-26b2633e7e0a', 'PEBBLE-LIGHT-250', { netWeightG: 250, unitGtin: '0000000000048', issuer: 'demo' }, 40, []],
      ['33469b16-5554-5ff4-adf8-4015e7db1d85', 'PEBBLE-LIGHT-250-L', { netWeightG: 500, issuer: 'starter:demo', unitGtin: '6815723410807' }, 80, []],
    ],
  ],
  [
    'b16da7cd-cc4d-59bd-ae28-acdec0e1137c', '0f09fde0-8e5e-5bbc-a3b1-12fd17ecd9c8', 'demo-coffee-medium-roast',
    '0eececab9bb3f78f429a7468d7f756a3833f56eaa5f59c7912d68e33447c184a', [
      ['8e48f4ff-8ac6-5dab-aef7-30c88e488352', 'PEBBLE-MEDIUM-250', { netWeightG: 250, unitGtin: '0000000000055', issuer: 'demo' }, 40, []],
      ['fc1eb207-f61b-5a9b-ad58-9cf46890d066', 'PEBBLE-MEDIUM-250-L', { netWeightG: 500, issuer: 'starter:demo', unitGtin: '3351248347431' }, 80, []],
    ],
  ],
  [
    '5cb40e17-d1af-5df1-a0db-a7334a96effc', '3d136f31-302a-5899-a58d-fb9c66e0236d', 'demo-coffee-dark-roast',
    '77d1ef008c77a7356e82561246ed63435e3d8d73fd3591bebadf9c01eff65238', [
      ['eb191375-ad2f-5833-a34c-9d6dab1acc0c', 'PEBBLE-DARK-250', { netWeightG: 250, unitGtin: '0000000000062', issuer: 'demo' }, 40, ['demo-restricted']],
      ['760bcff5-bfa2-5065-a853-cc69a2f5ca3a', 'PEBBLE-DARK-250-L', { netWeightG: 500, issuer: 'starter:demo', unitGtin: '1569102366975' }, 80, ['demo-restricted']],
    ],
  ],
  [
    'ad3461b4-211f-51d1-a209-374a11835880', 'cf7d9945-d0b4-5c2f-a128-a3006aff107b', 'demo-coffee-light-roast-extra',
    'e90df1599814272e89a419412372397a80e67237cb8f042d6691a2944fae3ff8', [
      ['90ddb9b6-7913-5b54-a0d1-04e0da2e2061', 'PEBBLE-LIGHT-250-EXTRA', { netWeightG: 100, issuer: 'starter:demo', unitGtin: '1925600957013' }, 10, []],
    ],
  ],
];

// The frozen bytes describe the shipped source fixtures. Extracted stores run the
// general seed contract against their own registry, even when they reuse an ID.
const extracted = fs.existsSync(new URL('../.starter-origin.json', import.meta.url));
for (const [id, retained] of [
  ['supplements', supplementsDocuments],
  ['coffee', coffeeDocuments],
] as const) {
  test(`${id}: installer preserves the predecessor's document payload and physical SQL arguments`, {
    skip: extracted && 'Frozen predecessor bytes cover the shipped source configuration.',
  }, async () => {
    const config = configurations[id]!;
    const { binding, calls } = installation();
    await applyDemoSeed(config, binding);
    const argsFor = (prefix: string) => calls.filter(({ text }) => text.startsWith(prefix)).map(({ values }) => values!);
    const documentArgs = retained.map(([revisionId, productId, productSlug, digest, rows]) => {
      const variants = rows.map(([skuId, sku, physical, demandPerUnit, exclusions]) =>
        ({ skuId, sku, physical, demandPerUnit, exclusions }));
      const document = { schemaVersion: 'neutral-store-product.v1', productId, productSlug, revisionNo: 1,
        sourceRef: 'demonstration-catalogue-v1', variants };
      return [revisionId, productId, 1, document.schemaVersion, `demo-document:${config.id}:${revisionId}`,
        document, document.sourceRef, digest];
    });
    const writes = argsFor('INSERT INTO public.catalog_product_document_revisions');
    assert.equal(writes.length, documentArgs.length);
    for (const [index, args] of documentArgs.entries()) {
      assert.deepEqual(writes[index], args);
      assert.equal(JSON.stringify(writes[index]![5]), JSON.stringify(args[5]));
    }
    assert.deepEqual(argsFor('UPDATE public.catalog_products SET primary_sku_id'),
      retained.map(([revisionId, productId, , , rows]) => [productId, rows[0]![0], revisionId]));
    assert.deepEqual(argsFor('UPDATE public.catalog_skus SET net_weight_g'),
      retained.flatMap(([, , , , rows]) => rows.map(([skuId, , { netWeightG }]) => [skuId, netWeightG])));
    assert.deepEqual(argsFor('INSERT INTO public.catalog_sku_identifiers'),
      retained.flatMap(([, , , , rows]) => rows.map(([skuId, , { issuer, unitGtin }]) => [skuId, issuer, unitGtin])));
  });
}

test('physical admission preserves canonical gram bounds, issuer bytes and identifier spelling', () => {
  const largestIssuer = 'a'.repeat(238) + '😀';
  for (const [grams, gtin] of [['1', '95010939'], ['2147483647', '0000000000017']]) {
    const config = structuredClone(selectConfiguration());
    const product = config.offer.products[0]!;
    product.physical.netContent.unscaled = grams!;
    product.physical.primaryUnitIdentifier = { scheme: 'gs1:gtin', issuer: largestIssuer, value: gtin! };
    config.subscriptionEditing.catalogue[1]!.physicalSize = 2_147_483_647;
    const variant = buildDemoSeed(config).documents[0]!.document.variants[0]!;
    assert.deepEqual(variant.physical, { netWeightG: Number(grams), unitGtin: gtin, issuer: largestIssuer });
    assert.equal(buildDemoSeed(config).documents[0]!.document.variants[1]!.physical.netWeightG, 2_147_483_647);
  }
});

test('refuses unsupported typed physical inputs before bootstrap, rules access or seed SQL', async () => {
  const productCode = 'OPENLUP_E_STARTER_PRODUCT_PHYSICAL_INVALID';
  const syntheticCode = 'OPENLUP_E_STARTER_SYNTHETIC_PHYSICAL_SIZE_INVALID';
  const fields: readonly [branch: 'netContent' | 'primaryUnitIdentifier', key: string, values: unknown[]][] = [
    ['netContent', 'unscaled', ['0', '1.5', 1, '2147483648', '01', '+1', '1e0', '1\n']],
    ['netContent', 'dimension', ['volume', 'count']],
    ['netContent', 'unit', ['openlup:kg', 'openlup:ml']],
    ['netContent', 'scale', [1, '0']],
    ['netContent', 'extra', [true]],
    ['primaryUnitIdentifier', 'scheme', ['example:gtin']],
    ['primaryUnitIdentifier', 'value', ['0000000000018', 'abc', 17]],
    ['primaryUnitIdentifier', 'issuer', ['', ' demo', 'demo ', 'a\u0000b', '\uD800', '\uDC00', 'a'.repeat(239) + '😀', 5]],
  ];
  const config = () => structuredClone(selectConfiguration());
  const cases = fields.flatMap(([branch, key, values]) => values.map(value => {
    const input = config();
    Reflect.set(input.offer.products[0]!.physical[branch]!, key, value);
    return { input, code: productCode, subject: input.offer.products[0]!.sku, path: 'offer.products[].physical' };
  }));
  for (const physical of [null, { netWeightG: 1, unitGtin: '0000000000017', issuer: 'demo' },
    { ...config().offer.products[0]!.physical, primaryUnitIdentifier: null }]) {
    const input = config();
    Reflect.set(input.offer.products[0]!, 'physical', physical);
    cases.push({ input, code: productCode, subject: input.offer.products[0]!.sku, path: 'offer.products[].physical' });
  }
  for (const value of [0, 1.5, '1', 2_147_483_648, Infinity, NaN]) {
    const input = config(), product = input.subscriptionEditing.catalogue[1]!;
    Reflect.set(product, 'physicalSize', value);
    cases.push({ input, code: syntheticCode, subject: product.sku, path: 'subscriptionEditing.catalogue[].physicalSize' });
  }
  for (const { input, code, subject, path } of cases) {
    const exact = (error: unknown) => {
      assert.equal(Object.getPrototypeOf(error), Error.prototype);
      assert.deepEqual(Reflect.ownKeys(error as object).filter(key => key !== 'stack'), ['message']);
      assert.equal((error as Error).message, code);
      const diagnostic = readStarterDiagnostic(error);
      assert.equal(diagnostic?.code, code);
      assert.deepEqual(diagnostic?.guidance, { ...diagnostic?.guidance, path, subject });
      return true;
    };
    assert.throws(() => assertConfig(input), exact);
    await assert.rejects(installDemonstration(input, async () => assert.fail('bootstrap reached')), exact);
    const { calls, binding } = installation();
    await assert.rejects(applyDemoSeed(input, binding, () => assert.fail('rules source reached')), exact);
    assert.deepEqual(calls, []);
  }
});

function infrastructureCause(original: unknown) {
  return (error: unknown) => {
    assert.equal(Object.getPrototypeOf(error), Error.prototype);
    assert.equal((error as Error).message, 'starter_installation_failed');
    const descriptor = Object.getOwnPropertyDescriptor(error, 'cause');
    assert.strictEqual(descriptor?.value, original);
    assert.equal(descriptor?.enumerable, false);
    return true;
  };
}

test('rollback and close preserve the primary install failure and close-only errors are reported', async context => {
  const rules = readStarterCatalogueRules();
  if (!rules) return context.skip('This starter has kept its existing draft validator.');
  const config = Object.values(configurations)[0]!, fixture = installation();
  const primary = new Error('definition connection lost');
  const cleanup = new Error('cleanup connection lost');
  const query = fixture.binding.connection.query;
  const close = fixture.binding.close;
  fixture.binding.catalogueRules = rules;
  fixture.binding.connection.query = async (sql, values) => {
    const result = await query(sql, values);
    if (sql.startsWith('SELECT public.catalog_definition_install')) throw primary;
    if (sql === 'ROLLBACK') throw cleanup;
    return result;
  };
  fixture.binding.close = async () => { await close(); throw cleanup; };
  await assert.rejects(installDemonstration(config, async () => fixture.binding), infrastructureCause(primary));
  assert.equal(fixture.calls.at(-1)?.text, 'ROLLBACK');
  assert.equal(fixture.closed(), 1);

  const success = installation();
  success.binding.close = async () => { throw cleanup; };
  await assert.rejects(installDemonstration(config, async () => success.binding), infrastructureCause(cleanup));
  assert.equal(success.calls.at(-1)?.text, 'COMMIT');
});

test('bootstrap connection failure is preserved instead of claiming the installed API is absent', async () => {
  const failure = new Error('bootstrap_connection_failed');
  await assert.rejects(installDemonstration(Object.values(configurations)[0]!, async () => { throw failure; }),
    infrastructureCause(failure));
});

for (const [name, identity, code] of [
  ['runtime login', { login: 'demo_runtime', role: 'demo_install', marker: demonstrationMarker }, 'starter_seed_runtime_role_forbidden'],
  ['runtime current role', { login: 'demo_install', role: 'demo_runtime', marker: demonstrationMarker }, 'starter_seed_runtime_role_forbidden'],
  ['other login', { login: 'other', role: 'demo_install', marker: demonstrationMarker }, 'starter_seed_install_role_required'],
  ['unmarked database', { login: 'demo_install', role: 'demo_install', marker: '' }, 'starter_seed_demonstration_database_required'],
] as const) {
  test(`${name} refuses seed before any application write and closes the install session`, async () => {
    const fixture = installation(identity);
    await assert.rejects(installDemonstration(Object.values(configurations)[0]!, async () => fixture.binding), { message: code });
    assert.equal(fixture.closed(), 1);
    assert.equal(fixture.calls.some(call => call.text.startsWith('INSERT')), false);
    assert.equal(fixture.calls.at(-1)!.text, 'ROLLBACK');
  });
}

test('equal install and runtime roles refuse before issuing SQL', async () => {
  const fixture = installation();
  fixture.binding.runtimeRole = fixture.binding.installRole;
  await assert.rejects(applyDemoSeed(Object.values(configurations)[0]!, fixture.binding), { message: 'starter_seed_install_role_required' });
  assert.equal(fixture.calls.length, 0);
});

test('failed seed write rolls back and closes rather than announcing an installation', async () => {
  const fixture = installation();
  const query = fixture.binding.connection.query;
  const failure = new Error('write_failed');
  fixture.binding.connection.query = async (text, values) => {
    if (text.startsWith('INSERT')) throw failure;
    return query(text, values);
  };
  await assert.rejects(installDemonstration(Object.values(configurations)[0]!, async () => fixture.binding), infrastructureCause(failure));
  assert.equal(fixture.calls.at(-1)!.text, 'ROLLBACK');
  assert.equal(fixture.closed(), 1);
});


test('a configured price outside PostgreSQL integer storage refuses before SQL', async () => {
  const config = structuredClone(Object.values(configurations)[0]!);
  config.offer.products[0]!.unitPrice.amountMinor = 2147483648;
  const fixture = installation();
  await assert.rejects(applyDemoSeed(config, fixture.binding), { message: 'starter_product_invalid' });
  assert.equal(fixture.calls.length, 0);
});

for (const existing of [[], [{ provenance: 'other_seed', active: true }],
  [{ provenance: acquisitionAddresses[0]!.addressReference.provenance, active: false }]]) {
  test(`conflicting or missing address registry row fails the installation: ${JSON.stringify(existing)}`, async () => {
    const fixture = installation();
    const query = fixture.binding.connection.query;
    fixture.binding.connection.query = async (text, values) => text.startsWith('SELECT provenance')
      ? { rows: existing } : query(text, values);
    await assert.rejects(installDemonstration(Object.values(configurations)[0]!, async () => fixture.binding),
      { message: 'starter_acquisition_seed_conflict' });
    assert.equal(fixture.calls.at(-1)!.text, 'ROLLBACK');
    assert.equal(fixture.closed(), 1);
  });
}


test('conflicting configured price is refused and rolls back instead of overwriting price truth', async () => {
  const fixture = installation();
  const query = fixture.binding.connection.query;
  fixture.binding.connection.query = async (text, values) => {
    const result = await query(text, values);
    if (text.startsWith('SELECT id, price_list_id')) result.rows[0]!.unit_price_minor = 1;
    return result;
  };
  await assert.rejects(applyDemoSeed(Object.values(configurations)[0]!, fixture.binding), (error: Error) => {
    assert.equal(error.message, 'starter_price_seed_conflict');
    return starterDiagnosticCode(error) === 'starter_price_seed_conflict';
  });
  assert.equal(fixture.calls.at(-1)!.text, 'ROLLBACK');
});


test('install uses the native stock writer for every exact editor SKU and seeds no editable subscription rows', async () => {
  const config = Object.values(configurations)[0]!, fixture = installation();
  await applyDemoSeed(config,fixture.binding);
  assert.equal(fixture.stockCalls.length,editorProducts(config).length);
  assert.equal(fixture.calls.some(call => /INSERT INTO public\.(subscription_lines|subscription_renewal_terms|subscription_renewal_term_lines|subscription_method_states|clients)\b/.test(call.text)),false);
  const settings = fixture.calls.filter(call => call.text.startsWith('INSERT INTO public.commerce_settings'));
  assert.equal(settings.find(call => call.values?.[0] === 'subscription_minimum_base_units')?.values?.[1],String(config.subscriptionEditing.minimumBaseUnits));
});

test('a changed installed document refuses instead of reusing an incompatible revision', async () => {
  const fixture = installation(),query = fixture.binding.connection.query;
  fixture.binding.connection.query = async (text,values) => text.startsWith('SELECT digest FROM public.catalog_product_document_revisions') ? { rows: [{ digest: '0'.repeat(64) }] } : query(text,values);
  await assert.rejects(applyDemoSeed(Object.values(configurations)[0]!,fixture.binding),{ message: 'starter_document_seed_conflict' });
  assert.equal(fixture.calls.at(-1)!.text,'ROLLBACK');
});


test('an existing seed caller without a stock port uses the native writer and rolls back its refusal', async () => {
  const config = Object.values(configurations)[0]!, fixture = installation();
  delete fixture.binding.stock;
  await applyDemoSeed(config,fixture.binding);
  const stockCalls = fixture.calls.filter(call => call.text.startsWith('SELECT public.fulfillment_record_stock_current'));
  assert.equal(stockCalls.length,editorProducts(config).length);
  assert.deepEqual(stockCalls.map(call => call.values?.[3]),editorProducts(config).map(product => product.sku));
  assert.ok(stockCalls.every(call => call.values?.[0] === `starter-demo:${config.id}`));
  const failed = installation(),query = failed.binding.connection.query;
  delete failed.binding.stock;
  failed.binding.connection.query = async (text,values) => {
    if (text.startsWith('SELECT public.fulfillment_record_stock_current')) throw new Error('native_stock_refused');
    return query(text,values);
  };
  await assert.rejects(applyDemoSeed(config,failed.binding),{ message: 'native_stock_refused' });
  assert.equal(failed.calls.at(-1)!.text,'ROLLBACK');
});

test('stock replay reports the affected SKU and succeeds after restoring its original quantity', async () => {
  const config = Object.values(configurations)[0]!, fixture = installation();
  delete fixture.binding.stock;
  const query = fixture.binding.connection.query;
  const first = editorProducts(config)[0]!;
  const code = 'fulfillment_stock_current_idempotency_conflict';
  fixture.binding.connection.query = async (text, values) => {
    if (text.startsWith('SELECT public.fulfillment_record_stock_current') && values?.[3] === first.sku
      && values[4] !== first.stockQuantity) {
      throw Object.assign(new Error(code), { code: '23505', detail: 'openlup:stock_current:replay_conflict' });
    }
    return query(text, values);
  };
  await applyDemoSeed(config, fixture.binding);
  const changed = structuredClone(config);
  changed.purchase.stock.quantities[first.sku] = first.stockQuantity + 1;
  await assert.rejects(installDemonstration(changed, async () => fixture.binding), (error: unknown) => {
    const report = installationReport(error);
    assert.ok(report);
    assert.equal(report.split('\n')[0], code);
    assert.ok(report.includes(first.sku));
    assert.match(report, /owned\/store.config.ts/u);
    assert.match(report, /Fix: Restore the original stock inputs for this SKU, then rerun the demo installer\./u);
    assert.match(report, /Recheck: Run `\.\/lifecycle up`\./u);
    return true;
  });
  assert.equal(fixture.calls.at(-1)?.text, 'ROLLBACK');
  await applyDemoSeed(config, fixture.binding);
  assert.equal(fixture.calls.at(-1)?.text, 'COMMIT');
});

test('blocked reminders report the validated count and leave unknown failures on the existing path', async () => {
  const config = Object.values(configurations)[0]!, fixture = installation();
  const query = fixture.binding.connection.query;
  const code = 'checkout_recovery_schedule_change_blocked_open_episodes';
  const raw = Object.assign(new Error(`${code} (2 blocking orders)`), { code: '55000' });
  let failure: unknown = Object.assign(new Error(raw.message), { code: raw.code, detail: 'openlup:reminder_schedule:blocking_orders=2' });
  fixture.binding.connection.query = async (text, values) => {
    if (text === installReminderSchedule && failure) throw failure;
    return query(text, values);
  };
  await assert.rejects(applyDemoSeed(config, fixture.binding), (error: unknown) => {
    const report = installationReport(error);
    assert.ok(report);
    assert.equal(report.split('\n')[0], code);
    assert.match(report, /checkoutRecoveryReminders.*\b2\b.*blocking orders/u);
    assert.match(report, /Fix: Keep the current schedule in effect\. Retry after the blocking orders are paid or cancelled\. For abandoned carts, retry once the blocking draft receipts are invalidated or the orders have a settlement intent\./u);
    return true;
  });
  assert.equal(fixture.calls.at(-1)?.text, 'ROLLBACK');
  failure = raw;
  await assert.rejects(applyDemoSeed(config, fixture.binding), (error: unknown) => error === raw);
  failure = undefined;
  await applyDemoSeed(config, fixture.binding);
  assert.equal(fixture.calls.at(-1)?.text, 'COMMIT');
});

test('owned renewal priority validates before installation writes, independent of configuration ID', async () => {
  for (const protection of [{ revision: '', renewalProtectionDays: 14 },
    { revision: 'owned-1', renewalProtectionDays: 0 }, { revision: 'owned-1', renewalProtectionDays: 3661 },
    { revision: 'owned-1', renewalProtectionDays: 1.5 }, { revision: 'owned-1', renewalProtectionDays: 14, extra: true }]) {
    const config = structuredClone(Object.values(configurations)[0]!);
    config.id = 'arbitrary-policy-fixture';
    config.inventory.renewalProtection = protection;
    const fixture = installation();
    await assert.rejects(applyDemoSeed(config, fixture.binding), { message: 'inventory_renewal_protection_policy_invalid' });
    assert.deepEqual(fixture.calls, []);
  }
});

test('owned reminder schedule validates and installs independently of configuration identity', async () => {
  for (const original of Object.values(configurations)) {
    const config = structuredClone(original); config.id = 'arbitrary-reminder-owner';
    config.checkoutRecoveryReminders = { revision: 'owned-48',
      abandonedCart: [{ stage: 'first', afterHours: 1 }, { stage: 'gentle', afterHours: 24 }, { stage: 'last', afterHours: 48 }],
      checkoutRecovery: [{ stage: 'last', afterHours: 48 }] };
    const fixture = installation(); await applyDemoSeed(config, fixture.binding);
    assert.deepEqual(JSON.parse(String(fixture.calls.find(call => call.values?.[0] === 'checkout_recovery_reminders')!.values?.[1])), config.checkoutRecoveryReminders);
    for (const invalid of [{ ...config.checkoutRecoveryReminders, revision: '' },
      { ...config.checkoutRecoveryReminders, checkoutRecovery: [] },
      { ...config.checkoutRecoveryReminders, abandonedCart: [{ stage: 'last', afterHours: 0 }] },
      { ...config.checkoutRecoveryReminders, abandonedCart: [{ stage: 'first', afterHours: 2 }, { stage: 'last', afterHours: 1 }] }]) {
      config.checkoutRecoveryReminders = invalid as typeof config.checkoutRecoveryReminders;
      const refused = installation();
      await assert.rejects(applyDemoSeed(config, refused.binding), { message: 'checkout_recovery_reminder_schedule_invalid' });
      assert.deepEqual(refused.calls, []);
    }
  }
});

test('lifecycle up, serve-demo, checkout-recovery and CLI delegation preserve named refusals and exit codes', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(resolve(root, '.context'), { recursive: true });
  const directory = await mkdtemp(resolve(root, '.context/lifecycle-diagnostics-'));
  try {
    for (const path of ['lifecycle.mjs', 'lifecycle-refusals.mjs', 'browser-groups.mjs', 'host', 'shared', 'owned', 'installation']) {
      await cp(resolve(root, path), resolve(directory, path), { recursive: true });
    }
    await writeFile(resolve(directory, 'package.json'), '{"type":"module"}');
    await mkdir(resolve(directory, 'node_modules/pg'), { recursive: true });
    await writeFile(resolve(directory, 'node_modules/pg/package.json'), '{"type":"module","exports":"./index.js"}');
    await writeFile(resolve(directory, 'node_modules/pg/index.js'), `export default { Client: class {
      async connect() {} async end() {}
      async query() { return { rows: [{ marker: ${JSON.stringify(demonstrationMarker)} }] }; }
    }, Pool: class { async end() {} } };`);
    async function invoke(argv: string[]) {
      const child = spawn(process.execPath, ['--experimental-strip-types', 'lifecycle.mjs', ...argv], { cwd: directory, stdio: 'pipe' });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += String(bytes); });
      child.stderr.on('data', bytes => { stderr += String(bytes); });
      return { code: (await once(child, 'exit'))[0], stdout, stderr };
    }
    const usage = await invoke(['unknown-command']);
    assert.equal(usage.code, 2);
    assert.ok(usage.stderr.includes('checkout-recovery --configuration <id> --database-url <runtime-url>'));

    for (const code of [
      'starter_locale_copy_missing: copy.heroTitle (pl)',
      'starter_locale_unsupported: de',
      'inventory_renewal_protection_policy_invalid',
      'checkout_recovery_reminder_schedule_invalid',
      'saved_address_policy_invalid',
    ]) {
      await writeFile(resolve(directory, 'shared/config.ts'), `
        export function assertConfig() { throw new Error(${JSON.stringify(code)}); }
        export function parseHostArguments() { return { configuration: undefined, port: 4319, listen: '127.0.0.1', databaseUrl: 'postgresql://starter_runtime@database:5432/neutral_store' }; }
      `);
      await writeFile(resolve(directory, 'host/server.ts'), `import { assertConfig } from '../shared/config.ts'; assertConfig();`);
      const up = await invoke(['up']);
      assert.equal(up.code, 2);
      const [first, fix] = up.stderr.trim().split('\n');
      assert.equal(first, code);
      assert.match(fix!, /^Fix: .+/u);
      const serve = await invoke(['serve-demo', '--database-url', 'postgresql://starter_runtime@database:5432/neutral_store']);
      assert.equal(serve.code, 2);
      assert.equal(serve.stderr.trim(), code);
    }

    const recovery = await invoke(['checkout-recovery', '--database-url', 'postgresql://starter_runtime@database:5432/neutral_store']);
    assert.notEqual(recovery.code, 0);
    assert.ok(recovery.stderr.includes('saved_address_policy_invalid'));

    await mkdir(resolve(directory, 'node_modules/.bin'), { recursive: true });
    await writeFile(resolve(directory, 'node_modules/.bin/openlup'),
      '#!/bin/sh\nprintf \'{"formatVersion":1,"command":"%s","exitCode":%s}\\n\' "$1" "$2"\nexit "$2"\n',
      { mode: 0o755 });
    for (const [subcommand, expectedCode] of [['verify', 2], ['verify', 74], ['upgrade', 1], ['upgrade', 64]] as const) {
      const delegated = await invoke([subcommand, String(expectedCode)]);
      assert.equal(delegated.code, expectedCode);
      assert.equal(delegated.stderr, '');
      assert.deepEqual(JSON.parse(delegated.stdout), { formatVersion: 1, command: subcommand, exitCode: expectedCode });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const maxVersion = 2_147_483_647;
const packFixture = (id: string, version = 1, keys = ['item']): CatalogPackInput => ({
  id, namespace: 'example', version, openlupRange: '1.x', capabilities: {},
  types: keys.map(key => ({ key: `example:${key}`, version, dimensions: [], validateContent: () => [],
    units: [{ code: 'openlup:piece', dimension: 'count', integral: true }], netContentUnits: ['openlup:piece'] })),
  taxClasses: [{ key: 'example:z' }, { key: 'example:a' }],
});
function buildReceipt(pack: CatalogPackInput): CatalogDefinitionInstallReceipt {
  const { digest, ...manifest } = catalogPackManifest(pack);
  return { packId: pack.id, packVersion: pack.version, manifestDigest: digest, types: manifest.types, installedAt: '2000-01-01T00:00:00.000Z',
    ...(manifest.subscriptionProfileDefinitions === undefined ? {} : {
      canonicalManifest: canonicalCatalogDraftJson(manifest), subscriptionProfileDefinitions: manifest.subscriptionProfileDefinitions,
    }) };
}
const missingBuild = { code: 'starter_catalogue_build_missing', path: '/type' };

test('host_resolves_pack_type_exact_pair and verifies the complete immutable build', async context => {
  const rules = readStarterCatalogueRules();
  if (!rules) return context.skip('The upgraded application kept its inline legacy validator.');
  const directory = await mkdtemp(resolve(tmpdir(), 'starter-pack-build-'));
  const originalLength = buildPacks.length;
  const artifact = Buffer.concat([rules, Buffer.from('// Règles ' + 'a'.repeat(840_001))]);
  const profile = { key: 'example:repeat', version: 1, allowedCadences: [{ schemaVersion: 1, kind: 'fixed_days' as const, days: 28 }],
    policyRef: { key: 'example:policy', version: 1 }, policyDigest: createHash('sha256').update('fixture').digest('hex') } as const;
  const first = { ...packFixture('example:é+_.-'), subscriptionProfiles: [{ key: profile.key, version: profile.version }],
    subscriptionProfileDefinitions: [profile] };
  const second = packFixture('example:other', maxVersion, ['item', 'sibling']);
  buildPacks.push(...[first, second].map(pack => ({ pack, drafts: [] })));
  try {
    const reader = starterCatalogue(directory);
    const [ref, newRef, sibling] = [first.types[0]!, second.types[0]!, second.types[1]!].map(({ key, version }) => ({ key, version }));
    for (const version of [0, maxVersion + 1, 1.5, '1']) {
      assert.throws(() => reader.registry.resolve({ key: ref!.key, version: version as number }), missingBuild);
    }
    assert.throws(() => reader.readInstalled(ref!), missingBuild);
    for (const pack of [first, second]) {
      const bound = withCatalogPublicationRules(pack, () => artifact), receipt = buildReceipt(bound);
      const stage = stagePackBuild(bound, receipt, artifact, directory)!;
      const target = resolve(directory, 'packs', `${pack.id}@${pack.version}.json`);
      await assert.rejects(stat(target), { code: 'ENOENT' });
      const identical = stagePackBuild(bound, receipt, artifact, directory)!;
      stage.publish(); stage.discard(); identical.publish(); identical.discard();
      const raw = await readFile(target);
      const build = JSON.parse(raw.toString('utf8'));
      assert.ok(raw.length > 1_048_576);
      assert.equal(build.asset, artifact.toString('base64'));
      assert.deepEqual(build.receipt, receipt);
      assert.deepEqual(build.pack.taxClasses, pack.taxClasses);
      assert.equal(build.pack.types.some((type: object) => Object.hasOwn(type, 'validateContent')), false);
      assert.equal(stagePackBuild(bound, receipt, artifact, directory), undefined);
      assert.deepEqual(await readFile(target), raw);
    }
    for (const pair of [ref!, newRef!, sibling!]) {
      const installed = reader.readInstalled(pair)!;
      assert.equal(installed.type, reader.registry.resolve(pair));
      assert.deepEqual(installed.type.validateContent({ title: 'Règles' }), []);
      assert.equal(installed.type.validateContent({})[0]?.code, 'title_required');
    }
    const read = context.mock.method(fs, 'readFileSync');
    syncBuiltinESMExports();
    try {
      const invalidRefs = [0, maxVersion + 1, 1.5, '1'].map(version => ({ key: ref!.key, version: version as number }));
      const fresh = starterCatalogue(directory);
      for (const invalid of invalidRefs) assert.throws(() => fresh.readInstalled(invalid), missingBuild);
      assert.ok(read.mock.calls.every(({ arguments: [path] }) => typeof path !== 'string' || !path.startsWith(directory)));
    } finally { read.mock.restore(); syncBuiltinESMExports(); }
    assert.throws(() => reader.registry.resolve({ key: sibling!.key, version: ref!.version }), missingBuild);
    const target = resolve(directory, 'packs', `${second.id}@${second.version}.json`);
    const raw = await readFile(target);
    type Build = { asset: string; receipt: { packId: string; types: object[] }; pack: { types: { netContentUnits: string[]; publicationRules?: boolean }[] } };
    const corruptions: ((build: Build) => void | string)[] = [
      () => '{',
      build => { build.asset += '='; },
      build => { build.asset = Buffer.from('forged rules').toString('base64'); },
      build => { build.receipt.packId = 'example:wrong'; },
      build => { build.receipt.types[1] = build.receipt.types[0]!; },
      build => { build.pack.types[1]!.netContentUnits = []; },
      build => { build.pack.types[1]!.publicationRules = false; },
      build => { delete build.pack.types[1]!.publicationRules; },
    ];
    for (const corrupt of corruptions) {
      const build = JSON.parse(raw.toString());
      await writeFile(target, corrupt(build) ?? JSON.stringify(build));
      assert.throws(() => starterCatalogue(directory).registry.resolve(newRef!), missingBuild);
    }
    await rm(target);
    const fresh = starterCatalogue(directory);
    assert.throws(() => fresh.registry.resolve(newRef!), missingBuild);
    await writeFile(target, raw);
    assert.equal(fresh.registry.resolve(newRef!)?.version, maxVersion);
    const profilePath = resolve(directory, 'packs', `${first.id}@1.json`);
    const profileBuild = JSON.parse(await readFile(profilePath, 'utf8'));
    profileBuild.receipt.subscriptionProfileDefinitions[0].profileDigest = '0'.repeat(64);
    await writeFile(profilePath, JSON.stringify(profileBuild));
    assert.throws(() => starterCatalogue(directory).registry.resolve(ref!), missingBuild);
  } finally { buildPacks.length = originalLength; await rm(directory, { recursive: true, force: true }); }
});

test('lost_build_refuses_build_missing_and_never_falls_back_inline across installer rollback and replay', async context => {
  const bytes = readStarterCatalogueRules();
  if (!bytes) return context.skip('The upgraded application kept its inline legacy validator.');
  const directory = await mkdtemp(resolve(tmpdir(), 'starter-pack-commit-'));
  const originalLength = buildPacks.length;
  const config = Object.values(configurations)[0]!;
  const pack = packFixture('example:commit');
  const target = resolve(directory, 'packs', `${pack.id}@1.json`), ref = { key: 'example:item', version: 1 };
  buildPacks.push({ pack, drafts: [] });
  function run(hook: (text: string, values: unknown[] | undefined, result: Awaited<ReturnType<DemonstrationInstallation['connection']['query']>>) => Promise<void>) {
    const fixture = installation(), query = fixture.binding.connection.query;
    Object.assign(fixture.binding, { catalogueRules: bytes, catalogueBuildDirectory: directory });
    fixture.binding.connection.query = async (text, values) => {
      const result = await query(text, values);
      await hook(text, values, result);
      return result;
    };
    return { result: applyDemoSeed(config, fixture.binding), calls: fixture.calls };
  }
  try {
    const reader = starterCatalogue(directory);
    const invalidReceipt = run(async (sql, values, result) => {
      if (sql.startsWith('SELECT public.catalog_definition_install') && values?.[0] === pack.id)
        (result.rows[0]!.receipt as { types: unknown[] }).types = [];
    });
    await assert.rejects(invalidReceipt.result, error => {
      assert.equal(Object.getPrototypeOf(error), Error.prototype);
      assert.deepEqual(Reflect.ownKeys(error as object).filter(key => key !== 'stack').sort(),
        ['causeText', 'code', 'fix', 'message', 'observed', 'path', 'recheck']);
      assert.match(String(error), /starter_catalogue_install_receipt_invalid/u);
      assert.equal((error as { path: string }).path, '/packs/1/pack');
      return true;
    });
    assert.equal(invalidReceipt.calls.at(-1)?.text, 'ROLLBACK');
    const failed = run(async sql => {
      if (sql !== 'COMMIT') return;
      assert.throws(() => reader.registry.resolve(ref), missingBuild);
      throw new Error('synthetic commit failure');
    });
    await assert.rejects(failed.result, { code: 'starter_installation_failed' });
    assert.equal(failed.calls.at(-1)?.text, 'ROLLBACK');
    await assert.rejects(stat(target), { code: 'ENOENT' });

    const ioFailure = run(async sql => {
      if (sql === 'COMMIT') {
        for (const entry of await readdir(resolve(directory, 'packs')))
          if (entry.startsWith('.pending-')) await rm(resolve(directory, 'packs', entry), { recursive: true });
      }
    });
    await assert.rejects(ioFailure.result, { code: 'starter_installation_failed', path: '/packs' });
    assert.equal(ioFailure.calls.at(-1)?.text, 'COMMIT');
    const replay = run(async (sql, _values, result) => {
      if (sql.startsWith('SELECT 1 FROM public.catalog_definition_installs')) result.rows.push({});
    });
    assert.equal((await replay.result)[0]?.outcome, 'unchanged');
    const statements = replay.calls.map(({ text }) => text);
    const ledger = statements.findIndex(text => text.startsWith('SELECT 1 FROM public.catalog_definition_installs'));
    assert.ok(statements[ledger - 1]?.startsWith('SELECT public.catalog_definition_install'));
    assert.ok(statements[ledger + 1]?.startsWith('SELECT public.catalog_definition_install'));
    assert.ok(reader.registry.resolve(ref));

    await rm(target);
    let ready!: () => void, commit!: () => void;
    const held = new Promise<void>(done => { ready = done; });
    const resume = new Promise<void>(done => { commit = done; });
    const losing = run(async sql => { if (sql === 'COMMIT') { ready(); await resume; } });
    const lost = assert.rejects(losing.result, { code: 'starter_catalogue_build_conflict', path: '/packs/1/pack' });
    await held;
    buildPacks[originalLength] = { pack: { ...pack, types: pack.types.map(type => ({ ...type, labels: { en: 'New label' } })) }, drafts: [] };
    try { assert.equal((await run(async () => {}).result)[0]?.outcome, 'installed'); }
    finally { commit(); }
    const winningBytes = await readFile(target);
    await lost;
    assert.equal(losing.calls.at(-1)?.text, 'COMMIT');
    buildPacks[originalLength] = { pack, drafts: [] };
    await assert.rejects(run(async () => {}).result, { code: 'starter_catalogue_build_conflict', path: '/packs/1/pack' });
    assert.deepEqual(await readFile(target), winningBytes);

    for (const id of ['outside/pack', 'outside\\pack', 'outside\0pack', 'é'.repeat(124) + 'a']) {
      buildPacks[originalLength] = { pack: { ...pack, id }, drafts: [] };
      const invalidName = run(async () => {});
      await assert.rejects(invalidName.result, { code: 'starter_catalogue_pack_invalid', path: '/packs/1/pack/id' });
      assert.deepEqual(invalidName.calls, []);
      assert.throws(() => starterCatalogue(directory).registry.resolve(ref), missingBuild);
    }
    const exact = 'é'.repeat(124);
    buildPacks[originalLength] = { pack: { ...pack, id: exact }, drafts: [] };
    await run(async () => {}).result;
    assert.equal(Buffer.byteLength(`${exact}@1.json`), 255);
    assert.ok((await stat(resolve(directory, 'packs', `${exact}@1.json`))).isFile());
  } finally { buildPacks.length = originalLength; await rm(directory, { recursive: true, force: true }); }
});
