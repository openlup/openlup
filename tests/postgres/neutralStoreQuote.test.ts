/** Installed engine and seed witness; subscription admission/activation retain their explicit predecessors. */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from '../helpers/postgresContainer.js';

let scratch: string;
let consumer: string;
let migrations: typeof import('@openlup/platform/migrations');
const containers: PostgresContainer[] = [];
const pools: Pool[] = [];
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error('Starter quote proof requires real PostgreSQL');
  mkdirSync(resolve('.context/scratch'), { recursive: true });
  scratch = mkdtempSync(resolve('.context/scratch/starter-quote-'));
  const closure = new Set<string>();
  function visit(directory: string) {
    if (closure.has(directory)) return;
    closure.add(directory);
    const manifest = JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));
    const local = createRequire(join(directory,'package.json'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (dependency.startsWith('@openlup/')) continue;
      const path = local.resolve.paths(dependency)?.map(base => join(base,dependency,'package.json')).find(existsSync);
      if (!path) throw new Error(`Missing locked dependency ${dependency}`);
      visit(dirname(path));
    }
  }
  for (const path of ['packages/core','packages/outbox','packages/platform','node_modules/pg','node_modules/zod']) visit(resolve(path));
  const tarballs = [...closure].map(cwd => {
    const result = JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',scratch], { cwd,encoding: 'utf8',timeout: 30_000 }));
    return join(scratch,result[0].filename);
  });
  consumer = join(scratch,'consumer'); mkdirSync(consumer);
  writeFileSync(join(consumer,'package.json'),'{"private":true,"type":"module"}');
  cpSync('.npmrc',join(consumer,'.npmrc'));
  execFileSync('npm',['install','--ignore-scripts','--offline','--no-audit','--no-fund','--legacy-peer-deps',...tarballs], { cwd: consumer,stdio: 'pipe',timeout: 120_000 });
  const own = JSON.parse(readFileSync('examples/neutral-store/ownership.json','utf8'));
  for (const file of [...own.owned,...own.managed]) {
    const from = own.sourceMappings?.[file] ?? file;
    const target = join(consumer,'application',file); mkdirSync(dirname(target),{ recursive: true });
    cpSync(join('examples/neutral-store',from),target);
  }
  const installed = createRequire(join(consumer,'package.json'));
  expect(installed.resolve('@openlup/platform/migrations').startsWith(join(consumer,'node_modules'))).toBe(true);
  migrations = await import(pathToFileURL(installed.resolve('@openlup/platform/migrations')).href);
}, postgresSetupTimeoutMs);
afterAll(async () => {
  try { await closePostgres(containers,pools); }
  finally { if (scratch) rmSync(scratch,{ recursive: true,force: true }); }
}, postgresTeardownTimeoutMs);

for (const configuration of ['supplements','coffee']) it(`${configuration}: installed seed, strict quotes, capability refusal and retained-promise acceptance`, async () => {
  const container = await runPostgresContainer({ name: `starter-quote-${configuration}-${process.pid}`,database: 'neutral_store',password: 'synthetic-conformance' });
  containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error('Starter quote PostgreSQL unavailable');
  const owner = new Pool({ connectionString: container.connectionString }); pools.push(owner);
  for (const role of ['starter_runtime','starter_restore']) await owner.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
  const selection = { generation: 'qualified-v2',roleMode: 'installer-managed',migrationLogin: 'postgres',bootstrapLogin: 'postgres',runtimeLogin: 'starter_runtime',restoreLogin: 'starter_restore' } as const;
  const migration = new Pool({ connectionString: container.connectionString,options: migrations.qualifiedPostgresStartupOptions(selection) });pools.push(migration);
  const runner = migrations.createPlatformPostgresMigrationRunner({ connectionString: container.connectionString }, { installation: selection,poolFactory: () => migration });
  await runner.apply();expect((await runner.status()).pending).toEqual([]);
  await owner.query("COMMENT ON DATABASE neutral_store IS 'openlup-neutral-store-demo-v1'");
  const runtime = new URL(container.connectionString);runtime.username = 'starter_runtime';runtime.password = 'synthetic-conformance';
  const script = `
    import assert from 'node:assert/strict';
    import pg from 'pg';
    import {configurations} from './application/owned/store.config.ts';
    import {applyDemoSeed} from './application/installation/install.ts';
    import {createNativeQuoteService} from './application/host/quote-composition.ts';
    import {installedAcquisitionPredecessors} from './application/host/acquisition-predecessors.ts';
    const config = structuredClone(configurations[fixture.configuration]);
    config.offer.products[0].unitPrice.amountMinor = 1499;
    const owner = new pg.Pool({connectionString:fixture.ownerUrl});
    const runtime = new pg.Pool({connectionString:fixture.runtimeUrl});
    try {
      const install = {connection:owner,installRole:'postgres',runtimeRole:'starter_runtime',close:async()=>{}};
      await applyDemoSeed(config,install);await applyDemoSeed(config,install);
      assert.equal(Number((await owner.query('SELECT count(*) AS n FROM public.subscription_price_policy_revisions')).rows[0].n),1);
      assert.equal(Number((await owner.query('SELECT count(*) AS n FROM public.commerce_promotion_definitions')).rows[0].n),1);
      const identity = (await runtime.query('SELECT session_user,current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
      assert.equal(identity.session_user,'starter_runtime');assert.equal(identity.current_user,'starter_runtime');assert.equal(identity.rolsuper,false);assert.equal(identity.rolbypassrls,false);
      await assert.rejects(runtime.query('UPDATE public.commerce_promotion_definitions SET active=false WHERE false'),e=>e.code==='42501');
      const context = {config,actor:{customerRef:null,operatorRef:null},commandKey:'quote-fixture-command-0001'};
      const cart = {schemaVersion:1,configuration:config.id,mode:'subscription',cadenceDays:config.offer.defaultCadenceDays,lines:[{sku:config.offer.products[0].sku,quantity:3}]};
      const input = {cart,acquisitionCapability:'subscription-acquisition.v1'};
      const quotes = createNativeQuoteService(runtime,installedAcquisitionPredecessors(),{current:'fixture-only-acceptance-key-00000000000000'});
      const before = (await owner.query('SELECT (SELECT count(*) FROM public.clients) AS clients,(SELECT count(*) FROM public.commerce_orders) AS orders,(SELECT count(*) FROM public.commerce_promotion_claims) AS claims,(SELECT count(*) FROM public.outbox_events) AS events')).rows;
      await assert.rejects(quotes.quote({cart},context),e=>e.reason==='acquisition_terms_capability_required');
      const current = await quotes.quote(input,context);
      const projection = quotes.public(current);
      assert.ok(Date.parse(projection.validUntil)>Date.now());
      assert.equal(Object.hasOwn(projection.acquisitionTerms,'sourcePromotionId'),false);
      assert.equal(current.snapshot.quote.lines[0].unitPriceGross.amountMinor,1420);
      assert.equal(current.snapshot.quote.subtotalGross.amountMinor,4260);
      assert.ok(current.snapshot.quote.discountTotalGross.amountMinor>0);
      assert.equal(current.terms.initialDiscountBps,2400);assert.equal(current.terms.delivery2DiscountBps,1200);
      assert.equal(current.projection.secondTotalMinor,3958);
      quotes.verify(current,{quoteAcceptance:current.token,expectedTotal:current.snapshot.quote.totalGross});
      await owner.query("UPDATE public.commerce_promotion_definitions SET definition=jsonb_set(definition,'{applies_to_payload,acquisitionTerms,delivery2DiscountBps}','1300')");
      const changed = await quotes.quote(input,context);
      assert.deepEqual(changed.snapshot.quote.totalGross,current.snapshot.quote.totalGross);
      assert.throws(()=>quotes.verify(changed,{quoteAcceptance:current.token,expectedTotal:current.snapshot.quote.totalGross}),/starter_quote_refresh_required/);
      const after = (await owner.query('SELECT (SELECT count(*) FROM public.clients) AS clients,(SELECT count(*) FROM public.commerce_orders) AS orders,(SELECT count(*) FROM public.commerce_promotion_claims) AS claims,(SELECT count(*) FROM public.outbox_events) AS events')).rows;
      assert.deepEqual(after,before);
      const one = await quotes.quote({cart:{...cart,mode:'one_time',cadenceDays:null}},context);
      assert.equal(one.snapshot.quote.totalGross.amountMinor,4497);assert.equal(one.snapshot.quote.discounts.length,0);
      const altered = structuredClone(config);altered.offer.subscriptionDiscountBps=700;altered.offer.subscriptionRoundingQuantumMinor=25;
      await assert.rejects(applyDemoSeed(altered,install),/starter_price_seed_conflict/);
      assert.equal(Number((await owner.query('SELECT count(*) AS n FROM public.subscription_price_policy_revisions')).rows[0].n),1);
      const rotated = structuredClone(config);rotated.quote.policy.revisionNo=2;
      await assert.rejects(applyDemoSeed(rotated,install),/starter_policy_seed_conflict/);
      const physical = structuredClone(config);physical.offer.products[0].physical.netWeightG++;
      await assert.rejects(applyDemoSeed(physical,install),/starter_document_seed_conflict/);
      console.log(JSON.stringify({configuration:config.id,unit:1420,subtotal:4260,second:3958,capabilityRefused:true,secondPromiseRefresh:true}));
    } finally {await runtime.end();await owner.end();}
  `;
  writeFileSync(join(consumer,'scenario.mjs'),`const fixture = ${JSON.stringify({ configuration,ownerUrl: container.connectionString,runtimeUrl: runtime.toString() })};\n${script}`);
  let output: string;
  try { output = execFileSync(process.execPath,['--experimental-strip-types','scenario.mjs'], { cwd: consumer,encoding: 'utf8',timeout: 20_000 }); }
  catch (error) { throw new Error((error as { stderr?: Buffer }).stderr?.toString() ?? 'Starter quote child failed',{ cause: error }); }
  expect(JSON.parse(output.trim())).toMatchObject({ configuration,unit: 1420,subtotal: 4260,second: 3958,capabilityRefused: true,secondPromiseRefresh: true });
}, 30_000);
