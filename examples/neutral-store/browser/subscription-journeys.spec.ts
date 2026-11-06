import { test, expect, nativeSubscription } from './subscription-native-fixture.ts';
import { randomUUID } from 'node:crypto';

// Native purchase is mandatory. These journeys must remain unrun until its template attachment is available.
test('J-C1: quantities, candidate and removal review exact recurring money/date, confirm and read back',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject),catalog = await f.catalogue();
  const candidate = catalog.candidates.find(item => !f.sub.lines.some(line => line.variantId === item.variantId) && item.groupId !== f.config.subscriptionEditing.catalogue[0]!.groupKey)!;
  await f.open(); await page.getByRole('button',{ name: `Add one unit: ${f.sub.lines[0]!.title}`,exact: true }).click();
  await page.locator(`[data-variant="${candidate.variantId}"]`).click();
  await page.getByRole('button',{ name: `Remove ${f.sub.lines[1]!.title} from package`,exact: true }).click();
  const previewResponse = page.waitForResponse(response => response.url().endsWith('/subscription.preview'));
  await page.getByRole('button',{ name: 'Review changes',exact: true }).click();
  const preview = (await (await previewResponse).json()).value;
  await expect(page.getByTestId('price-review')).toBeVisible();
  await expect(page.locator('main')).toContainText('without the one-time introductory promotion');
  await page.getByRole('button',{ name: 'Confirm changes',exact: true }).click(); await expect(page).toHaveURL(/packageSaved=1$/);
  const current = await f.read(); expect(current.recurringTotal).toEqual(preview.newTotal);
  expect(current.lines.some(line => line.variantId === candidate.variantId && line.qty === 1)).toBe(true);
  expect(current.lines.some(line => line.variantId === f.sub.lines[1]!.variantId)).toBe(false);
  expect(current.nextCycleAt).toBe(f.sub.nextCycleAt);
});
test('J-C2: classic plan-only edit preserves quantities and moves cadence',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject),days = f.config.subscriptionEditing.planDays.find(value => value !== f.sub.cadenceDays)!;
  await f.open(); await page.getByRole('button',{ name: `Every ${days} days`,exact: true }).click(); await f.confirm();
  const current = await f.read(); expect(current.cadenceDays).toBe(days);
  expect(current.lines.map(line => [line.variantId,line.qty])).toEqual(f.sub.lines.map(line => [line.variantId,line.qty]));
});
test('J-C3: native small purchase displays the minimum banner and cannot review',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject,1); await f.open();
  await expect(page.getByTestId('minimum-banner')).toBeVisible(); await expect(page.getByRole('button',{ name: 'Review changes',exact: true })).toBeDisabled();
});
test('J-C4: a concurrent edit stales acceptance; return to editing and a fresh review succeeds',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject); await f.open();
  await page.getByRole('button',{ name: `Add one unit: ${f.sub.lines[0]!.title}`,exact: true }).click();
  await page.getByRole('button',{ name: 'Review changes',exact: true }).click();
  const competing = await f.classicRequest(); competing.base[1]!.qty++;
  await f.apply(competing);
  await page.getByRole('button',{ name: 'Confirm changes',exact: true }).click();
  await expect(page.getByTestId('editor-error')).toContainText('could not be saved');
  await f.confirm(); expect((await f.read()).lines.find(line => line.variantId === f.sub.lines[0]!.variantId)!.qty).toBe(7);
});
test('J-C5: closed edit window and open payment blocker disable the editor without moving its anchor',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject);
  f.sql(`UPDATE public.subscriptions SET edit_window_hours=720 WHERE id='${f.id}'`);
  await f.open(); await expect(page.getByRole('alert')).toContainText('edit window');
  f.sql(`UPDATE public.subscriptions SET edit_window_hours=72 WHERE id='${f.id}'`);
  const client = f.rows(`SELECT client_id FROM public.subscriptions WHERE id='${f.id}'`)[0]!.client_id;
  f.sql(`SELECT public.dunning_lifecycle_open_case('${randomUUID()}','${f.id}',NULL,'${f.uuid(String(client))}',1,'2030-12-01T12:00:00.000Z','provider_declined','synthetic','2026-11-06T12:00:00.000Z',100,'XTS','subscription-payment-failed-1',NULL)`);
  await page.reload(); await expect(page.getByRole('alert')).toContainText('open payment case');
  expect((await f.read()).nextCycleAt).toBe(f.sub.nextCycleAt); expect((await f.read()).status).toBe('active');
});
test('J-C6: an agreed extra is removed and restored with its saved quantity',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject);
  const addon = String(f.rows('SELECT id FROM public.catalog_skus WHERE is_addon ORDER BY id LIMIT 1')[0]!.id);
  await f.apply({ subscriptionId: f.id,action: 'add_addon',variantId: addon,qty: 3 });
  const saved = (await f.read()).lines.find(line => line.isAddon)!;
  await f.open(); await page.getByRole('button',{ name: `Remove ${saved.title} (3)`,exact: true }).click();
  await page.getByRole('button',{ name: `Restore ${saved.title} (3)`,exact: true }).click();
  await page.getByRole('button',{ name: 'Every 14 days',exact: true }).click(); await f.confirm();
  expect((await f.read()).lines.find(line => line.isAddon)!.qty).toBe(3);
});
test('J-C7: test-only native notice capture sees one package-change mail and none for a no-op',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject); await f.open();
  await page.getByRole('button',{ name: `Add one unit: ${f.sub.lines[0]!.title}`,exact: true }).click(); await f.confirm();
  expect(f.captureNotices().filter(item => item.subscriptionId === f.id && item.kind === 'subscription.package_changed')).toHaveLength(1);
  const noOp = await f.apply(await f.classicRequest()); expect(noOp.result.status).toBe('noop'); expect(noOp.result.eventId).toBeNull();
  expect(f.captureNotices().filter(item => item.subscriptionId === f.id && item.kind === 'subscription.package_changed')).toHaveLength(0);
});
test('J-S1: entry and abandonment keep classic; unchanged contents require review and explicit sized consent',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject); await f.open(true,true);
  expect((await f.read()).offerVersion).toBe('classic'); await page.getByRole('button',{ name: 'Back to classic package',exact: true }).click();
  expect((await f.read()).offerVersion).toBe('classic'); await f.open(true,true);
  await page.getByRole('button',{ name: 'Review changes',exact: true }).click(); await expect(page.getByTestId('opt-in-consent')).toBeVisible();
  expect((await f.read()).offerVersion).toBe('classic');
  await page.getByRole('button',{ name: 'I accept size-aware servicing and the price; save',exact: true }).click();
  await expect(page).toHaveURL(/packageSaved=1$/); expect((await f.read()).offerVersion).toBe('sized.v1');
});
test('J-S2: exact size/count/group edit quotes changed lines and retains the unchanged agreement',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject); await f.optIn();
  const before = f.eventPricing() as { sku: string; quoteLine: unknown }[],catalog = await f.catalogue(true);
  const first = catalog.candidates.find(item => item.variantId === f.sub.lines[0]!.variantId)!,sibling = catalog.candidates.find(item => item.groupId === first.groupId && item.variantId !== first.variantId)!;
  const unchangedSku = f.sub.lines[1]!.sku!;
  const price = f.rows(`SELECT id,unit_price_minor FROM public.price_entries WHERE variant_id='${f.uuid(f.sub.lines[1]!.variantId)}' AND mode='subscription'`)[0]!;
  try {
    f.sql(`UPDATE public.price_entries SET unit_price_minor=unit_price_minor+7 WHERE id='${f.uuid(String(price.id))}'`);
    await f.open(true); await page.getByRole('combobox',{ name: `Size: ${first.name.en}`,exact: true }).selectOption(sibling.variantId);
    await page.getByRole('button',{ name: `Add one unit: ${first.name.en}`,exact: true }).click();
    const candidate = catalog.candidates.find(item => !f.sub.lines.some(line => line.variantId === item.variantId) && item.groupId !== first.groupId && item.groupId !== catalog.candidates.find(row => row.variantId === f.sub.lines[1]!.variantId)!.groupId)!;
    await page.getByRole('button',{ name: `Add ${candidate.name.en} to package`,exact: true }).click(); await f.confirm();
    const after = f.eventPricing() as { sku: string; quoteLine: unknown }[];
    expect(after.find(item => item.sku === unchangedSku)!.quoteLine).toEqual(before.find(item => item.sku === unchangedSku)!.quoteLine);
    expect((await f.read()).lines.find(line => line.variantId === sibling.variantId)!.qty).toBe(7);
  } finally { f.sql(`UPDATE public.price_entries SET unit_price_minor=${Number(price.unit_price_minor)} WHERE id='${f.uuid(String(price.id))}'`); }
});
test('J-S3: excessive stock increase refuses; retained/reduced zero-stock lines survive',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject); await f.optIn(); const catalog = await f.catalogue(true);
  const first = catalog.candidates.find(item => item.variantId === f.sub.lines[0]!.variantId)!;
  const siblings = catalog.candidates.filter(item => item.groupId === first.groupId);
  try {
    for (const item of siblings) f.setStock(item.variantId,0);
    const request = await f.sizedRequest(); if (request.action !== 'resize_bundle' || request.resizeLever.kind !== 'subscription.sized.parcel') throw new Error('fixture');
    request.resizeLever.value.coreLines[0]!.qty++; request.compositionConstraint.value = 9;
    expect((await f.action('subscription.preview',{ request })).body.ok).toBe(false);
    await f.open(true); await expect(page.getByRole('button',{ name: `Add one unit: ${first.name.en}`,exact: true })).toBeDisabled();
    await page.getByRole('button',{ name: `Remove one unit: ${first.name.en}`,exact: true }).click(); await f.confirm();
    expect((await f.read()).lines.find(line => line.variantId === first.variantId)!.qty).toBe(5);
  } finally { for (const item of siblings) f.setStock(item.variantId,1000); }
});
test('J-S4: seeded exclusions block new selection/preview; retained conflict can be repaired and changed facts refuse apply',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject),original = f.subject(); await f.optIn();
  const catalog = await f.catalogue(true),conflict = catalog.candidates.find(item => item.sku === f.config.offer.products[2]!.sku)!;
  try {
    f.setSubject({ ...JSON.parse(original),currentExclusions: ['demo-restricted'] });
    await f.open(true); await expect(page.getByRole('button',{ name: `Add ${conflict.name.en} to package`,exact: true })).toBeDisabled();
    const request = await f.sizedRequest(); if (request.action !== 'resize_bundle' || request.resizeLever.kind !== 'subscription.sized.parcel') throw new Error('fixture');
    request.resizeLever.value.coreLines.push({ variantId: conflict.variantId,qty: 1 }); request.compositionConstraint.value = 9;
    expect((await f.action('subscription.preview',{ request })).body.code).toBe('subscription_reprice_sized_exclusion_conflict');
    f.setSubject(JSON.parse(original)); await f.apply(request);
    f.setSubject({ ...JSON.parse(original),currentExclusions: ['demo-restricted'] });
    await f.open(true); await expect(page.getByRole('button',{ name: 'Review changes',exact: true })).toBeDisabled();
    await page.getByRole('button',{ name: `Remove ${conflict.name.en} from package`,exact: true }).click();
    const previewReply = page.waitForResponse(response => response.url().endsWith('/subscription.preview'));
    await page.getByRole('button',{ name: 'Review changes',exact: true }).click(); expect((await (await previewReply).json()).ok).toBe(true);
    f.setSubject({ ...JSON.parse(original),revision: 2 });
    const applyReply = page.waitForResponse(response => response.url().endsWith('/subscription.command'));
    await page.getByRole('button',{ name: 'Confirm changes',exact: true }).click(); expect((await (await applyReply).json()).ok).toBe(false);
    expect((await f.read()).lines.some(line => line.variantId === conflict.variantId)).toBe(true);
  } finally { f.setSubject(JSON.parse(original)); }
});
test('J-S5: withdrawn new/increased SKUs refuse while exact retained quantities survive',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject); await f.optIn();
  const retained = f.uuid(f.sub.lines[0]!.variantId),novel = (await f.catalogue(true)).candidates.find(item => !f.sub.lines.some(line => line.variantId === item.variantId) && !item.isAddon)!;
  try {
    f.sql(`UPDATE public.catalog_skus SET sellable_in_subscription=false WHERE id IN ('${retained}','${f.uuid(novel.variantId)}')`);
    const exact = await f.sizedRequest(); if (exact.action !== 'resize_bundle') throw new Error('fixture');
    exact.cadenceDays = 14; await f.apply(exact);
    const changed = await f.sizedRequest(); if (changed.action !== 'resize_bundle' || changed.resizeLever.kind !== 'subscription.sized.parcel') throw new Error('fixture');
    changed.resizeLever.value.coreLines[0]!.qty++; changed.compositionConstraint.value = 9;
    expect((await f.action('subscription.preview',{ request: changed })).body.ok).toBe(false);
    const fresh = await f.sizedRequest(); if (fresh.action !== 'resize_bundle' || fresh.resizeLever.kind !== 'subscription.sized.parcel') throw new Error('fixture');
    fresh.resizeLever.value.coreLines.push({ variantId: novel.variantId,qty: 1 }); fresh.compositionConstraint.value = 9;
    expect((await f.action('subscription.preview',{ request: fresh })).body.ok).toBe(false);
  } finally { f.sql(`UPDATE public.catalog_skus SET sellable_in_subscription=true WHERE id IN ('${retained}','${f.uuid(novel.variantId)}')`); }
});
test('J-S6: a matching completed key replays after a later subject-fact change',async ({ page,baseURL,composeProject }) => {
  const f = await nativeSubscription(page,baseURL,composeProject),original = f.subject(); const applied = await f.optIn();
  try {
    f.setSubject({ ...JSON.parse(original),revision: 2,currentExclusions: ['demo-restricted'] });
    const events = f.rows(`SELECT id FROM public.subscription_events WHERE subscription_id='${f.id}'`);
    const replay = await f.action('subscription.command',{ request: applied.request },applied.key);
    expect(replay.body.ok).toBe(true); expect(replay.body.value.status).toBe('replayed');
    expect(f.rows(`SELECT id FROM public.subscription_events WHERE subscription_id='${f.id}'`)).toEqual(events);
  } finally { f.setSubject(JSON.parse(original)); }
});
