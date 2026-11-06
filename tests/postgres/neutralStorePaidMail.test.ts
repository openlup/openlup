import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createPlatformPostgresMigrationRunner, qualifiedPostgresStartupOptions } from '@openlup/platform/migrations';
import { applyDemoSeed, demonstrationMarker } from '../../examples/neutral-store/installation/install.ts';
import { createPostgresFulfillmentStockSyncPort } from '@openlup/platform/fulfillment';
import { createPaidMailHost } from '../../examples/neutral-store/host/paid-mail.ts';
import { createPrivateCapture } from '../../examples/neutral-store/host/private-capture.ts';
import { createPaidMailArtifacts, paidMailKey } from '../../examples/neutral-store/host/paid-mail-artifact.ts';
import { configurations } from '../../examples/neutral-store/owned/store.config.ts';
import { assertRenewalConfig } from '../../examples/neutral-store/shared/renewal-config.ts';
import type { StoreConfig } from '../../examples/neutral-store/shared/config.ts';
import type { PaidMailArtifactV1 } from '../../examples/neutral-store/host/paid-mail-artifact.ts';
import { createPostgresOutboxStore } from '@openlup/outbox/postgres';
import { closePostgres, dockerAvailable, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from '../helpers/postgresContainer.js';

let container: PostgresContainer | undefined;
let owner: Pool, migration: Pool, runtime: Pool;
let runtimeUrl: string;
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error('Paid message proof requires Docker PostgreSQL');
  container = await runPostgresContainer({ name: `starter-paid-mail-${process.pid}`, database: 'neutral_store', password: 'synthetic-conformance' });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error('Paid message PostgreSQL unavailable');
  owner = new Pool({ connectionString: container.connectionString });
  for (const role of ['starter_runtime', 'starter_restore']) await owner.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
  const installation = { generation: 'qualified-v2', roleMode: 'installer-managed', bootstrapLogin: 'postgres',
    migrationLogin: 'postgres', runtimeLogin: 'starter_runtime', restoreLogin: 'starter_restore' } as const;
  migration = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(installation) });
  const runner = createPlatformPostgresMigrationRunner({ connectionString: container.connectionString }, { installation, poolFactory: () => migration });
  await runner.apply();
  expect((await runner.status()).pending).toEqual([]);
  const url = new URL(container.connectionString); url.username = 'starter_runtime'; url.password = 'synthetic-conformance';
  runtimeUrl = url.toString(); runtime = new Pool({ connectionString: runtimeUrl });
  await owner.query(`COMMENT ON DATABASE neutral_store IS '${demonstrationMarker}'`);
  await applyDemoSeed(config(), { connection: owner, installRole: 'postgres', runtimeRole: 'starter_runtime',
    stock: createPostgresFulfillmentStockSyncPort(runtime, { sourceKey: `starter-demo:${config().id}`, readLocalInventoryStock: async () => [] }),
    close: async () => {} });
}, 60_000);
beforeEach(async () => { await owner.query('DELETE FROM public.outbox_events'); });
afterAll(async () => { await closePostgres(container, [owner, migration, runtime].filter(Boolean)); }, postgresTeardownTimeoutMs);

it('claims through the installed restricted runtime without supplementary grants', async () => {
  expect((await runtime.query("SELECT current_user,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated")).rows[0])
    .toEqual({ current_user: 'starter_runtime', elevated: false });
  expect(await createPostgresOutboxStore(runtime).claimBatch({ eventTypes: ['commerce.order.paid.email'],
    knownEventTypes: [], batchSize: 1, visibilitySeconds: 300, maxAttempts: 8 })).toEqual([]);
});

const now = '2026-10-20T12:00:00.000Z';
async function fixture(status: 'paid' | 'pending_payment' | 'cancelled') {
  const clientId = randomUUID(), orderId = randomUUID(), email = `${clientId}@example.test`, market = config().market;
  await owner.query(`INSERT INTO public.clients(id,email,first_name,country,created_at,updated_at)
    VALUES($1,$2,'Example',$4,$3,$3)`, [clientId, email, now, market.country]);
  const metadata = { orderDraftSnapshot: { context: { mode: 'one_time' },
    totals: { subtotalGross: { amountMinor: 2400 }, discountTotalGross: { amountMinor: 400 } },
    lines: [{ title: 'Frozen item' }] } };
  const db = await owner.connect();
  try {
  await db.query('BEGIN');
  await db.query(`INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor,metadata,created_at,updated_at)
    VALUES($1,$2,$5,2000,$3,$4,$4)`, [orderId, clientId, metadata, now, market.currency]);
  await db.query(`INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor,created_at,
    source_line_ordinal,catalog_unit_amount_minor,catalog_line_amount_minor,promotion_discount_allocated_minor,promotion_allocation_fingerprint)
    VALUES($1,1,2,1000,2000,$2,1,1200,2400,400,repeat('a',64))`, [orderId, now]);
  if (status !== 'pending_payment') await db.query(`UPDATE public.commerce_orders SET status=$2,
    paid_at=CASE WHEN $2='paid' THEN $3::timestamptz ELSE NULL END,updated_at=$3 WHERE id=$1`, [orderId, status, now]);
  await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  return { clientId, orderId, email };
}
async function local<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'starter-paid-mail-'));
  try { return await work(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const config = () => structuredClone(Object.values(configurations)[0]!);
async function lifecycle(directory: string, owned: StoreConfig) {
  const script = `import {runScheduledRenewal} from ${JSON.stringify(new URL('../../examples/neutral-store/host/scheduled-renewal.ts', import.meta.url).href)};
    import {readFileSync} from 'node:fs';
    const input=JSON.parse(readFileSync(0,'utf8'));
    process.stdout.write(JSON.stringify(await runScheduledRenewal(input.url,input.config)));`;
  return new Promise<{ output: string; result: { paidMail: { claimed: number; processed: number } } }>((done, fail) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); fail(new Error('paid_mail_lifecycle_timeout')); }, 15_000);
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('exit', code => { clearTimeout(timer);
      if (code !== 0) fail(new Error(errors.includes('ERR_MODULE_NOT_FOUND')
        ? 'paid_mail_lifecycle_module_unavailable' : 'paid_mail_lifecycle_failed'));
      else done({ output: output + errors, result: JSON.parse(output) });
    });
    child.stdin.end(JSON.stringify({ url: runtimeUrl, config: owned }));
  });
}

// Local action cases completed within the file's 4.38 s total, including installation.
// Retain 10 s per action; the installation has its separate 60 s hook allowance.
it('the lifecycle entry captures exactly one paid receipt with owned locale, recipient and totals; replay is inert', async () => {
  const f = await fixture('paid'), owned = config();
  owned.renewal.notices.countryLocales = { [owned.market.country]: 'pl' };
  await local(async directory => {
    const first = await lifecycle(directory, owned);
    expect(first.result.paidMail).toMatchObject({ claimed: 1, processed: 1 });
    const mailbox = join(directory, '.context/captured-messages'), files = await readdir(mailbox);
    expect(files).toHaveLength(1);
    const path = join(mailbox, files[0]!), bytes = await readFile(path, 'utf8');
    const artifact = JSON.parse(bytes).record as PaidMailArtifactV1;
    expect(artifact).toMatchObject({ kind: 'order_paid', recipient: f.email, recipientReference: `client:${f.clientId}`,
      orderId: `order_${f.orderId}`, locale: 'pl', subject: owned.renewal.notices.copy.pl.paid.subject });
    expect(artifact.body).toContain('Frozen item');
    const copy = owned.renewal.notices.copy.pl.paid;
    const money = (major: number) => new Intl.NumberFormat('en', { style: 'currency', currency: owned.market.currency }).format(major);
    for (const [label, value] of [[copy.subtotal, money(24)], [copy.discount, `−${money(4)}`], [copy.total, money(20)]]) {
      expect(artifact.body).toContain(`${label}: ${value}`);
    }
    expect((await stat(mailbox)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const replay = await lifecycle(directory, owned);
    expect(replay.result.paidMail).toMatchObject({ claimed: 0, processed: 0 });
    expect(await readdir(mailbox)).toEqual(files);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    for (const output of [first.output, replay.output]) for (const value of [f.email, artifact.body]) expect(output.includes(value)).toBe(false);
    const rows = (await owner.query('SELECT event_type,status FROM public.outbox_events WHERE aggregate_id=$1 ORDER BY event_type', [f.orderId])).rows;
    expect(rows).toEqual([{ event_type: 'commerce.order.paid', status: 'pending' }, { event_type: 'commerce.order.paid.email', status: 'processed' }]);
  });
}, 10_000);

// Exercise the store's strict Node profile and real native purchase/editor ports.
// Only catalogue/configuration is seeded; orders, templates and cycles use native writers.
it('paid sized renewal receipts include the frozen parcel note while classic receipts omit it', async () => {
  await local(async directory => {
    const host = new URL('../../examples/neutral-store/host/', import.meta.url);
    const script = `import assert from 'node:assert/strict';
      import {randomUUID} from 'node:crypto';
      import {readFileSync} from 'node:fs';
      import pg from 'pg';
      import {createPostgresAccountLinkStore} from '@openlup/platform/identity';
      import {createPostgresRenewalReservationPort} from '@openlup/platform/inventory';
      import {createNativeRenewalCodec,createPostgresRenewalStore,createPostgresRenewalSettlementPort,
        runOneAutomaticSubscriptionRenewal} from '@openlup/platform/subscriptions';
      import {composeNativeBindings} from ${JSON.stringify(new URL('native-composition.ts', host).href)};
      import {createOriginPolicy} from ${JSON.stringify(new URL('origin-policy.ts', host).href)};
      import {readEditorSubscriptions} from ${JSON.stringify(new URL('subscription-editors.ts', host).href)};
      import {composeRenewalSandbox} from ${JSON.stringify(new URL('renewal-sandbox.ts', host).href)};
      const input=JSON.parse(readFileSync(0,'utf8')),config=input.config;
      process.chdir(input.directory);
      const pool=new pg.Pool({connectionString:input.url}),accounts=createPostgresAccountLinkStore({connectionString:input.url});
      const bindings=await composeNativeBindings(input.url,createOriginPolicy(config,3210));
      const results=[];
      try {
        for (const sized of [true,false]) {
          const principalRef=randomUUID(),email=randomUUID()+'@example.test';
          const client=await accounts.createAccount({email,principalId:principalRef,acquisitionSource:'fixture',lifecycleStage:'customer'});
          const actor={customerRef:client.id,principalRef,operatorRef:null,requesterKey:'a'.repeat(64),requestOrigin:'http://127.0.0.1:3210'};
          const call=async (name,payload) => {
            const result=await bindings.actions[name](payload,{config,actor,commandKey:randomUUID()});
            assert.equal(result.ok,true,name+': '+JSON.stringify(result)); return result.value;
          };
          const bought=await call('checkout.create',{locale:'en',configuration:config.id,country:config.market.country,
            termsRevision:config.legal.revision,termsAccepted:true,firstName:'Example',lastName:'Customer',phone:'000000000',
            line1:'1 Example Street',city:'Example City',postalCode:'00000',
            cart:{schemaVersion:1,configuration:config.id,mode:'subscription',cadenceDays:28,
              lines:[{sku:config.offer.products[0].sku,quantity:6},{sku:config.offer.products[1].sku,quantity:2}]}});
          await call('payment.simulate',{orderRef:bought.orderRef,outcome:'captured'});
          const [subscription]=await readEditorSubscriptions(pool,actor);
          assert.ok(subscription.lines.length>0);
          if(sized) {
            const catalog=await call('subscription.catalog',{subscriptionRef:subscription.subscriptionId,mode:'sized',optIn:true});
            const coreLines=subscription.lines.filter(line=>!line.isAddon).map(line=>({variantId:line.variantId,qty:line.qty}));
            const request={subscriptionId:subscription.subscriptionId,action:'resize_bundle',cadenceDays:28,
              expectedTemplateVersion:subscription.templateVersion,
              compositionConstraint:{...catalog.context.compositionConstraint,value:8},
              resizeLever:{kind:'subscription.sized.parcel',value:{coreLines,optInToSized:true}}};
            const preview=await call('subscription.preview',{request}); assert.equal(preview.preview.canApply,true);
            await call('subscription.command',{request:{...request,acceptedQuoteHash:preview.quoteHash}});
          }
          const at=new Date(Date.parse(subscription.nextCycleAt)+60000).toISOString();
          const withTransaction=async work=>{const db=await pool.connect();try {await db.query('BEGIN');
            const value=await work(db);await db.query('COMMIT');return value;
          }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}};
          const codec=createNativeRenewalCodec(),store=createPostgresRenewalStore(pool,codec,withTransaction);
          const sandbox=composeRenewalSandbox({executor:pool,withTransaction,codec,config:{...config.renewal,
            sandbox:{initial:'succeeded',retry:'succeeded'}},now:()=>at,
            failureTemplate:config.purchase.sandbox.dunningTemplateSlug,recoveredTemplate:config.purchase.sandbox.recoveryTemplateSlug,
            recoveryPath:config.purchase.sandbox.recoveryUrlPath});
          await sandbox.refresh();
          const due=(await store.listDue(100,at)).find(row=>row.subscriptionId===subscription.subscriptionId);assert.ok(due);
          const renewed=await runOneAutomaticSubscriptionRenewal({store,
            settlement:createPostgresRenewalSettlementPort(pool,codec,withTransaction),
            inventory:createPostgresRenewalReservationPort(pool),paymentRails:sandbox.paymentRails,policy:sandbox.policy,
            failureHandoff:{async handoffFailure(){throw Error('unexpected_renewal_failure');}},workerId:'paid-mail-witness'},due,at);
          assert.equal(renewed.status,'succeeded',JSON.stringify(renewed));
          const order=(await pool.query('SELECT id AS order_id FROM public.commerce_orders WHERE renewal_operation_id=$1',[renewed.operationId])).rows[0];
          results.push({sized,orderId:order.order_id,acquisitionOrderId:bought.orderRef,email});
        }
        process.stdout.write(JSON.stringify(results));
      }finally {await bindings.close();await accounts.close();await pool.end();}`;
    const purchases = await new Promise<{ sized: boolean; orderId: string; acquisitionOrderId: string; email: string }[]>((done, fail) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', errors = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); fail(new Error('paid_mail_purchase_timeout')); }, 20_000);
      child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
      child.once('error', error => { clearTimeout(timer); fail(error); });
      child.once('exit', code => { clearTimeout(timer); if (code !== 0) fail(new Error(errors)); else done(JSON.parse(output)); });
      child.stdin.end(JSON.stringify({ url: runtimeUrl, config: config(), directory }));
    });
    const events = (await runtime.query(`SELECT aggregate_id,status,available_at,now() AS observed_at FROM public.outbox_events
      WHERE event_type='commerce.order.paid.email' ORDER BY created_at,id`)).rows;
    expect(events).toHaveLength(4);
    expect((await lifecycle(directory, config())).result.paidMail, JSON.stringify(events)).toMatchObject({ claimed: 4, processed: 4 });
    const artifacts = createPaidMailArtifacts(createPrivateCapture(join(directory, '.context/captured-messages')));
    for (const purchase of purchases) {
      for (const orderId of [purchase.orderId, purchase.acquisitionOrderId]) {
        const event = (await runtime.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.paid.email'", [orderId])).rows[0];
        const artifact = await artifacts.read(paidMailKey(event.id));
        expect(artifact).toMatchObject({ orderId: `order_${orderId}`, recipient: purchase.email });
        const note = 'Items: 8 · 8 × 250 g · Every 28 days';
        if (purchase.sized && orderId === purchase.orderId) expect(artifact!.body).toContain(note);
        else expect(artifact!.body).not.toContain('Items:');
      }
    }
  });
}, 30_000);

it('a second claimant is fenced, and a reclaimed send dedupes before reading the changed recipient', async () => {
  const f = await fixture('paid'), owned = config();
  await local(async directory => {
    const capture = createPrivateCapture(directory), host = createPaidMailHost({ executor: runtime, config: owned, capture });
    expect([...host.registry.keys()]).toEqual(['commerce.order.paid.email']);
    const store = createPostgresOutboxStore(runtime), claim = { eventTypes: [...host.registry.keys()],
      knownEventTypes: ['commerce.order.paid'], batchSize: 10, visibilitySeconds: 300, maxAttempts: 8 };
    const rows = await store.claimBatch(claim); expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(await store.claimBatch(claim)).toEqual([]);
    expect(await host.registry.get(row.event_type)!.handle(row, new AbortController().signal)).toEqual({ kind: 'processed' });
    const original = await capture.read(paidMailKey(row.id));
    await owner.query('UPDATE public.clients SET email=$2 WHERE id=$1', [f.clientId, `${randomUUID()}@example.test`]);
    // Lost acknowledgement: the original lease expires before a replacement pass.
    await owner.query("UPDATE public.outbox_events SET available_at='2020-01-01T00:00:00Z' WHERE id=$1", [row.id]);
    expect(await createPaidMailHost({ executor: runtime, config: owned, capture }).run()).toMatchObject({ claimed: 1, processed: 1 });
    expect(await capture.read(paidMailKey(row.id))).toEqual(original);
    expect(await readdir(directory)).toHaveLength(1);
    expect(await host.run()).toMatchObject({ claimed: 0 });
    expect((await owner.query('SELECT status,attempts,metadata FROM public.outbox_events WHERE id=$1', [row.id])).rows[0])
      .toMatchObject({ status: 'processed', attempts: 2, metadata: { dedupe: 'email_already_sent' } });
  });
}, 10_000);

it('unpaid and cancelled orders produce no paid message, while every other send method refuses', async () => {
  const unpaid = await fixture('pending_payment'), cancelled = await fixture('cancelled');
  await local(async directory => {
    const host = createPaidMailHost({ executor: runtime, config: config(), capture: createPrivateCapture(directory) });
    expect(await host.run()).toMatchObject({ claimed: 0 });
    expect(await readdir(directory)).toEqual([]);
    expect((await owner.query("SELECT id FROM public.outbox_events WHERE event_type='commerce.order.paid.email' AND aggregate_id=ANY($1::uuid[])", [[unpaid.orderId, cancelled.orderId]])).rows).toEqual([]);
    for (const [name, method] of Object.entries(host.emailPort)) if (name.startsWith('send') && name !== 'sendOrderPaidConfirmation') {
      await expect((method as () => Promise<unknown>)()).rejects.toThrow('starter_paid_mail_method_not_selected');
    }
  });
}, 10_000);

it('copy validation refuses a missing locale and an empty subject', () => {
  const missing = config(); Reflect.deleteProperty(missing.renewal.notices.copy, 'pl');
  expect(() => assertRenewalConfig(missing.renewal)).toThrow('starter_renewal_configuration_invalid');
  const empty = config(); empty.renewal.notices.copy.en.paid.subject = '  ';
  expect(() => assertRenewalConfig(empty.renewal)).toThrow('starter_renewal_configuration_invalid');
});

it('the paid artifact preserves atomic bytes and refuses corrupt identities without exposing private content', async () => {
  await local(async directory => {
    const capture = createPrivateCapture(directory), artifacts = createPaidMailArtifacts(capture), eventId = randomUUID();
    const key = paidMailKey(eventId), record: PaidMailArtifactV1 = { schemaVersion: 1, kind: 'order_paid',
      messageKey: key, outboxEventId: eventId, orderId: `order_${randomUUID()}`, recipient: 'private@example.test',
      recipientReference: `client:${randomUUID()}`, templateReference: 'template:commerce-order-paid:en',
      locale: 'en', subject: 'Private subject', body: 'Private message' };
    await artifacts.writeOnce(key, record); await artifacts.writeOnce(key, record);
    await expect(artifacts.writeOnce(key, { ...record, body: 'Changed' })).rejects.toThrow('starter_private_capture_unavailable');
    expect(await artifacts.read(key)).toEqual(record);
    const path = join(directory, createHash('sha256').update(key).digest('hex') + '.json');
    await writeFile(path, '{}\n', { mode: 0o600 });
    await expect(artifacts.read(key)).rejects.toThrow('starter_private_capture_unavailable');
    await expect(artifacts.writeOnce(key, { ...record, outboxEventId: randomUUID() })).rejects.toThrow('starter_paid_mail_identity_unavailable');
  });
});
