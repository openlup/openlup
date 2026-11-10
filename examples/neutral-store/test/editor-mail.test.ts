import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeSizedPaidEmailNote } from '../host/editor-mail.ts';
import { configurations } from '../owned/store.config.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture() {
  const header = { subscription_cycle_id: id(2),cycle_id: id(2),subscription_id: id(3),binding: 'sized.v1',
    cycle_snapshot: { subscriptionId: id(3),cycle: { status: 'correlated',logicalCycleNumber: 2 },
      templateSnapshot: { cadenceDays: 28 },orderSnapshot: { lines: [{ lineOrdinal: 1,sku: 'EXACT-A',quantity: 4 },{ lineOrdinal: 2,sku: 'EXACT-B',quantity: 2 }] } } };
  const items = [{ sku_id: id(4),quantity: 4,line_ordinal: 1 },{ sku_id: id(5),quantity: 2,line_ordinal: 2 }];
  const retained = new Map([[id(4),{ id: id(4),sku: 'EXACT-A',net_weight_g: 250 }],[id(5),{ id: id(5),sku: 'EXACT-B',net_weight_g: 500 }]]);
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const db = { async query(sql: string,values?: unknown[]) {
    calls.push({ sql,values });
    return { rows: sql.includes('cycle_snapshot') ? [header] : sql.includes('commerce_order_items') ? items
      : sql.includes('FROM public.catalog_skus') ? [retained.get(String(values?.[0]))!] : [] };
  } };
  return { header,items,retained,calls,note: composeSizedPaidEmailNote(db,configurations.supplements!) };
}
test('describeParcel uses frozen quantities, exact retained physical identities and the renewal snapshot cadence', async () => {
  const f = fixture();
  assert.equal(await f.note(id(1),'en',new AbortController().signal),'Items: 6 · 4 × 250 g, 2 × 500 g · Every 28 days');
  assert.equal(await f.note(id(1),'pl',new AbortController().signal),'Produkty: 6 · 4 × 250 g, 2 × 500 g · Co 28 dni');
  assert.deepEqual(f.calls.filter(call => call.sql.includes('FROM public.catalog_skus')).map(call => call.values),[[id(4)],[id(5)],[id(4)],[id(5)]]);
  assert.ok(f.calls.every(call => !call.sql.includes('s.cadence_days') && !call.sql.includes('subscription_lines')));
});
for (const kind of ['identity','quantity','correlation','acquisition','binding','unreadable'] as const) {
  test(`describeParcel omits unprovable ${kind} facts`, async () => {
    const f = fixture();
    if (kind === 'identity') f.retained.get(id(4))!.sku = 'SIBLING';
    if (kind === 'quantity') f.items[0]!.quantity = 9;
    if (kind === 'correlation') f.header.cycle_snapshot.subscriptionId = id(9);
    if (kind === 'acquisition') f.header.cycle_snapshot.cycle.logicalCycleNumber = 1;
    if (kind === 'binding') f.header.binding = 'classic';
    if (kind === 'unreadable') f.retained.get(id(4))!.net_weight_g = 0;
    assert.equal(await f.note(id(1),'en',new AbortController().signal),null);
  });
}
test('describeParcel omits an unsupported frozen cadence and stops before reading after abort', async () => {
  const f = fixture(); f.header.cycle_snapshot.templateSnapshot.cadenceDays = 17;
  assert.equal(await f.note(id(1),'en',new AbortController().signal),'Items: 6 · 4 × 250 g, 2 × 500 g');
  const before = f.calls.length,controller = new AbortController(); controller.abort();
  assert.equal(await f.note(id(1),'en',controller.signal),null); assert.equal(f.calls.length,before);
});
