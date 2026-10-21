import { createHash,randomUUID } from 'node:crypto';
import { mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { Pool } from 'pg';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { FULFILLMENT_MIGRATIONS,createPostgresFulfillmentDispatchStore,createPostgresPaidFulfillmentHandoffStore,createPostgresFulfillmentShipmentSpinePort,createPostgresFulfillmentStockSyncPort } from '@openlup/platform/fulfillment';
import { readSelectedCatalogProjection,selectedCatalogProjectionPayload } from '../../server/adapters/postgres/selectedCatalogProjection.js';
import { runPostgresContainer,waitForPostgresTcpReady,type PostgresContainer } from '../helpers/postgresContainer.js';
import { executor,fixture,manifest,nativeHarness,units } from '../helpers/fulfillmentNative.js';
import type { FulfillmentObservation } from '@openlup/platform/fulfillment/contracts';
function observation(): FulfillmentObservation {
 const at='2026-10-21T12:00:00.000Z';
 return {fact:{schemaVersion:1,mapperVersion:'fixture-v1',factId:'fact:fixture',providerKind:'warehouse-a',fulfillmentReference:'external-fixture',canonicalStatus:'in_transit',provenance:{source:'provider_webhook',authority:'provider_asserted'},occurredAt:at,receivedAt:at,rawEvent:{reference:'evidence:00000000-0000-4000-8000-000000000001',digestAlgorithm:'sha256',digest:'a'.repeat(64)}},eventKind:'order.shipped',eventKey:'fixture-shipped',firstReceivedAt:at,correlation:{orderRef:null,fulfillmentRef:null,externalRef:'external-fixture',orderNumber:null,providerFulfillmentRef:null,parcelRef:null},trackingRefs:[]};
}
const h=nativeHarness('stores');beforeAll(()=>h.start(),120_000);afterAll(()=>h.stop());
const revision={schemaVersion:1,source:'fixture',revision:1};
const evidence={commandFingerprint:'a'.repeat(64),contactRevision:revision,providerRef:'warehouse-a',carrierRef:null,serviceRef:null};
const store=()=>createPostgresFulfillmentDispatchStore(executor(h.pool),{async prepare(){return {disposition:'ready',contactRevision:1};},async readCandidate(){return null;}});
it('fresh full-catalogue install binds sparse assets, hashes and object inventory, then replays without changing history',async()=>{
 expect(FULFILLMENT_MIGRATIONS.map(unit=>unit.position)).toEqual([5,27,51,73,74]);
 for(const unit of FULFILLMENT_MIGRATIONS){const bytes=readFileSync(unit.catalogPath);expect(readFileSync(unit.url)).toEqual(bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(unit.sha256);expect(units[unit.position]).toEqual({file:unit.catalogPath,sha256:unit.sha256});}
 const history=(await h.pool.query('SELECT * FROM public.platform_schema_migrations ORDER BY position')).rows;
 expect(history.map(({catalog_path,sha256,position})=>({file:catalog_path,sha256,position}))).toEqual(units.map((u,position)=>({...u,position})));
 expect(await h.runner().apply()).toEqual({applied:[]});expect((await h.runner().status()).pending).toEqual([]);
 expect((await h.pool.query('SELECT * FROM public.platform_schema_migrations ORDER BY position')).rows).toEqual(history);
 const client=await h.pool.connect();try{expect(createHash('sha256').update(selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client))).digest('hex')).toBe(manifest.objectInventorySha256);}finally{client.release();}
});
it('complete immutable prefix 72 upgrades through 73/74, preserves rows/history and replays the full catalogue',async()=>{
 let resource:PostgresContainer|undefined,db:Pool|undefined;const root=mkdtempSync(join(tmpdir(),'m08-p4-prefix-'));
 try{
  const boot=Date.now();resource=await runPostgresContainer({name:`m08-p4-prefix-${process.pid}`,password:'synthetic-conformance'});if(!await waitForPostgresTcpReady(resource.connectionString))throw new Error('P4 prefix PostgreSQL unavailable');console.log(`P4 prefix Docker setup ms=${Date.now()-boot}`);
  db=new Pool({connectionString:resource.connectionString});const tx=await db.connect();let payload:string;
  try{await tx.query('BEGIN');for(const unit of units.slice(0,73))await tx.query(readFileSync(unit.file,'utf8'));payload=selectedCatalogProjectionPayload(await readSelectedCatalogProjection(tx));}finally{await tx.query('ROLLBACK');tx.release();}
  const prefix={...manifest,forward:manifest.forward.slice(0,72),objectInventorySha256:createHash('sha256').update(payload!).digest('hex')};
  for(const unit of units.slice(0,73)){const path=join(root,unit.file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,readFileSync(unit.file));}
  mkdirSync(join(root,'config'));writeFileSync(join(root,'config/platform-migration-manifest.json'),JSON.stringify(prefix));await h.runner(db,root).apply();
  const f=await fixture(db);const before=(await db.query('SELECT * FROM public.platform_schema_migrations ORDER BY position')).rows;const rows=(await db.query('SELECT * FROM public.fulfillment_shipments WHERE id=$1',[f.shipment])).rows;
  const oldAcl=(await db.query("SELECT oid,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid")).rows;expect(before).toHaveLength(73);expect((await h.runner(db).apply()).applied).toEqual(units.slice(73).map(u=>u.file));
  expect((await db.query('SELECT * FROM public.platform_schema_migrations WHERE position<=72 ORDER BY position')).rows).toEqual(before);expect((await db.query('SELECT * FROM public.fulfillment_shipments WHERE id=$1',[f.shipment])).rows).toEqual(rows);expect((await db.query('SELECT oid,proacl::text FROM pg_proc WHERE oid=ANY($1::oid[]) ORDER BY oid',[oldAcl.map(row=>row.oid)])).rows).toEqual(oldAcl);
  expect(await h.runner(db).apply()).toEqual({applied:[]});expect((await h.runner(db).status()).pending).toEqual([]);expect((await db.query('SELECT mode FROM public.subscription_delivery_alignment_control')).rows).toEqual([{mode:'off'}]);
 }finally{await db?.end();await resource?.remove();rmSync(root,{recursive:true,force:true});}
},60_000);
it('durable command/dispatch fences, G14/remap, atomic paid/accepted ACK, G15–G17 replay and rollback survive lost responses',async()=>{
 const f=await fixture(h.pool);const native=store();
 await h.pool.query("INSERT INTO public.fulfillment_dispatch_contexts(shipment_id,contact_revision,provider_ref) VALUES($1,$2,'warehouse-a')",[f.shipment,revision]);
 const input={requestKey:`dispatch-${f.shipment}`,fulfillmentRef:f.shipment,orderRef:f.order,parcelRef:null,mode:'live' as const,evidence};
 const [a,b]=await Promise.all([native.claim(input),native.claim(input)]);expect(a.kind).toBe('claimed');expect(b.kind).toBe('claimed');if(a.kind!=='claimed')throw new Error('claim refused');
 expect(await native.recordProviderAttempt(`mapped-${f.shipment}`,f.shipment,evidence,'live','recorded')).toEqual({replayed:false});expect(await native.recordProviderAttempt(`mapped-${f.shipment}`,f.shipment,evidence,'live','recorded')).toEqual({replayed:true});
 const next={...evidence,commandFingerprint:'b'.repeat(64),contactRevision:{...revision,revision:2}};
 await h.pool.query('UPDATE public.fulfillment_dispatch_contexts SET contact_revision=$2 WHERE shipment_id=$1',[f.shipment,next.contactRevision]);
 expect(await native.begin({dispatchRef:a.record.dispatchRef,commandFingerprint:evidence.commandFingerprint})).toMatchObject({kind:'refused',refusal:{reason:'contact_stale'}});
 expect(await native.claim({...input,evidence:next})).toMatchObject({kind:'claimed',record:{evidence:next}});
 await native.recordProviderAttempt(`remapped-${f.shipment}`,f.shipment,next,'live','recorded');
 await expect(native.recordProviderAttempt(`mapped-${f.shipment}`,f.shipment,next,'live','recorded')).rejects.toMatchObject({code:'23505'});
 await h.pool.query("INSERT INTO public.commerce_order_holds(order_id,reason,status,idempotency_key) VALUES($1,'manual_support','active',$2)",[f.order,`hold-${f.order}`]);
 expect(await native.begin({dispatchRef:a.record.dispatchRef,commandFingerprint:next.commandFingerprint})).toMatchObject({kind:'refused',refusal:{reason:'not_dispatchable'}});
 await h.pool.query("UPDATE public.commerce_order_holds SET status='released',released_at=now() WHERE order_id=$1",[f.order]);
 const pristine=await native.commandLedger.enqueue({fulfillmentRef:f.shipment,providerRef:'warehouse-a',commandKind:'dispatch_create',contractVersion:'1',idempotencyKey:randomUUID(),commandKeyFingerprint:'1'.repeat(64),commandPayloadFingerprint:'2'.repeat(64),providerIdempotencyKeyFingerprint:null,routingFingerprint:'3'.repeat(64),configurationFingerprint:'4'.repeat(64),correlationKeyFingerprint:'5'.repeat(64),retryBudget:2});
 const begins=await Promise.all([native.begin({dispatchRef:a.record.dispatchRef,commandFingerprint:next.commandFingerprint}),native.begin({dispatchRef:a.record.dispatchRef,commandFingerprint:next.commandFingerprint})]);expect(begins.filter(v=>v.kind==='begun'&&v.begun)).toHaveLength(1);expect((await h.pool.query('SELECT status,last_reason_code FROM public.commerce_fulfillment_provider_commands WHERE id=$1',[pristine.commandId])).rows).toEqual([{status:'cancelled',last_reason_code:'superseded_by_direct_dispatch'}]);
 const accepted={kind:'accepted' as const,externalRef:`external-${f.shipment}`,evidence:next,providerAttemptKey:`accepted-${f.shipment}`,labelKey:`label-${f.shipment}`};
 expect(await native.finalize({dispatchRef:a.record.dispatchRef,result:accepted})).toMatchObject({status:'uncertain',externalRef:accepted.externalRef});
 // A failed local ACK rolls every write back, preserving accepted proof for repair.
 await expect(native.acknowledge({dispatchRef:a.record.dispatchRef,acceptance:{...accepted,labelKey:accepted.providerAttemptKey}})).rejects.toMatchObject({code:'22023'});
 expect((await native.read(input.requestKey))?.status).toBe('uncertain');
 const lostAck=async()=>{await native.acknowledge({dispatchRef:a.record.dispatchRef,acceptance:accepted});throw new Error('synthetic_ack_lost');};await expect(lostAck()).rejects.toThrow('synthetic_ack_lost');
 expect(await native.acknowledge({dispatchRef:a.record.dispatchRef,acceptance:accepted})).toMatchObject({acknowledged:true,replayed:true,record:{status:'created'}});
 expect((await h.pool.query('SELECT status FROM public.fulfillment_shipments WHERE id=$1',[f.shipment])).rows[0].status).toBe('created');
 expect((await h.pool.query("SELECT external_id FROM public.shipment_external_refs WHERE shipment_id=$1 AND ref_role='dispatch'",[f.shipment])).rows).toEqual([{external_id:accepted.externalRef}]);
 await expect(h.pool.query("SELECT public.fulfillment_cancel_shipment($1,$2,'test','{}',now())",[`cancel-${f.shipment}`,f.shipment])).rejects.toThrow('dispatch_outstanding');
 const handoff=createPostgresPaidFulfillmentHandoffStore(executor(h.pool),'fixture-port');const paid={requestKey:`paid-${f.order}`,orderRef:f.order,paidFactRef:`fact-${f.order}`};expect(await handoff.ensureObligation(paid)).toMatchObject({fulfillmentRef:f.shipment,replayed:false});expect(await handoff.ensureObligation(paid)).toMatchObject({replayed:true});expect(await handoff.acknowledge({requestKey:paid.requestKey,fulfillmentRef:f.shipment})).toMatchObject({acknowledged:true,replayed:false});expect(await handoff.acknowledge({requestKey:paid.requestKey,fulfillmentRef:f.shipment})).toMatchObject({replayed:true});
 const ledger=native.commandLedger;const commandFixture=await fixture(h.pool);const enqueued=await ledger.enqueue({fulfillmentRef:commandFixture.shipment,providerRef:'warehouse-a',commandKind:'dispatch_create',contractVersion:'1',idempotencyKey:randomUUID(),commandKeyFingerprint:'a'.repeat(64),commandPayloadFingerprint:'b'.repeat(64),providerIdempotencyKeyFingerprint:null,routingFingerprint:'c'.repeat(64),configurationFingerprint:'d'.repeat(64),correlationKeyFingerprint:'e'.repeat(64),retryBudget:2});
 const claims=(await Promise.all([ledger.claim({providerRef:'warehouse-a',commandKind:'dispatch_create',limit:1,claimOwnerFingerprint:'f'.repeat(64),leaseSeconds:60}),ledger.claim({providerRef:'warehouse-a',commandKind:'dispatch_create',limit:1,claimOwnerFingerprint:'f'.repeat(64),leaseSeconds:60})])).flat();expect(claims).toHaveLength(1);
 const claim=claims[0];const fence={commandId:enqueued.commandId,claimToken:claim.claimToken,claimGeneration:claim.claimGeneration,expectedVersion:claim.version};
 await expect(ledger.markSubmitting({...fence,claimGeneration:claim.claimGeneration+1,providerAttemptRef:null})).rejects.toMatchObject({code:'40001'});
 await h.pool.query("INSERT INTO public.fulfillment_dispatch_contexts(shipment_id,contact_revision,provider_ref) VALUES($1,$2,'warehouse-a')",[commandFixture.shipment,revision]);
 const competing=await native.claim({...input,requestKey:`direct-${commandFixture.shipment}`,fulfillmentRef:commandFixture.shipment,orderRef:commandFixture.order});
 if(competing.kind!=='claimed')throw new Error('competing fixture claim');
 expect(await native.begin({dispatchRef:competing.record.dispatchRef,commandFingerprint:evidence.commandFingerprint})).toMatchObject({kind:'refused',refusal:{reason:'not_dispatchable'}});
 const submitting=await ledger.markSubmitting({...fence,providerAttemptRef:null});await expect(ledger.markSubmitting({...fence,providerAttemptRef:null})).rejects.toMatchObject({code:'40001'});
 const uncertain=await ledger.applyWriteOutcome({...fence,expectedVersion:submitting.version,providerAttemptRef:null,identityFingerprint:'e'.repeat(64),kind:'uncertain',reason:'write_uncertain'});
 expect(await ledger.claim({providerRef:'warehouse-a',commandKind:'dispatch_create',limit:1,claimOwnerFingerprint:'f'.repeat(64),leaseSeconds:60})).toEqual([]);
 const proofAt=(await h.pool.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
 await expect(ledger.resolve({commandId:claim.commandId,expectedVersion:uncertain.version,identityFingerprint:'e'.repeat(64),decision:'retry_wait',reason:'authoritative_absence',retryNotBefore:new Date(Date.now()+60_000).toISOString(),proof:{kind:'authoritative_absence',fingerprint:'a'.repeat(64),observedAt:proofAt,source:'provider_lookup'}})).rejects.toMatchObject({code:'22023'});
 expect(await ledger.reconcile({commandId:claim.commandId,expectedVersion:uncertain.version,identityFingerprint:'e'.repeat(64),proof:{kind:'correlation_key',fingerprint:'e'.repeat(64),observedAt:proofAt,source:'provider_lookup'}})).toMatchObject({status:'confirmed',proofRecorded:true});
 const spine=createPostgresFulfillmentShipmentSpinePort(executor(h.pool),{portKey:'fixture-port'});const obs=observation();obs.correlation.fulfillmentRef=f.shipment;obs.correlation.orderRef=f.order;
 expect(await spine.localPersistence.recordObservation(obs)).toEqual({replayed:false});expect(await spine.localPersistence.recordObservation({...obs,firstReceivedAt:'2026-10-22T00:00:00Z'})).toEqual({replayed:true});expect(await spine.localPersistence.readLocalFulfillmentState(f.shipment)).toMatchObject({latestStatusOccurredAt:null});await spine.localPersistence.recordStatusEvidence({fulfillmentRef:f.shipment},obs);await spine.localPersistence.markProcessed(obs.eventKey,{status:'processed'});await spine.localPersistence.markProcessed(obs.eventKey,{status:'processed'});expect(await spine.localPersistence.readLocalFulfillmentState(f.shipment)).toMatchObject({status:'created',latestStatusOccurredAt:obs.fact.occurredAt});expect((await h.pool.query('SELECT first_received_at FROM public.fulfillment_observations WHERE event_key=$1',[obs.eventKey])).rows[0].first_received_at.toISOString()).toBe(obs.firstReceivedAt);
 const stock=createPostgresFulfillmentStockSyncPort(executor(h.pool),{sourceKey:'fixture-stock',async readLocalInventoryStock(){return [];}});const cursor={status:'succeeded' as const,lastStockSyncedAt:'2026-10-21T12:00:00Z',lastMovementOccurredAt:null,continuation:{nextRef:'opaque-next',startLocalDate:null,endLocalDate:null},coverageGapSkus:['sku-a'],refusal:null};await stock.recordCursor(cursor);expect(await stock.readCursor()).toEqual({...cursor,lastStockSyncedAt:'2026-10-21T12:00:00.000Z'});
 const movement={requestKey:'fixture-movement',movement:{providerRef:'warehouse-a',syncRunId:'run-a',collectedAt:'2026-10-21T12:00:00Z',sourceRevision:null,revisionSource:'collection' as const,skuRef:'sku-a',quantityKind:'movement' as const,quantity:2,occurredAt:null,operationType:null,documentRef:null,lotRef:null,expirationDate:null}};expect(await stock.recordMovement(movement)).toEqual({replayed:false,readBack:true});expect(await stock.recordMovement(movement)).toEqual({replayed:true,readBack:true});await expect(stock.recordMovement({...movement,movement:{...movement.movement,quantity:3}})).rejects.toMatchObject({code:'23505'});
});
