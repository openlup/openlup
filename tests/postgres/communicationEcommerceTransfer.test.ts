import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createPostgresEcommerceEventProjection} from '@openlup/platform/communications';
import {currencyExponent} from '@openlup/platform/market-packs';
import {ecommercePaid} from './communicationEcommerceFixture.js';
import {storeJourneyResources,captureStoreJourney,journeySelection,type JourneyInstallation} from '../helpers/storeJourney.js';
import {restoreConnectedNativeStore} from '../../server/adapters/postgres/connectedStoreRestore.js';
import {postgresSetupTimeoutMs,postgresTeardownTimeoutMs} from '../helpers/postgresContainer.js';
const resources=storeJourneyResources();
let source:JourneyInstallation,target:JourneyInstallation;
beforeAll(async()=>{source=await resources.installation('event-source');target=await resources.installation('event-target');},postgresSetupTimeoutMs);
afterAll(()=>resources.close(),postgresTeardownTimeoutMs);
it('restricted runtime emits/projects and exact native transfer retains unknown duties and source fences',async()=>{
 const db=await source.owner.connect();let f:Awaited<ReturnType<typeof ecommercePaid>>;
 try{await db.query('BEGIN');f=await ecommercePaid(db,{deferSettlement:true});await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 expect((await source.runtime.query(`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
 await source.runtime.query(`SELECT public.commerce_record_settlement($1,$2,'succeeded','restricted-paid','{}','2026-11-11T12:00Z')`,[randomUUID(),f.intent]);
 const withTransaction=async<T>(work:(db:PoolClient)=>Promise<T>)=>{
  const connection=await source.runtime.connect();try{await connection.query('BEGIN');const value=await work(connection);await connection.query('COMMIT');return value;}
  catch(error){await connection.query('ROLLBACK');throw error;}finally{connection.release();}
 };
 const p=createPostgresEcommerceEventProjection({binding:{account:'event-transfer',environment:'test',namespace:'synthetic',mappingVersion:'ecommerce-v1'},
  liveSince:new Date('2026-11-11T11:00Z'),currency:{code:'USD',exponent:currencyExponent('USD'),provenance:'runtime-icu:currencyExponent.v1'},now:()=>new Date('2026-11-11T13:00Z'),withTransaction,
  resolveTarget:async()=>({subjectReference:'subject:transfer',profileId:'profile_transfer',generation:1,authorityReference:'authority:transfer'})});
 await p.initialize();expect(await p.project()).toEqual({projected:1,refused:0,deferred:0});
 await source.owner.query(`UPDATE public.communication_event_receipts SET state='unknown',reason='acceptance_ambiguous'`);
 const erased=await source.owner.connect();let erasedClient:string;
 try{await erased.query('BEGIN');erasedClient=(await ecommercePaid(erased,{complete:false})).client;await erased.query('SELECT public.communication_event_privacy($1,true)',[erasedClient]);await erased.query('COMMIT');}
 catch(error){await erased.query('ROLLBACK');throw error;}finally{erased.release();}
 const subscription=randomUUID(),legacyEvent=randomUUID();
 await source.owner.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,'2026-12-11')",[subscription,f.client]);
 const copy=await source.owner.connect();
 try{await copy.query('BEGIN');await copy.query("SELECT set_config('app.communication_retained_copy','on',true)");
  await copy.query("INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,occurred_at,communication_subject_id) VALUES($1::uuid,$2::uuid,'subscription.activated',$1::text,'2026-10-01',NULL)",[legacyEvent,subscription]);
  await copy.query('COMMIT');
 }catch(error){await copy.query('ROLLBACK');throw error;}finally{copy.release();}
 await expect(source.runtime.query(`UPDATE public.outbox_events SET metadata=metadata-'commercePaidFactV1' WHERE event_type='commerce.order.paid'`)).rejects.toThrow('event_source_immutable');
 const packet=await captureStoreJourney(source.owner,'event-transfer'),freshTarget=await captureStoreJourney(target.owner,'event-pristine');
 const input={owner:target.owner,installation:journeySelection,packet,freshTarget};
 expect(await restoreConnectedNativeStore(input)).toMatchObject({replayed:false});
 for(const table of ['communication_event_bindings','communication_event_receipts','communication_event_erasures','outbox_events','subscription_events']){
  const sql=`SELECT to_jsonb(t)::text AS value FROM public.${table} t ORDER BY to_jsonb(t)::text`;
  expect((await target.owner.query(sql)).rows).toEqual((await source.owner.query(sql)).rows);
 }
 expect((await target.owner.query('SELECT client_id FROM public.communication_event_erasures')).rows).toEqual([{client_id:erasedClient!}]);
 expect((await target.owner.query('SELECT communication_subject_id FROM public.subscription_events WHERE id=$1',[legacyEvent])).rows[0]).toEqual({communication_subject_id:null});
 expect(await restoreConnectedNativeStore(input)).toMatchObject({replayed:true});
 expect((await target.owner.query('SELECT state,request_digest FROM public.communication_event_receipts')).rows[0]).toMatchObject({state:'unknown',request_digest:expect.any(String)});
},postgresSetupTimeoutMs);
