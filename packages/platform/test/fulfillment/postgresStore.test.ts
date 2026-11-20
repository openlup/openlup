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

it('batches stock sync writes in deterministic lock order, scatters responses back, and matches single-item fingerprints', async () => {
 const calls: { sql: string; values: unknown[] }[] = [];
 const query = vi.fn(async (sql: string, values: unknown[] = []) => {
  calls.push({ sql, values });
  if (sql.includes('unnest') && sql.includes('fulfillment_record_stock_current')) {
   const skus = values[3] as string[];
   return { rows: skus.map((sku, idx) => ({ ord: idx + 1, response: { replayed: sku === 'sku-a', readBack: true } })) };
  }
  if (sql.includes('unnest') && sql.includes('fulfillment_record_stock_snapshot')) {
   const keys = values[1] as string[];
   return { rows: keys.map((key, idx) => ({ ord: idx + 1, response: { replayed: key === 'k-a', readBack: true } })) };
  }
  if (sql.includes('unnest') && sql.includes('fulfillment_record_stock_evidence')) {
   const keys = values[1] as string[];
   return { rows: keys.map((key, idx) => ({ ord: idx + 1, response: { replayed: key === 'ev-a' } })) };
  }
  if (sql.includes('jsonb_array_elements') && sql.includes('fulfillment_resolve_stock_evidence')) {
   const payload = JSON.parse(String(values[1])) as { skuRef: string }[];
   return { rows: payload.map((entry, idx) => ({ ord: idx + 1, response: { resolved: entry.skuRef === 'sku-a' ? 2 : 0 } })) };
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
 expect(calls[0].values[3]).toEqual(['sku-a', 'sku-b']);
 expect(currentOut).toEqual([{ replayed: false, readBack: true }, { replayed: true, readBack: true }]);

 const snapshotOut = await port.recordStockSnapshotBatch!([
  { requestKey: 'k-b', snapshot: snapB, local: localB, mismatchKind: 'none', inventoryClass: 'sellable' },
  { requestKey: 'k-a', snapshot: snapA, local: localA, mismatchKind: 'none', inventoryClass: null },
 ]);
 expect(calls[1].values[1]).toEqual(['k-a', 'k-b']);
 expect(snapshotOut).toEqual([{ replayed: false, readBack: true }, { replayed: true, readBack: true }]);

 const evA = { requestKey: 'ev-a', skuRef: 'sku-a', thresholdKind: 'safety_stock' as const, severity: 'warning' as const, providerForSaleQuantity: 5, localAvailableQuantity: 2, syncRunId: 'run-1' };
 const evB = { requestKey: 'ev-b', skuRef: 'sku-b', thresholdKind: 'reservation_coverage' as const, severity: 'critical' as const, providerForSaleQuantity: 3, localAvailableQuantity: 1, syncRunId: 'run-1' };
 const evidenceOut = await port.recordLowStockEvidenceBatch!([evB, evA]);
 expect(calls[2].values[1]).toEqual(['ev-a', 'ev-b']);
 expect(evidenceOut).toEqual([{ replayed: false }, { replayed: true }]);
 await port.recordLowStockEvidence(evA);
 expect((calls[2].values[2] as string[])[0]).toBe(calls[3].values[2]);

 const resolveOut = await port.resolveLowStockEvidenceBatch!([
  { skuRef: 'sku-b', activeThresholdKinds: [], syncRunId: 'run-1' },
  { skuRef: 'sku-a', activeThresholdKinds: ['safety_stock'], syncRunId: 'run-1' },
 ]);
 expect(JSON.parse(String(calls[4].values[1]))).toEqual([
  { skuRef: 'sku-a', activeThresholdKinds: ['safety_stock'], syncRunId: 'run-1' },
  { skuRef: 'sku-b', activeThresholdKinds: [], syncRunId: 'run-1' },
 ]);
 expect(resolveOut).toEqual([{ resolved: 0 }, { resolved: 2 }]);

 const badPort = createPostgresFulfillmentStockSyncPort({ query: async () => ({ rows: [] }) }, { sourceKey: 'native-a', readLocalInventoryStock: async () => [] });
 await expect(badPort.recordProviderStockCurrentBatch!([
  { requestKey: 'k-a', snapshot: snapA, inventoryClass: 'sellable', lastSyncedAt: at, staleAfter: at },
 ])).rejects.toThrow('fulfillment_native_response_missing');
});
