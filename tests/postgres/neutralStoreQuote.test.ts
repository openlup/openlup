/** Installed engine and seed witness; subscription admission/activation retain their explicit predecessors. */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
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

const shippingScript = String.raw`
  import assert from 'node:assert/strict';
  import pg from 'pg';
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
  const {createApplication} = await import('./application/host/server.ts');
  const owner = new pg.Pool({connectionString:fixture.ownerUrl});
  const runtime = new pg.Pool({connectionString:fixture.runtimeUrl});
  const bindings = await composeNativeBindings(fixture.runtimeUrl,createOriginPolicy(config,fixture.port),{current:'fixture-only-acceptance-key-00000000000000'});
  const server = createApplication(bindings);
  await new Promise(resolve=>server.listen(fixture.port,'127.0.0.1',resolve));
  try {
    const base = 'http://127.0.0.1:'+fixture.port;
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

// Measured shipping bodies: 9.334 s / 8.768 s, including both scratch mutations.
// Four times the maximum fits the 45 s body bound.
// The child measured at most 2.703 s; retain its separate 20 s deadline.
for (const configuration of ['supplements','coffee']) it(`${configuration}: installed seed, strict quotes, capability refusal and retained-promise acceptance`, async () => {
  const caseStarted = performance.now();
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
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0,'127.0.0.1',resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Starter quote fixture port unavailable');
  const port = address.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const script = String.raw`
    import assert from 'node:assert/strict';
    import pg from 'pg';
    import {createHash} from 'node:crypto';
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
      await owner.query("UPDATE public.commerce_promotion_definitions SET definition=jsonb_set(definition,'{applies_to_payload,acquisitionTerms,delivery2DiscountBps}',$1::jsonb)",[JSON.stringify(config.quote.acquisition.delivery2DiscountBps)]);
      configurations[fixture.configuration] = config;
      const port=fixture.port;
      const {createApplication}=await import('./application/host/server.ts');
      const {composeNativeBindings}=await import('./application/host/native-composition.ts');
      const {createOriginPolicy}=await import('./application/host/origin-policy.ts');
      const keyring={current:'fixture-only-acceptance-key-00000000000000'};
      const bindings=await composeNativeBindings(fixture.runtimeUrl,createOriginPolicy(config,port),keyring);
      const server=createApplication(bindings);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
      try {
        const base='http://127.0.0.1:'+port;
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
        await owner.query("UPDATE public.commerce_promotion_definitions SET definition=jsonb_set(definition,'{applies_to_payload,acquisitionTerms,delivery2DiscountBps}','1300')");
        await refused('checkout.create',accepted,'starter_quote_refresh_required');
        await owner.query("UPDATE public.commerce_promotion_definitions SET definition=jsonb_set(definition,'{applies_to_payload,acquisitionTerms,delivery2DiscountBps}',$1::jsonb)",[JSON.stringify(config.quote.acquisition.delivery2DiscountBps)]);
        const minimum=config.quote.acquisition.minimumProductPayableMinor;
        config.quote.acquisition.minimumProductPayableMinor=minimum+1;
        try {await refused('checkout.create',accepted,'starter_quote_refresh_required');} finally {config.quote.acquisition.minimumProductPayableMinor=minimum;}
        const graduation=config.quote.acquisition.graduationCadenceDays;
        config.quote.acquisition.graduationCadenceDays=config.offer.cadenceDays.find(value=>value!==graduation);
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
      } finally {await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});await bindings.close();}
      console.log(JSON.stringify({configuration:config.id,unit:1420,subtotal:4260,second:3958,capabilityRefused:true,secondPromiseRefresh:true,retainedCapture:true}));
    } finally {await runtime.end();await owner.end();}
  `;
  writeFileSync(join(consumer,'scenario.mjs'),`const fixture = ${JSON.stringify({ configuration,port,ownerUrl: container.connectionString,runtimeUrl: runtime.toString() })};\n${script}`);
  const childStarted = performance.now();
  let output: string;
  try { output = execFileSync(process.execPath,['--experimental-strip-types','scenario.mjs','--configuration',configuration,'--port',String(port)], { cwd: consumer,encoding: 'utf8',timeout: 20_000 }); }
  catch (error) { throw new Error((error as { stderr?: Buffer }).stderr?.toString() ?? 'Starter quote child failed',{ cause: error }); }
  expect(JSON.parse(output.trim())).toMatchObject({ configuration,unit: 1420,subtotal: 4260,second: 3958,capabilityRefused: true,secondPromiseRefresh: true,retainedCapture: true });
  writeFileSync(join(consumer,'shipping-scenario.mjs'),`const fixture = ${JSON.stringify({ configuration,port,ownerUrl: container.connectionString,runtimeUrl: runtime.toString() })};\n${shippingScript.replaceAll('\\`','`')}`);
  const shippingRun = () => execFileSync(process.execPath,['--experimental-strip-types','shipping-scenario.mjs','--configuration',configuration,'--port',String(port)], { cwd: consumer,encoding: 'utf8',timeout: 20_000,stdio: 'pipe' });
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
  console.info(JSON.stringify({ configuration, caseMs: performance.now() - caseStarted, childMs: performance.now() - childStarted }));
}, 45_000);
