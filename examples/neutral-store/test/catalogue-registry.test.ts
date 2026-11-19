import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogDefinitionDigest, catalogPackIssues } from '@openlup/platform/catalog';
import { createPostgresCommercePriceAuthorityReadPort } from '@openlup/platform/commerce/server/postgres';
import { configurations } from '../owned/store.config.ts';
import { catalogueConformance, supplementsCatalogueFor } from '../owned/catalogue.ts';
import { offerVersion } from '../owned/catalog-packs/supplements/catalogue.ts';
import { requiredChecks, supplementsFixtures } from '../owned/catalog-packs/supplements/fixtures.ts';
import { pack } from '../owned/catalog-packs/supplements/pack.ts';
import { bindRegisteredCatalogue, starterCatalogue, selectCatalogueConfiguration } from '../host/catalogue-selection.ts';
import { createStarterCatalogueRegistry, type StarterCatalogueRegistration } from '../host/catalogue-registry.ts';
import { installStarterCatalogueDefinitions } from '../installation/install.ts';
import { demoIdentifier, starterQuoteCatalogue } from '../host/editor-catalogue.ts';
import { parseHostArguments } from '../shared/config.ts';

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

const configuredEntries = starterCatalogue.list().filter(({ configuration }) => Object.hasOwn(configurations, configuration.id));
for (const entry of configuredEntries) test(`MC5-N-005 ${entry.configuration.id} drives boot, authoring, install and read composition`, async () => {
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

test('a deferred registration resolves only when selected', () => {
  const config = starterCatalogue.select().configuration;
  const pack = { id: 'synthetic:articles', namespace: 'synthetic', version: 1,
    openlupRange: '0.43.x', capabilities: {}, taxClasses: [], types: [articleType] };
  const id = 'deferred-articles';
  let reads = 0;
  const registry = createStarterCatalogueRegistry([
    { configuration: config, pack, draftType: articleType, offerVersion: 'classic' },
    { configurationId: id, pack, draftType: articleType, offerVersion: 'classic',
      get configuration() { reads++; return { ...config, id }; } },
  ], config.id);
  assert.equal(registry.list().length, 2);
  assert.equal(registry.select().configuration, config);
  assert.equal(reads, 0);
  assert.equal(registry.select(id).pack, pack);
  assert.equal(reads, 1);
});

test('RP1-D-003a selects the supplements pack through the explicit LC8 binding', async () => {
  if (!Object.hasOwn(configurations, 'supplements')) {
    assert.throws(() => starterCatalogue.select('supplements-pack'), { message: 'starter_configuration_unknown' });
    return;
  }
  const selected = starterCatalogue.select('supplements-pack');
  const transactions = { async run(): Promise<never> { throw new Error('binding must perform no effects'); } };
  assert.equal(selectCatalogueConfiguration('supplements-pack'), selected.configuration);
  assert.equal(selected.pack?.id, 'supplements');
  assert.equal(selected.explicitOnly, true);
  assert.equal(starterCatalogue.select().pack?.id, 'starter:demonstration');
  assert.equal(await bindRegisteredCatalogue(selected, transactions, false), undefined);
  const binding = await bindRegisteredCatalogue(selected, transactions, true);
  assert.equal(binding.registration, selected);
  assert.equal(binding.publication.transactions, transactions);
  assert.equal(binding.readEnabled(), true);
  assert.equal(binding.writerEnabled(), true);
  assert.equal(typeof binding.observePublication, 'function');
  assert.equal(typeof binding.publication.bindHumanTransaction, 'function');
  await assert.rejects(bindRegisteredCatalogue(starterCatalogue.select(), transactions), { message: 'starter_catalogue_registration_invalid' });
});

test('catalogue_transport_matrix RP2-D-002 projects the selected runtime pack and RP1 fixtures', async () => {
  const app = fileURLToPath(new URL('../', import.meta.url));
  const options = parseHostArguments(['--configuration', 'supplements-pack', '--catalogue-publication', 'on',
    '--database-url', 'postgresql://starter_runtime@127.0.0.1/neutral_store']);
  const selected = starterCatalogue.select(options.configuration);
  assert.equal(options.cataloguePublication, true);
  assert.equal(selected.pack, pack);
  const { country, currency } = selected.configuration.market;
  assert.deepEqual(selected.scope, { types: [selected.draftType], offerVersion, priceContext: {
    regionCode: country, currency, channel: 'D2C', readPrices: createPostgresCommercePriceAuthorityReadPort,
  } });
  assert.equal(starterCatalogue.list().filter(entry => entry.pack === pack).length, 1);
  assert.deepEqual(catalogueConformance.packs.map(entry => entry.pack), [selected.pack]);
  const transactions = { async run(): Promise<never> { throw new Error('offline binding must perform no effects'); } };
  const binding = await bindRegisteredCatalogue(selected, transactions, options.cataloguePublication);
  assert.equal(binding.registration, selected);
  assert.equal(binding.readEnabled(), true);
  assert.equal(binding.writerEnabled(), true);

  const priceListId = demoIdentifier(selected.configuration, 'price-list', currency);
  const { fixtures } = supplementsFixtures(priceListId);
  const { initialDrafts } = supplementsCatalogueFor(selected);
  assert.deepEqual(initialDrafts.flatMap(({ payload }) => payload.skus.flatMap(sku =>
    sku.priceOperations?.map(operation => operation.priceListId) ?? [])), initialDrafts.map(() => priceListId));

  const runtimeTypes = pack.types.map(type => {
    const resolved = selected.types.resolve(type);
    assert(resolved);
    return resolved;
  });
  const executor = { async query(sql: string, values?: unknown[]) {
    assert.match(sql, /catalog_definition_install/u);
    const { manifest } = JSON.parse(String(values?.[2]));
    const installed = JSON.parse(manifest);
    assert.equal(installed.id, pack.id);
    assert.deepEqual(installed.types, runtimeTypes.map(type => ({
      key: type.key, version: type.version, definitionDigest: catalogDefinitionDigest(type),
    })));
    assert.deepEqual(installed.subscriptionProfileDefinitions, pack.subscriptionProfileDefinitions);
    return { rows: [{ receipt: { manifestDigest: createHash('sha256').update(manifest).digest('hex'),
      subscriptionProfileDefinitions: pack.subscriptionProfileDefinitions } }] };
  } };
  await installStarterCatalogueDefinitions(executor, selected.configuration.id);
  for (const draft of fixtures.drafts) {
    assert.deepEqual(selected.types.resolve(draft.product.type)?.validateContent(draft.product.sharedContent), []);
  }

  const pkg = dirname(fileURLToPath(import.meta.resolve('@openlup/platform/package.json')));
  const bin = join(pkg, 'src/lifecycle/openlup.mjs');
  const project = ['catalogue', 'project', '--trusted-packs', './owned/catalogue.ts', '--json'];
  const { scripts } = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  assert.equal(scripts['catalogue:check:source'], ['openlup', ...project].join(' '));
  // The source extraction tests deliberately clear PATH. Use the same installed argv in that lane.
  const args = process.env.npm_execpath ? [process.env.npm_execpath, '--silent', 'run', 'catalogue:check:source'] : [bin, ...project];
  const report = JSON.parse(execFileSync(process.execPath, args, { cwd: app, encoding: 'utf8' }));
  assert.equal(report.formatVersion, 1);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.findings, []);
  assert.equal(report.transport.checkerInvocations, 1);
  const { subjectPath, subjectHash } = report.transport;
  assert(!realpathSync(subjectPath).startsWith(realpathSync(app) + sep));
  try {
    const bytes = readFileSync(subjectPath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), subjectHash);
    const subject = JSON.parse(bytes.toString('utf8'));
    const expected = JSON.parse(JSON.stringify({
      packs: [{ ...fixtures, pack: { ...pack, types: runtimeTypes }, profilePolicies: binding.profilePolicies }],
      requiredChecks,
    }));
    assert.deepEqual(subject, expected);
    const inert = spawnSync(process.execPath, [bin,
      'catalogue', 'check', '--packs', subjectPath, '--json'], { cwd: app, encoding: 'utf8' });
    assert.equal(inert.status, 2, inert.stdout);
    const { findings } = JSON.parse(inert.stdout);
    assert.deepEqual(findings.map(({ code, path }: { code: string; path: string }) => [code, path]),
      fixtures.drafts.map((_, i) => ['conformance_owner_unavailable', `/packs/0/drafts/${i}/product/sharedContent`]));
  } finally { rmSync(dirname(subjectPath), { recursive: true }); }
});

import { bindCataloguePorts } from '../host/catalogue-binding.ts';
import type { ActionContext, ApplicationBindings } from '../host/bindings.ts';

const bindingCases = [
  ['shopper', 'offer.validate'], ['settlement', 'checkout.create'], ['settlement', 'checkout.inlineRetry'],
  ['account', 'account.orders'], ['editor', 'subscription.preview'], ['successor', 'subscription.successor'],
  ['publicationRead', null], ['publish', 'operator.catalogPublication'], ['lifecycleWrite', 'operator.catalogPublication'],
  ['profiles', null],
] as const;

for (const [lane, operation] of bindingCases) test(`LC8 catalogue_bound_g1_ports ${lane} ${operation ?? 'status'}`, async () => {
  type Inputs = Parameters<typeof bindCataloguePorts>[0];
  const comeFrom = 'explicit-publication';
  const config = starterCatalogue.select().configuration;
  const actor = { customerRef: 'client', principalRef: 'principal', operatorRef: 'operator' };
  const context: ActionContext = { actor, config, commandKey: 'host-command-key' };
  let enabled = false, writer = false, verified = true;
  let observed: 'ready' | 'unsupported' | 'unadopted' | 'dependency_unavailable' = 'ready';
  let calls = 0;
  const touched = async () => { calls++; return { ok: true as const, value: comeFrom }; };
  const useHost = async (_input: unknown, supplied: ActionContext) =>
    supplied.catalogueQuote === quote ? touched() : { ok: true as const, value: 'legacy' };
  const actions: ApplicationBindings['actions'] = { 'offer.validate': useHost, 'checkout.create': useHost,
    'checkout.inlineRetry': useHost, 'account.orders': useHost, 'subscription.preview': useHost };
  const empty = { items: [], version: comeFrom, nextCursor: null };
  const serving: Inputs['serving'] = {
    list: async () => { calls++; return empty; }, detail: async () => empty,
    listQuoteCatalogItems: async () => [], listEditorSkus: async () => [], invalidateProduct() {},
  };
  const quote: Inputs['quote'] = { serving, offerVersion: 'classic', admission: { async assertCurrent() {} },
    async buildAdmission() { throw new Error('unexpected quote'); } };
  const ready = async () => ({ schemaCompatible: true, privilegeGranted: true, state: 'ready' as const });
  const probe = async () => ({ ...await ready(), state: observed });
  const publish = async (command: { commandKey: string }) => {
    assert.equal(command.commandKey, context.commandKey);
    calls++;
    return { outcome: 'replayed', receipt: { productId: comeFrom } };
  };
  const publisher = { authorize: async () => verified ? {} : null, decision: publish, publish, reads: { current: publish } } as unknown as Inputs['publisher'];
  const successor = { offer: async (owner: { actorId: string; clientId: string }, command: { historicalBinding?: unknown }) => {
    assert.deepEqual(owner, { actorId: 'principal', clientId: 'client' });
    assert.equal(command.historicalBinding, undefined); calls++; return comeFrom;
  } } as unknown as Inputs['successor'];
  const binding = bindCataloguePorts({ actions, serving, quote, publisher, successor, adoption: undefined,
    configId: config.id, readEnabled: () => enabled, writerEnabled: () => writer,
    observeRead: lane === 'shopper' || lane === 'publicationRead' ? probe : ready,
    observeAdmission: lane === 'editor' ? probe : ready, observeSettlement: lane === 'settlement' ? probe : ready,
    observeAccount: lane === 'account' ? probe : ready, observeSuccessor: lane === 'successor' ? probe : ready,
    observeProfiles: lane === 'profiles' ? probe : ready, observeWriter: lane === 'publish' || lane === 'lifecycleWrite' ? probe : ready });
  const payload = lane === 'successor' ? { action: 'offer', command: { historicalBinding: 'ignored' } }
    : { action: lane === 'publish' ? 'decide' : 'publish', command: { commandKey: 'payload-key' } };
  const run = () => operation ? actions[operation]!(payload, context) : binding.catalogue.list({ cursor: null, limit: 1 });
  assert.equal((await binding.catalogueStatus()).profiledAcquisition, false);
  if (operation && ['shopper', 'settlement', 'account', 'editor'].includes(lane)) {
    assert.deepEqual(await run(), { ok: true, value: 'legacy' });
  }
  enabled = true;
  if (lane === 'profiles') {
    assert.equal((await binding.catalogueStatus()).profiledAcquisition, true);
    observed = 'unsupported';
    assert.equal((await binding.catalogueStatus()).profiledAcquisition, false);
    return;
  }
  if (lane === 'publish' || lane === 'lifecycleWrite') {
    assert.deepEqual(await run(), { ok: false, code: 'catalog_capability_unsupported' });
    writer = true;
    verified = false;
    assert.deepEqual(await run(), { ok: false, code: 'publisher_not_authorized' });
    verified = true;
  }
  if (lane === 'publicationRead') {
    assert.deepEqual(await run(), empty);
    observed = 'unadopted';
    await assert.rejects(run, { code: 'catalog_authority_unsupported' });
    observed = 'dependency_unavailable';
    await assert.rejects(run, { code: 'catalog_authority_unavailable' });
  } else {
    const delivered = await run();
    assert.ok('ok' in delivered && delivered.ok);
    observed = 'dependency_unavailable';
    assert.deepEqual(await run(), { ok: false, code: 'dependency_unavailable' });
  }
  assert.equal(calls, 1);
});
