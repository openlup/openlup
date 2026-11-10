import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { configurations } from '../owned/store.config.ts';
import { buildDemoSeed } from '../owned/demo-seed.ts';
import { editorProducts } from '../host/editor-catalogue.ts';
import { acquisitionAddresses } from '../owned/acquisition-addresses.ts';
import { applyDemoSeed, demonstrationMarker, installDemonstration,
  type DemonstrationInstallation } from '../installation/install.ts';

test('container demo startup privately creates a key once, reuses it, and refuses a customer database', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(resolve(root, '.context'), { recursive: true });
  const directory = await mkdtemp(resolve(root, '.context/demo-start-'));
  try {
    for (const path of ['lifecycle.mjs', 'host', 'shared', 'owned', 'installation']) {
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
    const argv = ['lifecycle.mjs', 'serve-demo', '--configuration', 'supplements', '--port', '4319',
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

for (const config of Object.values(configurations)) {
  test(`${config.id}: fictional catalog and prices come from one configuration deterministically`, () => {
    const seed = buildDemoSeed(config);
    assert.deepEqual(buildDemoSeed(structuredClone(config)), seed);
    assert.equal(seed.products.length, new Set(editorProducts(config).map(product => product.groupKey)).size);
    assert.equal(seed.priceLists[0]!.currency, config.market.currency);
    const ids = [...seed.products, ...seed.skus, ...seed.priceLists, ...seed.prices].map(row => row.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const [index, product] of config.offer.products.entries()) {
      assert.equal(seed.products[index]!.name, product.name.en);
      assert.equal(seed.products[index]!.description, product.description.en);
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
    assert.equal(first.calls[0]!.text, 'BEGIN');
    assert.equal(first.calls.at(-1)!.text, 'COMMIT');
    const inserts = first.calls.filter(call => call.text.startsWith('INSERT INTO public.'));
    assert.equal(inserts.length, buildDemoSeed(config).products.length + buildDemoSeed(config).skus.length * 2 + buildDemoSeed(config).documents.length + buildDemoSeed(config).settings.length + seedPriceCount(config) + 3);
    for (const call of inserts) {
      assert.match(call.text, /ON CONFLICT/);
      assert.match(call.text, /INSERT INTO public\.(catalog_products|catalog_skus|price_lists|price_entries|catalog_product_document_revisions|catalog_sku_identifiers|commerce_settings|subscription_price_policy_revisions|commerce_promotion_definitions)\b/);
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
  await assert.rejects(applyDemoSeed(Object.values(configurations)[0]!, fixture.binding), { message: 'starter_price_seed_conflict' });
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
