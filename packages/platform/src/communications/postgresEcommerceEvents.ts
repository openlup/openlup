import {createHash} from 'node:crypto';
import type {SqlExecutor} from '@openlup/core/readiness';
import type {OutboxHandler} from '@openlup/core/outbox';
import type {SyncBinding} from './contracts/marketingSync.js';
import type {EcommerceEvent,EcommerceEventExportRequest,EcommerceEventsPort} from './contracts/ecommerceEvents.js';
import {ECOMMERCE_EXPORT_EVENT_TYPE,ecommerceEventExportRequestSchema,ecommerceEventSchema} from './ecommerceEvents.js';
export interface EcommerceEventTransaction {withTransaction<T>(work:(db:SqlExecutor)=>Promise<T>):Promise<T>}
export interface EcommerceEventTarget {subjectReference:string;profileId:string;generation:number;authorityReference:string}
export interface PostgresEcommerceEventOptions extends EcommerceEventTransaction {
  binding:SyncBinding;liveSince:Date;now():Date;
  /** Existing qualified profile only; missing or ambiguous identity records a refusal. */
  resolveTarget(event:EcommerceEvent):Promise<EcommerceEventTarget|null>;
  /** Derived once by the host's existing settlement/currency owner, never guessed. */
  currency:Readonly<{code:string;exponent:number;provenance:string}>;
}
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const sameBinding=(a:SyncBinding,b:SyncBinding)=>(['account','environment','namespace','mappingVersion'] as const).every(field=>a[field]===b[field]);
async function sourceCurrent(db:SqlExecutor,event:EcommerceEvent,now:Date):Promise<boolean>{
  return (await db.query('SELECT public.communication_event_source_current($1::jsonb,$2::timestamptz) AS value',[JSON.stringify(event),now.toISOString()])).rows[0]?.value===true;
}
async function work(db:SqlExecutor,id:string,claim:unknown):Promise<Record<string,unknown>|null>{
  return (await db.query('SELECT public.communication_event_work($1::uuid,$2::text) AS value',[id,claim??null])).rows[0]?.value as Record<string,unknown>|null;
}
async function settle(db:SqlExecutor,id:string,hash:string,before:string,after:string,reason:string|null,recovery:string|null=null):Promise<boolean>{
  return (await db.query('SELECT public.communication_event_settle($1::uuid,$2,$3,$4,$5,$6) AS value',[id,hash,before,after,reason,recovery])).rows[0]?.value===true;
}
/** One postcommit projection transaction; receipt anti-join cannot skip late commits. */
export function createPostgresEcommerceEventProjection(options:PostgresEcommerceEventOptions){
  const binding=structuredClone(options.binding),cutoff=options.liveSince.toISOString();
  return {
    async initialize():Promise<void>{await options.withTransaction(async db=>{await db.query('SELECT public.communication_event_binding($1::jsonb,$2::timestamptz)',[JSON.stringify(binding),cutoff]);});},
    async project(limit=100):Promise<{projected:number;refused:number;deferred:number}>{
      if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('ecommerce_projection_limit');
      return options.withTransaction(async db=>{
        const sources=await db.query('SELECT * FROM public.communication_event_candidates($1::jsonb,$2::timestamptz,$3::integer)',[JSON.stringify(binding),cutoff,limit]);
        const result={projected:0,refused:0,deferred:0};
        for(const source of sources.rows){
          const parsed=ecommerceEventSchema.safeParse(source.event),event=parsed.success?parsed.data:null;
          let reason=source.reason?String(source.reason):source.historical?'historical_source':!event?'source_invalid':null;
          if(!reason&&event&&!await sourceCurrent(db,event,options.now()))reason='source_ineligible';
          const target=!reason&&event?await options.resolveTarget(event):null;
          if(!reason&&!target)reason='target_unavailable';
          let request:EcommerceEventExportRequest|null=null;
          if(!reason&&event&&target){
            if(event.sourceType==='order.paid'&&event.data.currency!==options.currency.code)reason='currency_unqualified';
            else request=ecommerceEventExportRequestSchema.parse({binding,event,...target,classification:'live',
              ...(event.sourceType==='order.paid'?{currencyExponent:options.currency.exponent,currencyExponentSource:options.currency.provenance}:{})});
          }
          const applied=(await db.query('SELECT public.communication_event_enqueue($1::jsonb,$2::timestamptz,$3,$4,$5) AS value',
            [JSON.stringify(binding),cutoff,source.source_key,request?JSON.stringify(request):null,reason])).rows[0]?.value;
          if(applied==='pending')result.projected++;else if(applied==='refused')result.refused++;
        }
        return result;
      });
    },
  };
}
/** Register in a separately invoked, export-only existing outbox worker. */
export function createPostgresEcommerceEventHandler(options:EcommerceEventTransaction&{
  binding:SyncBinding;provider:EcommerceEventsPort;now():Date;authorize(request:EcommerceEventExportRequest):Promise<boolean>;
}):OutboxHandler<AbortSignal>{
  const binding=structuredClone(options.binding);
  return {eventType:ECOMMERCE_EXPORT_EVENT_TYPE,timeoutMs:10_000,async handle(row,signal){
    const parsed=ecommerceEventExportRequestSchema.safeParse(row.payload);
    if(!parsed.success)return {kind:'discard',reason:'ecommerce_request_invalid'};
    const request=parsed.data,hash=digest(JSON.stringify(request));
    if(!sameBinding(request.binding,binding))return {kind:'snooze',reason:'ecommerce_binding_unselected'};
    const admission=await options.withTransaction(async db=>{
      const receipt=await work(db,row.id,row.metadata.claimToken);
      if(!receipt)return 'stale';
      if(receipt.state==='accepted')return 'accepted';
      if(receipt.state==='unknown'||receipt.state==='dispatching')return 'unknown';
      if(receipt.state!=='pending'||receipt.request_digest!==hash)return 'refused';
      if(!await sourceCurrent(db,request.event,options.now())||signal.aborted||!await options.authorize(request)){
        await settle(db,row.id,hash,'pending','refused','authority_or_source_ineligible');return 'refused';
      }
      return await settle(db,row.id,hash,'pending','dispatching',null)?'admitted':'stale';
    });
    if(admission==='accepted')return {kind:'processed'};
    if(admission==='unknown')return {kind:'snooze',reason:'ecommerce_reconciliation_required'};
    if(admission==='stale')return {kind:'retry',reason:'ecommerce_claim_stale'};
    if(admission!=='admitted')return {kind:'discard',reason:'ecommerce_authority_refused',benign:true};
    let outcome;
    try{outcome=await options.provider.exportEvent(request,{signal});}
    catch{outcome={kind:'unknown' as const,reason:'acceptance_ambiguous' as const};}
    await options.withTransaction(async db=>{await settle(db,row.id,hash,'dispatching',outcome.kind==='retryable'?'pending':outcome.kind,outcome.kind==='accepted'?null:outcome.reason);});
    return outcome.kind==='accepted'?{kind:'processed'}:outcome.kind==='retryable'?{kind:'retry',reason:`ecommerce_${outcome.reason}`}:
      outcome.kind==='unknown'?{kind:'snooze',reason:'ecommerce_reconciliation_required'}:{kind:'discard',reason:'ecommerce_provider_refused',benign:true};
  }};
}
/** Explicit quiesced recovery. Qualified retry retains the exact original tuple and bytes. */
export async function reconcilePostgresEcommerceEvent(options:EcommerceEventTransaction&{
  binding:SyncBinding;eventId:string;expectedRequestDigest:string;evidenceReference:string;
  resolution:'accepted'|'refused'|'retry';quiesced:boolean;qualifiedIdenticalRetry?:boolean;
  now():Date;authorize(request:EcommerceEventExportRequest):Promise<boolean>;
}):Promise<'resolved'|'refused'>{
  if(!options.quiesced||!options.evidenceReference.trim()||options.evidenceReference.length>180)return 'refused';
  return options.withTransaction(async db=>{
    const row=await work(db,options.eventId,null);
    if(!row||!['unknown','dispatching'].includes(String(row.state))||row.request_digest!==options.expectedRequestDigest||
      (row.status==='processing'&&new Date(String(row.available_at)).getTime()>options.now().getTime()))return 'refused';
    const parsed=ecommerceEventExportRequestSchema.safeParse(row.payload);
    if(!parsed.success||digest(JSON.stringify(parsed.data))!==options.expectedRequestDigest||!sameBinding(parsed.data.binding,options.binding))return 'refused';
    if(options.resolution==='retry'&&(!options.qualifiedIdenticalRetry||!await sourceCurrent(db,parsed.data.event,options.now())||!await options.authorize(parsed.data)))return 'refused';
    if(!await settle(db,options.eventId,options.expectedRequestDigest,String(row.state),options.resolution==='retry'?'pending':options.resolution,'explicit_reconciliation',options.evidenceReference))return 'refused';
    await db.query(`UPDATE public.outbox_events SET status=$2,available_at=$3::timestamptz,
      processed_at=CASE WHEN $2='processed' THEN $3::timestamptz ELSE processed_at END,
      metadata=metadata||CASE WHEN $2='discarded' THEN jsonb_build_object('discardedAt',$3::timestamptz) ELSE '{}'::jsonb END WHERE id=$1::uuid`,
      [options.eventId,options.resolution==='accepted'?'processed':options.resolution==='refused'?'discarded':'pending',options.now().toISOString()]);
    return 'resolved';
  });
}
