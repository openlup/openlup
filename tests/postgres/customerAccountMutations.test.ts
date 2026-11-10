import { randomUUID } from "node:crypto";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createPostgresCustomerAccountMutationPort, createCustomerAccountMutationSchemas, createSelfServiceCommandFacade, createAccountEventPrivacyContributor } from "@openlup/platform/account-support";
import { createPostgresPrivacyStore, createIdentityPersonalDataContributor, createPersonalDataContributorRegistry, createPrivacyOperations } from "@openlup/platform/identity";
import type { PrivacyJson } from "@openlup/platform/identity/contracts";
import type { AccountSupportCapabilities } from "@openlup/platform/account-support/contracts";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { installAccountMutations, type AccountProfile } from "./customerAccountMutations.fixture.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
const AT = "2026-11-10T12:00:00.000Z";
const policy = { key: { min: 8, max: 180 }, name: { min: 2, max: 80 }, phone: { callingCode: "99", localDigits: 9 }, correction: { reasonMin: 8, reasonMax: 500, fieldsMax: 20, fieldMax: 80, noteMax: 240 } };
const schemas = createCustomerAccountMutationSchemas(policy);
const capabilities: AccountSupportCapabilities = {
  graph: "native", accountRead: { supported: false, refusalCode: "host_binding_required" }, customer360Read: { supported: false, refusalCode: "host_binding_required" }, invoiceAccess: { supported: false, refusalCode: "host_binding_required" },
  paymentMethodSetup: { supported: false, refusalCode: "unsupported" }, commerceRecovery: { supported: false, refusalCode: "host_binding_required" }, configuredPurchase: { supported: false, refusalCode: "host_binding_required" },
  operatorSubscription: { supported: false, refusalCode: "operator_subscription_authority_unavailable" }, operatorContact: { supported: false, refusalCode: "operator_subscription_authority_unavailable" }, communicationGifts: { supported: false, refusalCode: "unsupported_preference" },
  subscriptions: { ...NATIVE_SUBSCRIPTION_CAPABILITIES, genericBundleCommands: { supported: false, refusalCode: "native_generic_bundle_commands_unsupported" }, commandBoundReceipts: { supported: false, refusalCode: "native_command_bound_receipts_unsupported" } },
};
for (const profile of ["legacy", "bootstrap", "separate", "admin-managed", "admin-operator"] as AccountProfile[]) describe(`owned account mutations on ${profile}`, () => {
  let db: Awaited<ReturnType<typeof installAccountMutations>>;
  beforeAll(async () => { db = await installAccountMutations(profile); }, postgresSetupTimeoutMs);
  afterAll(async () => { if (db) await db.close(); }, postgresTeardownTimeoutMs);
  async function fixture() {
    const clientId = randomUUID(), principalId = randomUUID(), otherClient = randomUUID(), otherPrincipal = randomUUID(), invoice = randomUUID(), foreign = randomUUID();
    for (const [id, principal, document] of [[clientId, principalId, invoice], [otherClient, otherPrincipal, foreign]]) {
      await db.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [principal, `${principal}@example.invalid`]);
      await db.owner.query("INSERT INTO public.clients(id,principal_id,email,first_name,last_name,phone,lifecycle_stage,created_at,updated_at) VALUES($1,$2,$3,'Initial','Family','+99500100100','customer',$4,$4)", [id, principal, `${id}@example.invalid`, AT]);
      const order = randomUUID(), connection = await db.owner.connect();
      try { await connection.query("BEGIN"); await connection.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,created_at,updated_at) VALUES($1,$2,'pending_payment','XXX',100,$3,$3)", [order,id,AT]);
        await connection.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,100,100)",[order]); await connection.query("INSERT INTO public.accounting_documents(id,order_id,document_ref,status,total_gross_minor,created_at,updated_at) VALUES($1,$2,$3,'draft',100,$4,$4)", [document,order,`document:${document}`,AT]);
        await connection.query("INSERT INTO public.accounting_document_positions(document_id,position_ordinal,description,quantity,unit_gross_minor,total_gross_minor,created_at) VALUES($1,1,'Example item',1,100,100,$2)",[document,AT]); await connection.query("COMMIT");
      } catch(error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
    }
    const scope = { principalId, clientId }, port = createPostgresCustomerAccountMutationPort(db.runtime, scope, schemas, () => AT);
    return { clientId, principalId, otherClient, otherPrincipal, invoice, foreign, port, scope };
  }
  const state = (client: string) => db.owner.query("SELECT to_jsonb(c) AS row,xmin::text FROM public.clients c WHERE id=$1", [client]).then(r=>r.rows);
  const events = (client: string) => db.owner.query("SELECT to_jsonb(e) AS row,xmin::text FROM public.customer_account_events e WHERE client_id=$1 ORDER BY id",[client]).then(r=>r.rows);
  async function admin() {
    const operator = randomUUID(); await db.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)",[operator,`${operator}@example.invalid`]);
    await db.owner.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',$2)",[operator,AT]);
    await db.owner.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)",[operator]); return operator;
  }
  it("carries exact account-event rows alongside the customer preference ledger in the finite profile", async () => {
    // Exercise the finite account ledger before adding unrelated document fixtures.
    const clientId=randomUUID(),principalId=randomUUID();
    await db.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)",[principalId,`${principalId}@example.invalid`]);
    await db.owner.query("INSERT INTO public.clients(id,principal_id,email,created_at,updated_at) VALUES($1,$2,$3,$4,$4)",[clientId,principalId,`${clientId}@example.invalid`,AT]);
    const port=createPostgresCustomerAccountMutationPort(db.runtime,{principalId,clientId},schemas,()=>AT);
    await port.updateProfile(principalId,{idempotencyKey:"transfer-profile",firstName:"Transferred"});
    await port.updateProfile(principalId,{idempotencyKey:"transfer-profile-next",lastName:"Example",phone:"500 100 100"});
    const capture=(store: typeof db)=>captureConnectedNativeStore({
      sourceId:"account-event-source",catalogueId:store.inventory,maximumRows:10000,maximumBytes:64*1024*1024,
      source:{async withSnapshot(work){
        const client=await store.migrator.connect();
        const restricted=store.installation.generation === "qualified-admin";
        try {
          // Match the restricted connected-restore fixture's host-owned capture window.
          if (restricted) await client.query("GRANT platform_acquisition_owner TO account_m WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY account_m");
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          const result=await work({query:(sql,values)=>client.query(sql,values?[...values]:undefined)});
          await client.query("COMMIT"); return result;
        } catch(error) { await client.query("ROLLBACK"); throw error; }
        finally {
          try { if (restricted) await client.query("REVOKE platform_acquisition_owner FROM account_m GRANTED BY account_m"); }
          finally { client.release(); }
        }
      }},
    });
    const packet=await capture(db);
    expect(packet.owned.some(row=>row.table==="customer_communication_preference_events")).toBe(true);
    const expected=(await db.owner.query("SELECT to_jsonb(e)::text AS value FROM public.customer_account_events e ORDER BY id")).rows.map(row=>row.value);
    expect(expected).toHaveLength(2);
    expect(packet.owned.find(row=>row.table==="customer_account_events")?.rows).toEqual(expected);
    if (profile === "legacy") return; // Finite restore requires a qualified target.
    const target=await installAccountMutations(profile,false,"target");
    try {
      if (target.installation.generation === "legacy") throw new Error("qualified_restore_target_required");
      const freshTarget=await capture(target);
      const input={owner:target.migrator,installation:target.installation,packet,freshTarget};
      expect(await restoreConnectedNativeStore(input)).toMatchObject({replayed:false});
      const restored=()=>target.owner.query("SELECT to_jsonb(e)::text AS value,xmin::text FROM public.customer_account_events e ORDER BY id").then(result=>result.rows);
      const before=await restored();
      expect(before.map(row=>row.value)).toEqual(expected);
      const clients=await target.owner.query("SELECT to_jsonb(c) AS row,xmin::text FROM public.clients c WHERE id=$1",[clientId]);
      expect(clients.rows).toMatchObject([{row:{id:clientId,first_name:"Transferred",last_name:"Example",phone:"+99500100100"}}]);
      expect(await restoreConnectedNativeStore(input)).toMatchObject({replayed:true});
      expect(await restored()).toEqual(before);
      expect((await target.owner.query("SELECT to_jsonb(c) AS row,xmin::text FROM public.clients c WHERE id=$1",[clientId])).rows).toEqual(clients.rows);
    } finally { await target.close(); }
  }, postgresSetupTimeoutMs);
  it("updates through the selected self-service profile port with normalized readback and omitted/null/empty distinctions", async () => {
    const f=await fixture(), facade=createSelfServiceCommandFacade({context:{...f.scope,graph:"native"},capabilities,profile:f.port});
    expect(await facade.profile.updateProfile(f.principalId,{idempotencyKey:"profile-normalized",firstName:" Ada   Buyer ",phone:"500 100 100"})).toMatchObject({profile:{firstName:"Ada Buyer",lastName:"Family",phone:"+99500100100"}});
    expect(await f.port.updateProfile(f.principalId,{idempotencyKey:"profile-clear",firstName:null,lastName:" ",phone:""})).toMatchObject({profile:{firstName:null,lastName:null,phone:null}});
    expect(await f.port.updateProfile(f.principalId,{idempotencyKey:"profile-omitted",lastName:"Later"})).toMatchObject({profile:{firstName:null,lastName:"Later",phone:null}});
    expect((await events(f.clientId)).map(e=>e.row.payload)).toContainEqual({idempotencyKey:"profile-normalized",firstName:"Ada Buyer",phone:"+99500100100"});
  });
  it("refuses unlinked and cross-customer scopes and principal spoofing before mutation", async () => {
    const f=await fixture(), before=await state(f.clientId);
    const cross=createPostgresCustomerAccountMutationPort(db.runtime,{principalId:f.otherPrincipal,clientId:f.clientId},schemas,()=>AT);
    expect(await cross.updateProfile(f.otherPrincipal,{idempotencyKey:"profile-foreign",firstName:"Other"})).toBeNull();
    expect(await cross.readEvents(f.otherPrincipal)).toBeNull();
    const unlinkedPrincipal=randomUUID(), unlinked=createPostgresCustomerAccountMutationPort(db.runtime,{principalId:unlinkedPrincipal,clientId:f.clientId},schemas,()=>AT);
    expect(await unlinked.updateProfile(unlinkedPrincipal,{idempotencyKey:"profile-unlinked"})).toBeNull();
    expect(await db.runtime.query("SELECT public.customer_account_profile_update($1,$2,$3,$4) AS result",[randomUUID(),f.clientId,{idempotencyKey:"profile-unlinked"},AT]).then(r=>r.rows[0].result)).toBeNull();
    await expect(f.port.updateProfile(f.otherPrincipal,{idempotencyKey:"profile-spoofed"})).rejects.toMatchObject({code:"customer_principal_mismatch"});
    expect(await state(f.clientId)).toEqual(before); expect(await events(f.clientId)).toEqual([]);
  });
  it("rejects invalid names, phones, email and malformed inputs without writes", async () => {
    const f=await fixture(), before=await state(f.clientId);
    for(const input of [{firstName:"A"},{lastName:"www.example.invalid"},{phone:"123"},{email:"change@example.invalid"},{phone:1}]) await expect(f.port.updateProfile(f.principalId,{idempotencyKey:"profile-invalid",...input} as never)).rejects.toMatchObject({code:"customer_account_invalid_input"});
    await expect(db.runtime.query("SELECT public.customer_account_profile_update($1,$2,$3,$4)",[f.principalId,f.clientId,{idempotencyKey:"profile-email",email:"change@example.invalid"},AT])).rejects.toMatchObject({code:"22023"});
    expect(await state(f.clientId)).toEqual(before); expect(await events(f.clientId)).toEqual([]);
  });
  it("replays an event key to current state with no second mutation or event", async () => {
    const f=await fixture(); await f.port.updateProfile(f.principalId,{idempotencyKey:"profile-first",firstName:"First"});
    await f.port.updateProfile(f.principalId,{idempotencyKey:"profile-second",firstName:"Current"});
    const before=await state(f.clientId), history=await events(f.clientId);
    expect(await f.port.updateProfile(f.principalId,{idempotencyKey:"profile-first",firstName:"Ignored"})).toMatchObject({profile:{firstName:"Current"}});
    expect(await state(f.clientId)).toEqual(before); expect(await events(f.clientId)).toEqual(history); expect(history).toHaveLength(2);
  });
  it("keeps a committed profile write when its separate event append fails; retry may mutate again", async () => {
    const f=await fixture(); const failing={query:(sql:string,values?:unknown[])=>sql.includes("customer_account_event_append")?Promise.reject(new Error("synthetic append failure")):db.runtime.query(sql,values)};
    const port=createPostgresCustomerAccountMutationPort(failing,f.scope,schemas,()=>AT);
    await expect(port.updateProfile(f.principalId,{idempotencyKey:"profile-append-failure",firstName:"Committed"})).rejects.toThrow("synthetic append failure");
    expect((await state(f.clientId))[0].row.first_name).toBe("Committed"); expect(await events(f.clientId)).toEqual([]);
    await f.port.updateProfile(f.principalId,{idempotencyKey:"profile-append-failure",firstName:"Retried"}); expect((await state(f.clientId))[0].row.first_name).toBe("Retried"); expect(await events(f.clientId)).toHaveLength(1);
  });
  it("appends owned invoice requests, stores repeated keys without deduplication and preserves invoice state", async () => {
    const f=await fixture(), input={idempotencyKey:"invoice-request",invoiceId:f.invoice,reason:" Correct the address ",requestedFields:[" address "],note:null};
    const invoice=await db.owner.query("SELECT to_jsonb(d) AS row,xmin::text FROM public.accounting_documents d WHERE id=$1",[f.invoice]);
    const first=await f.port.requestInvoiceCorrection(f.principalId,input); expect(first?.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await events(f.clientId)).toHaveLength(1);
    const second=await f.port.requestInvoiceCorrection(f.principalId,input); expect(second?.eventId).not.toBe(first?.eventId);
    const rows=await events(f.clientId); expect(rows).toHaveLength(2); expect(rows[0].row).toMatchObject({event_type:"customer.invoice_correction_requested",entity_id:f.invoice,payload:{idempotencyKey:input.idempotencyKey,invoiceRef:`document:${f.invoice}`,reason:"Correct the address",requestedFields:["address"],note:null}});
    expect((await db.owner.query("SELECT to_jsonb(d) AS row,xmin::text FROM public.accounting_documents d WHERE id=$1",[f.invoice])).rows).toEqual(invoice.rows);
  });
  it("refuses missing/foreign invoices and malformed correction requests", async () => {
    const f=await fixture(), input={idempotencyKey:"invoice-refusal",invoiceId:f.foreign,reason:"Correct the address"};
    expect(await f.port.requestInvoiceCorrection(f.principalId,input)).toBeNull(); expect(await f.port.requestInvoiceCorrection(f.principalId,{...input,invoiceId:randomUUID()})).toBeNull();
    const unlinkedPrincipal=randomUUID(), unlinked=createPostgresCustomerAccountMutationPort(db.runtime,{principalId:unlinkedPrincipal,clientId:f.clientId},schemas,()=>AT);
    expect(await unlinked.requestInvoiceCorrection(unlinkedPrincipal,input)).toBeNull();
    for(const invalid of [{reason:"short"},{invoiceId:"bad"},{requestedFields:[""]},{note:""},{idempotencyKey:"x"}]) await expect(f.port.requestInvoiceCorrection(f.principalId,{...input,...invalid})).rejects.toMatchObject({code:"customer_account_invalid_input"});
    expect(await events(f.clientId)).toEqual([]);
  });
  it("provides owned metadata-only history bounded to the latest twenty events", async () => {
    const f=await fixture();
    for(let i=0;i<23;i++) await db.runtime.query("SELECT public.customer_account_event_append($1,$2,'customer.example','client',$2,$3,$4)",[f.principalId,f.clientId,{sequence:i,private:"Synthetic history"},new Date(Date.parse(AT)+i*1000).toISOString()]);
    const history=await f.port.readEvents(f.principalId); expect(history).toHaveLength(20); expect(history?.[0].occurredAt).toBe("2026-11-10T12:00:22.000000Z"); expect(history?.every(e=>!Object.hasOwn(e,"payload"))).toBe(true);
    expect((await db.runtime.query("SELECT public.customer_account_event_append($1,$2,'customer.example','client',$2,'{}',$3) AS result",[f.otherPrincipal,f.clientId,AT])).rows[0].result).toBeNull();
    if(profile!=="legacy") await expect(db.runtime.query("SELECT payload FROM public.customer_account_events")).rejects.toMatchObject({code:"42501"});
    expect((await db.owner.query("SELECT confdeltype FROM pg_constraint WHERE conrelid='public.customer_account_events'::regclass AND contype='f'")).rows).toEqual([{confdeltype:"c"}]);
  });
  it("blocks event-bearing leads while empty-history leads absorb and replay", async () => {
    const f=await fixture(), operator=await admin(), free=randomUUID(), blocked=randomUUID(), key=`absorb-${randomUUID()}`;
    for(const id of [free,blocked]) await db.owner.query("INSERT INTO public.clients(id,email,created_at,updated_at) VALUES($1,$2,$3,$3)",[id,`${id}@example.invalid`,AT]);
    await db.owner.query("INSERT INTO public.customer_account_events(client_id,event_type,entity_type,payload,occurred_at,created_at) VALUES($1,'customer.example','client','{}',$2,$2)",[blocked,AT]);
    const call=(lead:string,k:string)=>db.runtime.query("SELECT public.customer_support_absorb_lead_v1($1,$2,$3,$4,$5,$6) AS result",[operator,f.clientId,lead,`${lead}@example.invalid`,k,AT]).then(r=>r.rows[0].result);
    const before=await state(blocked), history=await events(blocked); expect(await call(blocked,`blocked-${key}`)).toMatchObject({outcome:"refused",refusalCode:"lead_has_commercial_footprint",blockingTables:["customer_account_events"]});
    expect(await state(blocked)).toEqual(before); expect(await events(blocked)).toEqual(history);
    const applied=await call(free,key); expect(applied).toMatchObject({outcome:"applied"}); const settled=await state(free); expect(await call(free,key)).toEqual({...applied,outcome:"replayed"}); expect(await state(free)).toEqual(settled);
  });
  it("exports classified payloads and requires an explicit retention disposition before identity erasure", async () => {
    const f=await fixture(), operator=await admin(); await f.port.updateProfile(f.principalId,{idempotencyKey:"privacy-profile",firstName:"Private"});
    const store=createPostgresPrivacyStore(), identity=createIdentityPersonalDataContributor(store,{retainedContactFields:Object.fromEntries(["lifecycle_stage","acquisition_source"].map(field=>[field,{owner:"clients",resource:`clients.${field}`,disposition:"retain" as const,reasonCode:"CONTACT_LIFECYCLE_RETENTION",remote:false}]))},randomUUID);
    const read=async (context:PgQueryExecutor,subject:{contactId:string|null})=>({available:true,data:(await context.query("SELECT to_jsonb(e)::text AS value FROM public.customer_account_events e WHERE client_id=$1 ORDER BY id",[subject.contactId])).rows.map(row=>JSON.parse(String(row.value))) as PrivacyJson});
    const unitOfWork={run:async<T>(work:(context:PgQueryExecutor)=>Promise<T>)=>{const client=await db.owner.connect();try{await client.query("BEGIN");const result=await work(client);await client.query("COMMIT");return result;}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}}};
    const make=(retain:boolean)=>createPrivacyOperations({store,unitOfWork,registry:createPersonalDataContributorRegistry([identity,createAccountEventPrivacyContributor({read,assess:retain?async()=>"retain":null})],{requiredContributorIds:["identity","account-support"]}),now:()=>new Date(AT),randomId:randomUUID});
    const exported=await make(false).export({principalId:operator},{kind:"contact",contactId:f.clientId});
    expect(exported.documents.find(d=>d.contributorId==="account-support")).toMatchObject({coverage:{complete:true},data:[{payload:{firstName:"Private"}}],obligations:[{disposition:"unresolved"}]});
    await expect(make(false).erase({principalId:operator},{subject:{kind:"contact",contactId:f.clientId},idempotencyKey:randomUUID()})).rejects.toMatchObject({code:"PRIVACY_OWNERSHIP_UNDECLARED"});
    expect((await state(f.clientId))[0].row.first_name).toBe("Private");
    const receipt=await make(true).erase({principalId:operator},{subject:{kind:"contact",contactId:f.clientId},idempotencyKey:randomUUID()});
    expect(receipt.obligations).toContainEqual({owner:"account-support",resource:"account-support.account-events",disposition:"retain",reasonCode:"ACCOUNT_EVENT_POLICY_RETENTION",remote:false});
    expect((await state(f.clientId))[0].row.first_name).toBeNull(); expect((await events(f.clientId))[0].row.payload.firstName).toBe("Private");
    expect(await createAccountEventPrivacyContributor<PgQueryExecutor>({read:null,assess:null}).export(db.owner,{contactId:f.clientId,principalId:null,identity:{}})).toMatchObject({coverage:{complete:false,unavailable:["account-support.account-events"]}});
  });

});
