import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { lifecycleInstallation, lifecycleProfiles } from './subscriptionLifecycleClosureFixture.js';
import { fixture } from '../helpers/fulfillmentNative.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';
const at='2026-11-10T15:50:00.000Z';
const enqueueSql='SELECT public.commerce_fulfillment_enqueue_provider_command($1,$2,\'dispatch_create\',\'1\',$3,$4,$5,NULL,$6,$7,$8,3) AS value';
const args=(shipment:string,provider:string,key=randomUUID())=>[shipment,provider,key,'a'.repeat(64),'b'.repeat(64),'c'.repeat(64),'d'.repeat(64),'e'.repeat(64)];
const claimSql="SELECT public.commerce_fulfillment_claim_provider_commands($1,'dispatch_create',1,$2,900) AS value";
const submitSql='SELECT public.commerce_fulfillment_mark_command_submitting($1,$2,$3,$4,NULL) AS value';
const fenceArgs=(v:Record<string,unknown>)=>[v.commandId,v.claimToken,v.claimGeneration,v.version];
const cancel=(db:Pool|PoolClient,shipment:string)=>db.query("SELECT public.fulfillment_cancel_shipment($1,$2,'Synthetic cancellation','{}',$3)",[`cancel-${shipment}`,shipment,at]);
async function waitBlocked(owner:Pool,waiting:number,blocking:number){
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){if((await owner.query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked',[blocking,waiting])).rows[0].blocked)return;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error('Expected PostgreSQL lock wait was not observed');
}
for(const profile of lifecycleProfiles)describe(`parcel status fence on ${profile}`,()=>{
  let db:Awaited<ReturnType<typeof lifecycleInstallation>>;
  beforeAll(async()=>{db=await lifecycleInstallation(profile);},postgresSetupTimeoutMs);
  afterAll(async()=>{if(db)await db.close();},postgresTeardownTimeoutMs);
  it('refuses a waiting enqueue after native cancellation commits, before claim or provider submission',async()=>{
    const f=await fixture(db.owner),provider=`race_${randomUUID().replaceAll('-','')}`;
    const cancellation=await db.runtime.connect(),enqueue=await db.runtime.connect();
    try{
      await cancellation.query('BEGIN');await enqueue.query('BEGIN');
      const blocking=(await cancellation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const waiting=(await enqueue.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await cancel(cancellation,f.shipment);
      const pending=enqueue.query(enqueueSql,args(f.shipment,provider)).then(result=>({result,error:null}),error=>({result:null,error}));
      await waitBlocked(db.owner,waiting,blocking);await cancellation.query('COMMIT');
      const outcome=await pending;await enqueue.query(outcome.error?'ROLLBACK':'COMMIT');
      if(!outcome.error){
        const claim=(await db.runtime.query(claimSql,[provider,'f'.repeat(64)])).rows[0]?.value;
        if(claim)await db.runtime.query(submitSql,fenceArgs(claim));
      }
      const observed=(await db.owner.query("SELECT s.status AS parcel_status,c.status AS command_status FROM public.fulfillment_shipments s LEFT JOIN public.commerce_fulfillment_provider_commands c ON c.shipment_id=s.id WHERE s.id=$1",[f.shipment])).rows;
      console.log({profile,observed});
      expect(outcome.error?.message).toBe('fulfillment_provider_command_fence_conflict');
      expect(observed).toEqual([{parcel_status:'cancelled',command_status:null}]);
      expect((await db.owner.query('SELECT count(*)::int n FROM public.commerce_fulfillment_provider_command_transitions t JOIN public.commerce_fulfillment_provider_commands c ON c.id=t.command_id WHERE c.shipment_id=$1',[f.shipment])).rows[0].n).toBe(0);
    }finally{await cancellation.query('ROLLBACK');await enqueue.query('ROLLBACK');cancellation.release();enqueue.release();}
  },15000);
  async function census(shipment:string){
    return (await db.owner.query(`SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(c)||jsonb_build_object('rowVersion',c.xmin::text) ORDER BY c.id),'[]') FROM public.commerce_fulfillment_provider_commands c WHERE shipment_id=$1) AS commands,
      (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM public.commerce_fulfillment_provider_command_transitions t JOIN public.commerce_fulfillment_provider_commands c ON c.id=t.command_id WHERE c.shipment_id=$1) AS transitions,
      (SELECT count(*)::int FROM public.fulfillment_provider_attempts WHERE shipment_id=$1) AS attempts,
      (SELECT count(*)::int FROM public.shipment_external_refs WHERE shipment_id=$1) AS external_refs`,[shipment])).rows;
  }
  it('skips a cancelled queued command without changing its row or transition history',async()=>{
    const f=await fixture(db.owner),provider=`queued_${randomUUID().replaceAll('-','')}`,input=args(f.shipment,provider);
    await db.runtime.query(enqueueSql,input);await cancel(db.runtime,f.shipment);
    const before=await census(f.shipment);
    expect((await db.runtime.query(claimSql,[provider,'f'.repeat(64)])).rows).toEqual([]);
    await expect(db.runtime.query(enqueueSql,input)).rejects.toMatchObject({code:'40001',message:'fulfillment_provider_command_fence_conflict'});
    expect(await census(f.shipment)).toEqual(before);
  });
  it('waits on cancellation before claim and leaves the queued command untouched',async()=>{
    const f=await fixture(db.owner),provider=`claim_${randomUUID().replaceAll('-','')}`;
    await db.runtime.query(enqueueSql,args(f.shipment,provider));const before=await census(f.shipment);
    const cancellation=await db.runtime.connect(),claim=await db.runtime.connect();
    try{
      await cancellation.query('BEGIN');await claim.query('BEGIN');await cancel(cancellation,f.shipment);
      const blocking=(await cancellation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const waiting=(await claim.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending=claim.query(claimSql,[provider,'f'.repeat(64)]);
      await waitBlocked(db.owner,waiting,blocking);await cancellation.query('COMMIT');
      expect((await pending).rows).toEqual([]);await claim.query('COMMIT');
      expect(await census(f.shipment)).toEqual(before);
    }finally{await cancellation.query('ROLLBACK');await claim.query('ROLLBACK');cancellation.release();claim.release();}
  },15000);
  it('waits on cancellation before submission and refuses unchanged claimed tokens again after commit',async()=>{
    const f=await fixture(db.owner),provider=`submit_${randomUUID().replaceAll('-','')}`;
    await db.runtime.query(enqueueSql,args(f.shipment,provider));
    const claimed=(await db.runtime.query(claimSql,[provider,'f'.repeat(64)])).rows[0].value;
    const before=await census(f.shipment),cancellation=await db.runtime.connect(),submission=await db.runtime.connect();
    try{
      await cancellation.query('BEGIN');await submission.query('BEGIN');await cancel(cancellation,f.shipment);
      const blocking=(await cancellation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const waiting=(await submission.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending=submission.query(submitSql,fenceArgs(claimed)).then(()=>null,error=>error);
      await waitBlocked(db.owner,waiting,blocking);await cancellation.query('COMMIT');
      expect(await pending).toMatchObject({code:'40001',message:'fulfillment_provider_command_fence_conflict'});await submission.query('ROLLBACK');
      await expect(db.runtime.query(submitSql,fenceArgs(claimed))).rejects.toMatchObject({code:'40001'});
      expect(await census(f.shipment)).toEqual(before);
    }finally{await cancellation.query('ROLLBACK');await submission.query('ROLLBACK');cancellation.release();submission.release();}
  },15000);
  it('preserves live enqueue replay, identity conflicts, exclusive claims and submission fencing',async()=>{
    const f=await fixture(db.owner),provider=`live_${randomUUID().replaceAll('-','')}`,input=args(f.shipment,provider);
    // ErrorResponse can precede abort and dispatch-lock release. One session
    // queues the next claim behind ReadyForQuery instead of another backend.
    const work=await db.runtime.connect();
    try{
      const first=(await work.query(enqueueSql,input)).rows[0].value;
      expect((await work.query(enqueueSql,input)).rows[0].value).toEqual(first);
      const altered=[...input];altered[4]='f'.repeat(64);
      await expect(work.query(enqueueSql,altered)).rejects.toMatchObject({code:'23505'});
      const claimed=(await work.query(claimSql,[provider,'f'.repeat(64)])).rows[0].value;
      expect((await work.query(claimSql,[provider,'f'.repeat(64)])).rows).toEqual([]);
      const wrong=fenceArgs(claimed);wrong[2]=Number(claimed.claimGeneration)+1;
      await expect(work.query(submitSql,wrong)).rejects.toMatchObject({code:'40001'});
      const submitted=(await work.query(submitSql,fenceArgs(claimed))).rows[0].value;
      expect(submitted).toMatchObject({commandId:first.commandId,status:'submitting',version:3});
      const before=await census(f.shipment);
      await expect(work.query(submitSql,fenceArgs(claimed))).rejects.toMatchObject({code:'40001'});
      expect((await work.query(enqueueSql,input)).rows[0].value).toEqual(submitted);
      expect(await census(f.shipment)).toEqual(before);
    }finally{try{await work.query('ROLLBACK');}finally{work.release();}}
  });

  it.each(['enqueue','claim','submit'])('fences operator cancellation against %s without changing the ledger on refusal',async axis=>{
    const f=await fixture(db.owner),provider=`operator_${randomUUID().replaceAll('-','')}`,actor=randomUUID(),key=`cancel-${randomUUID()}`;
    await db.owner.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Fixture operator')",[actor]);
    let claimed:Record<string,unknown>|undefined;
    if(axis!=='enqueue')await db.runtime.query(enqueueSql,args(f.shipment,provider));
    if(axis==='submit')claimed=(await db.runtime.query(claimSql,[provider,'f'.repeat(64)])).rows[0].value;
    const before=await census(f.shipment),cancellation=await db.runtime.connect(),work=await db.runtime.connect();
    try{
      await cancellation.query('BEGIN');await work.query('BEGIN');
      const blocking=(await cancellation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,waiting=(await work.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await cancellation.query("SELECT public.fulfillment_operator_cancel_order($1,$2,'Synthetic cancellation',$3)",[key,f.shipment,actor]);
      expect((await db.owner.query("SELECT mode FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=1179665228 AND objsubid=2 AND granted",[blocking])).rows).toEqual([{mode:'ExclusiveLock'}]);
      if(axis==='claim'){
        expect((await work.query(claimSql,[provider,'f'.repeat(64)])).rows).toEqual([]);
        await cancellation.query('COMMIT');await work.query('COMMIT');
        expect((await db.runtime.query(claimSql,[provider,'f'.repeat(64)])).rows).toEqual([]);
      }else{
        const pending=(axis==='enqueue'?work.query(enqueueSql,args(f.shipment,provider)):work.query(submitSql,fenceArgs(claimed!))).then(()=>null,error=>error);
        await waitBlocked(db.owner,waiting,blocking);
        if(axis==='submit')expect((await db.owner.query("SELECT mode FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=1179665228 AND objsubid=2 AND NOT granted",[waiting])).rows).toEqual([{mode:'ShareLock'}]);
        await cancellation.query('COMMIT');expect(await pending).toMatchObject({code:'40001',message:'fulfillment_provider_command_fence_conflict'});await work.query('ROLLBACK');
      }
      expect(await census(f.shipment)).toEqual(before);
      expect((await db.runtime.query("SELECT public.fulfillment_operator_cancel_order($1,$2,'Synthetic cancellation',$3) AS value",[key,f.shipment,actor])).rows[0].value).toMatchObject({replayed:true,status:'cancelled'});
      expect(await census(f.shipment)).toEqual(before);
    }finally{await cancellation.query('ROLLBACK');await work.query('ROLLBACK');cancellation.release();work.release();}
  },15000);
  it.each([1,3])('claims live work past cancelled queue entries before a limit of %s',async limit=>{
    const provider=`mixed_${randomUUID().replaceAll('-','')}`,cancelled:string[]=[],live:string[]=[];
    for(let i=0;i<limit*2;i++){
      const f=await fixture(db.owner),identity=randomUUID().replaceAll('-','').repeat(2);
      await db.owner.query(`WITH command AS (
        INSERT INTO public.commerce_fulfillment_provider_commands(shipment_id,order_id,provider_kind,command_kind,contract_version,
          idempotency_key_fingerprint,command_key_fingerprint,command_payload_fingerprint,routing_fingerprint,config_fingerprint,
          correlation_fingerprint,retry_budget,available_at,created_at)
        VALUES($1,$2,$3,'dispatch_create','1',$4,$4,repeat('b',64),repeat('c',64),repeat('d',64),repeat('e',64),3,
          '2026-11-01T00:00:00Z'::timestamptz+($5::int*interval '1 second'),'2026-11-01T00:00:00Z') RETURNING id)
        INSERT INTO public.commerce_fulfillment_provider_command_transitions(command_id,to_status,reason_code,command_version,attempt_count)
        SELECT id,'queued','command_enqueued',1,0 FROM command`,[f.shipment,f.order,provider,identity,i]);
      if(i<limit){await cancel(db.runtime,f.shipment);cancelled.push(f.shipment);}else live.push(f.shipment);
    }
    const before=await Promise.all(cancelled.map(census));
    const many="SELECT public.commerce_fulfillment_claim_provider_commands($1,'dispatch_create',$2,$3,900) AS value";
    const rows=(await db.runtime.query(many,[provider,limit,'f'.repeat(64)])).rows;
    expect(rows.map(r=>r.value.fulfillmentRef)).toEqual(live);
    for(const row of rows)expect(row.value).toMatchObject({status:'claimed',version:2,claimGeneration:1});
    expect(await Promise.all(cancelled.map(census))).toEqual(before);
    expect((await db.runtime.query(many,[provider,limit,'f'.repeat(64)])).rows).toEqual([]);
    expect(await Promise.all(cancelled.map(census))).toEqual(before);
  });
  it('submits a live claimed command without waiting on the address path parcel locks',async()=>{
    const f=await fixture(db.owner),provider=`address_${randomUUID().replaceAll('-','')}`;
    await db.runtime.query(enqueueSql,args(f.shipment,provider));const claimed=(await db.runtime.query(claimSql,[provider,'f'.repeat(64)])).rows[0].value;
    const address=await db.runtime.connect(),submission=await db.runtime.connect();
    try{
      await address.query('BEGIN');await address.query("SELECT pg_advisory_xact_lock(hashtextextended('native-dispatch|'||$1::uuid::text,0))",[f.shipment]);
      await address.query('SELECT id FROM public.fulfillment_shipments WHERE id=$1 FOR UPDATE',[f.shipment]);
      await submission.query("BEGIN; SET LOCAL statement_timeout='1s'");
      expect((await submission.query(submitSql,fenceArgs(claimed))).rows[0].value).toMatchObject({status:'submitting'});
      await submission.query('COMMIT');
      await expect(db.owner.query('SELECT id FROM public.fulfillment_shipments WHERE id=$1 FOR UPDATE NOWAIT',[f.shipment])).rejects.toMatchObject({code:'55P03'});
      expect((await db.owner.query('SELECT status FROM public.fulfillment_shipments WHERE id=$1',[f.shipment])).rows).toEqual([{status:'created'}]);
    }finally{await address.query('ROLLBACK');await submission.query('ROLLBACK');address.release();submission.release();}
  });
  it.each(['native','operator'])('holds the shared initiation gate until commit before %s cancellation',async kind=>{
    const f=await fixture(db.owner),provider=`shared_${randomUUID().replaceAll('-','')}`,actor=randomUUID();
    await db.owner.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Fixture operator')",[actor]);
    const initiation=await db.runtime.connect(),cancellation=await db.runtime.connect();
    try{
      await initiation.query('BEGIN');await cancellation.query('BEGIN');
      const blocking=(await initiation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,waiting=(await cancellation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await initiation.query(enqueueSql,args(f.shipment,provider));
      expect((await db.owner.query("SELECT mode FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=1179665228 AND objsubid=2 AND granted",[blocking])).rows).toEqual([{mode:'ShareLock'}]);
      const key=(await db.owner.query('SELECT hashtext($1::uuid::text) AS key',[f.shipment])).rows[0].key;
      const oneBigint=(BigInt(1179665228)<<32n)|BigInt.asUintN(32,BigInt(key));
      const otherSpace=await db.runtime.connect();try{await otherSpace.query("BEGIN; SET LOCAL statement_timeout='1s'");await otherSpace.query('SELECT pg_advisory_xact_lock($1::bigint)',[oneBigint.toString()]);await otherSpace.query('COMMIT');}finally{await otherSpace.query('ROLLBACK');otherSpace.release();}
      const pending=kind==='native'?cancel(cancellation,f.shipment):cancellation.query("SELECT public.fulfillment_operator_cancel_order($1,$2,'Synthetic cancellation',$3)",[`cancel-${randomUUID()}`,f.shipment,actor]);
      await waitBlocked(db.owner,waiting,blocking);await initiation.query('COMMIT');await pending;await cancellation.query('COMMIT');
      const before=await census(f.shipment);expect((await db.runtime.query(claimSql,[provider,'f'.repeat(64)])).rows).toEqual([]);expect(await census(f.shipment)).toEqual(before);
    }finally{await initiation.query('ROLLBACK');await cancellation.query('ROLLBACK');initiation.release();cancellation.release();}
  },15000);

  it.each(['native','operator'])('enqueues from an existing preparation lock while %s cancellation waits',async kind=>{
    const f=await fixture(db.owner),provider=`prepared_${randomUUID().replaceAll('-','')}`,actor=randomUUID();
    await db.owner.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Fixture operator')",[actor]);
    const preparation=await db.runtime.connect(),cancellation=await db.runtime.connect();
    try{
      await preparation.query("BEGIN; SET LOCAL statement_timeout='1s'");await cancellation.query('BEGIN');
      const blocking=(await preparation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,waiting=(await cancellation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await preparation.query("SELECT pg_advisory_xact_lock(hashtextextended('native-dispatch|'||$1::uuid::text,0))",[f.shipment]);
      await preparation.query('SELECT id FROM public.fulfillment_shipments WHERE id=$1 FOR UPDATE',[f.shipment]);
      const pending=kind==='native'?cancel(cancellation,f.shipment):cancellation.query("SELECT public.fulfillment_operator_cancel_order($1,$2,'Synthetic cancellation',$3)",[`cancel-${randomUUID()}`,f.shipment,actor]);
      await waitBlocked(db.owner,waiting,blocking);
      expect((await db.owner.query("SELECT mode FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=1179665228 AND objsubid=2 AND granted",[waiting])).rows).toEqual([]);
      expect((await preparation.query(enqueueSql,args(f.shipment,provider))).rows[0].value).toMatchObject({status:'queued'});
      await preparation.query('COMMIT');await pending;await cancellation.query('COMMIT');
      const before=await census(f.shipment);expect((await db.runtime.query(claimSql,[provider,'f'.repeat(64)])).rows).toEqual([]);expect(await census(f.shipment)).toEqual(before);
    }finally{await preparation.query('ROLLBACK');await cancellation.query('ROLLBACK');preparation.release();cancellation.release();}
  },15000);
  async function isolationCensus(shipment:string,order:string){
    const state=(await db.owner.query(`SELECT
      (SELECT to_jsonb(s)||jsonb_build_object('rowVersion',s.xmin::text) FROM public.fulfillment_shipments s WHERE id=$1) AS parcel,
      (SELECT to_jsonb(o)||jsonb_build_object('rowVersion',o.xmin::text) FROM public.commerce_orders o WHERE id=$2) AS purchase,
      (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.id),'[]') FROM public.fulfillment_shipment_operations o WHERE shipment_id=$1) AS parcel_operations,
      (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.id),'[]') FROM public.commerce_order_operations o WHERE order_id=$2) AS order_operations,
      (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM public.fulfillment_inventory_reservations r) AS reservations,
      (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.idempotency_key),'[]') FROM public.fulfillment_operator_receipts r WHERE command->>'shipmentId'=$1::text) AS receipts`,[shipment,order])).rows;
    return {state,ledger:await census(shipment)};
  }
  for(const isolation of ['REPEATABLE READ','SERIALIZABLE']){
    it.each(['enqueue','claim','submit','native cancel','operator cancel'])('refuses %s at entry under '+isolation+' without changing state',async axis=>{
      const f=await fixture(db.owner),provider=`isolation_${randomUUID().replaceAll('-','')}`,actor=randomUUID();
      await db.owner.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Fixture operator')",[actor]);
      let claimed:Record<string,unknown>|undefined;
      if(axis==='claim'||axis==='submit')await db.runtime.query(enqueueSql,args(f.shipment,provider));
      if(axis==='submit')claimed=(await db.runtime.query(claimSql,[provider,'f'.repeat(64)])).rows[0].value;
      const before=await isolationCensus(f.shipment,f.order),work=await db.runtime.connect();
      try{
        await work.query('BEGIN ISOLATION LEVEL '+isolation);
        const invocation=axis==='enqueue'?()=>work.query(enqueueSql,args(f.shipment,provider))
          :axis==='claim'?()=>work.query(claimSql,[provider,'f'.repeat(64)])
          :axis==='submit'?()=>work.query(submitSql,fenceArgs(claimed!))
          :axis==='native cancel'?()=>cancel(work,f.shipment)
          :()=>work.query("SELECT public.fulfillment_operator_cancel_order($1,$2,'Synthetic cancellation',$3)",[`cancel-${randomUUID()}`,f.shipment,actor]);
        await expect(invocation()).rejects.toMatchObject({code:'22023',message:'inventory_admission_isolation_unsupported'});
        await work.query('ROLLBACK');
        expect(await isolationCensus(f.shipment,f.order)).toEqual(before);
      }finally{await work.query('ROLLBACK');work.release();}
    });
  }
  it.each(['claim','submit'])('refuses stale-snapshot REPEATABLE READ %s before waiting behind uncommitted cancellation',async axis=>{
    const f=await fixture(db.owner),provider=`snapshot_${randomUUID().replaceAll('-','')}`;
    await db.runtime.query(enqueueSql,args(f.shipment,provider));
    const claimed=axis==='submit'?(await db.runtime.query(claimSql,[provider,'f'.repeat(64)])).rows[0].value:undefined;
    const before=await census(f.shipment),cancellation=await db.runtime.connect(),work=await db.runtime.connect();
    try{
      await work.query("BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL statement_timeout='1s'");
      // Establish the old snapshot before cancellation takes its exclusive gate.
      expect((await work.query('SELECT status FROM public.fulfillment_shipments WHERE id=$1',[f.shipment])).rows).toEqual([{status:'created'}]);
      await cancellation.query('BEGIN');await cancel(cancellation,f.shipment);
      const blocking=(await cancellation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      expect((await db.owner.query("SELECT mode FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=1179665228 AND objsubid=2 AND granted",[blocking])).rows).toEqual([{mode:'ExclusiveLock'}]);
      const pending=axis==='claim'?work.query(claimSql,[provider,'f'.repeat(64)]):work.query(submitSql,fenceArgs(claimed));
      await expect(pending).rejects.toMatchObject({code:'22023',message:'inventory_admission_isolation_unsupported'});
      await work.query('ROLLBACK');
      expect(await census(f.shipment)).toEqual(before);
      await cancellation.query('COMMIT');
      expect(await census(f.shipment)).toEqual(before);
      expect((await db.owner.query('SELECT status FROM public.fulfillment_shipments WHERE id=$1',[f.shipment])).rows).toEqual([{status:'cancelled'}]);
    }finally{await cancellation.query('ROLLBACK');await work.query('ROLLBACK');cancellation.release();work.release();}
  });

});
