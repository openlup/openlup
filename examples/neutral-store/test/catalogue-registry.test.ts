import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogDefinitionDigest } from '@openlup/platform/catalog';
import { configurations } from '../owned/store.config.ts';
import { catalogueConformance } from '../owned/catalogue.ts';
import { offerVersion } from '../owned/catalog-packs/supplements/catalogue.ts';
import { fixtures, requiredChecks } from '../owned/catalog-packs/supplements/fixtures.ts';
import { pack } from '../owned/catalog-packs/supplements/pack.ts';
import { bindRegisteredCatalogue, starterCatalogue, selectCatalogueConfiguration } from '../host/catalogue-selection.ts';
import { createStarterCatalogueRegistry } from '../host/catalogue-registry.ts';
import { installStarterCatalogueDefinitions } from '../installation/install.ts';
import { starterQuoteCatalogue } from '../host/editor-catalogue.ts';
import { parseHostArguments } from '../shared/config.ts';

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

test('RP1-D-003a selects the supplements pack through the explicit LC8 binding', async () => {
  const selected = starterCatalogue.select('supplements-pack');
  const transactions = { async run(): Promise<never> { throw new Error('binding must perform no effects'); } };
  assert.equal(selectCatalogueConfiguration('supplements-pack'), selected.configuration);
  assert.equal(selected.pack?.id, 'supplements');
  assert.equal(selected.explicitOnly, true);
  assert.equal(starterCatalogue.select().pack?.id, 'starter:demonstration');
  const binding = await bindRegisteredCatalogue(selected, transactions);
  assert.equal(binding.registration, selected);
  assert.equal(binding.publication.transactions, transactions);
  assert.equal(binding.readEnabled(), true);
  assert.equal(binding.writerEnabled(), false);
  await assert.rejects(bindRegisteredCatalogue(starterCatalogue.select(), transactions), { message: 'starter_catalogue_registration_invalid' });
});

test('catalogue_transport_matrix RP2-D-002 projects the selected runtime pack and RP1 fixtures', async () => {
  const app = fileURLToPath(new URL('../', import.meta.url));
  const options = parseHostArguments(['--configuration', 'supplements-pack', '--catalogue-publication', 'on',
    '--database-url', 'postgresql://starter_runtime@127.0.0.1/neutral_store']);
  const selected = starterCatalogue.select(options.configuration);
  assert.equal(options.cataloguePublication, true);
  assert.equal(selected.pack, pack);
  assert.deepEqual(selected.scope, { types: pack.types.map(({ key, version }) => ({ key, version })), offerVersion });
  assert.equal(starterCatalogue.list().filter(entry => entry.pack === pack).length, 1);
  assert.deepEqual(catalogueConformance.packs.map(entry => entry.pack), [selected.pack]);
  const transactions = { async run(): Promise<never> { throw new Error('offline binding must perform no effects'); } };
  const binding = await bindRegisteredCatalogue(selected, transactions);
  assert.equal(binding.registration, selected);
  assert.equal(binding.readEnabled(), true);
  assert.equal(binding.writerEnabled(), false);

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

  const report = JSON.parse(execFileSync('npm', ['--silent', 'run', 'catalogue:check:source'], { cwd: app, encoding: 'utf8' }));
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
    const pkg = dirname(fileURLToPath(import.meta.resolve('@openlup/platform/package.json')));
    const inert = spawnSync(process.execPath, [join(pkg, 'src/lifecycle/openlup.mjs'),
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
