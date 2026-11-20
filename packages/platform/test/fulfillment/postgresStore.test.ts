import { expect,it,vi } from 'vitest';
import { createPostgresFulfillmentDispatchStore,createPostgresDeliveryAlignmentPort,createPostgresFulfillmentStockSyncPort } from '../../src/fulfillment/index.js';

it('forwards durable operations through the injected executor, projects evidence, and preserves timed G16 host input',async()=>{
 const query=vi.fn(async(sql:string)=>({rows:[{response:sql.includes('record_provider_attempt')?{replayed:true}:{status:'confirmed',proofRecorded:true}}]}));
 const db={query};const store=createPostgresFulfillmentDispatchStore(db,{async prepare(){return {disposition:'ready',contactRevision:1};},async readCandidate(){return null;}});
 const evidence={commandFingerprint:'a'.repeat(64),contactRevision:{schemaVersion:1,source:'host',revision:1},providerRef:'warehouse-a',carrierRef:null,serviceRef:null,rawBody:'must-not-persist'};
 expect(await store.recordProviderAttempt('legacy-key','shipment-a',evidence,'live','recorded')).toEqual({replayed:true});
 expect(query.mock.calls[0][0]).toContain('fulfillment_record_provider_attempt');expect(JSON.stringify(query.mock.calls)).not.toContain('must-not-persist');
 await store.commandLedger.reconcile({commandId:'command-a',expectedVersion:4,identityFingerprint:'b'.repeat(64),proof:{kind:'correlation_key',fingerprint:'b'.repeat(64),observedAt:'2026-10-21T12:00:00Z',source:'provider_lookup'}});expect(query.mock.calls[1][0]).toContain('commerce_fulfillment_reconcile_provider_command');
 const lines=[{skuRef:'sku-a',quantity:{onHand:4,reserved:1,unavailable:0,safetyStock:1},fulfillable:true,locationStatus:'active' as const,lotStatus:null,expiresAt:null}];const readLocalInventoryStock=vi.fn(async()=>lines);const stock=createPostgresFulfillmentStockSyncPort(db,{sourceKey:'native-a',readLocalInventoryStock});const at='2026-10-21T12:00:00Z';expect(await stock.readLocalInventoryStock(at)).toBe(lines);expect(readLocalInventoryStock).toHaveBeenCalledWith(at);
 expect(Object.keys(createPostgresDeliveryAlignmentPort(db))).toEqual(['read','recordArrival']);
});

it.each([undefined, 'webhook', 'polling'] as const)('threads %s intake outside retained acceptance and validates receipt alias bytes', async intakeMode => {
 const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ response: { acknowledged: true } }] }));
 const store = createPostgresFulfillmentDispatchStore({ query }, { intakeMode, prepare: vi.fn(), readCandidate: vi.fn() });
 const evidence = { commandFingerprint: 'a'.repeat(64), contactRevision: { schemaVersion: 1, source: 'host', revision: 1 }, providerRef: 'warehouse-a', carrierRef: null, serviceRef: null };
 const legacy = { kind: 'accepted' as const, externalRef: 'external-a', evidence, providerAttemptKey: 'attempt-a', labelKey: 'receipt-a' };
 await store.acknowledge({ dispatchRef: 'dispatch-a', acceptance: legacy });
 expect(JSON.parse(String(query.mock.calls[0][1]?.[1]))).toEqual(legacy);
 expect(query.mock.calls[0][1]?.slice(2)).toEqual([true, intakeMode === 'polling' ? 'poll' : 'push']);
 await store.finalize({ dispatchRef: 'dispatch-a', result: { ...legacy, receiptKey: legacy.labelKey } });
 expect(JSON.parse(String(query.mock.calls[1][1]?.[1]))).toEqual({ ...legacy, receiptKey: legacy.labelKey });
 expect(query.mock.calls[1][1]?.slice(2)).toEqual([false, intakeMode === 'polling' ? 'poll' : 'push']);
 expect(() => store.acknowledge({ dispatchRef: 'dispatch-a', acceptance: { ...legacy, receiptKey: 'Receipt-a' } })).toThrow('fulfillment_dispatch_receipt_key_conflict');
 expect(query).toHaveBeenCalledTimes(2);
});

it('batches stock sync writes with PostgreSQL collation-aligned MATERIALIZED CTE ordering, scatters by ord, and matches single-item fingerprints', async () => {
 const calls: { sql: string; values: unknown[] }[] = [];
 const query = vi.fn(async (sql: string, values: unknown[] = []) => {
  calls.push({ sql, values });
  if (sql.includes('WITH ordered AS MATERIALIZED') && sql.includes('fulfillment_record_stock_current')) {
   const skus = values[3] as string[];
   // Simulate PostgreSQL returning rows in sorted sku order (ord 2 before ord 1)
   const sorted = skus.map((sku, idx) => ({ sku, ord: idx + 1 })).sort((a, b) => a.sku.localeCompare(b.sku) || a.ord - b.ord);
   return { rows: sorted.map(({ sku, ord }) => ({ ord: String(ord), response: { replayed: sku === 'sku-a', readBack: true } })) };
  }
  if (sql.includes('WITH ordered AS MATERIALIZED') && sql.includes('fulfillment_record_stock_snapshot')) {
   const keys = values[1] as string[];
   const sorted = keys.map((key, idx) => ({ key, ord: idx + 1 })).sort((a, b) => a.key.localeCompare(b.key) || a.ord - b.ord);
   return { rows: sorted.map(({ key, ord }) => ({ ord, response: { replayed: key === 'k-a', readBack: true } })) };
  }
  if (sql.includes('WITH ordered AS MATERIALIZED') && sql.includes('fulfillment_record_stock_evidence')) {
   const skus = values[3] as string[];
   const sorted = skus.map((sku, idx) => ({ sku, ord: idx + 1 })).sort((a, b) => a.sku.localeCompare(b.sku) || a.ord - b.ord);
   return { rows: sorted.map(({ sku, ord }) => ({ ord, response: { replayed: sku === 'sku-a' } })) };
  }
  if (sql.includes('WITH ordered AS MATERIALIZED') && sql.includes('fulfillment_resolve_stock_evidence')) {
   const payload = JSON.parse(String(values[1])) as { skuRef: string }[];
   const sorted = payload.map((entry, idx) => ({ sku: entry.skuRef, ord: idx + 1 })).sort((a, b) => a.sku.localeCompare(b.sku) || a.ord - b.ord);
   return { rows: sorted.map(({ sku, ord }) => ({ ord: String(ord), response: { resolved: sku === 'sku-a' ? 2 : 0 } })) };
  }
  return { rows: [{ response: { replayed: false } }] };
 });
 const port = createPostgresFulfillmentStockSyncPort({ query }, { sourceKey: 'native-a', readLocalInventoryStock: async () => [] });

 expect(await port.recordProviderStockCurrentBatch!([])).toEqual([]);
 expect(await port.recordStockSnapshotBatch!([])).toEqual([]);
 expect(await port.recordLowStockEvidenceBatch!([])).toEqual([]);
 expect(await port.resolveLowStockEvidenceBatch!([])).toEqual([]);
 expect(query).not.toHaveBeenCalled();

 const at = '1999-01-01T00:00:00Z';
 const snapB = { providerRef: 'wh', syncRunId: 'run-1', collectedAt: at, sourceRevision: null, revisionSource: 'collection' as const, skuRef: 'sku-b', quantityKind: 'snapshot' as const, totalQuantity: 4, forSaleQuantity: 3, reservedOrUnavailableQuantity: 1 };
 const snapA = { ...snapB, skuRef: 'sku-a', totalQuantity: 9, forSaleQuantity: 5, reservedOrUnavailableQuantity: 4 };
 const localB = { skuRef: 'sku-b', onHand: 4, reserved: 0, unavailable: 0, safetyStock: 1 };
 const localA = { skuRef: 'sku-a', onHand: 10, reserved: 2, unavailable: 1, safetyStock: 2 };

 const currentOut = await port.recordProviderStockCurrentBatch!([
  { requestKey: 'k-b', snapshot: snapB, inventoryClass: 'sellable', lastSyncedAt: at, staleAfter: at },
  { requestKey: 'k-a', snapshot: snapA, inventoryClass: null, lastSyncedAt: at, staleAfter: at },
 ]);
 expect(calls[0].sql).toContain('ORDER BY t.sku, t.ord');
 expect(calls[0].values[3]).toEqual(['sku-b', 'sku-a']);
 expect(currentOut).toEqual([{ replayed: false, readBack: true }, { replayed: true, readBack: true }]);

 const snapshotOut = await port.recordStockSnapshotBatch!([
  { requestKey: 'k-b', snapshot: snapB, local: localB, mismatchKind: 'none', inventoryClass: 'sellable' },
  { requestKey: 'k-a', snapshot: snapA, local: localA, mismatchKind: 'none', inventoryClass: null },
 ]);
 expect(calls[1].sql).toContain('ORDER BY t.request_key, t.ord');
 expect(snapshotOut).toEqual([{ replayed: false, readBack: true }, { replayed: true, readBack: true }]);

 const evA = { requestKey: 'ev-a', skuRef: 'sku-a', thresholdKind: 'safety_stock' as const, severity: 'warning' as const, providerForSaleQuantity: 5, localAvailableQuantity: 2, syncRunId: 'run-1' };
 const evB = { requestKey: 'ev-b', skuRef: 'sku-b', thresholdKind: 'reservation_coverage' as const, severity: 'critical' as const, providerForSaleQuantity: 3, localAvailableQuantity: 1, syncRunId: 'run-1' };
 const evidenceOut = await port.recordLowStockEvidenceBatch!([evB, evA]);
 expect(calls[2].sql).toContain('ORDER BY t.sku, t.ord');
 expect(evidenceOut).toEqual([{ replayed: false }, { replayed: true }]);
 await port.recordLowStockEvidence(evA);
 expect((calls[2].values[2] as string[])[1]).toBe(calls[3].values[2]);

 const resolveOut = await port.resolveLowStockEvidenceBatch!([
  { skuRef: 'sku-b', activeThresholdKinds: [], syncRunId: 'run-9' },
  { skuRef: 'sku-a', activeThresholdKinds: ['safety_stock'], syncRunId: 'run-10' },
 ]);
 expect(calls[4].sql).toContain("ORDER BY t.elem->>'skuRef', t.ord");
 expect(JSON.parse(String(calls[4].values[1]))).toEqual([
  { skuRef: 'sku-b', activeThresholdKinds: [], syncRunId: 'run-9' },
  { skuRef: 'sku-a', activeThresholdKinds: ['safety_stock'], syncRunId: 'run-10' },
 ]);
 expect(resolveOut).toEqual([{ resolved: 0 }, { resolved: 2 }]);

 // Missing rows, duplicate ord, or out-of-range ord fail fast
 for (const rows of [
  [],
  [{ ord: 1, response: { replayed: false, readBack: true } }, { ord: 1, response: { replayed: false, readBack: true } }],
  [{ ord: 3, response: { replayed: false, readBack: true } }],
 ]) {
  const badPort = createPostgresFulfillmentStockSyncPort({ query: async () => ({ rows }) }, { sourceKey: 'native-a', readLocalInventoryStock: async () => [] });
  const batch = rows.length === 2
   ? [{ requestKey: 'k-b', snapshot: snapB, inventoryClass: 'sellable' as const, lastSyncedAt: at, staleAfter: at },
      { requestKey: 'k-a', snapshot: snapA, inventoryClass: null, lastSyncedAt: at, staleAfter: at }]
   : [{ requestKey: 'k-a', snapshot: snapA, inventoryClass: 'sellable' as const, lastSyncedAt: at, staleAfter: at }];
  await expect(badPort.recordProviderStockCurrentBatch!(batch)).rejects.toThrow('fulfillment_native_response_missing');
 }
});
