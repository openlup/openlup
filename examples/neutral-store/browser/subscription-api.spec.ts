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
