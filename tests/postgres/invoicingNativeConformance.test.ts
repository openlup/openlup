import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createPostgresInvoiceStore, INVOICING_MIGRATIONS, runNativeInvoiceIssueJob } from "@openlup/platform/invoicing";
import { createPostgresPaymentTruthPort } from "@openlup/platform/payments";
import type { PaymentTruthEvent } from "@openlup/platform/payments/contracts";
import { createPostgresFulfillmentDispatchStore } from "@openlup/platform/fulfillment";
import { fixture as shipmentFixture } from "../helpers/fulfillmentNative.js";
import { createPostgresAccountingPaidOrderDocumentPort } from "../../server/adapters/postgres/accountingPaidOrderDocument.js";
import { invoicingNativeHarness, manifest, prefixLength, sha256, units } from "../helpers/invoicingNativeHarness.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const h = invoicingNativeHarness();
let started: number;
let caseStarted: number;
beforeAll(async () => { await h.start(); started = performance.now(); }, postgresSetupTimeoutMs);
afterAll(async () => { await h.stop(); const elapsed=performance.now()-started; console.log(`M09 whole-file ms=${Math.round(elapsed)}`); expect(elapsed).toBeLessThanOrEqual(28_000); }, postgresTeardownTimeoutMs);
beforeEach(() => { caseStarted=performance.now(); });
afterEach(context => { console.log(`M09 case ${context.task.name} ms=${Math.round(performance.now()-caseStarted)}`); });
const executor = (db: Pool | PoolClient) => ({ query: (sql:string, values?:unknown[]) => db.query(sql,values) });
const money = (db:Pool|PoolClient = h.pool) => createPostgresPaymentTruthPort(executor(db), { dunningTemplateSlug:"payment_failed", recoveryUrlPath:"/recover", recoveryTemplateSlug:"payment_recovered" });
async function rpc(db:Pool|PoolClient, name:string, args:unknown[]) {
  // Function identifiers are literals owned by these tests, never external input.
  return (await db.query(`SELECT public.${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) AS result`,args.map(arg=>Array.isArray(arg)?JSON.stringify(arg):arg))).rows[0].result;
}
// Host worker boundaries are separate autocommit RPCs, like the outbox worker.
async function call(db:Pool|PoolClient,name:string,args:unknown[]):ReturnType<typeof rpc> {
  const result=await rpc(db,name,args);
  if(name==="invoicing_sweep_duties") {
    for(const lease of result.claims) {
      const outcome=await rpc(db,"invoicing_prepare_facts",[lease.dutyId,lease.token]);
      await rpc(db,"invoicing_finish_facts",[lease.dutyId,lease.token,outcome]);
    }
  }
  if(name==="invoicing_install_facts" && !result.replayed && result.status==="owed") {
    await call(db,"invoicing_sweep_duties",[100]);
    const row=(await db.query("SELECT status FROM public.invoicing_duties WHERE id=$1",[args[0]])).rows[0];
    return {dutyId:args[0],status:row.status};
  }
  return result;
}
const facts = () => ({
  factRevision: "facts-a", policyVersion: "host-v1", refs: { orderId: "order-a", orderRef: "ORDER/A", invoiceRef: "INVOICE/A" },
  dates: { issueDate: "2026-10-22", sellDate: "2026-10-21", handedOverAt: null, paymentCompletedAt: null },
  documentKind: "host-document", clearanceRequired: false, currency: "XXX",
  buyer: { name: "Saved buyer", email: null, taxIdentifier: null, companyName: null, address: null },
  payment: { intentRef: "intent-a", providerRef: null, providerPaymentRef: null, amountMinor: 900, currency: "XXX", localSettlementState: "matched" }, orderMoney: null,
  lines: [{ description: "Saved item", quantity: 1, unitNetMinor: 750, unitGrossMinor: 900, totalNetMinor: 750, totalTaxMinor: 150, totalGrossMinor: 900, taxRateBps: 2000, positionKind: "item", catalogTotalGrossMinor: null, discountAllocatedMinor: null, shippingGrossMinor: null, shippingDiscountMinor: null }],
  totalNetMinor: 750, totalTaxMinor: 150, totalGrossMinor: 900, chargedTotalGrossMinor: 900,
});
async function paymentFixture() {
  const client=randomUUID(), order=randomUUID(), intent=randomUUID(), subscription=randomUUID(), cycle=randomUUID();
  await h.pool.query("INSERT INTO public.clients(id,email) VALUES($1,$2)",[client,`${client}@example.invalid`]);
  await h.pool.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,'2026-08-29T12:00:00Z')",[subscription,client]);
  await h.pool.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at) VALUES($1,$2,'2026-08-01T12:00:00Z')",[cycle,subscription]);
  const db=await h.pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,currency_code,total_amount_minor) VALUES($1,$2,$3,'XXX',900)",[order,client,cycle]);
    await db.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,900,900)",[order]);
    await db.query("INSERT INTO public.commerce_settlement_intents(id,order_id,channel_key,amount_minor,currency_code,open_idempotency_key) VALUES($1,$2,'fixture',900,'XXX',$3)",[intent,order,`open-${intent}`]);
    await db.query("COMMIT");
  } catch(error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  const input: PaymentTruthEvent = { sourceEventId:`event:${intent}`,idempotencyKey:`event-${intent}`,settlementIntentId:intent,outcome:"captured",amountMinor:900,currency:"XXX",occurredAt:"2026-08-12T12:00:00.000Z",failure:null,
    evidence:{sourceKind:"accepted_event",sourceReference:`event:${intent}`,observedStatus:"captured",observedAt:"2026-08-12T12:00:00.000Z",payloadFingerprint:"a".repeat(64)} };
  return {client,order,intent,subscription,cycle,input};
}
async function owe(f:Awaited<ReturnType<typeof paymentFixture>>) {
  await rpc(h.pool,"commerce_record_settlement",[`settled-${f.intent}`,f.intent,"succeeded",null,{},f.input.occurredAt]);
  return rpc(h.pool,"invoicing_capture_duty",[`duty-${f.order}`,"paid",f.intent,f.order,{},f.input.occurredAt]);
}
async function duty() {
  const f=await paymentFixture();
  await rpc(h.pool,"commerce_record_settlement",[`settled-${f.intent}`,f.intent,"succeeded",null,{},f.input.occurredAt]);
  const captured=await rpc(h.pool,"invoicing_capture_duty",[`duty-${f.order}`,"paid",f.intent,f.order,{},f.input.occurredAt]);
  expect(await call(h.pool,"invoicing_install_facts",[captured.dutyId,facts(),"facts-v1"])).toMatchObject({status:"ready"});
  return {...f,duty:captured.dutyId};
}
async function claim(id:string) {
  const order=(await h.pool.query("SELECT order_id FROM public.invoicing_duties WHERE id=$1",[id])).rows[0].order_id;
  const rows=await rpc(h.pool,"invoicing_claim_duties",[100,300,"fixture",order]);
  const row=rows.find((item:{id:string})=>item.id===id);
  if(!row) throw new Error(`Expected claim for ${id}`);
  return row;
}
async function preflight(row:{id:string;claim_token:string;generation:number}) {
  expect(await call(h.pool,"invoicing_preflight_duty",[row.id,row.claim_token,row.generation,{kind:"observed",outcome:"captured",amountMinor:900,currency:"XXX"}])).toEqual({kind:"ready"});
}
const proof=(id:string,external:string,kind="issued")=>({kind,externalId:external,providerCreateIdentity:`invoicing:${id}`});
async function finish(row:{id:string;claim_token:string;generation:number},external:string,kind="issued") {
  if(kind==="issued") await preflight(row);
  return call(h.pool,"invoicing_finish_issue",[row.id,row.claim_token,row.generation,external,null,proof(row.id,external,kind)]);
}
it("fresh complete install and exact pre-M09 prefix upgrade preserve rows/history and bind both native forwards and three sparse rails",async()=>{
  expect(prefixLength).toBeGreaterThan(0);
  expect(h.freshDigest).toBe(manifest.objectInventorySha256);
  expect(await money().ingestEvent(h.legacy.input)).toMatchObject({event:{replayed:true,state:"settled"},effects:{accountingRequested:true}});
  expect((await h.pool.query("SELECT * FROM public.payment_truth_events WHERE id=$1",[h.legacy.eventId])).rows).toEqual([h.legacy.row]);
  expect(h.upgradeFiles).toEqual(units.slice(prefixLength).map(unit=>unit.file));
  expect((await h.pool.query("SELECT * FROM public.platform_schema_migrations WHERE position<$1 ORDER BY position",[prefixLength])).rows).toEqual(h.prefixHistory);
  expect((await h.pool.query("SELECT * FROM public.commerce_orders WHERE id=$1",[h.witness.order])).rows).toEqual(h.prefixRows);
  for(const unit of units.slice(prefixLength)) {
    const canonical=readFileSync(unit.file);
    expect(sha256(canonical)).toBe(unit.sha256);
    expect(readFileSync(`packages/platform/sql/${unit.file.split("/").at(-1)}`)).toEqual(canonical);
  }
  for(const unit of INVOICING_MIGRATIONS.native.units) {
    expect(units[unit.position]).toEqual({file:unit.catalogPath,sha256:unit.sha256});
    expect(readFileSync(unit.url)).toEqual(readFileSync(unit.catalogPath));
  }
  expect((await h.pool.query("SELECT * FROM public.platform_schema_migrations WHERE position<=$1 ORDER BY position",[prefixLength])).rows).toEqual(h.resumeHistory);
  expect(h.replay).toEqual({applied:[],pending:[]});
  await call(h.pool,"invoicing_sweep_duties",[100]);
  const historic=(await h.pool.query("SELECT id FROM public.commerce_orders WHERE id IN ($1,$2)",[h.historicUninvoicedOrder,h.legacy.row && (await h.pool.query("SELECT order_id FROM public.commerce_settlement_intents WHERE id=$1",[h.legacy.input.settlementIntentId])).rows[0].order_id])).rows;
  expect(historic).toHaveLength(2);
  expect((await h.pool.query("SELECT id FROM public.invoicing_duties WHERE order_id=ANY($1::uuid[])",[historic.map(row=>row.id)])).rows).toEqual([]);

  // D#8: execute the exact install prefix before any invoicing FK table.
  // Keep the seed transaction open while an independent order writer proceeds.
  const seed=await h.pool.connect(),writer=await h.pool.connect();
  try {
    await seed.query("BEGIN; DROP TABLE public.invoicing_cutover CASCADE");
    const forward=readFileSync(units[prefixLength].file,"utf8");
    await seed.query(forward.slice(0,forward.indexOf("CREATE TABLE public.invoicing_duties")));
    expect((await seed.query(`SELECT source_kind,source_id FROM public.invoicing_cutover
      EXCEPT (SELECT 'paid',id FROM public.commerce_settlement_transitions
        UNION ALL SELECT 'handoff',id FROM public.fulfillment_shipment_operations)`)).rows).toEqual([]);
    expect((await seed.query(`(SELECT 'paid' AS source_kind,id FROM public.commerce_settlement_transitions
      UNION ALL SELECT 'handoff',id FROM public.fulfillment_shipment_operations)
      EXCEPT SELECT source_kind,source_id FROM public.invoicing_cutover`)).rows).toEqual([]);
    expect((await seed.query(`SELECT relation::regclass::text FROM pg_locks
      WHERE pid=pg_backend_pid() AND relation IN ('public.commerce_orders'::regclass,
      'public.accounting_documents'::regclass,'public.accounting_document_requests'::regclass)`)).rows).toEqual([]);
    await writer.query("BEGIN; SET LOCAL statement_timeout='1000ms'");
    await writer.query("UPDATE public.commerce_orders SET updated_at=updated_at WHERE id=$1",[h.witness.order]);
  } finally {await writer.query("ROLLBACK");await seed.query("ROLLBACK");writer.release();seed.release();}

  const routines=(await h.pool.query("SELECT oid,prosecdef,proconfig,proacl FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'invoicing_%'")).rows;
  expect(routines.length).toBe(15);
  for(const routine of routines) {
    expect(routine.prosecdef).toBe(false);expect(routine.proconfig).toEqual(["search_path=pg_catalog"]);
    expect((await h.pool.query("SELECT has_function_privilege('anon',$1::oid,'EXECUTE') anon,has_function_privilege('authenticated',$1::oid,'EXECUTE') authenticated",[routine.oid])).rows).toEqual([{anon:false,authenticated:false}]);
  }
  const db=await h.pool.connect();try{await db.query("SET ROLE anon");await expect(call(db,"invoicing_sweep_duties",[1])).rejects.toMatchObject({code:"42501"});}finally{await db.query("RESET ROLE");db.release();}
});

it("two claimants fence generations and unknown outcomes require exact readback or authoritative absence",async()=>{
  const f=await duty();
  const source=randomUUID(), key=`  exact host key ${randomUUID()}  `;
  expect(await call(h.pool,"invoicing_capture_duty",[key,"handoff",source,f.order,{shipment:"opaque"},f.input.occurredAt])).toMatchObject({dutyId:f.duty});
  const alternateZone=await h.pool.connect();try {
    await alternateZone.query("SET TIMEZONE='UTC+03'");
    expect(await call(alternateZone,"invoicing_capture_duty",[key,"handoff",source,f.order,{shipment:"opaque"},f.input.occurredAt])).toMatchObject({dutyId:f.duty});
  }finally{await alternateZone.query("RESET TIMEZONE");alternateZone.release();}
  await expect(call(h.pool,"invoicing_capture_duty",[key,"handoff",source,f.order,{shipment:"conflict"},f.input.occurredAt])).rejects.toMatchObject({code:"23505"});
  expect(await call(h.pool,"invoicing_install_facts",[f.duty,facts(),"facts-v1"])).toMatchObject({replayed:true});
  await expect(call(h.pool,"invoicing_install_facts",[f.duty,{...facts(),buyer:{name:"changed"}},"facts-v1"])).rejects.toMatchObject({code:"23505"});
  const results=await Promise.all([call(h.pool,"invoicing_claim_duties",[100,300,"fixture"]),call(h.pool,"invoicing_claim_duties",[100,300,"fixture"])]);
  const claims=results.flat().filter(row=>row.id===f.duty);expect(claims).toHaveLength(1);const old=claims[0];
  expect(await call(h.pool,"invoicing_preflight_duty",[old.id,old.claim_token,old.generation,{kind:"observed",amountMinor:901,currency:"XXX",outcome:"captured"}])).toEqual({kind:"mismatch"});
  await expect(finish({...old,generation:old.generation+1},"bad")).rejects.toThrow();
  await h.pool.query("UPDATE public.invoicing_duties SET lease_until=now()-interval '1 second' WHERE id=$1",[f.duty]);
  const current=await claim(f.duty);expect(current.generation).toBe(old.generation+1);expect(current.last_result).toEqual({action:"readback"});
  expect(await call(h.pool,"invoicing_fail_duty",[old.id,old.claim_token,old.generation,"retryable",{phase:"before_send"},0])).toEqual({kind:"stale"});
  expect(await call(h.pool,"invoicing_finish_issue",[old.id,old.claim_token,old.generation,"stale",null,proof(old.id,"stale")])).toEqual({kind:"stale"});
  expect(await call(h.pool,"invoicing_fail_duty",[current.id,current.claim_token,current.generation,"retryable",{phase:"before_send"},0])).toEqual({kind:"retryable"});
  expect((await h.pool.query("SELECT status FROM public.invoicing_duties WHERE id=$1",[f.duty])).rows).toEqual([{status:"unknown"}]);
  const readback=await claim(f.duty);expect(readback.last_result.action).toBe("readback");
  expect(await finish(readback,`recovered-${f.order}`,"readback_found")).toEqual({kind:"issued",replayed:false});
  expect((await h.pool.query("SELECT claim_token,attempts,status FROM public.accounting_document_requests WHERE id=$1",[readback.request_id])).rows).toEqual([{claim_token:null,attempts:readback.generation,status:"succeeded"}]);
  {
    const f=await duty();
  const row=await claim(f.duty);
  expect(await call(h.pool,"invoicing_request_reversal",[`reverse-${f.order}`,f.order,"order_refunded",{}])).toEqual({kind:"pending_readback"});
  await h.pool.query(`CREATE FUNCTION public.m09_compensation_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.correction_of_document_id IS NOT NULL THEN RAISE EXCEPTION 'synthetic_compensation_fault'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER m09_compensation_fault BEFORE INSERT ON public.accounting_documents FOR EACH ROW EXECUTE FUNCTION public.m09_compensation_fault();`);
  try {
    await expect(finish(row,`invoice-${f.order}`)).rejects.toThrow("synthetic_compensation_fault");
    expect((await h.pool.query("SELECT provider_reference FROM public.accounting_documents WHERE id=$1",[row.document_id])).rows).toEqual([{provider_reference:null}]);
    expect((await h.pool.query("SELECT receipt_key FROM public.invoicing_effect_receipts WHERE receipt_key=$1",[`issue:${f.duty}`])).rows).toEqual([]);
  } finally {await h.pool.query("DROP TRIGGER m09_compensation_fault ON public.accounting_documents; DROP FUNCTION public.m09_compensation_fault()");}
  expect(await finish(row,`invoice-${f.order}`)).toEqual({kind:"issued",replayed:false});
  const children=(await h.pool.query("SELECT * FROM public.invoicing_duties WHERE parent_duty_id=$1",[f.duty])).rows;expect(children).toHaveLength(1);
  expect(await call(h.pool,"invoicing_request_reversal",[`reverse-alias-${f.order}`,f.order,"order_refunded",{}])).toMatchObject({replayed:true,dutyId:children[0].id});
  const correction=await claim(children[0].id);await preflight(correction);
  expect(correction.facts.before.lines).toEqual(facts().lines);expect(correction.facts.after.totalGrossMinor).toBe(0);
  expect((await h.pool.query("SELECT total_gross_minor FROM public.accounting_document_positions WHERE document_id=$1",[children[0].document_id])).rows).toEqual([{total_gross_minor:"-900"}]);
  const correctionProof={...proof(correction.id,`correction-${f.order}`),parentExternalId:`invoice-${f.order}`};
  await expect(call(h.pool,"invoicing_finish_correction",[correction.id,correction.claim_token,correction.generation,`correction-${f.order}`,null,{...correctionProof,parentExternalId:"wrong"}])).rejects.toMatchObject({code:"22023"});
  expect(await call(h.pool,"invoicing_finish_correction",[correction.id,correction.claim_token,correction.generation,`correction-${f.order}`,null,correctionProof])).toMatchObject({replayed:false});
  expect(await call(h.pool,"invoicing_finish_correction",[correction.id,correction.claim_token,correction.generation,`correction-${f.order}`,null,correctionProof])).toMatchObject({replayed:true});
  expect((await h.pool.query("SELECT status FROM public.accounting_documents WHERE id=$1",[row.document_id])).rows).toEqual([{status:"corrected"}]);
  }

});

it("missing/unsafe fiscal facts stay document-only and pre-submit void plus authoritative absence never duplicate creates",async()=>{
  const f=await paymentFixture();await owe(f);
  const id=(await h.pool.query("SELECT id FROM public.invoicing_duties WHERE order_id=$1",[f.order])).rows[0].id;
  expect(await call(h.pool,"invoicing_install_facts",[id,{},"missing"])).toMatchObject({status:"blocked"});
  expect(await call(h.pool,"invoicing_duty_readback",[f.order])).toMatchObject({duties:[{state:"blocked",diagnosticCode:"missing_facts"}]});
  expect(await call(h.pool,"invoicing_duty_readback",[randomUUID()])).toMatchObject({duties:[]});
  // D#6: latest per (kind, source), including terminal and resolved receipts.
  const source=randomUUID();
  await h.pool.query(`INSERT INTO public.invoicing_capture_faults(order_id,source_kind,source_id,attempts,state,available_at,recorded_at)
    VALUES($1,'paid',$2,1,'retryable',now(),'2026-10-21'),
      ($1,'paid',$2,2,'faulted','infinity','2026-10-22'),
      ($1,'handoff',$2,3,'retryable',now(),'2026-10-23')`,[f.order,source]);
  expect((await rpc(h.pool,"invoicing_duty_readback",[f.order])).captureFaults).toEqual([
    {sourceId:source,state:"faulted",attempts:2,availableAt:"infinity"},
    {sourceId:source,state:"retryable",attempts:3,availableAt:expect.any(String)},
  ]);
  await h.pool.query("INSERT INTO public.invoicing_effect_receipts(receipt_key,duty_id,payload) VALUES($1,$2,'{}')",[`source:paid:${source}`,id]);
  expect((await rpc(h.pool,"invoicing_duty_readback",[f.order])).captureFaults).toEqual([
    {sourceId:source,state:"resolved",attempts:2,availableAt:"infinity"},
    {sourceId:source,state:"retryable",attempts:3,availableAt:expect.any(String)},
  ]);

  const unsafe=facts();unsafe.lines[0].unitGrossMinor=9007199254740992;
  await expect(call(h.pool,"invoicing_install_facts",[id,unsafe,"unsafe"])).rejects.toMatchObject({code:"22023"});
  const widerRailRate=facts();widerRailRate.lines[0].taxRateBps=50000;
  await expect(call(h.pool,"invoicing_install_facts",[id,widerRailRate,"unsupported-rate"])).rejects.toMatchObject({code:"22023"});
  expect((await h.pool.query("SELECT * FROM public.accounting_documents WHERE order_id=$1",[f.order])).rows).toEqual([]);
  await call(h.pool,"invoicing_install_facts",[id,facts(),"valid"]);
  expect(await call(h.pool,"invoicing_request_reversal",[`void-${f.order}`,f.order,"local cancellation",{}])).toMatchObject({kind:"voided"});
  expect(await call(h.pool,"invoicing_request_reversal",[`void-${f.order}`,f.order,"local cancellation",{}])).toMatchObject({kind:"voided",replayed:true});
  // C#2: a stored reversal closes a proven unsubmitted/absent create,
  // but retryable readback remains unknown until authoritative evidence arrives.
  for(const beforeSend of [true,false]) {
    const reversed=await duty();let pending=await claim(reversed.duty);
    expect(await rpc(h.pool,"invoicing_request_reversal",[`stored-${reversed.order}`,reversed.order,"order_refunded",{}])).toEqual({kind:"pending_readback"});
    if(!beforeSend) {
      await rpc(h.pool,"invoicing_fail_duty",[pending.id,pending.claim_token,pending.generation,"unknown",{phase:"after_send"},0]);
      pending=await claim(reversed.duty);expect(pending.last_result.action).toBe("readback");
      expect(await rpc(h.pool,"invoicing_fail_duty",[pending.id,pending.claim_token,pending.generation,"retryable",{phase:"before_send"},0])).toEqual({kind:"retryable"});
      expect((await h.pool.query("SELECT status FROM public.invoicing_duties WHERE id=$1",[pending.id])).rows).toEqual([{status:"unknown"}]);
      pending=await claim(reversed.duty);
    }
    expect(await rpc(h.pool,"invoicing_fail_duty",[pending.id,pending.claim_token,pending.generation,beforeSend?"retryable":"absent",
      beforeSend?{phase:"before_send"}:{kind:"authoritative_absence",providerCreateIdentity:`invoicing:${pending.id}`},0])).toEqual({kind:"voided"});
    expect((await h.pool.query(`SELECT d.status duty,a.status document,r.status request,r.available_at::text,
      d.claim_token,d.lease_until FROM public.invoicing_duties d
      JOIN public.accounting_documents a ON a.id=d.document_id
      JOIN public.accounting_document_requests r ON r.id=d.request_id WHERE d.id=$1`,[pending.id])).rows)
      .toEqual([{duty:"voided",document:"voided",request:"discarded",available_at:"infinity",claim_token:null,lease_until:null}]);
    expect(await rpc(h.pool,"invoicing_claim_duties",[1,300,"fixture",reversed.order])).toEqual([]);
    expect((await h.pool.query("SELECT id FROM public.invoicing_duties WHERE parent_duty_id=$1",[pending.id])).rows).toEqual([]);
  }
  const issued=await paymentFixture();await owe(issued);
  const old=await call(h.pool,"accounting_document_request_from_paid_order",[`legacy-native-${issued.order}`,issued.order,JSON.stringify(facts().lines),900,{neutralFacts:facts(),currency:"XXX"}]);
  await call(h.pool,"accounting_document_advance",[`legacy-issued-${issued.order}`,old.document.id,"issued","legacy-fiscal",{}]);
  const oldRow=(await h.pool.query("SELECT * FROM public.accounting_documents WHERE id=$1",[old.document.id])).rows;
  const owed=(await h.pool.query("SELECT id FROM public.invoicing_duties WHERE order_id=$1",[issued.order])).rows[0].id;
  expect(await call(h.pool,"invoicing_install_facts",[owed,facts(),"legacy-matched"])).toMatchObject({status:"issued"});
  expect((await call(h.pool,"invoicing_claim_duties",[100,300,"fixture"])).filter((r:{id:string})=>r.id===owed)).toEqual([]);
  expect((await h.pool.query("SELECT * FROM public.accounting_documents WHERE id=$1",[old.document.id])).rows).toEqual(oldRow);
  const other=await duty();let row=await claim(other.duty);
  await call(h.pool,"invoicing_fail_duty",[row.id,row.claim_token,row.generation,"unknown",{phase:"after_send"},0]);
  row=await claim(other.duty);expect(row.last_result.action).toBe("readback");
  await expect(call(h.pool,"invoicing_fail_duty",[row.id,row.claim_token,row.generation,"absent",{kind:"authoritative_absence",providerCreateIdentity:"wrong"},0])).rejects.toMatchObject({code:"22023"});
  await call(h.pool,"invoicing_fail_duty",[row.id,row.claim_token,row.generation,"absent",{kind:"authoritative_absence",providerCreateIdentity:`invoicing:${row.id}`},0]);
  row=await claim(other.duty);expect(row.last_result.action).toBe("create");await finish(row,`after-absence-${other.order}`);
  const delivery=randomUUID();await h.pool.query("INSERT INTO public.accounting_document_deliveries(id,document_id,channel,recipient_reference) VALUES($1,$2,'receipt','recipient:opaque')",[delivery,row.document_id]);
  const send=(await call(h.pool,"invoicing_claim_deliveries",[100,300,false])).find((r:{delivery_id:string})=>r.delivery_id===delivery);
  const settle=[delivery,send.claim_token,send.generation,"sent","transport:receipt",{phase:"after_send"}];
  expect(await call(h.pool,"invoicing_settle_delivery",settle)).toEqual({kind:"sent",replayed:false});
  const before=(await h.pool.query("SELECT * FROM public.accounting_document_delivery_attempts WHERE delivery_id=$1",[delivery])).rows;
  expect(await call(h.pool,"invoicing_settle_delivery",settle)).toEqual({kind:"sent",replayed:true});
  expect((await h.pool.query("SELECT * FROM public.accounting_document_delivery_attempts WHERE delivery_id=$1",[delivery])).rows).toEqual(before);
  const unrelatedDelivery=randomUUID();
  const another=await duty(),anotherRow=await claim(another.duty);await finish(anotherRow,`delivery-scope-${another.order}`);
  await h.pool.query("INSERT INTO public.accounting_document_deliveries(id,document_id,channel,recipient_reference,created_at) VALUES($1,$2,'scoped','recipient:opaque','2000-01-01')",[unrelatedDelivery,anotherRow.document_id]);
  const targeted=randomUUID();await h.pool.query("INSERT INTO public.accounting_document_deliveries(id,document_id,channel,recipient_reference) VALUES($1,$2,'scoped','recipient:opaque')",[targeted,row.document_id]);
  const deliveryClaimant=await h.pool.connect(),deliveryObserver=await h.pool.connect();
  try {
    await deliveryClaimant.query("BEGIN");
    const targetedRows=await rpc(deliveryClaimant,"invoicing_claim_deliveries",[1,300,false,other.order]);
    expect(targetedRows).toHaveLength(1);expect(targetedRows[0].delivery_id).toBe(targeted);
    await deliveryObserver.query("SELECT id FROM public.accounting_document_deliveries WHERE id=$1 FOR UPDATE NOWAIT",[unrelatedDelivery]);
    expect((await h.pool.query("SELECT * FROM public.invoicing_delivery_receipts WHERE delivery_id=$1",[unrelatedDelivery])).rows).toEqual([]);
  } finally {await deliveryClaimant.query("ROLLBACK");deliveryClaimant.release();deliveryObserver.release();}
  const unrelated=await duty(),target=await duty();
  await h.pool.query("UPDATE public.accounting_document_requests SET created_at='2000-01-01' WHERE document_id=(SELECT document_id FROM public.invoicing_duties WHERE id=$1)",[unrelated.duty]);
  const snapshot=async()=> (await h.pool.query(`SELECT to_jsonb(d) duty,to_jsonb(r) request
    FROM public.invoicing_duties d JOIN public.accounting_document_requests r ON r.id=d.request_id
    WHERE d.id=$1`,[unrelated.duty])).rows;
  const scopedBefore=await snapshot();
  const claimant=await h.pool.connect(),observer=await h.pool.connect();
  try {
    await claimant.query("BEGIN");await claimant.query("SET LOCAL statement_timeout='1500ms'");
    const rows=await rpc(claimant,"invoicing_claim_duties",[1,300,"fixture",target.order]);
    expect(rows).toHaveLength(1);expect(rows[0].id).toBe(target.duty);
    await observer.query("BEGIN");
    await observer.query("SELECT 1 FROM public.accounting_document_requests r JOIN public.invoicing_duties d ON d.request_id=r.id WHERE d.id=$1 FOR UPDATE OF r,d NOWAIT",[unrelated.duty]);
    await observer.query("ROLLBACK");
    await claimant.query("COMMIT");
    expect(await snapshot()).toEqual(scopedBefore);
  } finally { await claimant.query("ROLLBACK");await observer.query("ROLLBACK");claimant.release();observer.release(); }

});


async function waitForLock(pid:number) {
  const deadline=performance.now()+1500;
  while(performance.now()<deadline) {
    if((await h.pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.wait_event_type==="Lock")return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error("Expected accounting/claim lock wait was not observed");
}
it("D7 dispatch locks the SAME renewal order while leased accounting work is in flight, then stale marks refuse",async()=>{
  const f=await shipmentFixture(h.pool);
  await h.pool.query("UPDATE public.commerce_orders SET paid_at=now() WHERE id=$1",[f.order]);
  const captured=await call(h.pool,"invoicing_capture_duty",[`d7-${f.order}`,"paid",randomUUID(),f.order,{},new Date().toISOString()]);
  const row=(await h.pool.query("SELECT total_amount_minor,currency_code FROM public.commerce_orders WHERE id=$1",[f.order])).rows[0];
  const fiscal={...facts(),currency:row.currency_code,totalGrossMinor:Number(row.total_amount_minor),totalNetMinor:Number(row.total_amount_minor),totalTaxMinor:0,lines:[{...facts().lines[0],unitGrossMinor:Number(row.total_amount_minor),unitNetMinor:Number(row.total_amount_minor),totalGrossMinor:Number(row.total_amount_minor),totalNetMinor:Number(row.total_amount_minor),totalTaxMinor:0,taxRateBps:0}]};
  await rpc(h.pool,"invoicing_install_facts",[captured.dutyId,fiscal,"d7-facts"]);
  const leases=await rpc(h.pool,"invoicing_sweep_duties",[100]);const lease=leases.claims.find((item:{dutyId:string})=>item.dutyId===captured.dutyId);
  const locker=await h.pool.connect(), worker=await h.pool.connect(), dispatch=await h.pool.connect();
  let pending:ReturnType<typeof rpc>|undefined;
  const evidence={commandFingerprint:"d".repeat(64),contactRevision:{schemaVersion:1,source:"fixture",revision:1},providerRef:"warehouse-a",carrierRef:null,serviceRef:null};
  await h.pool.query("INSERT INTO public.fulfillment_dispatch_contexts(shipment_id,contact_revision,provider_ref) VALUES($1,$2,'warehouse-a')",[f.shipment,evidence.contactRevision]);
  const before=(await h.pool.query("SELECT (SELECT to_jsonb(s) FROM public.subscriptions s WHERE id=$1) subscription,(SELECT to_jsonb(c) FROM public.subscription_cycles c WHERE id=$2) cycle,(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.commerce_order_holds x WHERE order_id=$3) holds",[f.subscription,f.cycle,f.order])).rows;
  try {
    await locker.query("BEGIN; LOCK TABLE public.accounting_documents IN ACCESS EXCLUSIVE MODE");
    const pid=(await worker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    pending=rpc(worker,"invoicing_prepare_facts",[lease.dutyId,lease.token]);await waitForLock(pid);
    expect((await h.pool.query("SELECT mode FROM pg_locks WHERE pid=$1 AND relation='public.commerce_orders'::regclass",[pid])).rows).toEqual([]);
    await dispatch.query("BEGIN");
    await dispatch.query("SELECT id FROM public.invoicing_duties WHERE id=$1 FOR UPDATE NOWAIT",[lease.dutyId]);
    await dispatch.query("SELECT id FROM public.commerce_orders WHERE id=$1 FOR NO KEY UPDATE NOWAIT",[f.order]);
    await dispatch.query("COMMIT");
    await dispatch.query("SET statement_timeout='1000ms'");
    const store=createPostgresFulfillmentDispatchStore(executor(dispatch),{async prepare(){return {disposition:"ready",contactRevision:1};},async readCandidate(){return null;}});
    const result=await store.claim({requestKey:`dispatch-d7-${f.shipment}`,fulfillmentRef:f.shipment,orderRef:f.order,parcelRef:null,mode:"live",evidence});
    expect(result.kind).toBe("claimed");if(result.kind!=="claimed")throw new Error("Dispatch refused");
    expect(await store.begin({dispatchRef:result.record.dispatchRef,commandFingerprint:evidence.commandFingerprint})).toMatchObject({kind:"begun",begun:true});
    const outcome=await pending;expect(outcome).toEqual({status:"owed",kind:"retryable"});
    expect(await rpc(h.pool,"invoicing_finish_facts",[lease.dutyId,randomUUID(),outcome])).toEqual({status:"stale"});
    expect(await rpc(h.pool,"invoicing_finish_facts",[lease.dutyId,lease.token,outcome])).toMatchObject({status:"owed"});
  } finally {await locker.query("ROLLBACK");await pending;await dispatch.query("RESET statement_timeout");locker.release();worker.release();dispatch.release();}
  expect((await h.pool.query("SELECT (SELECT to_jsonb(s) FROM public.subscriptions s WHERE id=$1) subscription,(SELECT to_jsonb(c) FROM public.subscription_cycles c WHERE id=$2) cycle,(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM public.commerce_order_holds x WHERE order_id=$3) holds",[f.subscription,f.cycle,f.order])).rows).toEqual(before);
});

it("B1 keyed cutover excludes 20000 historic paid AND handoff sources and collects only post-cutover sources below two seconds",async()=>{
  expect((await h.pool.query("SELECT source_kind,count(*)::integer n FROM public.invoicing_cutover GROUP BY source_kind ORDER BY source_kind")).rows)
    .toEqual([{source_kind:"handoff",n:20000},{source_kind:"paid",n:expect.toSatisfy((n:number)=>n>=20000)}]);
  const paid=await paymentFixture(), handoff=await shipmentFixture(h.pool);
  await call(h.pool,"commerce_record_settlement",[`scale-post-${paid.intent}`,paid.intent,"succeeded",null,{},paid.input.occurredAt]);
  const source=randomUUID();
  await h.pool.query("UPDATE public.fulfillment_shipments SET handed_over_at=now() WHERE id=$1",[handoff.shipment]);
  await h.pool.query(`INSERT INTO public.fulfillment_shipment_operations(id,shipment_id,order_id,operation_type,idempotency_key,payload)
    VALUES($1,$2,$3,'shipment_advanced',$4,'{"toStatus":"handed_over"}')`,[source,handoff.shipment,handoff.order,`scale-post-${source}`]);
  await h.pool.query("ANALYZE public.invoicing_cutover; ANALYZE public.commerce_settlement_transitions; ANALYZE public.fulfillment_shipment_operations");
  const at=performance.now();
  const rows=(await h.pool.query("SELECT * FROM public.invoicing_due_sources")).rows;
  expect(rows.filter(row=>row.order_id===paid.order)).toHaveLength(1);
  expect(rows.filter(row=>row.order_id===handoff.order)).toHaveLength(1);
  expect(rows.filter(row=>[h.historicUninvoicedOrder,h.witness.order].includes(row.order_id))).toEqual([]);
  const plan=(await h.pool.query("EXPLAIN (ANALYZE,FORMAT JSON) SELECT * FROM public.invoicing_due_sources")).rows[0]["QUERY PLAN"];
  console.log(`M09 B1 EXPLAIN ${JSON.stringify(plan)}`);
  const swept=await createPostgresInvoiceStore(executor(h.pool)).sweep(100);
  if ("kind" in swept) throw new Error("Native sweep unavailable");
  const elapsed=performance.now()-at;
  console.log(`M09 B1 view+explain+sweep ms=${Math.round(elapsed)} collected=${swept.collected}`);
  expect(elapsed).toBeLessThan(2000);
  expect((await h.pool.query("SELECT order_id FROM public.invoicing_duties WHERE order_id=ANY($1::uuid[]) ORDER BY order_id",[[paid.order,handoff.order]])).rows.map(row=>row.order_id).sort()).toEqual([paid.order,handoff.order].sort());
  expect((await h.pool.query("SELECT id FROM public.invoicing_duties WHERE order_id=ANY($1::uuid[])",[[h.historicUninvoicedOrder,h.witness.order]])).rows).toEqual([]);
  expect(await createPostgresInvoiceStore(executor(h.pool)).readDuties(paid.order)).toMatchObject({duties:[{state:"owed",factAttempts:0}]});
  expect((await h.pool.query("SELECT duty_id FROM public.invoicing_fact_revisions WHERE duty_id IN (SELECT id FROM public.invoicing_duties WHERE order_id=$1)",[paid.order])).rows).toEqual([]);
  const discovered=await createPostgresInvoiceStore(executor(h.pool)).discoverDuties(100);
  const paidDuty=(await h.pool.query("SELECT id FROM public.invoicing_duties WHERE order_id=$1",[paid.order])).rows[0].id;
  expect(discovered).toEqual(expect.arrayContaining([{dutyId:paidDuty,orderId:paid.order}]));
  const beforeDiscovery=(await h.pool.query("SELECT to_jsonb(d) row,xmin::text FROM public.invoicing_duties d WHERE id=$1",[paidDuty])).rows;
  expect(await createPostgresInvoiceStore(executor(h.pool)).discoverDuties(100)).toEqual(discovered);
  expect((await h.pool.query("SELECT to_jsonb(d) row,xmin::text FROM public.invoicing_duties d WHERE id=$1",[paidDuty])).rows).toEqual(beforeDiscovery);
  // F1: unavailable facts in a full page must not hide later owed work. Keep
  // all 101 captured duties unprepared and traverse the stable UUID cursor.
  const backlog: string[]=[];
  for(let n=0;n<101;n++) backlog.push((await owe(await paymentFixture())).dutyId);
  const missingBefore=(await h.pool.query("SELECT to_jsonb(d) row,xmin::text FROM public.invoicing_duties d WHERE id=ANY($1::uuid[]) ORDER BY id",[backlog])).rows;
  const pages: string[][]=[];let after: string|null=null;
  for(let n=0;n<4;n++) {
    const page=await createPostgresInvoiceStore(executor(h.pool)).discoverDuties(100,after);
    pages.push(page.map(target=>target.dutyId));
    if(page.length===0)break;
    after=page.at(-1)!.dutyId;
  }
  expect(pages[0]).toHaveLength(100);expect(pages.at(-1)).toEqual([]);
  const discoveredIds=pages.flat();expect(new Set(discoveredIds).size).toBe(discoveredIds.length);
  expect(discoveredIds).toEqual(expect.arrayContaining(backlog));
  expect((await h.pool.query("SELECT to_jsonb(d) row,xmin::text FROM public.invoicing_duties d WHERE id=ANY($1::uuid[]) ORDER BY id",[backlog])).rows).toEqual(missingBefore);
  const timeoutSource=await paymentFixture();
  const tx=await h.pool.connect();try {
    await tx.query("BEGIN; SET LOCAL lock_timeout='2345ms'");
    await rpc(tx,"commerce_record_settlement",[`timeout-source-${timeoutSource.intent}`,timeoutSource.intent,"succeeded",null,{},timeoutSource.input.occurredAt]);
    expect((await rpc(tx,"invoicing_sweep_duties",[100])).collected).toBeGreaterThan(0);
    expect((await tx.query("SHOW lock_timeout")).rows).toEqual([{lock_timeout:"2345ms"}]);
    await tx.query("ROLLBACK");
  }finally{await tx.query("ROLLBACK");tx.release();}
});

it("incumbent claimer cannot see M09 pending, expired processing, failed or correction requests; drift and blocked work stay fenced",async()=>{
  const f=await paymentFixture();await owe(f);
  const id=(await h.pool.query("SELECT id FROM public.invoicing_duties WHERE order_id=$1",[f.order])).rows[0].id;
  await rpc(h.pool,"invoicing_install_facts",[id,facts(),"incumbent"]);
  const lease=(await rpc(h.pool,"invoicing_sweep_duties",[100])).claims.find((v:{dutyId:string})=>v.dutyId===id);
  const outcome=await rpc(h.pool,"invoicing_prepare_facts",[id,lease.token]);
  const incumbent=async()=> {
    const rows=(await h.pool.query("SELECT * FROM public.accounting_document_queue_claim(ARRAY['issue','correction'],100,30,20)")).rows;
    expect(rows.filter(row=>row.document_id===outcome.documentId)).toEqual([]);
    expect((await h.pool.query("SELECT available_at::text FROM public.accounting_document_requests WHERE document_id=$1",[outcome.documentId])).rows).toEqual([{available_at:"infinity"}]);
  };
  await incumbent();
  await rpc(h.pool,"invoicing_finish_facts",[id,lease.token,outcome]);
  let row=await claim(id);await h.pool.query("UPDATE public.invoicing_duties SET lease_until=now()-interval '1 second' WHERE id=$1",[id]);
  await incumbent();row=await claim(id);
  await rpc(h.pool,"invoicing_fail_duty",[id,row.claim_token,row.generation,"blocked",{},0]);
  await incumbent();
  const snapshot=(await h.pool.query("SELECT * FROM public.invoicing_duties WHERE id=$1",[id])).rows;
  await call(h.pool,"invoicing_sweep_duties",[100]);
  expect((await h.pool.query("SELECT * FROM public.invoicing_duties WHERE id=$1",[id])).rows).toEqual(snapshot);
  expect(await rpc(h.pool,"invoicing_prepare_facts",[id,lease.token])).toEqual({status:"stale"});
  expect(await rpc(h.pool,"invoicing_finish_facts",[id,lease.token,outcome])).toEqual({status:"stale"});
  expect(await rpc(h.pool,"invoicing_duty_readback",[f.order])).toMatchObject({duties:[{state:"blocked",diagnosticCode:"blocked"}]});
  const local=await paymentFixture();await owe(local);
  const localPort=createPostgresAccountingPaidOrderDocumentPort(executor(h.pool));
  const localRequest={idempotencyKey:`local-${local.order}`,orderId:local.order,providerKind:"fixture"};
  const localFirst=await localPort.requestInvoiceIssueFromPaidOrder(localRequest);
  expect(await localPort.requestInvoiceIssueFromPaidOrder(localRequest)).toEqual({invoice:{...localFirst.invoice,replayed:true}});
  expect((await h.pool.query("SELECT tax_rate_bps FROM public.accounting_document_positions WHERE document_id=$1",[localFirst.invoice.id])).rows).toEqual([{tax_rate_bps:0}]);
  const actual=await duty(), native=createPostgresInvoiceStore(executor(h.pool));
  const claims=await native.claim({limit:1,visibilitySeconds:300,providerRef:"fixture",orderId:actual.order});
  if(!Array.isArray(claims)||claims.length!==1)throw new Error("Native store claim missing");
  const selected=claims[0];expect(selected.identity.requestKey).toBe(`duty-${actual.order}`);
  expect(await native.preflight({claim:selected,status:"succeeded",amountMinor:900,currency:"XXX",proof:null})).toEqual({kind:"ready"});
  const remoteProof={evidenceRef:"synthetic",fingerprint:"a".repeat(64),observedAt:"2026-10-22T12:00:00Z"};
  expect(await native.finish({claim:selected,result:{kind:"issued",identity:selected.identity,providerDocumentRef:`actual-${actual.order}`,providerDocumentNumber:null,proof:remoteProof,replayed:false}})).toEqual({kind:"issued",replayed:false});
  // Native binding: readback -> absent -> create -> fresh mismatch must settle
  // blocked, rather than reclaiming the same mismatched create indefinitely.
  const bound=await duty(), nativeStore=createPostgresInvoiceStore(executor(h.pool));
  const first=await claim(bound.duty);
  await rpc(h.pool,"invoicing_fail_duty",[first.id,first.claim_token,first.generation,"unknown",{},0]);
  const io: string[]=[];
  let lookup: "absent" | "found" | "unknown"="unknown", fresh: "ready" | "mismatch" | "unavailable"="ready";
  const run=()=>runNativeInvoiceIssueJob({ store:nativeStore,providerRef:"fixture",orderId:bound.order,
    readLocalPayment:async()=>({kind:"unavailable",code:"money_unavailable"}),
    money:{read:async()=>{io.push("money");return fresh==="unavailable"?{kind:"unavailable",code:"money_unavailable"}
      :{kind:"observed",status:"succeeded",amountMinor:fresh==="mismatch"?901:900,currency:"XXX",proof:remoteProof};}},
    provider:{issue:async input=>{io.push("issue");return {kind:"issued",identity:input.identity,providerDocumentRef:"bound-remote",providerDocumentNumber:null,proof:remoteProof,replayed:false};},
      correct:async()=>{throw new Error("unexpected correction");},
      read:async identity=>{io.push("read");return lookup==="absent"?{kind:"absent",identity,evidence:{...remoteProof,exact:true,complete:true,scope:identity}}
        :lookup==="found"?{kind:"found",identity,providerDocumentRef:"bound-remote",providerDocumentNumber:null,proof:remoteProof}:{kind:"unknown",identity,code:"unknown"};}} });
  expect(await run()).toMatchObject({updated:0,failures:1});expect(io).toEqual(["read"]);
  await h.pool.query("UPDATE public.invoicing_duties SET available_at=now() WHERE id=$1",[bound.duty]);
  lookup="absent";expect(await run()).toMatchObject({updated:0});expect(io).toEqual(["read","read"]);
  await h.pool.query("UPDATE public.invoicing_duties SET available_at=now() WHERE id=$1",[bound.duty]);
  fresh="mismatch";expect(await run()).toMatchObject({updated:0,failures:1});expect(io).toEqual(["read","read","money"]);
  expect((await h.pool.query("SELECT status,claim_token,lease_until FROM public.invoicing_duties WHERE id=$1",[bound.duty])).rows)
    .toEqual([{status:"blocked",claim_token:null,lease_until:null}]);
  expect(await run()).toMatchObject({checked:0});

  const unavailable=await duty();
  const notReady=await runNativeInvoiceIssueJob({store:nativeStore,providerRef:"fixture",orderId:unavailable.order,
    readLocalPayment:async()=>({kind:"unknown",code:"money_unavailable"}),money:{read:async()=>({kind:"unavailable",code:"money_unavailable"})},
    provider:{issue:async()=>{throw new Error("must not dispatch");},correct:async()=>{throw new Error("must not correct");},read:async()=>{throw new Error("must not readback");}}});
  expect(notReady).toMatchObject({updated:0,failures:1});
  expect((await h.pool.query("SELECT status,claim_token,lease_until,last_result FROM public.invoicing_duties WHERE id=$1",[unavailable.duty])).rows)
    .toEqual([{status:"ready",claim_token:null,lease_until:null,last_result:{kind:"retryable",evidence:{phase:"before_send",proof:null}}}]);
  const drift=await duty();await h.pool.query("UPDATE public.accounting_document_requests SET attempts=attempts+1 WHERE id=(SELECT request_id FROM public.invoicing_duties WHERE id=$1)",[drift.duty]);
  expect(await rpc(h.pool,"invoicing_claim_duties",[1,300,"fixture",drift.order])).toEqual([]);
  expect(await rpc(h.pool,"invoicing_duty_readback",[drift.order])).toMatchObject({duties:[{state:"unsupported",diagnosticCode:"unsupported"}]});
  const base=await duty();await finish(await claim(base.duty),`incumbent-parent-${base.order}`);
  const child=await rpc(h.pool,"invoicing_request_reversal",[`incumbent-child-${base.order}`,base.order,"order_refunded",{}]);
  const childRequest=(await h.pool.query("SELECT request_id FROM public.invoicing_duties WHERE id=$1",[child.dutyId])).rows[0].request_id;
  expect((await h.pool.query("SELECT * FROM public.accounting_document_queue_claim(ARRAY['correction'],100,30,20)")).rows.map(row=>row.id)).not.toContain(childRequest);
});
