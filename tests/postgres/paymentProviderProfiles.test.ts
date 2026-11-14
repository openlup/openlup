import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nativeStoreFunctionDefinitions, sqlStatements } from "../../scripts/reviewed-platform-forward.js";
import type { PaymentProviderProfile } from "@openlup/platform/payments/contracts";
import { lifecycleInstallation, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const slot = "db/platform/migrations/20261121090000_payment_provider_profiles.sql";
const sql = readFileSync(slot, "utf8");
const registry = JSON.parse(readFileSync("config/reviewed-platform-forwards.json", "utf8"));
const entry = registry.nativeStoreForwardClass.slots.find((s: { path: string }) => s.path === slot);
type Pin = { signature: string; beforeSha256: string };
const pins: Pin[] = entry.replacedFunctions;
const attemptTable=sqlStatements(readFileSync("db/platform/migrations/20261114100000_payment_provider_attempt_store.sql","utf8"),true).find(statement=>statement.startsWith("CREATE TABLE public.payment_provider_attempts ("))!;
const attemptStatuses=[...attemptTable.match(/CHECK \(status IN \(([^)]+)\)\)/u)![1]!.matchAll(/'([^']+)'/gu)].map(m=>m[1]!);
const expectedBefore = [
  "32a796357656910c9886789c49c72b1dfd2dcbc021de766a653c8c363191587b",
  "582c9451047f03bc0069cdb5491bf4b8274d84652547bbb624b59ef8bbdc35d2",
  "68065292f5b861697f7ea64e076d9048145122f30cae09ae9777c245a2bea644",
  "9b1e745d36ba7095bc724ed62e04ba95742de55722cf4145245d4cc21a96c772",
  "45d4f74759ca8177b820ccdcf6d04a488960e6b3523ecc15c58ef51832035b5d",
  "a0bcea1a8af73d9aeeb004bf4de39e4c5ef9a9a59330d2499a1c20ee012cfba6",
  "0e1de9e956b8238f87480303bfd3da050003cbaf1bbf277cf82a3ac082f013c7",
  "35a8d5c2b664e9b00fe297bc8927c731634b5b0649a9f0f75dbc78ad96ba92f0",
  "ed2d3fbc368ad461a9c7242d5668c35164613938024ada6c9b72281ea6be0aaa",
  "4f6cc69c44ab60625ade46cf61846b2199c7008e6c7bcd7967369c8f2fb7b775",
];
const statements = sqlStatements(sql);
const predecessors = pins.map(pin => {
  const owner = registry.nativeStoreForwards.filter((f: { path: string; functions: Pin[] }) => f.path < slot && f.functions.some(p => p.signature === pin.signature)).at(-1);
  const source = readFileSync(owner.path, "utf8");
  return sqlStatements(source, true).filter(s => nativeStoreFunctionDefinitions(Buffer.from(s), [pin.signature], true).has(pin.signature)).at(-1)!;
});
const replacements = pins.map(pin => statements.find(s => nativeStoreFunctionDefinitions(Buffer.from(s), [pin.signature], true).has(pin.signature))!);
const replace = (s: string) => s.replace(/^CREATE(?: OR REPLACE)? FUNCTION/u, "CREATE OR REPLACE FUNCTION");
const oldDDL = predecessors.map(replace).join("\n"), newDDL = replacements.join("\n");
const profileDDL = statements.find(s => s.startsWith("CREATE FUNCTION public.payment_provider_profile("))!;
const knownNames = [...new Set([...predecessors[0]!.matchAll(/p_provider='([^']+)'/gu)].map(m => m[1]!))];
const forbidden = new RegExp("(?<![a-z0-9])(?:"+knownNames.join("|")+")", "iu");
let env: LifecycleInstallation, owner: PoolClient, runtime: PoolClient, at: string, old: string, future: string;
let profiles: PaymentProviderProfile[];
const third: { policy: PaymentProviderProfile; paid: Fixture; claim: Fixture; renewal: Fixture; interactive: Fixture; inline: Fixture }[] = [];
let genericBefore: unknown;
let handoffDDL: string;
let referenceFixture: Fixture;
type Fixture = { client: string; intent: string; attempt: string; order: string; cycle: string | null; subscription: string | null; provider: string; event: string; key: string };
type Probe = { fn: string; args: unknown[]; types: string[]; expected?: string; kind?: string; handoffFault?: string };
type Case = { group: string; name: string; subscription?: boolean; state?: "paid" | "failed" | "prepared"; expected?: string; kind?: string; early?: boolean; change?: (f: Fixture, p: Probe) => Promise<void>; args?: (f: Fixture) => unknown[] };
const prepare = "payment_provider_attempt_prepare", truth = "payment_provider_assert_truth", result = "payment_provider_result_apply";
const stale = "commerce_payment_reconciliation_claim_stale_attempts", prepared = "commerce_payment_reconciliation_claim_prepared_attempts";
const record = "payment_refund_evidence_record", financial = "commerce_order_provider_refund_evidence", refund = "payment_refund_apply_result";
const renewal = "commerce_payment_control_reopen_prepared_attempt_after_absence", interactive = "commerce_payment_reopen_interactive_sealed_v1";
const update = async (table: string, f: Fixture, set: string, values: unknown[] = []) => {
  const id = table === "payment_provider_attempts" ? f.attempt : table === "commerce_orders" ? f.order : table === "subscription_cycles" ? f.cycle : table === "subscriptions" ? f.subscription : table === "payment_provider_attempt_evidence" ? f.event : f.intent;
  await owner.query(`UPDATE public.${table} SET ${set} WHERE id=$1`, [id, ...values]);
};
const event = (f: Fixture, set: string, values: unknown[] = []) => update("payment_provider_attempt_evidence", f, set, values);
const state = (f: Fixture, set: string, values: unknown[] = []) => update("payment_provider_states", f, set, values);
const attempt = (f: Fixture, set: string, values: unknown[] = []) => update("payment_provider_attempts", f, set, values);
async function corrupt(_f: Fixture, table: string, id: string) {
  // Fixture-only broken historical references expose the existing defensive refusals.
  await owner.query("SET session_replication_role=replica");
  try { await owner.query(`DELETE FROM public.${table} WHERE id=$1`, [id]); }
  finally { await owner.query("SET session_replication_role=origin"); }
}
async function conflict(f: Fixture, scope: string) {
  await owner.query("INSERT INTO public.payment_provider_receipts(scope,idempotency_key,request_fingerprint,status,response_payload) VALUES($1,$2,'different','completed','{}')", [scope, f.key]);
}
const cases: Case[] = [];
function refusals(group: string, prefix: string, defs: Record<string, Case["change"]>, extra: Partial<Case> = {}) {
  for (const [suffix, change] of Object.entries(defs)) cases.push({ group, name: suffix, expected: prefix + suffix, change, ...extra });
}
refusals(prepare, "payment_control_", {
  inline_retry_invalid_context: async (_f,p) => { p.args[7] = { source: "commerce.checkout-inline-recovery.prepare.v1" }; },
  provider_attempt_prepare_invalid_input: async (_f,p) => { p.args[0] = ""; },
  provider_attempt_prepare_invalid_flow: async (_f,p) => { p.args[5] = "unknown-flow"; },
  provider_attempt_prepare_idempotency_conflict: f => conflict(f,"commerce.payment_attempt.prepare_provider"),
  provider_attempt_prepare_intent_not_found: async (_f,p) => { p.args[1]=randomUUID(); },
  provider_attempt_prepare_intent_not_retryable: f => state(f,"status='succeeded'"),
});
for (const suffix of ["order_not_payable", "predecessor_mismatch", "context_mismatch"]) cases.push({group:prepare,name:`inline_${suffix}`,state:"failed",expected:`payment_control_inline_retry_${suffix}`,change:async(f,p)=>{
  p.args[7]={source:"commerce.checkout-inline-recovery.prepare.v1",expectedPaymentAttemptId:f.attempt,retryRequestId:randomUUID(),purchaseContext:"one_time"};
  if(suffix==="order_not_payable")await update("commerce_orders",f,"status='paid'");
  if(suffix==="predecessor_mismatch")(p.args[7] as Record<string,unknown>).expectedPaymentAttemptId=randomUUID();
  if(suffix==="context_mismatch")p.args[5]="off_session_payment";
}});
refusals(truth,"payment_control_result_",{
  active_attempt_not_found:f=>state(f,"active_attempt_id=NULL"),
  evidence_mismatch:async(_f,p)=>{p.args[5]={sourceKind:"execution_response"};},
  event_mismatch:async(_f,p)=>{p.args[5]={sourceReference:randomUUID()};},
  attempt_unresolved:async f=>{await event(f,"payment_attempt_id=NULL");},
  attempt_mismatch:async f=>{await event(f,"payment_attempt_id=$2",[randomUUID()]);},
});
refusals(result,"payment_control_result_",{
  invalid_input:async(_f,p)=>{p.args[0]="";},
  attempt_unresolved:f=>event(f,"payment_attempt_id=NULL"),
  idempotency_conflict:f=>conflict(f,"commerce.payment_result.apply"),
  intent_not_found:async(_f,p)=>{p.args[1]=randomUUID();p.args[2]=null;},
  active_attempt_not_found:f=>state(f,"active_attempt_id=NULL"),
  event_mismatch:async(_f,p)=>{p.args[2]=randomUUID();},
  attempt_mismatch:f=>event(f,"payment_attempt_id=$2",[randomUUID()]),
  amount_mismatch:f=>event(f,"amount_minor=100"),
  currency_mismatch:f=>event(f,"currency='YYY'"),
  order_not_found:f=>corrupt(f,"commerce_orders",f.order),
  terminal_intent:f=>state(f,"status='cancelled'"),
});
for(const group of [stale,prepared])refusals(group,group===stale?"payment_reconciliation_claim_":"payment_reconciliation_prepared_claim_",{
  invalid_input:async(_f,p)=>{p.args[1]=59;},
  invalid_key:async(_f,p)=>{p.args[3]="x";},
});
refusals(record,"",{
  payment_control_result_refund_snapshot_unproven:async(_f,p)=>{p.args[2]=0;},
  payment_refund_evidence_conflict:async f=>{
    await owner.query("SELECT public.payment_refund_evidence_record($1,$2,3000,'XXX')",[f.event,`charge_${f.attempt}`]);
    await owner.query("UPDATE public.payment_refund_evidence SET provider_reference='other' WHERE source_evidence_id=$1",[f.event]);
  },
},{state:"paid"});
refusals(refund,"payment_control_result_",{
  invalid_input:async(_f,p)=>{p.args[0]="";},
  idempotency_conflict:f=>conflict(f,"commerce.payment_result.apply"),
  active_attempt_not_found:f=>state(f,"active_attempt_id=NULL"),
  refund_or_dispute_requires_success:f=>state(f,"status='processing'"),
  event_mismatch:async(_f,p)=>{p.args[2]=randomUUID();},
  attempt_unresolved:f=>event(f,"payment_attempt_id=NULL"),
  attempt_mismatch:f=>event(f,"payment_attempt_id=$2",[randomUUID()]),
  currency_mismatch:f=>event(f,"currency='YYY'"),
  refund_snapshot_unproven:async f=>{await event(f,"signature_verified=false");},
},{state:"paid"});
refusals(renewal,"prepared_attempt_absence_reopen_",{
  invalid_input:async(_f,p)=>{p.args[0]="";},
  absence_checked_at_in_future:async(_f,p)=>{p.args[5]=future;},
  requires_provider_absence_proof:async(_f,p)=>{p.args[7]={};},
  sensitive_evidence:async(_f,p)=>{p.args[7]={providerAbsenceConfirmed:true,clientSecret:"synthetic"};},
  idempotency_conflict:f=>conflict(f,"commerce.payment_attempt.prepared_absence_reopen"),
  attempt_not_found:async(_f,p)=>{p.args[1]=randomUUID();},
  intent_mismatch:async(_f,p)=>{p.args[2]=randomUUID();},
  attempt_not_prepared:f=>attempt(f,"status='failed'"),
  provider_not_supported:f=>attempt(f,"provider='unprofiled-provider'"),
  provider_ref_exists:f=>attempt(f,"provider_attempt_id='unexpected'"),
  provider_call_recorded:f=>attempt(f,"response_payload='{\"providerCall\":true}'"),
  missing_provider_identity:f=>attempt(f,"request_payload='{}'"),
  intent_not_found:f=>corrupt(f,"payment_provider_states",f.intent),
  active_attempt_mismatch:f=>state(f,"active_attempt_id=NULL"),
  cycle_mismatch:async(_f,p)=>{p.args[3]=randomUUID();},
  intent_not_active:f=>state(f,"status='failed'"),
  intent_provider_ref_exists:f=>state(f,"provider_payment_id='unexpected'"),
  cycle_not_found:f=>corrupt(f,"subscription_cycles",f.cycle!),
  cycle_not_pending:f=>update("subscription_cycles",f,"status='paid'"),
  order_mismatch:f=>update("commerce_orders",f,"subscription_cycle_id=NULL"),
  order_not_pending_payment:f=>update("commerce_orders",f,"status='paid'"),
  provider_event_exists:async f=>{await owner.query("SELECT public.payment_provider_event_ingest($1,$2,'payment.failed','ref',$3,$4,12999,'XXX',true,'{}')",[f.provider,randomUUID(),f.intent,f.attempt]);},
  terminal_reconciliation_exists:async f=>{await owner.query("UPDATE public.payment_provider_reconciliation_runs SET provider_status='succeeded',correction_status='corrected' WHERE payment_attempt_id=$1",[f.attempt]);},
  watchdog_evidence_missing:async f=>{await owner.query("DELETE FROM public.payment_provider_reconciliation_runs WHERE payment_attempt_id=$1",[f.attempt]);},
  too_fresh:f=>attempt(f,"updated_at=now()"),
},{subscription:true,state:"prepared"});
refusals(interactive,"interactive_prepared_attempt_reopen_",{
  invalid_input:async(_f,p)=>{p.args[0]="";},
  sensitive_evidence:async(_f,p)=>{p.args[12]={clientSecret:"synthetic"};},
  invalid_trusted_pre_dispatch_evidence:async(_f,p)=>{p.args[9]="wrong-code";},
  invalid_provider_refusal_evidence:async(_f,p)=>{p.args[6]="trusted_provider_refusal";},
  invalid_manual_absence_evidence:async(_f,p)=>{p.args[6]="manual_provider_absence";},
  idempotency_conflict:f=>conflict(f,"commerce.payment_attempt.interactive_prepared_reopen"),
  subscription_not_found:async(_f,p)=>{p.args[4]=randomUUID();p.args[5]=randomUUID();},
  intent_not_found:f=>corrupt(f,"payment_provider_states",f.intent),
  active_attempt_mismatch:f=>state(f,"active_attempt_id=NULL"),
  expected_ids_mismatch:async(_f,p)=>{p.args[3]=randomUUID();},
  intent_not_active:f=>state(f,"status='failed'"),
  intent_provider_ref_exists:f=>state(f,"provider_payment_id='unexpected'"),
  attempt_not_found:f=>corrupt(f,"payment_provider_attempts",f.attempt),
  intent_mismatch:async f=>{await attempt(f,"settlement_intent_id=$2",[randomUUID()]);},
  attempt_not_prepared:f=>attempt(f,"status='failed'"),
  provider_not_supported:f=>attempt(f,"provider='unprofiled-provider'"),
  provider_ref_exists:f=>attempt(f,"provider_session_id='unexpected'"),
  provider_call_recorded:f=>attempt(f,"response_payload='{\"providerCall\":true}'"),
  not_interactive_prepare:f=>attempt(f,"request_payload='{}'"),
  order_not_pending_payment:f=>update("commerce_orders",f,"status='paid'"),
  one_time_context_mismatch:f=>update("commerce_orders",f,"subscription_cycle_id=$2",[randomUUID()]),
  checkout_source_mismatch:f=>state(f,"metadata='{}'"),
  payment_not_pending:f=>state(f,"payment_status='failed'"),
  provider_event_exists:async f=>{await owner.query("SELECT public.payment_provider_event_ingest($1,$2,'payment.failed','ref',$3,$4,12999,'XXX',true,'{}')",[f.provider,randomUUID(),f.intent,f.attempt]);},
  terminal_reconciliation_exists:async f=>{await owner.query("UPDATE public.payment_provider_reconciliation_runs SET provider_status='succeeded',correction_status='corrected' WHERE payment_attempt_id=$1",[f.attempt]);},
  watchdog_evidence_missing:async(f,p)=>{manual(p);await owner.query("DELETE FROM public.payment_provider_reconciliation_runs WHERE payment_attempt_id=$1",[f.attempt]);},
  too_fresh:async(f,p)=>{manual(p);await attempt(f,"updated_at=now()");},
},{state:"prepared"});
for(const suffix of ["cycle_not_payment_pending","subscription_not_pending_activation","subscription_context_mismatch"]) cases.push({group:interactive,name:suffix,subscription:true,state:"prepared",expected:`interactive_prepared_attempt_reopen_${suffix}`,change:async f=>{
  if(suffix==="cycle_not_payment_pending")await update("subscription_cycles",f,"status='paid'");
  if(suffix==="subscription_not_pending_activation")await update("subscriptions",f,"status='active'");
  if(suffix==="subscription_context_mismatch")await update("commerce_orders",f,"subscription_cycle_id=NULL");
}});
function manual(p: Probe) {p.args[6]="manual_provider_absence";p.args[7]="provider_absence_confirmed";p.args[8]="operator_reconciliation";p.args[9]="operator_verified_absence";p.args[10]="operator.fixture";p.args[11]=at;p.args[12]={providerAbsenceConfirmed:true,watchdogEvidence:true,evidenceCode:"operator_verified_absence"};}
for(const code of ["subscription_renewal_cycle_correlation_required","subscription_retry_not_prepared"])cases.push({group:result,name:code,subscription:true,expected:code,change:async(f,p)=>{
  p.args[2]=null;p.args[3]="failed";
  const operation=randomUUID(),fingerprint="f".repeat(64);
  await owner.query("UPDATE public.commerce_settlement_intents SET renewal_operation_id=$2,renewal_operation_fingerprint=$3 WHERE id=$1",[f.intent,operation,fingerprint]);
  if(code==="subscription_retry_not_prepared"){
    await owner.query(`INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,claim_token,claimed_by,claimed_at,lease_expires_at)
      VALUES($1,$2,now(),1,$3,$4,'{"cycle":{"status":"correlated","logicalCycleNumber":3}}',$5,'fixture',now(),now()+interval '1 hour')`,[operation,f.subscription,randomUUID().replaceAll("-","").repeat(2),fingerprint,randomUUID()]);
    await update("subscription_cycles",f,"renewal_operation_id=$2",[operation]);
    await update("commerce_orders",f,"renewal_operation_id=$2",[operation]);
  }
}});
for(const [kind,fixtureState,subscription]of [
  ["ignored_failure_after_success_or_terminal","paid",false],
  ["ignored_duplicate_terminal_failure","failed",false],
  ["ignored_failure_terminalized_cycle","prepared",true],
  ["recoverable_decline",undefined,false],
] as const)cases.push({group:result,name:kind,kind,state:fixtureState,subscription,change:async(f,p)=>{
  p.args[2]=null;p.args[3]="failed";
  if(subscription)await update("subscription_cycles",f,"status='cancelled'");
}});
for(const [phase,index]of [["oauth",0],["oauth",1],["oauth",2],["transaction_dispatch",0],["transaction_dispatch",1],["response_decode",0]]as const)cases.push({group:interactive,name:`trusted_${phase}_${index}`,state:"prepared",change:async(_f,p)=>{
  const policy=profiles.find(profile=>profile.interactive)!;
  p.args[8]=phase;
  p.args[9]=phase==="oauth"?policy.trusted_oauth_codes[index]:phase==="transaction_dispatch"?policy.trusted_dispatch_codes[index]:policy.trusted_refusal_code;
  if(phase==="response_decode"){p.args[6]="trusted_provider_refusal";p.args[7]="refused";}
}});
cases.push({group:prepare,name:"inline_admission",state:"failed",change:async(f,p)=>{
  const profile=profiles.find(policy=>policy.provider===f.provider);
  p.args[5]=profile?.one_time_flow??"one_time_payment";
  p.args[7]={source:"commerce.checkout-inline-recovery.prepare.v1",expectedPaymentAttemptId:f.attempt,retryRequestId:randomUUID(),purchaseContext:"one_time"};
  if(!profile)p.expected="payment_control_inline_retry_context_mismatch";
}});
cases.push({group:truth,name:"historical_no_state",change:async(f,p)=>{
  await owner.query("UPDATE public.commerce_settlement_intents SET channel_key=$2 WHERE id=$1",[f.intent,f.provider]);
  await corrupt(f,"payment_provider_states",f.intent);
  if(profiles.some(policy=>policy.provider===f.provider))p.expected="payment_control_result_active_attempt_not_found";
}});
cases.push({group:truth,name:"missing_intent",expected:"payment_control_result_active_attempt_not_found",change:async(_f,p)=>{p.args[0]=randomUUID();}});
cases.push({group:refund,name:"non_advancing_snapshot",state:"paid",change:async(f,p)=>{
  const profile=profiles.find(policy=>policy.provider===f.provider);
  p.kind=profile?.refund_ignored_kind??"state_changed";
  if(profile?.refund_kind==="cumulative-snapshot"){
    const e=(await owner.query("SELECT public.payment_provider_event_ingest($1,$2,'payment.refunded',$3,$4,$5,12999,'XXX',true,(SELECT jsonb_set(payload,$6::text[],'12999') FROM public.payment_provider_attempt_evidence WHERE id=$7)) value",[f.provider,f.key+":prior",`charge_${f.attempt}`,f.intent,f.attempt,profile.refund_amount_path,f.event])).rows[0].value.paymentEvent.id;
    await owner.query("SELECT public.payment_refund_evidence_record($1,$2,12999,'XXX')",[e,`charge_${f.attempt}`]);
  }
}});
for(const [mode,code]of [["trusted_pre_dispatch","invalid_trusted_pre_dispatch_evidence"],["trusted_provider_refusal","invalid_provider_refusal_evidence"],["manual_provider_absence","invalid_manual_absence_evidence"]])cases.push({group:interactive,name:`tuple_before_replay_${mode}`,state:"prepared",early:true,expected:`interactive_prepared_attempt_reopen_${code}`,change:async(f,p)=>{
  await conflict(f,"commerce.payment_attempt.interactive_prepared_reopen");p.args[6]=mode;p.args[8]="wrong-phase";
}});
cases.push({group:prepare,name:"skipped_subscription",subscription:true,state:"failed",change:async f=>{
  await update("subscriptions",f,"status='cancelled'");
}});
for(const status of ["failed","expired","refunded","partially_refunded","disputed"])cases.push({group:result,name:`returned_${status}`,state:["refunded","partially_refunded","disputed"].includes(status)?"paid":undefined,change:async(_f,p)=>{p.args[2]=null;p.args[3]=status;}});
cases.push({group:record,name:"ignored_snapshot",state:"paid",change:async(f,p)=>{
  if(profiles.find(policy=>policy.provider===f.provider)?.refund_kind==="cumulative-snapshot"){
    const e=(await owner.query("SELECT public.payment_provider_event_ingest($1,$2,'payment.refunded',$3,$4,$5,12999,'XXX',true,(SELECT payload FROM public.payment_provider_attempt_evidence WHERE id=$6)) value",[f.provider,f.key+":prior",`charge_${f.attempt}`,f.intent,f.attempt,f.event])).rows[0].value.paymentEvent.id;
    await owner.query("SELECT public.payment_refund_evidence_record($1,$2,3000,'XXX')",[e,`charge_${f.attempt}`]);
  }
}});
for(const status of ["refunded","disputed"])cases.push({group:refund,name:`returned_${status}`,state:"paid",change:async(_f,p)=>{p.args[2]=null;p.args[3]=status;}});
cases.push({group:prepared,name:"returned_requires_action",state:"prepared",change:async f=>{await state(f,"status='requires_action'");}});
for(const status of attemptStatuses)cases.push({group:prepare,name:`returned_attempt_${status}`,state:"failed",change:async(_f,p)=>{
  const id=(await owner.query(callSQL(p),p.args)).rows[0].value.paymentAttempt.id;
  await owner.query("UPDATE public.payment_provider_attempts SET status=$2 WHERE id=$1",[id,status]);
}});
const caughtRefusals=[...predecessors[pins.findIndex(pin=>pin.signature.startsWith(`public.${result}(`))]!.matchAll(/IF SQLERRM NOT IN \(([^)]+)\)/gu)].flatMap(m=>[...m[1]!.matchAll(/'([^']+)'/gu)].map(v=>v[1]!));
for(const code of caughtRefusals)cases.push({group:result,name:`caught_${code}`,change:async(f,p)=>{
  p.args[0]=`provider-webhook:${f.provider}:${f.key}:apply`;p.args[3]="failed";p.handoffFault=code;
  await event(f,"event_type='payment.failed'");
}});
for(const status of ["sent_to_provider","requires_action"])cases.push({group:stale,name:`returned_${status}`,change:async f=>{
  await attempt(f,"status=$2",[status]);await state(f,"status='requires_action'");
}});
for(const group of [prepare,truth,result,stale,prepared,record,financial,refund,renewal,interactive])cases.push({group,name:"valid",state:group===refund||group===record||group===financial?"paid":group===prepare?"failed":group===renewal||group===interactive||group===prepared?"prepared":undefined,subscription:group===renewal});
const matrix = cases.flatMap((c,index)=>["snapshot","delta","unprofiled"].map(label=>({label,c,index,key:`${index}:${label}`})));
const probes = new Map<string,Probe>();
const executed = new Map<string,Set<string>>();
function callSQL(p: Probe) {
  const fn=p.fn===interactive?"commerce_payment_control_reopen_interactive_prepared_attempt":p.fn;
  return `SELECT to_jsonb(value) AS value FROM public.${fn}(${p.types.map((t,i)=>`$${i+1}::${t}`).join(",")}) value`;
}
function normalized(value: unknown, clock?: number): unknown {
  if(typeof value==="string"&&/^\d{4}-\d\d-\d\dT/u.test(value)&&Date.parse(value)===clock)return "<transaction-time>";
  if(typeof value==="string")return value.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/giu,"<uuid>");
  if(Array.isArray(value))return value.map(v=>normalized(v,clock));
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalized(v,clock)]));
  return value;
}
async function observe(p: Probe, clock?: number) {
  try {return {rows:normalized((await runtime.query(callSQL(p),p.args)).rows,clock)};}
  catch(error){const e=error as {code:string;message:string};return {error:{code:e.code,message:e.message}};}
}
// End each transaction before replacing pg_proc: otherwise this runtime backend
// can retain the earlier executable function version until transaction end.
async function observeDefinition(p:Probe,ddl:string){
  await owner.query(ddl);
  await runtime.query("BEGIN");
  try{
    const clock=(await runtime.query("SELECT transaction_timestamp() at")).rows[0].at.getTime();
    return await observe(p,clock);
  }finally{await runtime.query("ROLLBACK");}
}
beforeAll(async()=>{
  env=await lifecycleInstallation("qualified-v2");owner=await env.owner.connect();runtime=await env.runtime.connect();
  ({at,old,future}=(await owner.query("SELECT now()::text at,(now()-interval '2 hours')::text old,(now()+interval '1 hour')::text future")).rows[0]);
  // Counterfactual legacy rows exercise inherited defensive branches that current
  // subscription CHECKs exclude. Restore enforcement after fixture construction.
  const subscriptionCheck=(await owner.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='public.subscriptions'::regclass AND conname='subscriptions_status_check'")).rows[0].definition;
  await owner.query("ALTER TABLE public.subscriptions DROP CONSTRAINT subscriptions_status_check");
  profiles=(await runtime.query("SELECT * FROM public.payment_provider_profile(NULL)")).rows;
  for(const path of ["paymentProvider/setup.sql","paymentReconciliation/setup.sql"])await owner.query(readFileSync(`tests/postgres/fixtures/${path}`,"utf8"));
  for(const {label,c,key} of matrix){
    const provider=label==="unprofiled"?"unprofiled-provider":profiles.find(p=>(p.refund_kind==="cumulative-snapshot")===(label==="snapshot"))!.provider;
    const f:Fixture=(await owner.query("SELECT pg_temp.reconciliation_fixture($1,$2,$3) f",[provider,c.subscription??false,c.state!=="prepared"])).rows[0].f;
    f.key=`profile-proof:${randomUUID()}`;
    if(c.state==="paid"||c.state==="failed")await owner.query("SELECT pg_temp.provider_apply($1,$2,NULL,$3,$4,NULL)",[f.key+":initial",f.intent,c.state==="paid"?"succeeded":"failed",at]);
    if(c.group===interactive){
      await attempt(f,"request_payload=request_payload||'{\"source\":\"commerce.runtime.provider-attempt.prepare.v0\"}'");
      const kind=c.subscription?"subscription_initial":"one_time";
      await state(f,"metadata=metadata||jsonb_build_object('checkoutKind',$2::text)",[kind]);
      await update("commerce_orders",f,"metadata=metadata||jsonb_build_object('runtimeFinalize',jsonb_build_object('checkoutKind',$2::text,'source','commerce.runtime.hidden.v0'))",[kind]);
      if(c.subscription)await update("subscriptions",f,"status='pending_activation'");
    }
    if(c.group===renewal||c.group===interactive||c.group===stale||c.group===prepared){
      await attempt(f,"created_at=$2,updated_at=$2",[old]);await state(f,"created_at=$2,updated_at=$2",[old]);
      if(c.group===stale)await attempt(f,"provider_session_id='distinct-session'");
      await owner.query("SELECT * FROM public.commerce_payment_reconciliation_claim_prepared_attempts($1,900,500,$2)",[at,`watchdog:${f.key}`]);
    }
    let payload:unknown={},amount=12999;
    const isRefund=[refund,record,financial].includes(c.group);
    if(isRefund){
      amount=3000;
      if(label==="snapshot")payload=(await owner.query("SELECT pg_temp.refund_input($1,$2,3000) f",[f,f.key])).rows[0].f.rawPayload;
    }
    const ingested=await owner.query("SELECT public.payment_provider_event_ingest($1,$2,$3,$4,$5,$6,$7,'XXX',true,$8) value",[provider,f.key,isRefund?"payment.refunded":"payment.succeeded",`charge_${f.attempt}`,f.intent,f.attempt,isRefund&&label!=="snapshot"?amount:12999,payload]);
    f.event=ingested.rows[0].value.paymentEvent.id;
    if(c.group===prepare||c.group===renewal||c.group===interactive)await owner.query("DELETE FROM public.payment_provider_attempt_evidence WHERE id=$1",[f.event]);
    const args:Record<string,unknown[]>={
      [prepare]:[f.key,f.intent,provider,`provider:${f.key}`,"b".repeat(64),"one_time_payment",null,{}],
      [truth]:[f.intent,"captured",12999,"XXX",at,{sourceKind:"accepted_event",sourceReference:f.event,attemptRef:f.attempt,payloadFingerprint:null,observedAt:at}],
      [result]:[f.key,f.intent,f.event,"succeeded",at,null,null,null,"dunning","/recover","recovered"],
      [stale]:[at,900,500,f.key],[prepared]:[at,900,500,f.key],
      [record]:[f.event,`charge_${f.attempt}`,amount,"XXX"],[financial]:[f.order],
      [refund]:[f.key,f.intent,f.event,"partially_refunded",at,null,null,null],
      [renewal]:[f.key,f.attempt,f.intent,f.cycle,"operator.fixture",at,at,{providerAbsenceConfirmed:true}],
      [interactive]:[f.key,f.attempt,f.intent,f.order,f.subscription,f.cycle,"trusted_pre_dispatch","not_dispatched","oauth",profiles.find(p=>p.interactive)!.trusted_oauth_codes[0],null,null,{}],
    };
    if(c.group===truth)(args[truth]![5] as Record<string,unknown>).payloadFingerprint=createHash("sha256").update("{}").digest("hex");
    const pin=pins.find(p=>p.signature.startsWith(`public.${c.group}(`))!;
    const p:Probe={fn:c.group,args:c.args?.(f)??args[c.group]!,types:pin.signature.split("(")[1]!.slice(0,-1).split(","),expected:c.expected,kind:c.kind};
    await owner.query("SET session_replication_role=replica");
    try{await c.change?.(f,p);}catch(error){throw new Error(`Fixture ${key} ${c.group} ${c.name}`,{cause:error});}finally{await owner.query("SET session_replication_role=origin");}
    const unsupported = c.group===renewal ? label==="unprofiled" : c.group===interactive ? label!=="delta" : false;
    const cutoff = "provider_not_supported";
    const family = cases.filter(candidate=>candidate.group===c.group);
    if(unsupported && !c.early && (family.indexOf(c)>=family.findIndex(candidate=>candidate.name===cutoff)))
      p.expected=c.group===renewal?"prepared_attempt_absence_reopen_provider_not_supported":"interactive_prepared_attempt_reopen_provider_not_supported";
    probes.set(key,p);
  }
  genericBefore=await genericDefinitions();
  handoffDDL=(await owner.query("SELECT pg_get_functiondef('public.payment_reconciliation_open_dunning_from_failed_result(text,uuid,text,text,timestamptz,text,uuid,text,text)'::regprocedure) body")).rows[0].body;
  const withoutWatchdog=matrix.filter(m=>m.c.name==="watchdog_evidence_missing").map(m=>probes.get(m.key)!.args[1]);
  await owner.query("DELETE FROM public.payment_provider_reconciliation_runs WHERE payment_attempt_id=ANY($1::uuid[])",[withoutWatchdog]);
  await owner.query(`ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_status_check ${subscriptionCheck} NOT VALID`);
},postgresSetupTimeoutMs);
afterAll(async()=>{runtime?.release();owner?.release();await env?.close();},postgresTeardownTimeoutMs);

it("pins every preimage and proves the ten bodies and generic TypeScript contain no provider identifiers",()=>{
  expect(pins.map(p=>p.beforeSha256)).toEqual(expectedBefore);
  expect(knownNames).toHaveLength(2);
  expect(readFileSync("tests/postgres/paymentProviderProfiles.test.ts","utf8")).not.toMatch(forbidden);
  for(const [i,pin]of pins.entries()){
    expect(createHash("sha256").update(predecessors[i]!).digest("hex")).toBe(pin.beforeSha256);
    expect(replacements[i]).not.toMatch(forbidden);
    expect([...new Set([...replacements[i]!.matchAll(/RAISE EXCEPTION '([^']+)'/gu)].map(m=>m[1]))]).toEqual([...new Set([...predecessors[i]!.matchAll(/RAISE EXCEPTION '([^']+)'/gu)].map(m=>m[1]))]);
  }
  const visit=(path:string)=>{for(const item of readdirSync(path,{withFileTypes:true})){const child=join(path,item.name);if(item.isDirectory()){if(!knownNames.includes(item.name))visit(child);}else if(/\.tsx?$/u.test(child))expect(readFileSync(child,"utf8"),child).not.toMatch(forbidden);}};
  visit("packages/platform/src/payments");
  expect(readFileSync(slot)).toEqual(readFileSync(slot.replace("db/platform/migrations/","packages/platform/sql/")));
});
it("matches all SQL fields to the independent adapter declarations and preserves generic fallback",async()=>{
  expect(profiles).toHaveLength(2);
  for(const profile of profiles){
    const exports=await import(/* @vite-ignore */ pathToFileURL(resolve("packages/platform/dist/payments",profile.provider,"providerProfile.js")).href) as Record<string,unknown>;
    expect(Object.values(exports).find(value=>value&&typeof value==="object"&&"provider"in value&&(value as PaymentProviderProfile).provider===profile.provider)).toEqual(profile);
  }
  const fallback=(await runtime.query("SELECT * FROM public.payment_provider_profile('unprofiled-provider')")).rows;
  expect(fallback).toMatchObject([{provider:"unprofiled-provider",claim_stale:false,claim_prepared:false,renewal_absence:false,interactive:false,requires_attempt_truth:false,refund_kind:"event-delta"}]);
  expect((await runtime.query("SELECT current_user,session_user FROM pg_roles WHERE rolname=session_user")).rows[0]).toEqual({current_user:"service_role",session_user:"lifecycle_r"});
  await expect(runtime.query("SELECT public.commerce_payment_reopen_interactive_sealed_v1(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)")).rejects.toMatchObject({code:"42501"});
});
it.each(matrix)("preserves $label $c.group $c.name against its before-hash body",async({key,c})=>{
  const p=probes.get(key)!;
  try{
    if(p.handoffFault){
      // Synthetic callee fault isolates the five existing catch-to-result mappings,
      // matching the native dunning attribution boundary witnesses.
      await owner.query(handoffDDL.replace(/BEGIN/iu,`BEGIN RAISE EXCEPTION '${p.handoffFault}' USING ERRCODE='55000';`));
    }
    const before=await observeDefinition(p,oldDDL),after=await observeDefinition(p,newDDL);
    expect(after).toEqual(before);
    const codes=executed.get(c.group)??new Set<string>();
    const collect=(value:unknown)=>{if(typeof value==="string")codes.add(value);else if(Array.isArray(value))value.forEach(collect);else if(value&&typeof value==="object")Object.values(value).forEach(collect);};
    collect(after.rows);
    if(after.error){
      expect(after.error.code).toMatch(/^(?:22023|23505|55000)$/u);
      codes.add(after.error.message);
      if(p.expected)expect(after.error.message).toBe(p.expected);
    }else if(p.expected)throw Error(`Expected ${p.expected}, got ${JSON.stringify(after)}`);
    executed.set(c.group,codes);
    if((c.name==="valid"||c.name==="inline_admission"||c.name==="historical_no_state"||c.name.startsWith("trusted_")||c.name.startsWith("returned_")||c.name.startsWith("caught_")||c.name==="skipped_subscription"||c.name==="ignored_snapshot"||p.kind)&&!p.expected)expect(after.error).toBeUndefined();
    if(p.kind)expect(after.rows).toMatchObject([{value:{paymentResult:{kind:p.kind}}}]);
    if(c.name==="skipped_subscription")expect(after.rows).toMatchObject([{value:{paymentAttemptAdmission:{status:"skipped_not_chargeable",reason:"payment_control_subscription_not_chargeable"}}}]);
    if(p.handoffFault)expect(after.rows).toMatchObject([{value:{subscriptionWebhookDunning:{opened:false,reason:p.handoffFault}}}]);
    if((c.group===stale||c.group===prepared)&&c.name==="valid"){
      expect(third).toEqual([]);
      expect(after.rows).toBeInstanceOf(Array);
      const providers=(after.rows as {value:{provider:string}}[]).map(row=>row.value.provider);
      expect(new Set(providers)).toEqual(new Set(profiles.map(policy=>policy.provider)));
      expect(providers).not.toContain("unprofiled-provider");
    }
  }finally{await runtime.query("ROLLBACK");await owner.query(newDDL);if(p.handoffFault)await owner.query(handoffDDL);}
});

function literal(value:unknown):string {
  if(value===null)return "NULL";
  if(typeof value==="boolean")return String(value);
  if(Array.isArray(value))return "ARRAY["+value.map(literal).join(",")+"]::text[]";
  return "'"+String(value).replaceAll("'","''")+"'";
}
async function genericDefinitions(){return (await owner.query("SELECT oid::regprocedure::text signature,pg_get_functiondef(oid) body FROM pg_proc WHERE oid=ANY(SELECT to_regprocedure(unnest($1::text[]))) ORDER BY 1",[pins.map(p=>p.signature)])).rows;}
describe("declaration-only extension",()=>{
beforeAll(async()=>{
  const additions=profiles.map((p,index)=>({...p,provider:index===0?"example-snapshot":"example-session",
    ...(p.interactive?{trusted_oauth_codes:["example_oauth_unavailable"],trusted_dispatch_codes:["example_dispatch_unavailable"],trusted_refusal_code:"example_request_refused"}:{}),
    ...(p.refund_kind==="cumulative-snapshot"?{refund_operation_path:["exampleSnapshot","chargeId"],refund_amount_path:["exampleSnapshot","amountRefundedMinor"],refund_ignored_kind:"ignored_example_snapshot"}:{}),
  }));
  additions.push({...additions.find(policy=>policy.interactive)!,provider:"example-empty",trusted_oauth_codes:[],trusted_dispatch_codes:[],trusted_refusal_code:null});
  const amended=replace(profileDDL).replace("\n )\n SELECT * FROM declarations",",\n"+additions.map(p=>"  ("+Object.values(p).map(literal).join(",")+")").join(",\n")+"\n )\n SELECT * FROM declarations");
  expect(amended).not.toBe(replace(profileDDL));
  await owner.query(amended);
  for(const policy of additions){
    const make=async(subscription=false,finalized=true):Promise<Fixture>=>(await owner.query("SELECT pg_temp.reconciliation_fixture($1,$2,$3) f",[policy.provider,subscription,finalized])).rows[0].f;
    const paid=await make(),claim=await make(),renewalFixture=await make(true,false),interactiveFixture=await make(false,false),inline=await make();
    await owner.query("SELECT pg_temp.provider_apply($1,$2,NULL,'succeeded',$3,NULL)",[`third:${paid.intent}`,paid.intent,at]);
    await owner.query("SELECT pg_temp.provider_apply($1,$2,NULL,'failed',$3,NULL)",[`third-failed:${inline.intent}`,inline.intent,at]);
    await attempt(claim,"provider_session_id='session-reference'");
    for(const f of [claim,renewalFixture,interactiveFixture]){await attempt(f,"created_at=$2,updated_at=$2",[old]);await state(f,"created_at=$2,updated_at=$2",[old]);}
    await attempt(interactiveFixture,"request_payload=request_payload||'{\"source\":\"commerce.runtime.provider-attempt.prepare.v0\"}'");
    await state(interactiveFixture,"metadata=metadata||'{\"checkoutKind\":\"one_time\"}'");
    await update("commerce_orders",interactiveFixture,"metadata=metadata||'{\"runtimeFinalize\":{\"checkoutKind\":\"one_time\",\"source\":\"commerce.runtime.hidden.v0\"}}'");
    third.push({policy,paid,claim,renewal:renewalFixture,interactive:interactiveFixture,inline});
  }
  await owner.query("SELECT * FROM public.commerce_payment_reconciliation_claim_prepared_attempts($1,900,500,'third-watchdog')",[at]);
  const reference=profiles.find(policy=>policy.interactive)!;
  // The existing one-time fixtures remain prepared after each rolled-back call.
  referenceFixture=(await owner.query("SELECT pg_temp.reconciliation_fixture($1,false,false) f",[reference.provider])).rows[0].f as Fixture;
  await attempt(referenceFixture,"request_payload=request_payload||'{\"source\":\"commerce.runtime.provider-attempt.prepare.v0\"}'");
  await state(referenceFixture,"metadata=metadata||'{\"checkoutKind\":\"one_time\"}'");
  await update("commerce_orders",referenceFixture,"metadata=metadata||'{\"runtimeFinalize\":{\"checkoutKind\":\"one_time\",\"source\":\"commerce.runtime.hidden.v0\"}}'");
},postgresSetupTimeoutMs);
it("executes distinct before/after claim bodies in separate transactions",async()=>{
  for(const fn of [stale,prepared]){
    const p:Probe={fn,types:["timestamptz","integer","integer","text"],args:[at,900,500,`third-body-control:${fn}`]};
    try{
      const before=await observeDefinition(p,oldDDL),after=await observeDefinition(p,newDDL);
      expect(before.error).toBeUndefined();expect(after.error).toBeUndefined();
      const ids=(rows:unknown)=>new Set((rows as {value:{provider:string}}[]).map(row=>row.value.provider));
      expect(ids(before.rows)).toEqual(new Set(profiles.map(policy=>policy.provider)));
      expect(ids(after.rows)).toEqual(new Set([...profiles,...third.map(f=>f.policy)].map(policy=>policy.provider)));
      expect((after.rows as unknown[]).length).toBe((before.rows as unknown[]).length+third.length*(fn===stale?1:2));
    }finally{await owner.query(newDDL);}
  }
});
it("adds three policy variants by declarations only and executes claims, refunds and reopen through the runtime role",async()=>{
  expect(await genericDefinitions()).toEqual(genericBefore);
  const claimedPrepared=(await runtime.query("SELECT * FROM public.commerce_payment_reconciliation_claim_prepared_attempts($1,900,500,'third-runtime-prepared')",[at])).rows;
  for(const f of third){
    expect(claimedPrepared).toEqual(expect.arrayContaining([{...claimedPrepared.find(row=>row.payment_attempt_id===f.interactive.attempt),provider:f.policy.provider,payment_attempt_id:f.interactive.attempt}]));
    const declared=(await runtime.query("SELECT * FROM public.payment_provider_profile($1)",[f.policy.provider])).rows;
    expect(declared).toEqual([f.policy]);
    const claimed=(await runtime.query("SELECT * FROM public.commerce_payment_reconciliation_claim_stale_attempts($1,900,500,$2)",[at,`third-claim:${f.claim.intent}`])).rows.find(r=>r.payment_intent_id===f.claim.intent);
    expect(claimed).toMatchObject({provider:f.policy.provider,provider_payment_id:f.policy.readback_reference_order==="session-attempt-intent"?"session-reference":`charge_${f.claim.attempt}`});
    for(const [index,amount]of [3000,12999].entries()){
      const payload=f.policy.refund_kind==="cumulative-snapshot"?{eventType:f.policy.refund_event_type,providerPaymentId:`charge_${f.paid.attempt}`,
        exampleSnapshot:{chargeId:"third-charge",amountRefundedMinor:amount}}:{};
      const e=(await runtime.query("SELECT public.payment_provider_event_ingest($1,$2,'payment.refunded',$3,$4,$5,$6,'XXX',true,$7) value",[f.policy.provider,`third-refund:${f.paid.intent}:${index}`,`charge_${f.paid.attempt}`,f.paid.intent,f.paid.attempt,f.policy.refund_event_money_original?12999:amount,payload])).rows[0].value.paymentEvent.id;
      const input=[`third-apply:${f.paid.intent}:${index}`,f.paid.intent,e,index===0?"partially_refunded":"refunded",at];
      const query="SELECT public.payment_refund_apply_result($1,$2,$3,$4,$5,NULL,NULL,NULL) value";
      expect((await runtime.query(query,input)).rows[0].value.paymentResult.replayed).toBe(false);
      expect((await runtime.query(query,input)).rows[0].value.paymentResult.replayed).toBe(true);
    }
    expect((await runtime.query("SELECT public.payment_refund_readback($1) value",[f.paid.intent])).rows[0].value.refundCents).toBe(f.policy.refund_kind==="cumulative-snapshot"?12999:15999);
    const inline=f.inline,request={source:"commerce.checkout-inline-recovery.prepare.v1",expectedPaymentAttemptId:inline.attempt,retryRequestId:randomUUID(),purchaseContext:"one_time"};
    expect((await runtime.query("SELECT public.payment_provider_attempt_prepare($1,$2,$3,$4,$5,$6,NULL,$7) value",[`third-inline:${inline.intent}`,inline.intent,f.policy.provider,`next:${inline.intent}`,"b".repeat(64),f.policy.one_time_flow,request])).rows[0].value.paymentAttempt.replayed).toBe(false);
    const r=f.renewal;
    expect((await runtime.query("SELECT public.commerce_payment_control_reopen_prepared_attempt_after_absence($1,$2,$3,$4,'operator.fixture',$5,$5,'{\"providerAbsenceConfirmed\":true}') value",[`third-reopen:${r.intent}`,r.attempt,r.intent,r.cycle,at])).rows[0].value.preparedAttemptReopen.replayed).toBe(false);
    if(f.policy.interactive&&f.policy.trusted_oauth_codes.length){await runtime.query("BEGIN");try{const i=f.interactive;expect((await runtime.query("SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt($1,$2,$3,$4,NULL,NULL,'trusted_pre_dispatch','not_dispatched','oauth',$5,NULL,NULL,'{}') value",[`third-interactive:${i.intent}`,i.attempt,i.intent,i.order,f.policy.trusted_oauth_codes[0]])).rows[0].value.interactivePreparedAttemptReopen.replayed).toBe(false);}finally{await runtime.query("ROLLBACK");}}
  }
  expect(await genericDefinitions()).toEqual(genericBefore);
});

it("binds distinct and empty trusted lists to the attempt profile before replay",async()=>{
  const reference=profiles.find(policy=>policy.interactive)!,distinct=third.find(f=>f.policy.provider==="example-session")!,empty=third.find(f=>f.policy.provider==="example-empty")!;
  for(const [phase,field] of [["oauth","trusted_oauth_codes"],["transaction_dispatch","trusted_dispatch_codes"],["response_decode","trusted_refusal_code"]] as const){
    const code=(policy:PaymentProviderProfile)=>{const value=policy[field];return Array.isArray(value)?value[0]!:value!;};
    for(const [fixture,reason,accepted] of [[referenceFixture,code(distinct.policy),false],[distinct.interactive,code(reference),false],[distinct.interactive,code(distinct.policy),true],[empty.interactive,code(reference),false],[empty.interactive,code(distinct.policy),false]] as const){
      const mode=phase==="response_decode"?"trusted_provider_refusal":"trusted_pre_dispatch";
      const invalid=`interactive_prepared_attempt_reopen_invalid_${phase==="response_decode"?"provider_refusal":"trusted_pre_dispatch"}_evidence`;
      const p:Probe={fn:interactive,types:pins.at(-1)!.signature.split("(")[1]!.slice(0,-1).split(","),args:[`cross-profile:${fixture.intent}:${phase}:${reason}`,fixture.attempt,fixture.intent,fixture.order,null,null,mode,phase==="response_decode"?"refused":"not_dispatched",phase,reason,null,null,{}]};
      await runtime.query("BEGIN");
      try{const observed=await observe(p);if(accepted)expect(observed.rows).toMatchObject([{value:{interactivePreparedAttemptReopen:{replayed:false}}}]);else expect(observed.error).toEqual({code:"22023",message:invalid});}finally{await runtime.query("ROLLBACK");}
      if(!accepted){
        // Invalid foreign tuples still refuse before a conflicting receipt/replay.
        await owner.query("INSERT INTO public.payment_provider_receipts(scope,idempotency_key,request_fingerprint,status,response_payload) VALUES('commerce.payment_attempt.interactive_prepared_reopen',$1,'different','completed','{}') ON CONFLICT DO NOTHING",[p.args[0]]);
        expect((await observe(p)).error).toEqual({code:"22023",message:invalid});
      }
    }
  }
  expect(await genericDefinitions()).toEqual(genericBefore);
});
});

// Closed codes authored by the ten bodies: direct JSON status/reason fields,
// kind/observation assignments, admitted result statuses, caught refusal reasons,
// and the status columns returned by claim/evidence functions. Passthrough IDs,
// money, timestamps and opaque evidence are not policy/result codes.
function returnedCodes(source:string,fn:string):string[]{
  const codes=new Set<string>();
  const literals=(part:string)=>[...part.matchAll(/'([^']+)'/gu)].map(m=>m[1]!);
  const responses=[...source.matchAll(/(?:RETURN|(?:v_response|answer)\s*:=)\s*jsonb_build_object\([\s\S]*?;/giu)].map(m=>m[0]).join("\n");
  for(const m of responses.matchAll(/'(?:status|reason|kind|attemptStatus|paymentAttemptStatus|paymentIntentStatus)'\s*,\s*'([^']+)'/gu))codes.add(m[1]!);
  for(const m of source.matchAll(/\b(?:kind|observation)(?:\s+text)?\s*:=\s*'([^']+)'/gu))codes.add(m[1]!);
  for(const m of source.matchAll(/(?:p_result_status NOT IN|IF SQLERRM NOT IN)\s*\(([^)]+)\)/gu))literals(m[1]!).forEach(code=>codes.add(code));
  if(fn===prepare){
    expect(source).toContain("'status', v_attempt.status");attemptStatuses.forEach(code=>codes.add(code));
  }
  if(fn===refund){
    const statuses=source.match(/s\.status NOT IN \(([^)]+)\)/u);expect(statuses).not.toBeNull();literals(statuses![1]!).forEach(code=>codes.add(code));
  }
  if(fn===record){
    const statuses=source.match(/CASE WHEN observation='cumulative-snapshot' AND prior>=p_amount THEN ('[^']+' ELSE '[^']+') END/u);
    expect(statuses).not.toBeNull();literals(statuses![1]!).forEach(code=>codes.add(code));
  }
  if(fn===stale||fn===prepared){
    for(const m of source.matchAll(/\b[ai]\.status (?:IN\s*\(([^)]+)\)|=\s*('([^']+)'))/gu))literals(m[1]??m[2]!).forEach(code=>codes.add(code));
  }
  if(fn===renewal){
    expect(source).toContain("'cycleStatus', v_cycle.status");
    const status=source.match(/v_cycle\.status <> '([^']+)'/u);expect(status).not.toBeNull();codes.add(status![1]!);
  }
  return [...codes].sort();
}
it("executes every named refusal and returned result code from all ten pinned functions",()=>{
  const missing=pins.flatMap((pin,index)=>{
    const fn=pin.signature.split(".")[1]!.split("(")[0]!;
    const returns=returnedCodes(predecessors[index]!,fn);
    // The only dynamic kind in the new body comes from declaration data.
    const afterReturns=returnedCodes(replacements[index]!,fn);
    if(fn===refund)afterReturns.push(...profiles.flatMap(policy=>policy.refund_ignored_kind?[policy.refund_ignored_kind]:[]));
    expect([...new Set(afterReturns)].sort()).toEqual(returns);
    const codes=[...new Set([...predecessors[index]!.matchAll(/RAISE EXCEPTION '([^']+)'/gu)].map(m=>m[1]!)),...returns];
    const seen=executed.get(fn);
    return codes.filter(code=>!seen?.has(code)).map(code=>({signature:pin.signature,code}));
  });
  expect(missing,JSON.stringify(missing)).toEqual([]);
});
