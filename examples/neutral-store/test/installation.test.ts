import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../owned/store.config.ts';
import { buildDemoSeed } from '../owned/demo-seed.ts';
import { acquisitionAddresses } from '../owned/acquisition-addresses.ts';
import { applyDemoSeed, demonstrationMarker, installDemonstration,
  type DemonstrationInstallation } from '../installation/install.ts';

function installation(identity = { login: 'demo_install', role: 'demo_install', marker: demonstrationMarker }) {
  const calls: Array<{ text: string; values: unknown[] | undefined }> = [];
  let closed = 0;
  const binding: DemonstrationInstallation = {
    installRole: 'demo_install', runtimeRole: 'demo_runtime',
    connection: { query: async (text, values) => {
      calls.push({ text, values });
      return { rows: text.startsWith('SELECT provenance')
        ? [{ provenance: acquisitionAddresses[0]!.addressReference.provenance, active: true }]
        : text.startsWith('SELECT') ? [identity] : [] };
    } },
    close: async () => { closed++; },
  };
  return { binding, calls, closed: () => closed };
}

for (const config of Object.values(configurations)) {
  test(`${config.id}: fictional catalog and prices come from one configuration deterministically`, () => {
    const seed = buildDemoSeed(config);
    assert.deepEqual(buildDemoSeed(structuredClone(config)), seed);
    assert.equal(seed.products.length, config.offer.products.length);
    assert.equal(seed.priceLists[0]!.currency, config.market.currency);
    const ids = [...seed.products, ...seed.skus, ...seed.priceLists, ...seed.prices].map(row => row.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const [index, product] of config.offer.products.entries()) {
      assert.equal(seed.products[index]!.name, product.name.en);
      assert.equal(seed.products[index]!.description, product.description.en);
      assert.equal(seed.skus[index]!.sku, product.sku);
      assert.equal(seed.skus[index]!.product_id, seed.products[index]!.id);
      assert.equal(seed.prices[index]!.variant_id, seed.skus[index]!.id);
      assert.equal(seed.prices[index]!.unit_price_minor, product.unitPrice.amountMinor);
      assert.equal(seed.prices[index]!.price_list_id, seed.priceLists[0]!.id);
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
    assert.equal(first.calls[0]!.text, 'BEGIN');
    assert.equal(first.calls.at(-1)!.text, 'COMMIT');
    const inserts = first.calls.filter(call => call.text.startsWith('INSERT INTO public.'));
    assert.equal(inserts.length, config.offer.products.length * 3 + 1);
    for (const call of inserts) {
      assert.match(call.text, /ON CONFLICT \(id\) DO UPDATE/);
      assert.match(call.text, /INSERT INTO public\.(catalog_products|catalog_skus|price_lists|price_entries)\b/);
      assert.ok(call.values?.length);
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

test('bootstrap connection failure is preserved instead of claiming the installed API is absent', async () => {
  const failure = new Error('bootstrap_connection_failed');
  await assert.rejects(installDemonstration(Object.values(configurations)[0]!, async () => { throw failure; }),
    error => error === failure);
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
  fixture.binding.connection.query = async (text, values) => {
    if (text.startsWith('INSERT')) throw new Error('write_failed');
    return query(text, values);
  };
  await assert.rejects(installDemonstration(Object.values(configurations)[0]!, async () => fixture.binding), { message: 'write_failed' });
  assert.equal(fixture.calls.at(-1)!.text, 'ROLLBACK');
  assert.equal(fixture.closed(), 1);
});


test('a configured price outside PostgreSQL integer storage refuses before SQL', async () => {
  const config = structuredClone(Object.values(configurations)[0]!);
  config.offer.products[0]!.unitPrice.amountMinor = 2147483648;
  const fixture = installation();
  await assert.rejects(applyDemoSeed(config, fixture.binding), { message: 'starter_demo_price_out_of_range' });
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
