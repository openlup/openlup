import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogDefinitionDigest, catalogPackIssues, type CatalogDraftPayload } from '@openlup/platform/catalog';
import type { CatalogConformanceSource } from '@openlup/platform/catalog/testing';
import { createPostgresCommercePriceAuthorityReadPort } from '@openlup/platform/commerce/server/postgres';
import { configurations } from '../owned/store.config.ts';
import { catalogueConformance } from '../owned/catalogue.ts';
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

test('catalogue_transport_matrix RP2-D-002 projects each conformance pack from its runtime registration', async () => {
  const app = fileURLToPath(new URL('../', import.meta.url));
  const { packs, ...metadata }: CatalogConformanceSource = catalogueConformance;
  assert(packs.length > 0);
  const registrations = starterCatalogue.list();
  const expectedPacks = [];
  const draftPaths: string[] = [];
  for (const [index, { pack: sourcePack, ...fixtures }] of packs.entries()) {
    const registration = registrations.find(({ pack }) => pack?.id === sourcePack.id && pack.version === sourcePack.version);
    assert(registration, `Missing runtime registration for ${sourcePack.id}@${sourcePack.version}`);
    const options = parseHostArguments(['--configuration', registration.configuration.id, '--catalogue-publication', 'on',
      '--database-url', 'postgresql://starter_runtime@127.0.0.1/neutral_store']);
    const selected = starterCatalogue.select(options.configuration);
    assert.equal(options.cataloguePublication, true);
    assert.equal(selected, registration);
    const { pack } = selected;
    assert(pack);
    assert.deepEqual(sourcePack, pack);
    const { country, currency } = selected.configuration.market;
    assert.deepEqual(selected.scope?.types, [selected.draftType]);
    assert.deepEqual(selected.scope?.priceContext, {
      regionCode: country, currency, channel: 'D2C', readPrices: createPostgresCommercePriceAuthorityReadPort,
    });

    const runtimeTypes = pack.types.map(type => {
      const resolved = selected.types.resolve(type);
      assert(resolved);
      assert.equal(resolved.validateContent, type.validateContent);
      return resolved;
    });
    for (const [draftIndex, draft] of (fixtures.drafts ?? []).entries()) {
      const { product } = draft as CatalogDraftPayload;
      if (product.sharedContent === undefined) continue;
      assert.deepEqual(selected.types.resolve(product.type)?.validateContent(product.sharedContent), []);
      draftPaths.push(`/packs/${index}/drafts/${draftIndex}/product/sharedContent`);
    }
    expectedPacks.push({ ...fixtures, pack: { ...pack, types: runtimeTypes } });
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
  const { subjectPath, subjectHash, projectionMilliseconds, checkMilliseconds, recheck, replay } = report.transport;
  assert(projectionMilliseconds >= 0 && checkMilliseconds >= 0);
  assert.match(recheck, /catalogue project/u);
  assert.match(replay, /catalogue check/u);
  assert(!realpathSync(subjectPath).startsWith(realpathSync(app) + sep));
  try {
    const bytes = readFileSync(subjectPath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), subjectHash);
    const subject = JSON.parse(bytes.toString('utf8'));
    assert.deepEqual(subject, JSON.parse(JSON.stringify({ ...metadata, packs: expectedPacks })));
    const inert = spawnSync(process.execPath, [bin,
      'catalogue', 'check', '--packs', subjectPath, '--json'], { cwd: app, encoding: 'utf8' });
    const { findings } = JSON.parse(inert.stdout) as { findings: { code: string; path: string }[] };
    assert.equal(inert.status, findings.length ? 2 : 0, inert.stdout);
    assert(findings.every(({ code }) => code === 'conformance_owner_unavailable'));
    assert.deepEqual(findings.filter(({ path }) => path.endsWith('/product/sharedContent')).map(({ path }) => path),
      draftPaths.sort());
  } finally { rmSync(dirname(subjectPath), { recursive: true }); }
});

const supplements = starterCatalogue.list().find(entry => entry.pack?.id === 'supplements');
if (supplements) test('RP2-D-002 matches the supplements conformance source to the authoring fixtures and runtime binding', async () => {
  const { supplementsCatalogueFor } = await import('../owned/catalogue.ts');
  const { offerVersion } = await import('../owned/catalog-packs/supplements/catalogue.ts');
  const { requiredChecks, supplementsFixtures } = await import('../owned/catalog-packs/supplements/fixtures.ts');
  const { pack } = await import('../owned/catalog-packs/supplements/pack.ts');
  assert.equal(supplements.pack, pack);
  assert.equal(supplements.scope?.offerVersion, offerVersion);
  const transactions = { async run(): Promise<never> { throw new Error('offline binding must perform no effects'); } };
  const binding = await bindRegisteredCatalogue(supplements, transactions);
  assert.equal(binding.registration, supplements);
  assert.equal(binding.readEnabled(), true);
  assert.equal(binding.writerEnabled(), true);

  const queries: string[] = [];
  const executor = { async query(sql: string, values?: unknown[]) {
    queries.push(sql);
    const { manifest } = JSON.parse(String(values?.[2]));
    const installed = JSON.parse(manifest);
    assert.equal(installed.id, pack.id);
    assert.deepEqual(installed.types, pack.types.map(type => {
      const resolved = supplements.types.resolve(type);
      assert(resolved);
      return { key: type.key, version: type.version, definitionDigest: catalogDefinitionDigest(resolved) };
    }));
    assert.deepEqual(installed.subscriptionProfileDefinitions, pack.subscriptionProfileDefinitions);
    return { rows: [{ receipt: { manifestDigest: createHash('sha256').update(manifest).digest('hex'),
      subscriptionProfileDefinitions: pack.subscriptionProfileDefinitions } }] };
  } };
  await installStarterCatalogueDefinitions(executor, supplements.configuration.id);
  assert.deepEqual(queries, ['SELECT public.catalog_definition_install($1::text, $2::integer, $3::jsonb) AS receipt']);

  const priceListId = demoIdentifier(supplements.configuration, 'price-list', supplements.configuration.market.currency);
  const { fixtures } = supplementsFixtures(priceListId);
  const { initialDrafts } = supplementsCatalogueFor(supplements);
  assert.deepEqual(initialDrafts.flatMap(({ payload }) => payload.skus.flatMap(sku =>
    sku.priceOperations?.map(operation => operation.priceListId) ?? [])), initialDrafts.map(() => priceListId));
  assert.deepEqual(catalogueConformance, {
    packs: [{ ...fixtures, pack, profilePolicies: binding.profilePolicies }],
    requiredChecks,
  });
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
