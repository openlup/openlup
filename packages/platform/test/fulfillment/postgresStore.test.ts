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
