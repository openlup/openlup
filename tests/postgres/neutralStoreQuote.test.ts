/** Installed engine and seed witness; subscription admission/activation retain their explicit predecessors. */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { env as processEnv } from 'node:process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolConfig } from 'pg';
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from '../helpers/postgresContainer.js';
import { packWorkspaceTarballs } from '../helpers/packWorkspaceTarball.js';

let scratch: string;
let consumer: string;
let migrations: typeof import('@openlup/platform/migrations');
const scenarioHelper = pathToFileURL(resolve('tests/helpers/neutralStoreScenario.mjs')).href;
async function prepareQuoteConsumer() {
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
  const tarballs = await packWorkspaceTarballs([...closure], scratch, { timeoutMs: 30_000 });
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
}

function removeQuoteConsumer() {
  if (scratch) rmSync(scratch,{ recursive: true,force: true });
}

const shippingScript = String.raw`
  import assert from 'node:assert/strict';
  import pg from 'pg';
  import {bindScenarioServer} from ${JSON.stringify(scenarioHelper)};
  import {configurations} from './application/owned/store.config.ts';
  import {composeNativeBindings} from './application/host/native-composition.ts';
  import {createOriginPolicy} from './application/host/origin-policy.ts';
  import {composeRenewalSandbox} from './application/host/renewal-sandbox.ts';
  import * as api from '@openlup/platform/subscriptions';
  import {createPostgresRenewalReservationPort} from '@openlup/platform/inventory';
  const config = structuredClone(configurations[fixture.configuration]);
  config.offer.products[0].unitPrice.amountMinor = 1499;
  config.offer.shippingMinor = 640;
  configurations[fixture.configuration] = config;
  const {server,port,base} = await bindScenarioServer();
  const {createApplication} = await import('./application/host/server.ts');
  const owner = new pg.Pool({connectionString:fixture.ownerUrl});
  const runtime = new pg.Pool({connectionString:fixture.runtimeUrl});
  const bindings = await composeNativeBindings(fixture.runtimeUrl,createOriginPolicy(config,port),config,{current:'fixture-only-acceptance-key-00000000000000'});
  server.on('request',createApplication(bindings).listeners('request')[0]);
  try {
    const call = async (operation,payload,key=crypto.randomUUID()) => {
      const response = await fetch(base+'/api/actions/'+operation,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Starter-Request':'1','Idempotency-Key':key},body:JSON.stringify(payload)});
      const body = await response.json();assert.equal(body.ok,true,body.code);return body;
    };
    const cart = {schemaVersion:1,configuration:config.id,mode:'one_time',cadenceDays:null,lines:[{sku:config.offer.products[0].sku,quantity:3}]};
    const input = {locale:'en',configuration:config.id,country:config.market.country,termsAccepted:true,termsRevision:config.legal.revision,
      email:'shipping-'+crypto.randomUUID()+'@example.test',firstName:'Example',lastName:'Buyer',phone:'00000',line1:'1 Example Lane',city:'Example',postalCode:'00000',cart,acquisitionCapability:'subscription-acquisition.v1'};
    const money = async id => (await owner.query(\`SELECT o.total_amount_minor::integer AS total,
      (SELECT sum(line_amount_minor)::integer FROM public.commerce_order_items WHERE order_id=o.id) AS products,
      (SELECT coalesce(sum(amount_minor),0)::integer FROM public.commerce_order_adjustments WHERE order_id=o.id AND kind='shipping_charge') AS shipping,
      (SELECT count(*)::integer FROM public.commerce_order_adjustments WHERE order_id=o.id AND kind='shipping_charge') AS charges
      FROM public.commerce_orders o WHERE o.id=$1\`,[id])).rows[0];
    // Equality and above run first so the removed comparison fails this boundary.
    for (const [threshold,shipping] of [[4497,0],[4496,0],[4498,640]]) {
      config.offer.freeShippingFromMinor=threshold;
      const view=(await call('offer.validate',input)).value;
      assert.equal(view.shippingMinor,shipping,'shipping_boundary');assert.equal(view.totalMinor,4497+shipping);
      const made=(await call('checkout.create',{...input,quoteAcceptance:view.quoteAcceptance,expectedTotal:view.expectedTotal})).value;
      assert.equal(made.total.amountMinor,view.totalMinor);
      assert.deepEqual(await money(made.orderRef),{total:view.totalMinor,products:4497,shipping,charges:shipping?1:0});
    }
    config.offer.freeShippingFromMinor=4000;
    const promotionId='shipping-product-'+crypto.randomUUID();
    const definition={id:promotionId,name:'Product savings',status:'active',code:null,trigger_type:'automatic',discount_type:'percentage',discount_value:20,
      applies_to_kind:'order_total',applies_to_payload:{cart_mode:'one_time'},stacking_rule:'exclusive',eligibility:{},region_availability:[config.market.country],
      valid_from:'2000-01-01T00:00:00.000Z',valid_to:null,redemption_limit_global:null,redemption_limit_per_customer:null,
      promotion_engine_version:'promotion-engine.v2',benefit_lane:'product',benefit_kind:'target_percentage',benefit_value_bps:2000,benefit_value_minor:null,v2_mirror_of:null};
    await owner.query('INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active) VALUES($1,$2,true)',[promotionId,definition]);
    try {
      const discounted=(await call('offer.validate',input)).value;
      assert.equal(discounted.subtotalMinor,4497);assert.ok(discounted.discountMinor>0);
      const products=discounted.subtotalMinor-discounted.discountMinor;
      assert.ok(products<4000);assert.equal(discounted.shippingMinor,640);
      const discountedOrder=(await call('checkout.create',input)).value;
      assert.equal(discountedOrder.total.amountMinor,discounted.totalMinor);
      assert.deepEqual(await money(discountedOrder.orderRef),{total:products+640,products,shipping:640,charges:1});
    } finally {await owner.query('UPDATE public.commerce_promotion_definitions SET active=false WHERE promotion_id=$1',[promotionId]);}
    const subscription={...input,cart:{...cart,mode:'subscription',cadenceDays:config.offer.defaultCadenceDays}};
    const view=(await call('offer.validate',subscription)).value;
    assert.equal(view.subtotalMinor,4260);assert.ok(view.subtotalMinor>=4000);
    assert.ok(view.subtotalMinor-view.discountMinor<4000);assert.equal(view.shippingMinor,640);
    assert.equal(view.secondTotalMinor,3958+640);
    const made=(await call('checkout.create',{...subscription,quoteAcceptance:view.quoteAcceptance,expectedTotal:view.expectedTotal})).value;
    assert.equal(made.total.amountMinor,view.totalMinor);
    assert.deepEqual(await money(made.orderRef),{total:view.totalMinor,products:view.subtotalMinor-view.discountMinor,shipping:640,charges:1});
    const agreement=view.quote.quote.context.shippingTerms;
    config.offer.shippingMinor=17;config.offer.freeShippingFromMinor=0;
    const paid=(await call('payment.simulate',{orderRef:made.orderRef,token:made.token,outcome:'captured'})).value;
    assert.equal(paid.renewalAttachment,'complete');
    const attachment=(await owner.query('SELECT subscription_id,purchase_facts FROM public.subscription_renewal_attachments WHERE order_id=$1',[made.orderRef])).rows[0];
    assert.deepEqual(attachment.purchase_facts.renewalTerms.shippingTerms,agreement,'retained_shipping_agreement');
    assert.equal(attachment.purchase_facts.shippingAmountMinor,640);
    const withTransaction=async work=>{const db=await runtime.connect();try{await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}};
    const codec=api.createNativeRenewalCodec(),store=api.createPostgresRenewalStore(runtime,codec,withTransaction);
    const at='2030-01-01T00:00:00.000Z';
    const sandbox=composeRenewalSandbox({executor:runtime,withTransaction,codec,config:{...config.renewal,sandbox:{initial:'succeeded',retry:'succeeded'}},now:()=>at,failureTemplate:'failed',recoveredTemplate:'recovered',recoveryPath:'/recover'});
    await sandbox.refresh();
    const deps={store,settlement:api.createPostgresRenewalSettlementPort(runtime,codec,withTransaction),inventory:createPostgresRenewalReservationPort(runtime),paymentRails:sandbox.paymentRails,policy:sandbox.policy,workerId:'shipping-proof'};
    const due=(await store.listDue(100,at)).find(row=>row.subscriptionId===attachment.subscription_id);assert.ok(due);
    const result=await api.runOneAutomaticSubscriptionRenewal(deps,due,at);assert.equal(result.status,'succeeded');
    const operation=await store.readRenewal(result.identityKey);
    assert.equal(operation.cycleSnapshot.pricingSnapshot.shippingAmountMinor,640,'frozen_shipping_amount');
    assert.equal(operation.cycleSnapshot.pricingSnapshot.totalAmountMinor,view.secondTotalMinor);
    assert.deepEqual(operation.cycleSnapshot.pricingSnapshot.shippingTerms,agreement);
    const before=await money(operation.orderId);
    assert.deepEqual(before,{total:view.secondTotalMinor,products:3958,shipping:640,charges:1});
    assert.equal((await api.runOneAutomaticSubscriptionRenewal(deps,due,at)).status,'terminal_replay');
    assert.deepEqual(await money(operation.orderId),before);
    // An enrolled customer has no acquisition offer; the ordinary activation
    // branch must retain the same shipping agreement as well.
    config.offer.shippingMinor=640;config.offer.freeShippingFromMinor=4000;
    const ordinary={...subscription,cart:{...subscription.cart,lines:[{sku:cart.lines[0].sku,quantity:1}]}};
    const ordinaryView=(await call('offer.validate',ordinary)).value;assert.equal(ordinaryView.acquisitionTerms,undefined);
    const ordinaryOrder=(await call('checkout.create',ordinary)).value;
    config.offer.shippingMinor=19;config.offer.freeShippingFromMinor=0;
    assert.equal((await call('payment.simulate',{orderRef:ordinaryOrder.orderRef,token:ordinaryOrder.token,outcome:'captured'})).value.renewalAttachment,'complete');
    const ordinaryTerms=(await owner.query('SELECT subscription_id,purchase_facts FROM public.subscription_renewal_attachments WHERE order_id=$1',[ordinaryOrder.orderRef])).rows[0];
    assert.deepEqual(ordinaryTerms.purchase_facts.renewalTerms.shippingTerms,ordinaryView.quote.quote.context.shippingTerms);
    assert.equal(ordinaryTerms.purchase_facts.shippingAmountMinor,640);
    await sandbox.refresh();
    const ordinaryDue=(await store.listDue(100,at)).find(row=>row.subscriptionId===ordinaryTerms.subscription_id);assert.ok(ordinaryDue);
    const ordinaryResult=await api.runOneAutomaticSubscriptionRenewal(deps,ordinaryDue,at);assert.equal(ordinaryResult.status,'succeeded');
    const ordinaryOperation=await store.readRenewal(ordinaryResult.identityKey);
    assert.deepEqual(await money(ordinaryOperation.orderId),{total:2060,products:1420,shipping:640,charges:1});
    console.log(JSON.stringify({shippingBoundary:true,discountCrossing:true,quoteOrderAgreement:true,retainedRenewal:true,replay:true}));
  } finally {await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});await bindings.close();await runtime.end();await owner.end();}
`;

const quoteDatabase = {
  start: runPostgresContainer,
  ready: waitForPostgresTcpReady,
  pool: (options: PoolConfig) => new Pool(options),
  async createRole(owner: Pool, role: string) {
    await owner.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
  },
};

const bundleProof = String.raw`
  import assert from 'node:assert/strict';
  import pg from 'pg';
  import {bindScenarioServer} from ${JSON.stringify(scenarioHelper)};
  import {selectConfiguration} from './application/owned/store.config.ts';
  import {applyDemoSeed} from './application/installation/install.ts';
  import {composeNativeBindings} from './application/host/native-composition.ts';
  import {createOriginPolicy} from './application/host/origin-policy.ts';
  const config = selectConfiguration(fixture.configuration), coffee = config.id === 'coffee';
  const owner = new pg.Pool({connectionString:fixture.ownerUrl}), runtime = new pg.Pool({connectionString:fixture.runtimeUrl});
  const {server,base,port}=await bindScenarioServer();
  const {createApplication}=await import('./application/host/server.ts');
  let bindings;
  try {
    const db = await owner.connect();
    const seed = async owned => applyDemoSeed(owned,{connection:db,installRole:'postgres',runtimeRole:'starter_runtime',close:async()=>{}});
    const id = 'demo-bundle:'+config.id;
    const promotion = async () => (await owner.query('SELECT definition,definition_fingerprint,active FROM public.commerce_promotion_definitions WHERE promotion_id=$1',[id])).rows;
    try {
      await seed(config);
      const installed = await promotion();
      await seed(config);
      assert.deepEqual(await promotion(),installed);
      const original = installed[0].definition;
      assert.deepEqual(original,{id,name:'Demo one-time bundle',status:'active',trigger_type:'automatic',code:null,
        discount_type:'percentage',discount_value:5,applies_to_kind:'order_total',applies_to_payload:{cart_mode:'one_time'},
        stacking_rule:'stackable_with_any',eligibility:{min_cart_minor:12000},region_availability:[config.market.country],
        valid_from:'2000-01-01T00:00:00.000Z',valid_to:null,promotion_engine_version:'promotion-engine.v1',
        benefit_lane:'product',benefit_kind:'percentage',benefit_value_bps:500,benefit_value_minor:null,
        v2_mirror_of:null,redemption_limit_global:null,redemption_limit_per_customer:null});
      for (const path of [['other'],['applies_to_payload','other'],['eligibility','other'],['region_availability','0']]) {
        await assert.rejects(runtime.query('UPDATE public.commerce_promotion_definitions SET definition=jsonb_set(definition,$2,$3) WHERE promotion_id=$1',
          [id,path,{other:true}]),error=>error.code==='42501');
      }
      await owner.query("UPDATE public.commerce_promotion_definitions SET definition=definition||'{\"other\":true}'::jsonb WHERE promotion_id=$1",[id]);
      const changed = structuredClone(config);
      changed.brand.name += ' altered';
      await assert.rejects(seed(changed),/starter_promotion_seed_conflict/);
      assert.deepEqual((await owner.query('SELECT name FROM public.price_lists')).rows,[{name:config.brand.name+' demonstration'}]);
      await owner.query('UPDATE public.commerce_promotion_definitions SET definition=$2 WHERE promotion_id=$1',[id,original]);
    } finally {db.release();}
    bindings=await composeNativeBindings(fixture.runtimeUrl,createOriginPolicy(config,port),config);
    server.on('request',createApplication(bindings).listeners('request')[0]);
    const call = async (operation,payload) => {
      const response=await fetch(base+'/api/actions/'+operation,{method:'POST',
        headers:{Origin:base,'Content-Type':'application/json','X-Starter-Request':'1','Idempotency-Key':crypto.randomUUID()},
        body:JSON.stringify(payload)});
      const result=await response.json();assert.equal(result.ok,true,result.code);return result.value;
    };
    const [first,second] = config.offer.products;
    const cart = lines => ({schemaVersion:1,configuration:config.id,mode:'one_time',cadenceDays:null,lines});
    const line = (product,quantity) => ({sku:product.sku,quantity});
    const quote = cart => call('offer.validate',{cart});
    const compare = async (lines,before,discount,restore=false) => {
      const request=cart(lines);
      await owner.query('UPDATE public.commerce_promotion_definitions SET active=false WHERE promotion_id=$1',[id]);
      const previous=await quote(request);
      await owner.query('UPDATE public.commerce_promotion_definitions SET active=true WHERE promotion_id=$1',[id]);
      const current=await quote(request);
      assert.deepEqual([previous.totalMinor,current.discountMinor,current.totalMinor],[before,discount,before-discount]);
      if (restore) {
        const data={locale:'en',configuration:config.id,country:config.market.country,termsAccepted:true,termsRevision:config.legal.revision,
          email:'bundle@example.test',firstName:'Example',lastName:'Buyer',phone:'00000',line1:'1 Example Lane',city:'Example',postalCode:'00000',
          cart:request,expectedTotal:previous.expectedTotal};
        const made=await call('checkout.create',data);
        assert.equal(made.total.amountMinor,current.totalMinor);
        const saved=(await owner.query('SELECT total_amount_minor::int AS total FROM public.commerce_orders WHERE id=$1',[made.orderRef])).rows[0];
        assert.equal(saved.total,current.totalMinor);
      }
      return [previous.totalMinor,current.discountMinor,current.totalMinor];
    };
    const observed = [await compare([line(first,coffee?1:3)],coffee?4200:11700,0)];
    const basePrice = 'UPDATE public.price_entries e SET unit_price_minor=$2 FROM public.catalog_skus s WHERE e.variant_id=s.id AND s.sku=$1 AND e.mode=\'one_time\'';
    try {
      for (const amount of [11999,12000,12001]) {
        await owner.query(basePrice,[first.sku,amount]);
        observed.push(await compare([line(first,1)],amount,amount===11999?0:600));
      }
    } finally { await owner.query(basePrice,[first.sku,first.unitPrice.amountMinor]); }
    observed.push(coffee ? await compare([line(first,3)],12600,630,true)
      : await compare([line(first,1),line(second,2)],12900,645,true));
    console.log(JSON.stringify({configuration:config.id,beforeDiscountAfter:observed}));
  } finally {
    server.close();
    await Promise.all([bindings?.close(),owner.end(),runtime.end()]);
  }
`;

async function provisionQuoteCase(configuration: string, multiSize: boolean, containers: PostgresContainer[], pools: Pool[], database: typeof quoteDatabase, signal: AbortSignal) {
  const setupStarted = performance.now();
  // Opt-in reproduction of provisioning overrunning the existing 95 s case budget.
  if (configuration === 'supplements' && existsSync(resolve('.context/scratch/slow-quote-setup'))) {
    await delay(96_000, undefined, { signal });
  }
  signal.throwIfAborted();
  const bootStarted = performance.now();
  const container = await database.start({ name: `starter-quote-${configuration}-${multiSize ? "multi" : "single"}-${process.pid}`,database: 'neutral_store',password: 'synthetic-conformance' });
  if (signal.aborted) {
    // A start already in flight can return after the teardown snapshot.
    await container.remove();
    signal.throwIfAborted();
  }
  containers.push(container);
  const readyStarted = performance.now();
  const ready = await database.ready(container.connectionString);
  signal.throwIfAborted();
  if (!ready) throw new Error('Starter quote PostgreSQL unavailable');
  const migrationStarted = performance.now();
  const owner = database.pool({ connectionString: container.connectionString }); pools.push(owner);
  for (const role of ['starter_runtime','starter_restore']) {
    await database.createRole(owner, role);
    signal.throwIfAborted();
  }
  const selection = { generation: 'qualified-v2',roleMode: 'installer-managed',migrationLogin: 'postgres',bootstrapLogin: 'postgres',runtimeLogin: 'starter_runtime',restoreLogin: 'starter_restore' } as const;
  const migration = database.pool({ connectionString: container.connectionString,options: migrations.qualifiedPostgresStartupOptions(selection) });pools.push(migration);
  const runner = migrations.createPlatformPostgresMigrationRunner({ connectionString: container.connectionString }, {
    installation: selection,
    poolFactory: () => { signal.throwIfAborted(); return migration; },
  });
  await runner.apply();
  signal.throwIfAborted();
  const status = await runner.status();
  signal.throwIfAborted();
  expect(status.pending).toEqual([]);
  await owner.query("COMMENT ON DATABASE neutral_store IS 'openlup-neutral-store-demo-v1'");
  signal.throwIfAborted();
  const runtime = new URL(container.connectionString);runtime.username = 'starter_runtime';runtime.password = 'synthetic-conformance';
  const migrationFinished = performance.now();
  console.info(JSON.stringify({ configuration, multiSize, setupMs: migrationFinished - setupStarted,
    bootMs: readyStarted - bootStarted, readyMs: migrationStarted - readyStarted, migrationMs: migrationFinished - migrationStarted }));
  return { configuration, multiSize, ownerUrl: container.connectionString, runtimeUrl: runtime.toString() };
}

// Product documents and labels captured before replacing the owned physical input.
const retainedDocuments = { supplements: [
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
], coffee: [
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
] };

const retainedLabels = {
  supplements: [
    ['Dawn', 'A fictional supplement in a simple amber container.'],
    ['Noon', 'A fictional supplement with a pale green label.'],
    ['Dusk', 'A fictional supplement with a muted blue label.'],
    ['Extra container', 'A fictional optional extra.'],
  ],
  coffee: [
    ['Light roast', 'A fictional light roast in a paper bag.'],
    ['Medium roast', 'A fictional medium roast for your demonstration box.'],
    ['Dark roast', 'A fictional dark roast with an illustrated label.'],
    ['Extra container', 'A fictional optional extra.'],
  ],
};

function runQuoteProof({ configuration, multiSize, ownerUrl, runtimeUrl }: Awaited<ReturnType<typeof provisionQuoteCase>>) {
  const proofStarted = performance.now();
  const script = String.raw`
    import assert from 'node:assert/strict';
    import pg from 'pg';
    import {createHash} from 'node:crypto';
    import {bindScenarioServer} from ${JSON.stringify(scenarioHelper)};
    import * as awaitedPricing from '@openlup/platform/pricing';
    import {configurations} from './application/owned/store.config.ts';
    import {applyDemoSeed} from './application/installation/install.ts';
    import {createNativeQuoteService} from './application/host/quote-composition.ts';
    import {installedAcquisitionPredecessors} from './application/host/acquisition-predecessors.ts';
    const config = structuredClone(configurations[fixture.configuration]);
    const acquisition = 'demo-acquisition:'+config.id;
    config.offer.products[0].unitPrice.amountMinor = 1499;
    if (fixture.multiSize) {
      const large = structuredClone(config.subscriptionEditing.catalogue.find(row => row.sku === config.offer.products[0].sku + '-L'));
      large.unitPrice.amountMinor = 2998;
      large.physical = {netContent:{dimension:'mass',unit:'openlup:g',unscaled:'500',scale:0},
        primaryUnitIdentifier:{scheme:'gs1:gtin',issuer:'fixture-large',value:'0000000000109'}};
      config.offer.products.push(large);
      config.purchase.stock.quantities[large.sku]=1000;
    }
    const owner = new pg.Pool({connectionString:fixture.ownerUrl});
    const runtime = new pg.Pool({connectionString:fixture.runtimeUrl});
    try {
      const install = {connection:owner,installRole:'postgres',runtimeRole:'starter_runtime',stock:(await import('@openlup/platform/fulfillment')).createPostgresFulfillmentStockSyncPort(runtime,{sourceKey:'starter-demo:'+config.id,readLocalInventoryStock:async()=>[]}),close:async()=>{}};
      async function retainedRows() {
        return (await owner.query(\`SELECT p.id AS product_id,p.slug,p.name,p.description,p.primary_sku_id,p.current_document_revision_id,
          r.schema_id,r.revision_no,r.document_ref,r.source_ref,r.document_payload::text AS payload,r.digest,
          s.id AS sku_id,s.sku,s.title,s.net_weight_g,i.id AS identifier_id,i.issuer,i.normalized_value,i.identifier_kind,
          i.pack_kind,i.quantity,i.is_primary FROM public.catalog_products p
          JOIN public.catalog_product_document_revisions r ON r.id=p.current_document_revision_id
          JOIN public.catalog_skus s ON s.product_id=p.id JOIN public.catalog_sku_identifiers i ON i.catalog_sku_id=s.id
          ORDER BY s.id,i.id\`)).rows;
      }
      if (fixture.retained) {
        for (const [index,[revisionId,productId,productSlug,digest,rows]] of fixture.retained.entries()) {
          const [name,description] = fixture.labels[index];
          const variants = rows.map(([skuId,sku,physical,demandPerUnit,exclusions]) =>
            ({skuId,sku,physical,demandPerUnit,exclusions}));
          const document = {schemaVersion:'neutral-store-product.v1',productId,productSlug,revisionNo:1,
            sourceRef:'demonstration-catalogue-v1',variants};
          await owner.query('INSERT INTO public.catalog_products(id,slug,name,description) VALUES($1,$2,$3,$4)',
            [productId,productSlug,name,description]);
          for (const variant of variants) {
            const {skuId,sku,physical:{netWeightG,issuer,unitGtin}} = variant;
            await owner.query('INSERT INTO public.catalog_skus(id,product_id,sku,title,net_weight_g) VALUES($1,$2,$3,$4,$5)',
              [skuId,productId,sku,name,netWeightG]);
            await owner.query(\`INSERT INTO public.catalog_sku_identifiers
              (catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,is_primary)
              VALUES($1,$2,'gtin',$3,'unit',1,true)\`,[skuId,issuer,unitGtin]);
          }
          await owner.query(\`INSERT INTO public.catalog_product_document_revisions
            (id,product_id,revision_no,schema_id,document_ref,document_payload,provenance,source_ref,digest)
            VALUES($1,$2,1,$3,$4,$5,'{}',$6,$7)\`,[revisionId,productId,document.schemaVersion,
            'demo-document:'+config.id+':'+revisionId,document,document.sourceRef,digest]);
          await owner.query('UPDATE public.catalog_products SET primary_sku_id=$2,current_document_revision_id=$3 WHERE id=$1',
            [productId,variants[0].skuId,revisionId]);
        }
      }
      const predecessor = fixture.retained ? await retainedRows() : undefined;
      if (predecessor) assert.equal(predecessor.length,7);
      await applyDemoSeed(config,install);
      if (predecessor) assert.deepEqual(await retainedRows(),predecessor);
      await applyDemoSeed(config,install);
      if (predecessor) assert.deepEqual(await retainedRows(),predecessor);
      assert.equal(Number((await owner.query('SELECT count(*) AS n FROM public.subscription_price_policy_revisions')).rows[0].n),1);
      assert.equal(Number((await owner.query('SELECT count(*) AS n FROM public.commerce_promotion_definitions')).rows[0].n),2);
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
      await owner.query("UPDATE public.commerce_promotion_definitions SET definition=jsonb_set(definition,'{applies_to_payload,acquisitionTerms,delivery2DiscountBps}','1300') WHERE promotion_id=$1",[acquisition]);
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
      const physical = structuredClone(config);
      const content = physical.offer.products[0].physical.netContent;
      content.unscaled=String(Number(content.unscaled)+1);
      physical.offer.products[0].title='Rolled back title';
      const beforeWeightChange = await retainedRows();
      await assert.rejects(applyDemoSeed(physical,install),/starter_document_seed_conflict/);
      assert.deepEqual(await retainedRows(),beforeWeightChange);
      await owner.query("UPDATE public.commerce_promotion_definitions SET definition=jsonb_set(definition,'{applies_to_payload,acquisitionTerms,delivery2DiscountBps}',$1::jsonb) WHERE promotion_id=$2",[JSON.stringify(config.quote.acquisition.delivery2DiscountBps),acquisition]);
      configurations[fixture.configuration] = config;
      const {server,port,base}=await bindScenarioServer();
      const {createApplication}=await import('./application/host/server.ts');
      const {composeNativeBindings}=await import('./application/host/native-composition.ts');
      const {createOriginPolicy}=await import('./application/host/origin-policy.ts');
      const keyring={current:'fixture-only-acceptance-key-00000000000000'};
      const bindings=await composeNativeBindings(fixture.runtimeUrl,createOriginPolicy(config,port),config,keyring);
      server.on('request',createApplication(bindings).listeners('request')[0]);
      try {
        const call=async(operation,payload,key=crypto.randomUUID())=>{
          const response=await fetch(base+'/api/actions/'+operation,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Starter-Request':'1','Idempotency-Key':key},body:JSON.stringify(payload)});
          return {body:await response.json(),cookie:response.headers.get('set-cookie')};
        };
        const names=(await owner.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename);
        const graphSql=names.map(name=>"SELECT '"+name+"' AS name,coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'version',t.xmin::text) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."+JSON.stringify(name)+' t').join(' UNION ALL ')+' ORDER BY name';
        const graph=async()=>(await owner.query(graphSql)).rows.map(row=>({name:row.name,sha256:createHash('sha256').update(JSON.stringify(row.rows)).digest('hex')}));
        const refused=async(operation,payload,code,key)=>{const before=await graph();const response=(await call(operation,payload,key)).body;assert.deepEqual(response,{ok:false,code});assert.deepEqual(await graph(),before);};
        const input={locale:'en',configuration:config.id,country:config.market.country,termsAccepted:true,termsRevision:config.legal.revision,
          email:'capture-'+config.id+'@example.test',firstName:'Example',lastName:'Buyer',phone:'00000',line1:'1 Example Lane',city:'Example',postalCode:'00000',
          cart,acquisitionCapability:'subscription-acquisition.v1'};
        const quote=async(payload)=>{const response=(await call('offer.validate',payload)).body;assert.equal(response.ok,true,response.code);assert.equal(JSON.stringify(response).includes('starterRenewalTerms'),false);return response.value;};
        const observed=await quote(input);assert.ok(observed.discountMinor>0);
        const accepted={...input,quoteAcceptance:observed.quoteAcceptance,expectedTotal:observed.expectedTotal};
        const incapable={...input};delete incapable.acquisitionCapability;
        await refused('offer.validate',incapable,'acquisition_terms_capability_required');
        await refused('checkout.create',incapable,'acquisition_terms_capability_required');
        await refused('checkout.create',{...accepted,cart:{...cart,lines:[{...cart.lines[0],quantity:4}]}},'starter_quote_refresh_required');
        await owner.query("UPDATE public.commerce_promotion_definitions SET definition=jsonb_set(definition,'{applies_to_payload,acquisitionTerms,delivery2DiscountBps}','1300') WHERE promotion_id=$1",[acquisition]);
        await refused('checkout.create',accepted,'starter_quote_refresh_required');
        await owner.query("UPDATE public.commerce_promotion_definitions SET definition=jsonb_set(definition,'{applies_to_payload,acquisitionTerms,delivery2DiscountBps}',$1::jsonb) WHERE promotion_id=$2",[JSON.stringify(config.quote.acquisition.delivery2DiscountBps),acquisition]);
        const minimum=config.quote.acquisition.minimumProductPayableMinor;
        config.quote.acquisition.minimumProductPayableMinor=minimum+1;
        try {await refused('checkout.create',accepted,'starter_quote_refresh_required');} finally {config.quote.acquisition.minimumProductPayableMinor=minimum;}
        const graduation=config.quote.acquisition.graduationCadenceDays;
        const {choices}=await import('./application/shared/subscription-offer.ts');
        config.quote.acquisition.graduationCadenceDays=choices(config.subscriptionOffers.classic.days).find(value=>value!==graduation);
        try {await refused('checkout.create',accepted,'starter_quote_refresh_required');} finally {config.quote.acquisition.graduationCadenceDays=graduation;}
        const key=crypto.randomUUID();const made=(await call('checkout.create',accepted,key)).body;
        assert.equal(made.ok,true,made.code);assert.equal(made.replayed,false);
        const original=(await owner.query('SELECT metadata FROM public.commerce_orders WHERE id=$1',[made.value.orderRef])).rows[0].metadata;
        const saved=original.quoteSnapshot;
        assert.equal(saved.quote.lines[0].unitPriceGross.amountMinor,1420);
        assert.equal(saved.quote.context.starterRenewalTerms.linePricing[0].quoteLine.catalogFacts.version,'catalog_facts_v2');
        const beforeReplay=await graph();const replay=(await call('checkout.create',accepted,key)).body;
        assert.equal(replay.ok,true,replay.code);assert.equal(replay.replayed,true);assert.equal(replay.value.orderRef,made.value.orderRef);assert.deepEqual((await graph()).filter(row=>row.name!=='clients'),beforeReplay.filter(row=>row.name!=='clients'));
        await refused('checkout.create',{...accepted,cart:{...cart,lines:[{...cart.lines[0],quantity:4}]}},'starter_command_conflict',key);
        await refused('payment.simulate',{orderRef:crypto.randomUUID(),token:made.value.token,outcome:'captured'},'starter_order_not_found');
        const corrupt=structuredClone(original);delete corrupt.quoteSnapshot.quote.context.starterRenewalTerms.linePricing[0].quoteLine;
        await owner.query('UPDATE public.commerce_orders SET metadata=$2::jsonb WHERE id=$1',[made.value.orderRef,JSON.stringify(corrupt)]);
        await refused('payment.simulate',{orderRef:made.value.orderRef,token:made.value.token,outcome:'captured'},'starter_quote_refresh_required');
        await owner.query('UPDATE public.commerce_orders SET metadata=$2::jsonb WHERE id=$1',[made.value.orderRef,JSON.stringify(original)]);
        const paid=(await call('payment.simulate',{orderRef:made.value.orderRef.toUpperCase(),token:made.value.token,outcome:'captured'})).body;
        assert.equal(paid.ok,true,paid.code);assert.equal(paid.value.status,'paid');assert.equal(paid.value.renewalAttachment,'complete');
        const attachment=(await owner.query('SELECT subscription_id,purchase_facts,completed_at FROM public.subscription_renewal_attachments WHERE order_id=$1',[made.value.orderRef])).rows[0];
        assert.ok(attachment.completed_at);assert.equal(attachment.purchase_facts.lines[0].unitAmountMinor,1420);
        assert.deepEqual(attachment.purchase_facts.renewalTerms,saved.quote.context.starterRenewalTerms);
        const native=(await runtime.query('SELECT public.subscription_renewal_purchase_terms($1::uuid) AS facts',[attachment.subscription_id.toUpperCase()])).rows[0].facts;
        assert.deepEqual(native.renewalTerms,saved.quote.context.starterRenewalTerms);assert.equal(native.shippingAmountMinor,0);
        assert.equal(native.renewalTerms.minimumPayableMinor,minimum);assert.deepEqual(native.renewalTerms.normalCadenceDays,[graduation]);
        assert.equal(native.renewalTerms.starterPack.graduation.cadenceDays,graduation);
        assert.deepEqual(native.renewalTerms.starterPack.delivery2,{discountBps:config.quote.acquisition.delivery2DiscountBps,basisSubtotalMinor:4260,discountMinor:4260-observed.secondTotalMinor});
        const allocated=(await owner.query('SELECT unit_amount_minor::integer AS unit FROM public.commerce_order_items WHERE order_id=$1',[made.value.orderRef])).rows;
        assert.ok(allocated.some(line=>line.unit!==1420));
        await refused('payment.simulate',{orderRef:made.value.orderRef,token:made.value.token,outcome:'captured'},'starter_order_not_found');
        const linkedEmail='linked-capture-'+config.id+'@example.test';
        const linkedInput={...input,email:linkedEmail,cart:{...cart,mode:'one_time',cadenceDays:null}};
        const first=(await call('checkout.create',linkedInput)).body;assert.equal(first.ok,true,first.code);
        assert.equal((await call('payment.simulate',{orderRef:first.value.orderRef,token:first.value.token,outcome:'captured'})).body.ok,true);
        assert.equal((await call('auth.request',{email:linkedEmail})).body.ok,true);
        const messages=(await (await import('node:fs/promises')).readFile('.context/captured-messages/identity.jsonl','utf8')).trim().split(String.fromCharCode(10)).map(JSON.parse);
        const challenge=messages.filter(message=>message.email===linkedEmail).at(-1);assert.ok(challenge);
        assert.equal((await call('auth.verify',{token:challenge.token})).body.ok,true);
        const linked={...input,email:linkedEmail};const linkedQuote=await quote(linked);assert.ok(linkedQuote.discountMinor>0);
        const second=(await call('checkout.create',{...linked,quoteAcceptance:linkedQuote.quoteAcceptance,expectedTotal:linkedQuote.expectedTotal})).body;
        assert.equal(second.ok,true,second.code);assert.equal(/"(?:linked|created|clientId|principalId|email|account)"/.test(JSON.stringify(second)),false);
        const secondPaid=(await call('payment.simulate',{orderRef:second.value.orderRef,token:second.value.token,outcome:'captured'})).body;
        assert.equal(secondPaid.ok,true,secondPaid.code);assert.equal(secondPaid.value.renewalAttachment,'complete');
        if (fixture.multiSize) {
          const large = config.offer.products.at(-1);
          const largeInput = {...input,email:'multi-size@example.test',cart:{...cart,mode:'one_time',cadenceDays:null,lines:[{sku:large.sku,quantity:2}]}};
          const largeQuote = await quote(largeInput);
          assert.equal(largeQuote.totalMinor,5996);
          const largeOrder = (await call('checkout.create',largeInput)).body;
          assert.equal(largeOrder.ok,true,largeOrder.code);
          assert.equal(largeOrder.value.total.amountMinor,5996);
          const line = (await owner.query('SELECT i.sku_id,s.product_id,p.current_document_revision_id FROM public.commerce_order_items i JOIN public.catalog_skus s ON s.id=i.sku_id JOIN public.catalog_products p ON p.id=s.product_id WHERE i.order_id=$1',[largeOrder.value.orderRef])).rows[0];
          const original = (await owner.query('SELECT document_payload,digest FROM public.catalog_product_document_revisions WHERE id=$1',[line.current_document_revision_id])).rows[0];
          assert.equal(original.document_payload.variants.length,2);
          assert.equal(original.document_payload.variants.find(row=>row.sku===large.sku).skuId,line.sku_id);
          const primaryProduct = (await owner.query('SELECT product_id FROM public.catalog_skus WHERE sku=$1',[config.offer.products[0].sku])).rows[0];
          assert.equal(line.product_id,primaryProduct.product_id);
          const damaged = structuredClone(original.document_payload);
          damaged.variants = damaged.variants.filter(row=>row.sku!==large.sku);
          damaged.revisionNo++;
          const digest = (await import('./application/host/editor-catalogue.ts')).documentDigest(damaged);
          const next = (await owner.query("INSERT INTO public.catalog_product_document_revisions(product_id,revision_no,schema_id,document_ref,document_payload,provenance,source_ref,digest) VALUES($1,$2,$3,'fixture:missing-variant',$4,'{}',$5,$6) RETURNING id",[line.product_id,damaged.revisionNo,damaged.schemaVersion,damaged,damaged.sourceRef,digest])).rows[0].id;
          try {
            await owner.query('UPDATE public.catalog_products SET current_document_revision_id=$2 WHERE id=$1',[line.product_id,next]);
            await assert.rejects(quotes.quote(largeInput,context),e=>e instanceof (awaitedPricing.CommerceQuoteCatalogReadError) && e.code==='catalog_document_schema_invalid');
          } finally {await owner.query('UPDATE public.catalog_products SET current_document_revision_id=$2 WHERE id=$1',[line.product_id,line.current_document_revision_id]);}
        }
      } finally {await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});await bindings.close();}
      console.log(JSON.stringify({configuration:config.id,unit:1420,subtotal:4260,second:3958,capabilityRefused:true,secondPromiseRefresh:true,retainedCapture:true}));
    } finally {await runtime.end();await owner.end();}
  `;
  const demo = configuration as keyof typeof retainedDocuments;
  const retained = !multiSize ? retainedDocuments[demo] : undefined;
  writeFileSync(join(consumer,'scenario.mjs'),`const fixture = ${JSON.stringify({ configuration,multiSize,ownerUrl,runtimeUrl,
    retained, labels: retainedLabels[demo] })};\n${script.replaceAll('\\`','`')}`);
  const childStarted = performance.now();
  let output: string;
  try { output = execFileSync(process.execPath,['--experimental-strip-types','scenario.mjs','--configuration',configuration], { cwd: consumer,encoding: 'utf8',timeout: 20_000 }); }
  catch (error) { throw new Error((error as { stderr?: Buffer }).stderr?.toString() ?? 'Starter quote child failed',{ cause: error }); }
  expect(JSON.parse(output.trim())).toMatchObject({ configuration,unit: 1420,subtotal: 4260,second: 3958,capabilityRefused: true,secondPromiseRefresh: true,retainedCapture: true });
  writeFileSync(join(consumer,'shipping-scenario.mjs'),`const fixture = ${JSON.stringify({ configuration,ownerUrl,runtimeUrl })};\n${shippingScript.replaceAll('\\`','`')}`);
  const shippingRun = () => execFileSync(process.execPath,['--experimental-strip-types','shipping-scenario.mjs','--configuration',configuration], { cwd: consumer,encoding: 'utf8',timeout: 20_000,stdio: 'pipe' });
  let shippingOutput: string;
  try { shippingOutput = shippingRun(); }
  catch (error) { throw new Error((error as { stderr?: Buffer }).stderr?.toString() ?? 'Shipping child failed',{ cause: error }); }
  expect(JSON.parse(shippingOutput.trim())).toMatchObject({ shippingBoundary: true, discountCrossing: true, quoteOrderAgreement: true, retainedRenewal: true, replay: true });
  for (const mutation of [
    { path: join(consumer,'node_modules/@openlup/platform/dist/shipping/thresholdPolicy.js'),
      from: 'grossMinor: remainingMinor > 0 ? terms.flatMinor : 0',to: 'grossMinor: terms.flatMinor',failure: 'shipping_boundary' },
    { path: join(consumer,'application/host/acquisition-predecessors.ts'),
      from: 'renewalTerms };',to: 'renewalTerms: { ...renewalTerms, shippingTerms: undefined } };',failure: 'retained_shipping_agreement' },
  ]) {
    const original = readFileSync(mutation.path,'utf8');expect(original).toContain(mutation.from);
    try {
      writeFileSync(mutation.path,original.replace(mutation.from,mutation.to));
      let failure = '';
      try { shippingRun(); } catch (error) { failure = (error as { stderr?: Buffer }).stderr?.toString() ?? ''; }
      expect(failure).toContain(mutation.failure);
    } finally { writeFileSync(mutation.path,original); }
  }
  console.info(JSON.stringify({ configuration, multiSize, proofMs: performance.now() - proofStarted, childMs: performance.now() - childStarted }));
}

// Leave room in the 75 s teardown for 5 s of pool close and 60 s of Docker removal.
const quoteProvisioningJoinMs = 5_000;

function quoteCaseFixture(configuration: string, multiSize: boolean, database = quoteDatabase) {
  const containers: PostgresContainer[] = [];
  const pools: Pool[] = [];
  const controller = new AbortController();
  let provisioning: ReturnType<typeof provisionQuoteCase> | undefined;
  return {
    setup: () => provisioning = provisionQuoteCase(configuration, multiSize, containers, pools, database, controller.signal),
    async teardown() {
      // The signal's aborted flag also marks that cleanup owns the acquired resources.
      controller.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (provisioning) {
          const deadline = new Promise<void>(resolve => {
            timer = setTimeout(resolve, quoteProvisioningJoinMs);
          });
          await Promise.race([provisioning.catch(() => undefined), deadline]);
        }
      } finally {
        clearTimeout(timer);
        await closePostgres(containers, pools);
      }
    },
  };
}

function controlledContainer(remove: PostgresContainer['remove']): PostgresContainer {
  const connectionString = 'postgres://127.0.0.1/neutral_store';
  return { port: 5432, connectionString, connectionStringFor: () => connectionString, remove };
}

it('closes quote pools and removes the container while provisioning is still stalled', async () => {
  vi.useFakeTimers();
  let queryHeld!: () => void;
  let releaseQuery!: () => void;
  const held = new Promise<void>(resolve => { queryHeld = resolve; });
  const release = new Promise<void>(resolve => { releaseQuery = resolve; });
  const owner = new Pool();
  const close = vi.spyOn(owner, 'end');
  let setupSettled = false;
  let openAtRemoval: boolean | undefined;
  let settledAtRemoval: boolean | undefined;
  const remove = vi.fn(async () => {
    openAtRemoval = !owner.ended;
    settledAtRemoval = setupSettled;
  });
  const fixture = quoteCaseFixture('interrupted', false, {
    start: async () => controlledContainer(remove),
    ready: async () => true,
    pool: () => owner,
    async createRole(_owner, role) {
      if (role === 'starter_restore') {
        queryHeld();
        await release;
      }
    },
  });
  const setup = fixture.setup();
  const settled = setup.catch(() => undefined).then(() => { setupSettled = true; });
  let teardown: Promise<void> | undefined;
  try {
    await Promise.race([held, setup]);
    teardown = fixture.teardown();
    await vi.advanceTimersByTimeAsync(quoteProvisioningJoinMs);
    expect(close).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(openAtRemoval).toBe(false);
    expect(settledAtRemoval).toBe(false);
    await teardown;
    releaseQuery();
    await expect(setup).rejects.toMatchObject({ name: 'AbortError' });
  } finally {
    releaseQuery();
    try {
      await settled;
      await (teardown ?? fixture.teardown());
    } finally {
      vi.useRealTimers();
    }
  }
});

it('removes a quote container acquired after teardown completed', async () => {
  vi.useFakeTimers();
  let finishStart!: (container: PostgresContainer) => void;
  const pendingStart = new Promise<PostgresContainer>(resolve => { finishStart = resolve; });
  const remove = vi.fn(async () => undefined);
  const container = controlledContainer(remove);
  const ready = vi.fn(async () => true);
  const fixture = quoteCaseFixture('late-start', false, {
    ...quoteDatabase,
    start: () => pendingStart,
    ready,
  });
  const setup = fixture.setup();
  const settled = setup.catch(() => undefined);
  let teardownFinished = false;
  const teardown = fixture.teardown().then(() => { teardownFinished = true; });
  try {
    await vi.advanceTimersByTimeAsync(quoteProvisioningJoinMs);
    expect(teardownFinished).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    finishStart(container);
    await expect(setup).rejects.toMatchObject({ name: 'AbortError' });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
  } finally {
    finishStart(container);
    try {
      await settled;
      await teardown;
    } finally {
      vi.useRealTimers();
    }
  }
});

describe.sequential('installed quote proofs', () => {
  beforeAll(prepareQuoteConsumer, postgresSetupTimeoutMs);
  afterAll(removeQuoteConsumer, postgresTeardownTimeoutMs);

  for (const configuration of ['coffee', 'supplements']) describe(`${configuration} shipped bundle`, () => {
    const database = quoteCaseFixture(configuration, false);
    let fixture: Awaited<ReturnType<typeof provisionQuoteCase>>;
    beforeAll(async () => { fixture = await database.setup(); }, postgresSetupTimeoutMs);
    afterAll(database.teardown, postgresTeardownTimeoutMs);
    it('replays the bundle, quotes its inclusive threshold and persists the server total', () => {
      writeFileSync(join(consumer,'bundle.mjs'),`const fixture = ${JSON.stringify(fixture)};\n${bundleProof}`);
      const output = execFileSync(process.execPath, ['bundle.mjs', '--configuration', configuration],
        { cwd: consumer, encoding: 'utf8', timeout: 20_000 });
      console.log(output.trim());
    });
  });

  describe('installed catalogue job lifecycle', () => {
    const database = quoteCaseFixture('coffee', false);
    let fixture: Awaited<ReturnType<typeof provisionQuoteCase>>;
    beforeAll(async () => { fixture = await database.setup(); }, postgresSetupTimeoutMs);
    afterAll(database.teardown, postgresTeardownTimeoutMs);
    it('serves without a principal, drains a held claim and records a failed heartbeat', () => {
      const extracted = join(consumer, 'extracted');
      execFileSync(process.execPath, ['examples/neutral-store/extract.mjs', extracted], { stdio: 'pipe' });
      let output: string;
      try {
        output = execFileSync(process.execPath, ['--test', '--test-force-exit', '--test-name-pattern=installed catalogue jobs isolate',
          'test/lifecycle.test.ts'], { cwd: extracted, encoding: 'utf8', timeout: 45_000,
          env: { ...processEnv, OPENLUP_STARTER_CATALOGUE_RECIPE_APP: extracted,
            OPENLUP_STARTER_CATALOGUE_TEST_OWNER_URL: fixture.ownerUrl } });
      } catch (error) {
        const report = (error as { stdout?: string }).stdout ?? 'Installed lifecycle process failed';
        throw new Error(report.replaceAll(fixture.ownerUrl, '[fixture owner]').replaceAll(fixture.runtimeUrl, '[fixture runtime]'));
      }
      expect(output).toMatch(/installed catalogue job lifecycle/u);
      console.log(output.split('\n').find(line => line.includes('firstPairMs')));
    });
  });

  it('checks out and replays the installed derived quote without a stored subscription price', async () => {
    const database = quoteCaseFixture('coffee', false);
    try {
      const { ownerUrl, runtimeUrl } = await database.setup();
      const script = String.raw`
        import assert from 'node:assert/strict';
        import pg from 'pg';
        import {bindScenarioServer} from ${JSON.stringify(scenarioHelper)};
        import {configurations} from './application/owned/store.config.ts';
        import {applyDemoSeed} from './application/installation/install.ts';
        import {createNativeQuoteService} from './application/host/quote-composition.ts';
        import {installedAcquisitionPredecessors} from './application/host/acquisition-predecessors.ts';
        import {composeNativeBindings} from './application/host/native-composition.ts';
        import {createOriginPolicy} from './application/host/origin-policy.ts';
        const config = configurations.coffee;
        config.offer.products[0].unitPrice.amountMinor = 1499;
        const owner = new pg.Pool({connectionString:fixture.ownerUrl});
        const runtime = new pg.Pool({connectionString:fixture.runtimeUrl});
        try {
          await applyDemoSeed(config,{connection:owner,installRole:'postgres',runtimeRole:'starter_runtime',close:async()=>{}});
          await owner.query("DELETE FROM public.price_entries WHERE mode IN ('subscription','any')");
          const sku=config.offer.products[0].sku;
          const cart={schemaVersion:1,configuration:config.id,mode:'subscription',cadenceDays:config.offer.defaultCadenceDays,lines:[{sku,quantity:3}]};
          const input={locale:'en',configuration:config.id,country:config.market.country,termsAccepted:true,termsRevision:config.legal.revision,
            email:'derived-quote@example.test',firstName:'Example',lastName:'Buyer',phone:'00000',line1:'1 Example Lane',city:'Example',postalCode:'00000',
            cart,acquisitionCapability:'subscription-acquisition.v1'};
          const keyring={current:'fixture-only-acceptance-key-00000000000000'};
          const quotes=createNativeQuoteService(runtime,installedAcquisitionPredecessors(),keyring);
          const observed=await quotes.quote(input,{config,actor:{customerRef:null,operatorRef:null},commandKey:crypto.randomUUID()});
          const quoted=observed.snapshot.quote.lines[0];
          const price=(await owner.query("SELECT e.id AS base,p.id AS revision,p.digest FROM public.price_entries e JOIN public.catalog_skus s ON s.id=e.variant_id JOIN public.subscription_price_policy_revisions p ON p.price_list_id=e.price_list_id WHERE s.sku=$1 AND e.mode='one_time' AND e.min_qty=1",[sku])).rows;
          const evidence=line=>[line.catalogFacts.basePriceEntryId,line.catalogFacts.policyRevisionId,line.catalogFacts.policyDigest,line.unitPriceGross.amountMinor];
          assert.equal(price.length,1);
          assert.equal(quoted.catalogFacts.version,'catalog_facts_v2');
          assert.deepEqual(evidence(quoted),[price[0].base,price[0].revision,price[0].digest,1420]);
          const {server,port,base}=await bindScenarioServer();
          const {createApplication}=await import('./application/host/server.ts');
          const bindings=await composeNativeBindings(fixture.runtimeUrl,createOriginPolicy(config,port),config,keyring);
          server.on('request',createApplication(bindings).listeners('request')[0]);
          try {
            const call=async(operation,payload,key=crypto.randomUUID())=>(await fetch(base+'/api/actions/'+operation,{
              method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Starter-Request':'1','Idempotency-Key':key},body:JSON.stringify(payload)
            })).json();
            const checked=await call('offer.validate',input);
            assert.equal(checked.ok,true,checked.code);
            const accepted={...input,quoteAcceptance:checked.value.quoteAcceptance,expectedTotal:checked.value.expectedTotal};
            const key=crypto.randomUUID();
            const made=await call('checkout.create',accepted,key);
            assert.equal(made.ok,true,made.code);
            assert.equal(made.replayed,false);
            const saved=(await owner.query("SELECT metadata FROM public.commerce_orders WHERE id=$1",[made.value.orderRef])).rows[0].metadata;
            const retained=saved.quoteSnapshot.quote.lines[0];
            assert.deepEqual(evidence(retained),evidence(quoted));
            assert.deepEqual(saved.orderDraftSnapshot.lines[0].catalogFacts,retained.catalogFacts);
            assert.equal(saved.orderDraftSnapshot.lines[0].lineSubtotalGross.amountMinor,4260);
            const receipts=async()=>(await owner.query("SELECT response_payload::text FROM public.commerce_order_draft_receipts WHERE order_id=$1",[made.value.orderRef])).rows;
            const beforeReplay=await receipts();
            assert.equal(beforeReplay.length,1);
            const replay=await call('checkout.create',accepted,key);
            assert.equal(replay.ok,true,replay.code);
            assert.equal(replay.replayed,true);
            assert.equal(replay.value.orderRef,made.value.orderRef);
            assert.deepEqual(await receipts(),beforeReplay);
          } finally {await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});await bindings.close();}
        } finally {await runtime.end();await owner.end();}
      `;
      try {
        execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-', '--configuration', 'coffee'], {
          cwd: consumer, input: `const fixture = ${JSON.stringify({ ownerUrl, runtimeUrl })};\n${script}`, stdio: 'pipe', timeout: 20_000,
        });
      } catch (error) {
        throw new Error((error as { stderr?: Buffer }).stderr?.toString() ?? 'Installed derived price proof failed', { cause: error });
      }
    } finally { await database.teardown(); }
  }, postgresSetupTimeoutMs);

  describe('active published catalogue', () => {
    const database = quoteCaseFixture('coffee', false);
    let fixture: Awaited<ReturnType<typeof provisionQuoteCase>>;
    beforeAll(async () => { fixture = await database.setup(); }, postgresSetupTimeoutMs);
    afterAll(database.teardown, postgresTeardownTimeoutMs);

    it('seeded_product_quote_succeeds_with_active_published_product', () => {
      const script = String.raw`
        import assert from 'node:assert/strict';
        import { createHash, randomUUID } from 'node:crypto';
        import { readFileSync } from 'node:fs';
        import pg from 'pg';
        import { buildCatalogReleaseDraftV3, canonicalCatalogDraftJson, catalogInternalGtin, createPostgresCatalogDraftStoreV4,
          createPostgresCatalogPublicationCommands } from '@openlup/platform/catalog';
        import { createPostgresFulfillmentStockSyncPort } from '@openlup/platform/fulfillment';
        import { createCatalogPriceSetupHandler, createPostgresCatalogPriceSetupStore } from '@openlup/platform/pricing';
        import { configurations } from './application/owned/store.config.ts';
        import { applyDemoSeed } from './application/installation/install.ts';
        import { catalogueWatchdogPrincipalId, startCatalogueReadinessJobs } from './application/host/catalogue-readiness-jobs.ts';
        import { setTimeout as delay } from 'node:timers/promises';
        import { demoIdentifier, readStarterCatalogueRules, starterCatalogue } from './application/host/editor-catalogue.ts';
        import { createNativeQuoteService } from './application/host/quote-composition.ts';
        import { installedAcquisitionPredecessors } from './application/host/acquisition-predecessors.ts';
        import { composeCatalogueStorefront } from './application/host/catalogue-storefront.ts';
        import { dispatchAction, pendingBindings } from './application/host/bindings.ts';
        import { editorQuotePorts } from './application/host/editor-ports.ts';
        import { createPostgresRoleFreeTransactionLane } from '@openlup/platform/data';
        const config = configurations.coffee;
        const owner = new pg.Pool({connectionString:fixture.ownerUrl});
        const runtime = new pg.Pool({connectionString:fixture.runtimeUrl});
        const transaction = async work => {
          const db = await owner.connect();
          try {
            await db.query('BEGIN');
            const result = await work(db);
            await db.query('COMMIT');
            return result;
          } catch (error) { await db.query('ROLLBACK'); throw error; }
          finally { db.release(); }
        };
        try {
          const db = await owner.connect();
          try {
            await applyDemoSeed(config, { connection: db, installRole:'postgres', runtimeRole:'starter_runtime',
              catalogueRules:readStarterCatalogueRules(), stock:createPostgresFulfillmentStockSyncPort(runtime,
                {sourceKey:'starter-demo:coffee',readLocalInventoryStock:async()=>[]}),close:async()=>{} });
          } finally { db.release(); }
          const closeJobs = startCatalogueReadinessJobs(fixture.runtimeUrl,catalogueWatchdogPrincipalId(config));
          try {
            let ready = false;
            for (let attempt=0; attempt<100; attempt++) {
              const { rows } = await owner.query("SELECT public.commerce_offer_policy_v2_readiness() AS verdict");
              if (!rows[0].verdict.reasons.some(reason => ['promotion_watchdog_not_ready','promotion_claim_sweep_not_ready'].includes(reason))) {
                assert.deepEqual(rows[0].verdict.reasons,['catalog_1490_legacy_1340_invalid']);
                assert.equal(rows[0].verdict.evidence.priceMismatchCount,6);
                ready = true;
                break;
              }
              await delay(40);
            }
            assert.equal(ready,true,'The native readiness jobs must produce current evidence');
          } finally { await closeJobs(); }
          const actorId = randomUUID();
          await owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'quote-operator@example.invalid')",[actorId]);
          await owner.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())",[actorId]);
          const installed = starterCatalogue(), type = { key:installed.current.key, version:installed.current.version };
          const mediaRef = '/media/collection.svg';
          const mediaDigest = () => createHash('sha256').update(readFileSync('./application/public'+mediaRef)).digest('hex');
          const commands = createPostgresCatalogPublicationCommands({
            authorizeHuman:async id => id === actorId ? {ok:true,userId:id,role:'admin',isMachineActor:false} : {ok:false},
            catalogPublicationOwner:{run:transaction},registry:installed.registry,
            verifyMedia:async (_db, claim)=>claim.mediaRef===mediaRef && claim.revisionDigest===mediaDigest(),
          });
          const operator = await commands.authorize(actorId);
          assert.ok(operator);
          const netContent = { dimension:'mass',unit:'openlup:g',scale:0,unscaled:'100' };
          const build = (slug,sku,sequence,presentation={title:'Published article',routePath:{en:'/products/'+slug}}) =>
            buildCatalogReleaseDraftV3({ namespace:'fixture', type, slug, name:'Published article', presentation,
            document:{details:{z:'Zażółć',a:['曲', '🌿']}}, skus:[{
              code:sku,title:'Published article',options:{},netContent,grossMass:{...netContent,unscaled:'120'},
              identifiers:[{scheme:'gs1:gtin',issuer:'fixture',value:catalogInternalGtin(sequence),packagingLevel:'unit'}],
              sell:{oneTime:true,subscription:false},logisticsRef:'fixture:logistics/article',
            }] });
          async function publish(draftId,revision,payload,expectedHead,changes=[]) {
            const canonicalCommand = canonicalCatalogDraftJson({schemaVersion:payload.schemaVersion,action:revision === 1 ? 'create' : 'revise',
              draftId,commandKey:randomUUID(),expectedRevision:revision-1,payload});
            const fingerprint = createHash('sha256').update(canonicalCommand).digest('hex');
            const saved = await createPostgresCatalogDraftStoreV4(owner).apply({canonicalCommand,fingerprint,actorId});
            assert.equal(saved.outcome,'committed',JSON.stringify(saved));
            const prepared = await commands.prepareCandidate({draftId,draftRevision:revision,expectedHead},operator);
            assert.ok(prepared.preparation?.postStateDigest,JSON.stringify(prepared));
            const candidate = {productId:payload.product.id,candidateRef:prepared.candidateRef,candidateDigest:prepared.candidateDigest};
            const approved = await commands.execute({...candidate,action:'approve',commandKey:randomUUID(),
              postStateDigest:prepared.preparation.postStateDigest},operator);
            assert.equal(approved.outcome,'committed',JSON.stringify(approved));
            const request = {...candidate,action:'publish',commandKey:randomUUID(),expectedHead,changes};
            let published = await commands.execute(request,operator);
            if (payload.product.slug === 'published-article' && revision === 2) {
              assert.deepEqual(published,{outcome:'validation_issue',reason:'publication_price_readiness',
                path:'pricing.readiness',subject:'catalog_1490_legacy_1340_invalid',
                message:'Observed: Publish could not verify price and offer readiness. Cause: The effective list or the eligible SKU price census could not be verified. Fix: Restore one effective list and verify each eligible SKU’s base and subscription branch with the pricing owner. Recheck: Retry the same approved request only while its draft and head still match.'});
              // The disposable storefront fixture uses a derived-only list for activation.
              assert.equal((await owner.query(\`UPDATE public.price_entries
                SET active=false,valid_to=statement_timestamp(),updated_at=statement_timestamp()
                WHERE price_list_id=$1 AND mode='subscription' AND active\`,
              [demoIdentifier(config,'price-list',config.market.currency)])).rowCount,7);
              published = await commands.execute(request,operator);
            }
            if (published.outcome !== 'committed') {
              const { rows } = await owner.query("SELECT public.commerce_offer_policy_v2_readiness() AS readiness");
              assert.fail(JSON.stringify({ published, readiness:rows[0].readiness }));
            }
            return published.receipt.head;
          }
          const quotes = createNativeQuoteService(runtime,installedAcquisitionPredecessors(),{current:'fixture-only-acceptance-key-00000000000000'});
          const context = {config,actor:{customerRef:null,operatorRef:null},commandKey:'published-quote-fixture'};
          const storefront = composeCatalogueStorefront(createPostgresRoleFreeTransactionLane({connectionString:fixture.runtimeUrl},{pool:runtime}));
          const bindings = { ...pendingBindings(), resolveCatalogue:storefront.resolveCatalogue,
            actions:{'storefront.catalogue':storefront.action,'offer.validate':async (payload,ctx)=>({ok:true,value:quotes.public(await quotes.quote(payload,ctx))})} };
          const seedRequest = {cart:{schemaVersion:1,configuration:config.id,mode:'one_time',cadenceDays:null,
            lines:[{sku:config.offer.products[0].sku,quantity:1}]}};
          const at = (await runtime.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
          const seedQuote = async () => (await quotes.quote(seedRequest,context,undefined,at)).snapshot.quote.totalGross;
          const original = await seedQuote();
          const draftId = randomUUID(), slug = 'published-article', sku = 'PUBLISHED-ARTICLE';
          const {release,activation} = build(slug,sku,1020);
          const released = await publish(draftId,1,release.payload,null);
          assert.deepEqual(await dispatchAction(bindings,'storefront.catalogue',{},context), {ok:true,value:{products:config.offer.products}});
          assert.deepEqual(await seedQuote(),original);
          const price = (variantId,unitPriceMinor) => transaction(async db => {
            await db.query('SET LOCAL ROLE authenticated');
            await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actorId,role:'authenticated'})]);
            const priceListId = demoIdentifier(config,'price-list',config.market.currency);
            const price = await createCatalogPriceSetupHandler({store:createPostgresCatalogPriceSetupStore(db),
              authorizeOperator:async()=>({actorId})}).apply({schemaVersion:1,commandKey:randomUUID(),variantId,priceListId,
                mode:'one_time',minQty:1,amountKind:'gross',unitPriceMinor,expected:{entryId:null,unitPriceMinor:null}},undefined);
            assert.equal(price.outcome,'committed',JSON.stringify(price));
          });
          await price(release.payload.skus[0].id,2700);
          await publish(draftId,2,activation.payload,released);
          const listed = await dispatchAction(bindings,'storefront.catalogue',{},context);
          assert.equal(listed.ok,true);
          const published = listed.value.products.find(item=>item.sku===sku);
          assert.equal(published.name.en,'Published article');
          assert.equal(published.media,'');
          assert.deepEqual(await seedQuote(),original);
          const publishedRequest = {cart:{...seedRequest.cart,lines:[{sku,quantity:1}]}};
          const answer = await dispatchAction(bindings,'offer.validate',publishedRequest,context);
          assert.equal(answer.ok,true,JSON.stringify(answer));
          assert.deepEqual(answer.value.lines,[{sku,quantity:1,baseUnitMinor:2700,unitMinor:2700,lineMinor:2700}]);
          assert.equal(answer.value.currency,config.market.currency);
          const cart = seedRequest.cart;
          const servicing = await editorQuotePorts(runtime,config).quotePort.createServerAuthoritativeQuote({
            mode:'one_time',cadenceDays:null,promoCodes:[],lines:cart.lines,
          });
          assert.equal(servicing.quote.lines[0].sku,cart.lines[0].sku);
          assert.deepEqual(servicing.quote.lines[0].unitPriceGross,config.offer.products[0].unitPrice);

          const collision = build('schema-collision','SCHEMA-COLLISION',1021,
            {title:'Schema collision',shortName:{en:'Collision example'},mediaRef}), collisionId = randomUUID();
          const initial = {...collision.release.payload,schemaVersion:4}, active = {...collision.activation.payload,schemaVersion:4};
          for (const {product} of [initial,active]) {
            const document = product.sharedContent.document;
            document.schemaId = config.quote.document.schemaId;
            product.documentRevision.schemaId = document.schemaId;
            const bytes = canonicalCatalogDraftJson(document);
            product.documentRevision.digest = createHash('sha256').update(bytes).digest('hex');
            Object.assign(initial.publication.operations.find(operation=>operation.op==='register_document_revision'),
              {canonicalText:bytes,digest:product.documentRevision.digest});
          }
          active.publication.operations = active.publication.operations.map(operation =>
            operation.op === 'set_product_status' ? {op:'set_product_lifecycle',productSlug:operation.productSlug,expectedState:'draft',state:'active',children:[]}
              : operation.op === 'set_sku_status' ? {op:'set_sku_lifecycle',skuCode:operation.skuCode,expectedState:'draft',state:'active'} : operation);
          const collisionRelease = await publish(collisionId,1,initial,null);
          const collisionSku = active.skus[0];
          active.publication.evidence.media = [{skuCode:collisionSku.code,mediaRef,assetRefs:[],revisionDigest:mediaDigest()}];
          await price(collisionSku.id,2800);
          const collisionActive = await publish(collisionId,2,active,collisionRelease,[{variantId:collisionSku.id,expectedRevision:1,state:'active'}]);
          const items = (await dispatchAction(bindings,'storefront.catalogue',{},context)).value.products;
          const illustrated = items.find(item=>item.sku===collisionSku.code);
          assert.equal(illustrated.name.en,'Collision example');
          assert.equal(illustrated.media,mediaRef);
          await assert.rejects(seedQuote,{message:'catalog_document_schema_invalid'});
          active.publication.operations = [{op:'set_product_lifecycle',productSlug:active.product.slug,
            expectedState:'active',state:'withdrawn',children:[{skuCode:collisionSku.code,expectedState:'active'}]}];
          delete active.publication.evidence.media;
          await publish(collisionId,3,active,collisionActive,[{variantId:collisionSku.id,expectedRevision:2,state:'withdrawn'}]);
          assert.deepEqual(await seedQuote(),original);
          const offline = composeCatalogueStorefront({run:async()=>{throw new Error('Disconnected reader');}});
          const refused = await offline.action({},context);
          assert.equal(refused.ok,false);
          assert.equal(refused.code,'publication_authority_unavailable');
        } finally { await runtime.end(); await owner.end(); }
      `;
      writeFileSync(join(consumer,'published-quote.mjs'),`const fixture = ${JSON.stringify(fixture)};\n${script.replaceAll('\\`','`')}`);
      try {
        execFileSync(process.execPath,['--experimental-strip-types','published-quote.mjs','--configuration','coffee'],
          { cwd:consumer,encoding:'utf8',timeout:30_000,stdio:'pipe' });
      } catch (error) {
        throw new Error((error as { stderr?: Buffer }).stderr?.toString() ?? 'Published quote child failed',{ cause: error });
      }
    }, 95_000);
  });

  for (const { configuration, multiSize } of [{ configuration: 'supplements', multiSize: false }, { configuration: 'coffee', multiSize: false }, { configuration: 'coffee', multiSize: true }]) {
    describe.sequential(multiSize ? 'multi-size quote' : `${configuration} quote`, () => {
      const database = quoteCaseFixture(configuration, multiSize);
      let fixture: Awaited<ReturnType<typeof provisionQuoteCase>>;
      beforeAll(async () => {
        fixture = await database.setup();
      }, postgresSetupTimeoutMs);
      afterAll(database.teardown, postgresTeardownTimeoutMs);

      // About 4x the slowest hosted run (23,351 ms), rounded up to 5 s.
      // The child measured at most 2.703 s; retain its separate 20 s deadline.
      it(multiSize ? 'multi-size checkout selects its SKU and refuses a SKU absent from the shared product document' : `${configuration}: installed seed, strict quotes, capability refusal and retained-promise acceptance`, () => runQuoteProof(fixture), 95_000);
    });
  }
});
