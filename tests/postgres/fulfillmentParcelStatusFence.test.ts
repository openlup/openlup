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
    const first=(await db.runtime.query(enqueueSql,input)).rows[0].value;
    expect((await db.runtime.query(enqueueSql,input)).rows[0].value).toEqual(first);
    const altered=[...input];altered[4]='f'.repeat(64);
    await expect(db.runtime.query(enqueueSql,altered)).rejects.toMatchObject({code:'23505'});
    const claimed=(await db.runtime.query(claimSql,[provider,'f'.repeat(64)])).rows[0].value;
    expect((await db.runtime.query(claimSql,[provider,'f'.repeat(64)])).rows).toEqual([]);
    const wrong=fenceArgs(claimed);wrong[2]=Number(claimed.claimGeneration)+1;
    await expect(db.runtime.query(submitSql,wrong)).rejects.toMatchObject({code:'40001'});
    const submitted=(await db.runtime.query(submitSql,fenceArgs(claimed))).rows[0].value;
    expect(submitted).toMatchObject({commandId:first.commandId,status:'submitting',version:3});
    const before=await census(f.shipment);
    await expect(db.runtime.query(submitSql,fenceArgs(claimed))).rejects.toMatchObject({code:'40001'});
    expect((await db.runtime.query(enqueueSql,input)).rows[0].value).toEqual(submitted);
    expect(await census(f.shipment)).toEqual(before);
  });

});
