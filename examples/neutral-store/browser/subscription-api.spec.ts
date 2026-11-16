import { execFileSync } from 'node:child_process';
import { test, expect, nativeSubscription } from './subscription-native-fixture.ts';

test('J-X1: swap through the starter routes preserves line ID and refuses a duplicate target',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject),catalog = await f.catalogue();
  const from = f.sub.lines[0]!,target = catalog.candidates.find(item => !f.sub.lines.some(line => line.variantId === item.variantId))!;
  await f.apply({ subscriptionId: f.id,action: 'swap_base_line',fromVariantId: from.variantId,toVariantId: target.variantId });
  expect((await f.read()).lines.find(line => line.variantId === target.variantId)!.lineId).toBe(from.lineId);
  const request = { subscriptionId: f.id,action: 'swap_base_line',fromVariantId: target.variantId,toVariantId: f.sub.lines[1]!.variantId };
  const quote = await f.accepted(request),before = (await f.read()).lines;
  const refused = await f.action('subscription.command',{ request: quote.request },quote.key);
  expect(refused.body.ok).toBe(false); expect(refused.body.code).toBe('subscription_edit_conflict_duplicate_line'); expect((await f.read()).lines).toEqual(before);
});
test('J-X2: add/change/remove extras preserve IDs and allow retired removal through starter routes',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject),variantId = f.uuid(String(f.rows('SELECT id FROM public.catalog_skus WHERE is_addon ORDER BY id LIMIT 1')[0]!.id));
  await f.apply({ subscriptionId: f.id,action: 'add_addon',variantId,qty: 2 });
  const before = (await f.read()).lines.find(line => line.isAddon)!;
  await f.apply({ subscriptionId: f.id,action: 'update_addon_quantity',variantId,qty: 4 });
  const updated = (await f.read()).lines.find(line => line.isAddon)!; expect(updated.lineId).toBe(before.lineId); expect(updated.qty).toBe(4);
  try { f.sql(`UPDATE public.catalog_skus SET status='archived' WHERE id='${variantId}'`);
    await f.apply({ subscriptionId: f.id,action: 'remove_addon',variantId }); expect((await f.read()).lines.some(line => line.isAddon)).toBe(false);
  } finally { f.sql(`UPDATE public.catalog_skus SET status='active' WHERE id='${variantId}'`); }
});
test('J-X3: base mix preserves its fixed total; changed total is refused by starter preview',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject),before = await f.classicRequest();
  const base = before.base.map((line,index) => ({ ...line,qty: line.qty+(index ? 1 : -1) }));
  await f.apply({ subscriptionId: f.id,action: 'update_base_mix',base });
  expect((await f.read()).lines.filter(line => !line.isAddon).map(line => [line.variantId,line.qty])).toEqual(base.map(line => [line.variantId,line.qty]));
  base[0]!.qty++;
  const refused = await f.action('subscription.preview',{ request: { subscriptionId: f.id,action: 'update_base_mix',base } });
  expect(refused.body.code).toBe('subscription_reprice_base_total_mismatch');
});
test('J-X4: plan-length and portion resize are named unconfigured starter limits',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject);
  for (const request of [{ subscriptionId: f.id,action: 'update_plan_length',planDays: 14 },{ subscriptionId: f.id,action: 'update_portion',portionMode: 'reduced' }]) {
    for (const operation of ['subscription.preview','subscription.command']) {
      const refused = await f.action(operation,{ request }); expect(refused.status).toBe(409); expect(refused.body.code).toBe('starter_subscription_resize_unconfigured');
    }
  }
});

test('J-X5: unsupported fresh classic cadence and forged variants refuse with zero durable writes',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject),request = await f.classicRequest();
  const snapshot = () => ({ subscription: f.rows(`SELECT cadence_days,template_version,next_cycle_at FROM public.subscriptions WHERE id='${f.id}'`),
    lines: f.rows(`SELECT * FROM public.subscription_lines WHERE subscription_id='${f.id}' ORDER BY id`),
    events: f.rows(`SELECT id FROM public.subscription_events WHERE subscription_id='${f.id}' ORDER BY id`),
    quotes: f.rows(`SELECT id FROM public.subscription_quote_previews WHERE subscription_id='${f.id}' ORDER BY id`),
    receipts: f.rows(`SELECT idempotency_key FROM public.subscription_command_receipts WHERE subscription_id='${f.id}' ORDER BY idempotency_key`) });
  const before = snapshot();
  for (const forged of [{ ...request,planDays: 35 },{ ...request,base: [{ ...request.base[0]!,variantId: '00000000-0000-4000-8000-000000000099' }] },
    { ...request,base: [{ ...request.base[0]!,qty: 100 }] }]) for (const phase of ['subscription.preview','subscription.command']) {
    const result = await f.action(phase,{ request: { ...forged,acceptedQuoteHash: 'a'.repeat(64) } });
    expect(result.body.ok).toBe(false);
    expect(snapshot()).toEqual(before);
  }
});

for (const mode of ['classic','sized'] as const) test(`owned ${mode} offer withdrawal preserves completed replay and refuses fresh full-result edits`,async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject);
  let applied;
  if (mode === 'sized') applied = await f.optIn();
  else { const request = await f.classicRequest(); request.base[0]!.qty++; applied = await f.apply(request); }
  const request = mode === 'sized' ? await f.sizedRequest() : await f.classicRequest();
  if ('resizeLever' in request) {
    if (request.action !== 'resize_bundle' || request.resizeLever.kind !== 'subscription.sized.parcel') throw new Error('fixture');
    request.resizeLever.value.coreLines[0]!.qty++; request.compositionConstraint.value = 9;
  } else if ('base' in request) request.base[0]!.qty++;
  else throw new Error('fixture');
  const accepted = await f.accepted(request),before = await f.read();
  const unchangedSku = before.lines.filter(line => !line.isAddon)[1]!.sku!;
  const writes = () => f.rows(`SELECT
    (SELECT count(*) FROM public.subscription_events WHERE subscription_id='${f.id}') AS events,
    (SELECT count(*) FROM public.subscription_quote_previews WHERE subscription_id='${f.id}') AS quotes,
    (SELECT count(*) FROM public.subscription_command_receipts WHERE subscription_id='${f.id}') AS receipts`);
  const counts = writes();
  // Execute the actual starter binding with an owned configuration change on the same installed database.
  const code = `import assert from 'node:assert/strict';import pg from 'pg';
    import {selectConfiguration} from './owned/store.config.ts';import {subscriptionEditing} from './owned/subscription-editing.ts';
    import {composeSubscriptionEditors} from './host/subscription-editors.ts';
    const pool=new pg.Pool({connectionString:'postgresql://starter_runtime@database/neutral_store'});
    try { const config=selectConfiguration(${JSON.stringify(f.config.id)}),offer=config.subscriptionOffers[${JSON.stringify(mode)}];
      offer.bySku=Object.fromEntries(Object.entries(offer.bySku).filter(([sku])=>sku!==${JSON.stringify(unchangedSku)}));
      config.subscriptionEditing=subscriptionEditing(config.offer.products,config.subscriptionOffers);
      const row=(await pool.query('SELECT s.client_id,c.principal_id FROM public.subscriptions s JOIN public.clients c ON c.id=s.client_id WHERE s.id=$1',[${JSON.stringify(f.id)}])).rows[0];
      const context={config,actor:{customerRef:row.client_id,principalRef:row.principal_id,operatorRef:null}};
      const actions=composeSubscriptionEditors(pool);
      const replay=await actions['subscription.command']({request:${JSON.stringify(applied.request)}},{...context,commandKey:${JSON.stringify(applied.key)}});
      assert.equal(replay.ok,true);assert.equal(replay.value.status,'replayed');
      for(const phase of ['subscription.preview','subscription.command']) {
        const request=${JSON.stringify(accepted.request)};if(phase==='subscription.preview')delete request.acceptedQuoteHash;
        const fresh=await actions[phase]({request},{...context,commandKey:${JSON.stringify(accepted.key)}});
        assert.equal(fresh.ok,false);assert.equal(fresh.code,'subscription_reprice_terms_not_admitted');
      }
    } finally {await pool.end()}`;
  execFileSync('docker',['compose','--project-name',composeProject,'exec','-T','--user','node','application','node','--experimental-strip-types','--input-type=module'],
    { input: code,stdio: ['pipe','pipe','pipe'],timeout: 30000 });
  expect(await f.read()).toEqual(before); expect(writes()).toEqual(counts);
});
