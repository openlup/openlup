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

// Measured local bodies: 6.529 s / 6.338 s; four times the maximum fits 30 s.
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
  console.info(JSON.stringify({ configuration, caseMs: performance.now() - caseStarted, childMs: performance.now() - childStarted }));
}, 30_000);
