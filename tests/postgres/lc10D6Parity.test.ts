import { createPostgresFulfillmentStockSyncPort } from "@openlup/platform/fulfillment";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { createPostgresCatalogPublication,createCatalogProductTypeRegistry,installCatalogDefinitions,catalogDefinitionDigest,canonicalCatalogDraftJson,catalogAcceptedReferenceV2Schema } from "@openlup/platform/catalog";
import type { CatalogDraftPayloadV4,CatalogDraftPayloadV5,CatalogHeadRef } from "@openlup/platform/catalog/contracts";
import { createNativeCatalogRenewalCodecV2 } from "@openlup/platform/subscriptions";
import type { SubscriptionEditConsent } from "@openlup/platform/subscriptions/contracts";
import { ecommercePaid } from "./communicationEcommerceFixture.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

const migration = "db/platform/migrations/20261123130000_catalog_successors.sql";
const containers: PostgresContainer[] = [], pools: Pool[] = [];
let pool: Pool, db: PoolClient;
beforeAll(async () => {
  const container = await runPostgresContainer({ name: `catalog-successors-${process.pid}`, password: "synthetic-successors" }); containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Successor witnesses require real PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString }); pools.push(pool);
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  for (const unit of [manifest.baseline, ...manifest.forward]) await pool.query(readFileSync(unit.file, "utf8"));
  if (!manifest.forward.some((unit: { file: string }) => unit.file === migration)) await pool.query(readFileSync(migration, "utf8"));
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(containers, pools), postgresTeardownTimeoutMs);
beforeEach(async () => { db = await pool.connect(); await db.query("BEGIN"); });
afterEach(async () => { await db.query("ROLLBACK"); db.release(); });
async function legacy() {
  const client = randomUUID(), subscription = randomUUID(), operation = randomUUID(), caseId = randomUUID();
  const instant = (await db.query("SELECT now()-interval '1 day' AS at")).rows[0].at;
  const fingerprint = createHash("sha256").update(operation).digest("hex");
  await db.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,$3)", [subscription, client, instant]);
  await db.query(`INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,
    cycle_snapshot,claim_token,claimed_by,claimed_at,lease_expires_at) VALUES($1,$2,$3,1,public.subscription_renewal_identity($2,$3),$4,'{}',$1,'synthetic',now()-interval '2 days',now()-interval '1 day')`,
    [operation, subscription, instant, fingerprint]);
  await db.query(`INSERT INTO public.subscription_stock_wait_cases(id,subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,
    due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits) SELECT $1,$2,$3,id,scheduled_at,cycle_number,'waiting','{}',cycle_snapshot,operation_fingerprint,identity_key,'[]'
    FROM public.subscription_renewal_operations WHERE id=$4`, [caseId, subscription, client, operation]);
  return { client, subscription, operation, caseId };
}
it("lc10_D6_C1_old_arbiter", async () => {
  const f = await legacy();
  const row = (await db.query(`INSERT INTO public.subscription_renewal_operations(subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,
    cycle_snapshot,claim_token,claimed_by,claimed_at,lease_expires_at) SELECT subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,
    cycle_snapshot,claim_token,claimed_by,claimed_at,lease_expires_at FROM public.subscription_renewal_operations WHERE id=$1
    ON CONFLICT(subscription_id,scheduled_at) DO UPDATE SET updated_at=public.subscription_renewal_operations.updated_at RETURNING id`, [f.operation])).rows;
  expect(row).toEqual([{ id: f.operation }]);
  expect((await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='subscription_renewal_operations_cycle_key'")).rows)
    .toEqual([{ definition: "UNIQUE (subscription_id, scheduled_at)" }]);
});
it("lc10_D6_C2_old_wait_upsert", async () => {
  const f = await legacy();
  expect((await db.query(`INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits)
    SELECT subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits FROM public.subscription_stock_wait_cases WHERE id=$1
    ON CONFLICT(subscription_id,scheduled_at) DO UPDATE SET last_checked_at=public.subscription_stock_wait_cases.last_checked_at RETURNING id`, [f.caseId])).rows).toEqual([{ id: f.caseId }]);
});
it("lc10_D6_C3_direct_legacy_json", async () => {
  const f = await legacy();
  const result = (await db.query(`SELECT public.subscription_stock_wait_projection(c) AS actual,to_jsonb(c)-'due_snapshot'-'cycle_snapshot'-'notice_messages' AS expected FROM public.subscription_stock_wait_cases c WHERE id=$1`, [f.caseId])).rows[0];
  expect(result.actual).toEqual(result.expected);
  expect(Object.keys(result.actual)).toHaveLength(21);
  expect((await db.query("SELECT public.subscription_stock_wait_projection(NULL::public.subscription_stock_wait_cases) AS result")).rows).toEqual([{ result: null }]);
});
it("lc10_D6_C4_direct_legacy_read", async () => {
  const f = await legacy();
  const result = (await db.query(`SELECT public.subscription_stock_wait_read(c.id) AS actual,(to_jsonb(c)-'due_snapshot'-'cycle_snapshot'-'notice_messages')||jsonb_build_object('waitingNoticeRelevant',true) AS expected FROM public.subscription_stock_wait_cases c WHERE id=$1`, [f.caseId])).rows[0];
  expect(result.actual).toEqual(result.expected);
  expect((await db.query("SELECT public.subscription_stock_wait_read($1) AS result", [randomUUID()])).rows).toEqual([{ result: null }]);
  expect((await db.query("SELECT public.subscription_stock_wait_read_v2($1,'legacy') AS result", [f.caseId])).rows[0].result).toEqual({ schemaVersion: 2, caseKind: "legacy", case: result.expected });
});

it("stock_wait_successor_resolution_supersedes_atomically", async () => {
  const f=await createSuccessorJourney(pool);
  const before=(await db.query("SELECT to_jsonb(op) AS row FROM public.subscription_renewal_operations op WHERE id=$1",[f.operationId])).rows[0].row;
  const result=(await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at])).rows[0].result;
  expect(result).toMatchObject({ schemaVersion: 2,status: "applied",proposalId: f.proposalId,rootOperationId: f.operationId,caseKind: "successor",cycleNumber: 1 });
  expect((await db.query("SELECT to_jsonb(op) AS row FROM public.subscription_renewal_operations op WHERE id=$1",[f.operationId])).rows[0].row).toEqual(before);
  expect((await db.query("SELECT state,block_reason FROM public.subscription_stock_wait_cases WHERE id=$1",[f.caseId])).rows).toEqual([{ state: "closed",block_reason: "superseded_by_successor" }]);
  expect((await db.query("SELECT variant_id,quantity,unit_price_minor FROM public.subscription_lines WHERE subscription_id=$1",[f.subscription])).rows).toEqual([{ variant_id: f.successor.sku,quantity: 1,unit_price_minor: "777" }]);
  expect((await db.query("SELECT count(*)::integer AS count FROM public.subscription_cycles WHERE subscription_id=$1 AND scheduled_at=$2",[f.subscription,f.anchor])).rows).toEqual([{ count: 0 }]);
});

it("lc10_D6_successor_paid_fact_direct_trigger", async () => {
  const f=await createSuccessorJourney(pool);
  const resolved=(await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at])).rows[0].result;
  const generation=(await db.query("SELECT * FROM public.subscription_successor_operations_v2 WHERE id=$1",[resolved.operationId])).rows[0];
  const prepared=(await db.query("SELECT public.commerce_prepare_successor_renewal_v2($1,$2,$3) AS result",[generation.id,generation.claim_token,f.at])).rows[0].result;
  expect(prepared).toMatchObject({ schemaVersion: 2,operationKind: "successor",state: "attempt_prepared",replayed: false });
  const eventKey=randomUUID();
  const evidence={ operationFingerprint: generation.operation_fingerprint,outcome: "succeeded",externalRef: `synthetic:${eventKey}` };
  const settled=(await db.query("SELECT public.commerce_settle_successor_renewal_v2($1,$2,$3,$4) AS result",[generation.id,eventKey,evidence,f.at])).rows[0].result;
  expect(settled).toMatchObject({ operation: { state: "succeeded" } });
  const source=(await db.query("SELECT metadata->'commercePaidFactV1' AS fact FROM public.outbox_events WHERE event_type='commerce.order.paid' AND aggregate_id=$1",[prepared.orderId])).rows[0];
  expect(source.fact).toMatchObject({ state: "complete",event: { sourceType: "order.paid",subject: { clientId: f.client },data: { purchaseKind: "renewal",orderId: prepared.orderId,currency: "XXX" } } });
  expect((await db.query("SELECT public.commerce_settle_successor_renewal_v2($1,$2,$3,$4) AS result",[generation.id,eventKey,evidence,f.at])).rows[0].result).toEqual(settled);
  expect((await db.query("SELECT count(*)::integer AS count FROM public.subscription_cycles WHERE subscription_id=$1 AND scheduled_at=$2",[f.subscription,f.anchor])).rows).toEqual([{ count: 1 }]);
  expect((await db.query("SELECT next_cycle_at>=$2::timestamptz+interval '28 days' AS extended FROM public.subscriptions WHERE id=$1",[f.subscription,f.anchor])).rows).toEqual([{ extended: true }]);
});

it.each([{ branch:"shortage",stock:0 },{ branch:"full_stock",stock:100 }])("lc10_D6_C6_persisted_due_snapshot",async ({stock})=>{
  const f=await createSuccessorJourney(pool,{ creator:"recover",recoveryStock:stock });
  expect((await db.query("SELECT due_snapshot FROM public.subscription_stock_wait_cases WHERE id=$1",[f.caseId])).rows[0].due_snapshot).toEqual(f.preRecovery);
  const opened=(await db.query("SELECT payload,idempotency_key FROM public.outbox_events WHERE event_type='subscription_stock_wait.opened.v1' AND aggregate_id=$1",[f.caseId])).rows;
  expect(opened).toHaveLength(1);
  expect(opened[0].payload).toMatchObject({ caseId:f.caseId,operationId:f.operationId,subscriptionId:f.subscription,clientId:f.client,identityKey:f.codec.identity(f.frozen),frozenFingerprint:f.codec.fingerprint(f.frozen) });
  expect(opened[0].idempotency_key).toBe(`subscription_stock_wait:${f.caseId}:opened:v1`);
  expect(Object.keys(opened[0].payload).sort()).toEqual(["caseId","clientId","frozenFingerprint","identityKey","operationId","scheduledAt","subscriptionId"].sort());
});

async function prepareLegacy() {
  const f=await createSuccessorJourney(pool,{ creator:"recover",recoveryStock:100 });
  const token=(await pool.query("SELECT claim_token FROM public.subscription_renewal_operations WHERE id=$1",[f.operationId])).rows[0].claim_token;
  const prepared=(await pool.query("SELECT public.commerce_prepare_subscription_renewal($1,$2,$3) AS result",[f.operationId,token,f.at])).rows[0].result;
  const external=`synthetic:${randomUUID()}`;
  await pool.query("SELECT public.commerce_acknowledge_subscription_renewal_attempt($1,$2,$3,$4)",[f.operationId,f.codec.fingerprint(f.frozen),external,f.at]);
  return { ...f,prepared,external };
}
const tracked=<T>(work:Promise<T>)=>work.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
async function hook(signature:string,boundary:string,insertion:string) {
  const before=(await pool.query("SELECT pg_get_functiondef(oid) AS ddl,prosrc FROM pg_proc WHERE oid=$1::regprocedure",[signature])).rows[0];
  expect(before.prosrc.split(boundary)).toHaveLength(2);
  await pool.query(before.ddl.replace(before.prosrc,()=>before.prosrc.replace(boundary,()=>boundary+insertion)));
  return ()=>pool.query(before.ddl);
}
async function gate(observer:PoolClient) {
  const key=BigInt(`0x${randomUUID().replaceAll("-","").slice(0,14)}`).toString();
  await observer.query("SELECT pg_advisory_lock($1::bigint)",[key]);
  return { sql:`PERFORM pg_advisory_lock(${key}::bigint); PERFORM pg_advisory_unlock(${key}::bigint);`,release:()=>observer.query("SELECT pg_advisory_unlock($1::bigint)",[key]) };
}
const pid=async(connection:PoolClient)=>Number((await connection.query("SELECT pg_backend_pid() AS id")).rows[0].id);
async function blocked(observer:PoolClient,waiter:number,holder:number) {
  await expect.poll(async()=>(await observer.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked",[waiter,holder])).rows[0].blocked).toBe(true);
}
async function state() {
  const result:Record<string,unknown>={};
  for(const name of ["subscriptions","subscription_lines","subscription_renewal_terms","subscription_renewal_operations","subscription_stock_wait_cases","fulfillment_inventory_reservations","fulfillment_inventory_reservation_lines","subscription_quote_previews","subscription_successor_proposals","subscription_successor_operations_v2","subscription_successor_wait_cases_v2","subscription_successor_reservations_v2","subscription_command_receipts","outbox_events"])
    result[name]=(await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM public.${name} t`)).rows[0].rows;
  return result;
}
it.each(["legacy_first","resolver_first"])("lc10_D6_direct_legacy_outcome_root_contention",async schedule=>{
  const f=await prepareLegacy(),observer=await pool.connect(),legacy=await pool.connect(),resolver=await pool.connect();
  const lPid=await pid(legacy),rPid=await pid(resolver),oPid=await pid(observer),pause=await gate(observer);
  let restore=async()=>{};
  const invoke=()=>legacy.query("SELECT public.commerce_record_subscription_renewal_outcome($1,$2,$3,'succeeded',$4,NULL,$5) AS result",[f.operationId,randomUUID(),f.codec.fingerprint(f.frozen),f.external,f.at]);
  const resolve=()=>resolver.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at]);
  let old:Promise<{ok:true;value:unknown}|{ok:false;error:unknown}>|undefined;
  try {
    await legacy.query("BEGIN");await resolver.query("BEGIN");
    if(schedule==="legacy_first") {
      restore=await hook("public.commerce_record_subscription_renewal_outcome(uuid,text,text,text,text,text,timestamptz)","WHERE id = p_operation_id FOR UPDATE;",pause.sql);
      old=tracked(invoke());await blocked(observer,lPid,oPid);
      const before=await state(),refused=await tracked(resolve());
      expect(refused).toMatchObject({ok:false,error:{code:"55P03",message:"lc10_root_operation_busy"}});
      await resolver.query("ROLLBACK");expect(await state()).toEqual(before);
    } else {
      restore=await hook("public.resolve_stock_wait_with_successor(uuid,uuid,text,text,uuid,timestamptz)","SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE NOWAIT;",pause.sql);
      const before=await state(),pending=tracked(resolve());await blocked(observer,rPid,oPid);
      old=tracked(invoke());await blocked(observer,lPid,rPid);
      await pause.release();expect(await pending).toMatchObject({ok:false,error:{code:"55P03",message:"lc10_root_operation_busy"}});
      await resolver.query("ROLLBACK");
      // L now owns the native settlement. R's proposal/template/sidecars remain unchanged.
      const after=await state();for(const name of ["subscription_successor_proposals","subscription_successor_operations_v2","subscription_successor_wait_cases_v2","subscription_successor_reservations_v2","subscription_command_receipts","subscription_quote_previews","subscription_lines"])expect(after[name]).toEqual(before[name]);
    }
    await pause.release();expect(await old).toMatchObject({ok:true});await legacy.query("COMMIT");
    expect((await pool.query("SELECT status FROM public.commerce_orders WHERE id=$1",[f.prepared.orderId])).rows).toEqual([{status:"paid"}]);
    await expect(resolve()).rejects.toMatchObject({code:"22023",message:"stock_wait_successor_provider_owned"});
    expect((await pool.query("SELECT count(*)::integer AS count FROM public.subscription_successor_operations_v2 WHERE root_operation_id=$1",[f.operationId])).rows).toEqual([{count:0}]);
  } finally {
    await pause.release();await legacy.query("ROLLBACK");await resolver.query("ROLLBACK");await restore();observer.release();legacy.release();resolver.release();
  }
});

it("lc10_D6_document_fk_witness_precedence",async()=>{
  const f=await createSuccessorJourney(pool);
  const revision=(await db.query("SELECT current_document_revision_id FROM public.catalog_products WHERE id=$1",[f.successor.product])).rows[0].current_document_revision_id;
  const before=(await db.query("SELECT to_jsonb(p) AS row FROM public.catalog_products p WHERE id=$1",[f.predecessor.product])).rows[0].row;
  const update=()=>db.query("UPDATE public.catalog_products SET current_document_revision_id=$2 WHERE id=$1",[f.predecessor.product,revision]);
  await db.query("SAVEPOINT original_guard");
  await expect(update()).rejects.toMatchObject({code:"42501",message:"catalog_document_pointer_direct_write_denied"});
  await db.query("ROLLBACK TO SAVEPOINT original_guard");
  await db.query("SAVEPOINT single_fk_mutant");
  await db.query("ALTER TABLE public.catalog_products DROP CONSTRAINT catalog_products_current_document_revision_same_product_fkey");
  await expect(update()).rejects.toMatchObject({code:"42501",message:"catalog_document_pointer_direct_write_denied"});
  await db.query("ROLLBACK TO SAVEPOINT single_fk_mutant");
  await db.query("SAVEPOINT pointer_authority");
  await expect(db.query("INSERT INTO public.catalog_publication_pointer_capabilities VALUES(pg_current_xact_id(),$1,$2,$3)",[f.predecessor.product,revision,"a".repeat(64)]))
    .rejects.toMatchObject({code:"23503",table:"catalog_publication_pointer_capabilities"});
  await db.query("ROLLBACK TO SAVEPOINT pointer_authority");
  expect((await db.query("SELECT to_jsonb(p) AS row FROM public.catalog_products p WHERE id=$1",[f.predecessor.product])).rows[0].row).toEqual(before);
});

it.each([
  {name:"lc10_history_02989_same_product_sku",column:"primary_sku_id",parent:"catalog_skus",constraint:"catalog_products_primary_sku_same_product_fkey"},
  {name:"lc10_history_03027_validated_sku_fk",column:"primary_sku_id",parent:"catalog_skus",constraint:"catalog_products_primary_sku_same_product_fkey"},
  {name:"lc10_history_02991_same_product_document",column:"current_document_revision_id",parent:"catalog_product_document_revisions",constraint:"catalog_products_current_document_revision_same_product_fkey"},
  {name:"lc10_history_03028_validated_document_fk",column:"current_document_revision_id",parent:"catalog_product_document_revisions",constraint:"catalog_products_current_document_revision_same_product_fkey"},
])("$name",async({column,parent,constraint})=>{
  const f=await createSuccessorJourney(pool);
  const pointers=(await db.query("SELECT primary_sku_id,current_document_revision_id FROM public.catalog_products WHERE id=$1",[f.successor.product])).rows[0];
  const product=randomUUID(),foreign=pointers[column];
  const before=(await db.query("SELECT to_jsonb(p) AS row FROM public.catalog_products p WHERE id=$1",[f.predecessor.product])).rows[0].row;
  const metadata=(await db.query(`SELECT c.convalidated,c.confdeltype,c.confrelid::regclass::text AS parent,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.ord) AS child_columns,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.ord) AS parent_columns
    FROM pg_constraint c WHERE c.conrelid='public.catalog_products'::regclass AND c.conname=$1`,[constraint])).rows;
  expect(metadata).toEqual([{convalidated:true,confdeltype:"r",parent,child_columns:["id",column],parent_columns:["product_id","id"]}]);
  let reachedWrite=false;
  async function witness() {
    await db.query("SAVEPOINT foreign_identity");
    try {
      // The document INSERT uses ordinary insert authority; its UPDATE fence stays intact.
      const write=column==="primary_sku_id"
        ? db.query("UPDATE public.catalog_products SET primary_sku_id=$2 WHERE id=$1",[f.predecessor.product,foreign])
        : db.query("INSERT INTO public.catalog_products(id,slug,name,current_document_revision_id) VALUES($1,$2,'Synthetic article',$3)",[product,`article-${product}`,foreign]);
      await expect(write.then(result=>{reachedWrite=result.rowCount===1;return result;})).rejects.toMatchObject({code:"23503",constraint});
    } finally { await db.query("ROLLBACK TO SAVEPOINT foreign_identity"); }
  }
  await witness();expect(reachedWrite).toBe(false);
  await db.query("SAVEPOINT target_fk_mutant");
  await db.query(`ALTER TABLE public.catalog_products DROP CONSTRAINT ${constraint}`);
  expect(await tracked(witness())).toMatchObject({ok:false,error:{name:"AssertionError"}});
  expect(reachedWrite).toBe(true);
  await db.query("ROLLBACK TO SAVEPOINT target_fk_mutant");
  reachedWrite=false;await witness();expect(reachedWrite).toBe(false);
  expect((await db.query("SELECT id FROM public.catalog_products WHERE id=$1",[product])).rows).toEqual([]);
  expect((await db.query("SELECT to_jsonb(p) AS row FROM public.catalog_products p WHERE id=$1",[f.predecessor.product])).rows[0].row).toEqual(before);
});

it("lc10_D6_paid_fact_legacy_bytes",async()=>{
  const source=readFileSync("db/platform/migrations/20261111120000_communication_ecommerce_sources.sql","utf8");
  const start=source.indexOf("CREATE FUNCTION public.communication_paid_fact(");
  const original=source.slice(start,source.indexOf("END; $$;",start)+9);
  expect(start).toBeGreaterThan(0);
  await db.query(original.replace("public.communication_paid_fact","pg_temp.lc10_legacy_paid_fact"));
  const f=await prepareLegacy();
  await pool.query("SELECT public.commerce_record_subscription_renewal_outcome($1,$2,$3,'succeeded',$4,NULL,$5)",[f.operationId,randomUUID(),f.codec.fingerprint(f.frozen),f.external,f.at]);
  const orders=[f.prepared.orderId];
  for(const options of [{},{initial:true},{discount:true},{complete:false}])orders.push((await ecommercePaid(db,{...options,at:f.at})).order);
  for(const order of orders) {
    const result=(await db.query("SELECT public.communication_paid_fact(o) AS actual,pg_temp.lc10_legacy_paid_fact(o) AS expected FROM public.commerce_orders o WHERE id=$1",[order])).rows[0];
    expect(result.actual).toEqual(result.expected);
  }
});

it("lc10_D6_C5_first_and_replay_json",async()=>{
  const f=await prepareLegacy();
  expect((await db.query("SELECT public.subscription_stock_wait_mark_resumed($1) AS result",[f.prepared.orderId])).rows).toEqual([{result:null}]);
  await db.query("SELECT public.commerce_record_subscription_renewal_outcome($1,$2,$3,'succeeded',$4,NULL,$5)",[f.operationId,randomUUID(),f.codec.fingerprint(f.frozen),f.external,f.at]);
  await db.query("SAVEPOINT no_shipment");
  await expect(db.query("SELECT public.subscription_stock_wait_mark_resumed($1)",[f.prepared.orderId])).rejects.toMatchObject({code:"22023",message:"stock_wait_realization_admission_missing"});
  await db.query("ROLLBACK TO SAVEPOINT no_shipment");
  await db.query("RELEASE SAVEPOINT no_shipment");
  await db.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('synthetic-successor','3pl',true) ON CONFLICT DO NOTHING");
  await db.query("SELECT public.fulfillment_create_shipment($1,$2,'synthetic-successor','{}'::jsonb,$3)",[`shipment:${f.prepared.orderId}`,f.prepared.orderId,f.at]);
  const first=(await db.query("SELECT public.subscription_stock_wait_mark_resumed($1) AS result",[f.prepared.orderId])).rows[0].result;
  const expected=(await db.query("SELECT to_jsonb(c)-'due_snapshot'-'cycle_snapshot'-'notice_messages' AS result FROM public.subscription_stock_wait_cases c WHERE id=$1",[f.caseId])).rows[0].result;
  expect(first).toEqual(expected);expect(Object.keys(first)).toHaveLength(21);expect(first.state).toBe("resumed");
  expect((await db.query("SELECT public.subscription_stock_wait_mark_resumed($1) AS result",[f.prepared.orderId])).rows[0].result).toEqual(first);
  expect((await db.query("SELECT idempotency_key FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription_stock_wait.resumed'",[f.caseId])).rows).toEqual([{idempotency_key:`subscription_stock_wait:${f.caseId}:resumed`}]);
  expect((await db.query("SELECT public.subscription_stock_wait_mark_resumed($1) AS result",[randomUUID()])).rows).toEqual([{result:null}]);
});

it("lc10_D6_shared_ATP_counts_generation_once",async()=>{
  const f=await createSuccessorJourney(pool);
  const resolved=(await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at])).rows[0].result;
  const g=(await db.query("SELECT * FROM public.subscription_successor_operations_v2 WHERE id=$1",[resolved.operationId])).rows[0];
  const atp=async(renewal:boolean,at=f.at)=>(await db.query("SELECT public.inventory_available_to_promise($1,$2,$3,$4) AS result",[f.source,f.successor.code,at,renewal])).rows[0].result;
  const expected={available_quantity:99,for_sale_quantity:100,hard_hold_quantity:1,safety_quantity:0,soft_subscription_demand_quantity:0,channel_exposure_quantity:0};
  expect(await atp(false)).toEqual(expected);expect(await atp(true)).toEqual(expected);
  const held=(await db.query("SELECT expires_at FROM public.subscription_successor_reservations_v2 WHERE operation_id=$1",[g.id])).rows[0];
  const expiry=(await db.query("SELECT $1::timestamptz+interval '1 second' AS at",[held.expires_at])).rows[0].at.toISOString();
  expect(await atp(false,expiry)).toEqual({...expected,hard_hold_quantity:0,soft_subscription_demand_quantity:1});
  expect(await atp(true,expiry)).toEqual({...expected,available_quantity:100,hard_hold_quantity:0,soft_subscription_demand_quantity:1});
  await db.query("SAVEPOINT committed_hold");
  await db.query("SELECT public.commerce_prepare_successor_renewal_v2($1,$2,$3)",[g.id,g.claim_token,f.at]);
  expect(await atp(false,expiry)).toEqual(expected);expect(await atp(true,expiry)).toEqual(expected);
  await db.query("ROLLBACK TO SAVEPOINT committed_hold");await db.query("RELEASE SAVEPOINT committed_hold");
  await db.query("SELECT public.fulfillment_release_successor_renewal_v2($1,$2,'fixture_release',$3)",[g.id,g.claim_token,f.at]);
  expect(await atp(false)).toEqual({...expected,hard_hold_quantity:0,soft_subscription_demand_quantity:1});
  expect(await atp(true)).toEqual({...expected,available_quantity:100,hard_hold_quantity:0,soft_subscription_demand_quantity:1});
});

it("stock_wait_successor_never_moves_cycle_earlier",async()=>{
  const f=await createSuccessorJourney(pool);
  const before=(await db.query("SELECT s.next_cycle_at,t.next_cycle_number,op.scheduled_at,op.cycle_number FROM public.subscriptions s JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id JOIN public.subscription_renewal_operations op ON op.subscription_id=s.id WHERE op.id=$1",[f.operationId])).rows[0];
  const result=(await db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6) AS result",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at])).rows[0].result;
  const after=(await db.query("SELECT s.next_cycle_at,t.next_cycle_number,g.scheduled_at,g.cycle_number FROM public.subscriptions s JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id JOIN public.subscription_successor_operations_v2 g ON g.subscription_id=s.id WHERE g.id=$1",[result.operationId])).rows[0];
  expect(after).toEqual(before);
  expect((await db.query("SELECT count(*)::integer AS count FROM public.subscription_delivery_alignment_arrivals a JOIN public.fulfillment_shipments f ON f.id=a.shipment_id JOIN public.commerce_orders o ON o.id=f.order_id JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id WHERE c.subscription_id=$1",[f.subscription])).rows).toEqual([{count:0}]);
});

it("successor_offer_requires_acceptance_and_never_substitutes",async()=>{
  const f=await prepareLegacy();
  expect((await db.query("SELECT state FROM public.subscription_successor_proposals WHERE id=$1",[f.proposalId])).rows).toEqual([{state:"offered"}]);
  expect((await db.query("SELECT variant_id,unit_price_minor FROM public.subscription_lines WHERE subscription_id=$1",[f.subscription])).rows).toEqual([{variant_id:f.predecessor.sku,unit_price_minor:"617"}]);
  expect((await db.query("SELECT sku_id,unit_amount_minor FROM public.commerce_order_items WHERE order_id=$1",[f.prepared.orderId])).rows).toEqual([{sku_id:f.predecessor.sku,unit_amount_minor:"617"}]);
  expect((await db.query("SELECT id FROM public.subscription_successor_operations_v2 WHERE root_operation_id=$1",[f.operationId])).rows).toEqual([]);
});

it("successor_offer_never_advances_cycle",async()=>{
  const f=await createSuccessorJourney(pool);
  expect((await db.query("SELECT next_cycle_at=$2::timestamptz AS same FROM public.subscriptions WHERE id=$1",[f.subscription,f.anchor])).rows).toEqual([{same:true}]);
  expect((await db.query("SELECT count(*)::integer AS count FROM public.subscription_cycles WHERE subscription_id=$1 AND scheduled_at=$2",[f.subscription,f.anchor])).rows).toEqual([{count:0}]);
});

it("stock_wait_successor_refuses_paid_or_provider_owned",async()=>{
  const f=await prepareLegacy();
  for(const paid of [false,true]) {
    if(paid)await pool.query("SELECT public.commerce_record_subscription_renewal_outcome($1,$2,$3,'succeeded',$4,NULL,$5)",[f.operationId,randomUUID(),f.codec.fingerprint(f.frozen),f.external,f.at]);
    const before=await state();
    await db.query("SAVEPOINT provider_owned");
    await expect(db.query("SELECT public.resolve_stock_wait_with_successor($1,$2,$3,$4,$5,$6)",[f.caseId,f.proposalId,f.quoteHash,randomUUID(),f.client,f.at]))
      .rejects.toMatchObject({code:"22023",message:"stock_wait_successor_provider_owned"});
    await db.query("ROLLBACK TO SAVEPOINT provider_owned");await db.query("RELEASE SAVEPOINT provider_owned");
    expect(await state()).toEqual(before);
  }
});

/** Existing journey resources, with real publication, frozen wait and consent owners. */
async function createSuccessorJourney(pool: Pool, options: { creator?: "admit" | "recover"; recoveryStock?: number } = {}) {
  const definition={ key:"example:article",version:1,units:[{code:"openlup:g",dimension:"mass" as const,integral:false}],netContentUnits:["openlup:g"],dimensions:[],axes:[],validatorRef:`sha256:${"a".repeat(64)}`,validateContent:()=>[] };
  const registry=createCatalogProductTypeRegistry([definition]);
  const rules={canonicalizeDocument:canonicalCatalogDraftJson,deriveSkuFacts:(document:unknown)=>({derived:(document as {derived:number}).derived}),validateProduct:()=>[],classifySkuChange:()=>"compatible" as const};
  const hash = (value: string) => createHash("sha256").update(value).digest("hex"), admin = randomUUID();
  const rpc = async (db: PgQueryExecutor, name: string, args: unknown[]) =>
    (await db.query(`SELECT public.${name}(${args.map((_,index) => `$${index + 1}`).join(",")}) AS result`,args)).rows[0]!.result as Record<string, unknown>;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await installCatalogDefinitions(db,{ id: "example:successor",namespace: "example",version: 1,openlupRange: "0.44.x",capabilities: { publish: false },types: [definition],taxClasses: [] });
    await db.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)",[admin,`${admin}@example.invalid`]);
    await db.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())",[admin]);
    await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_minimum_base_units','1') ON CONFLICT(key) DO NOTHING");
    const authority = createPostgresCatalogPublication({ registry,rules,authorizeHuman: async () => ({ ok: true as const,userId: admin,role: "admin",isMachineActor: false }),
      readiness: async () => ({ ready: true,reasons: [] }),globalReadiness: async () => ({ ready: true,reasons: [] }),verifyMedia: async () => false,
      transactions: { async run(work) { await db.query("SAVEPOINT publisher"); try { const result = await work(db); await db.query("RELEASE SAVEPOINT publisher"); return result; } catch (error) { await db.query("ROLLBACK TO SAVEPOINT publisher"); throw error; } } } });
    const actor = (await authority.authorize(null))!;
    async function publish(payload: CatalogDraftPayloadV4 | CatalogDraftPayloadV5,
      draftId: string,revision: number,head: CatalogHeadRef | null) {
      const command = { schemaVersion: payload.schemaVersion,action: revision ? "revise" : "create",draftId,commandKey: `draft:${revision}`,expectedRevision: revision,payload }, canonical = canonicalCatalogDraftJson(command);
      expect(await rpc(db,"catalog_draft_apply",[canonical,hash(canonical),"operator:synthetic"])).toMatchObject({ outcome: "committed" });
      const candidateRef = `v1:${draftId}@${revision + 1}/${head ? `${head.publicationId}@${head.revision}` : "unpublished"}`;
      const candidateDigest = hash('["catalog-candidate",1,'+canonicalCatalogDraftJson(payload)+','+canonicalCatalogDraftJson([{ ...payload.product.type,definitionDigest: catalogDefinitionDigest(definition) }])+','+canonicalCatalogDraftJson(head)+']');
      expect(await authority.decision({ schemaVersion: 2,action: "approve",productId: payload.product.id,commandKey: `approve:${revision}`,candidateRef,candidateDigest,reason: "Exact synthetic candidate" },actor)).toMatchObject({ outcome: "committed" });
      const result = await authority.publish({ productId: payload.product.id,commandKey: `publish:${revision}`,candidateRef,candidateDigest,expectedHead: head,changes: [] },actor);
      if (!("receipt" in result)) throw new Error(JSON.stringify(result));
      return result.receipt.head;
    }
    async function article(predecessor?: string) {
      const product = randomUUID(),sku = randomUUID(),draft = randomUUID(),document = randomUUID(),code = `ARTICLE-${sku}`,slug = `article-${product}`;
      const digits=(BigInt(`0x${sku.replaceAll("-","").slice(0,14)}`)%1_000_000_000_000n).toString().padStart(12,"0");
      const gtin=digits+String((10-[...digits].reduce((sum,digit,index)=>sum+Number(digit)*(index%2?3:1),0)%10)%10);
      const content={schemaVersion:1,derived:12},canonicalText=canonicalCatalogDraftJson(content),documentDigest=hash(canonicalText);
      const authoredFacts={skuCode:code,title:"Synthetic article",minQuantity:1,isAddon:false,facts:{derived:12}};
      const value:CatalogDraftPayloadV4={schemaVersion:4,product:{id:product,type:{key:definition.key,version:1},dimensions:[],slug,primarySkuId:sku,
        documentRevision:{id:document,productId:product,revisionNo:1,schemaId:"example:document.v1",documentRef:"example:document",sourceRef:"example:source",digest:documentDigest},
        sharedContent:{schemaVersion:1,catalogAction:"create",document:content,presentation:{},publicationSkus:[authoredFacts],requestedModes:[{skuCode:code,modes:[]}],offerMemberships:[]}},
        skus:[{id:sku,productId:product,code,options:{},netContent:{dimension:"mass",unit:"openlup:g",unscaled:"100",scale:0},identifiers:[{scheme:"gs1:gtin",issuer:"example",value:gtin,packagingLevel:"unit"}]}],
        publication:{kind:"release",evidence:{},operations:[{op:"create_product",productId:product,productSlug:slug,name:"Synthetic article"},
          {op:"register_document_revision",productSlug:slug,revisionId:document,revisionNo:1,documentRef:"example:document",sourceRef:"example:source",canonicalText,digest:documentDigest,provenance:{source:"current_draft"}},
          {op:"move_document_pointer",productSlug:slug,documentRevisionNo:1},{op:"create_sku",productSlug:slug,documentRevisionNo:1,skuId:sku,...authoredFacts},
          {op:"create_identifier",skuCode:code,scheme:"gs1:gtin",issuer:"example",value:gtin,packagingLevel:"unit",quantity:1,isPrimary:true,label:null,sourceRef:null},
          {op:"set_primary_sku",productSlug:slug,skuCode:code},{op:"set_product_presentation",productSlug:slug,presentation:{}}]}};
      let authored: typeof value | CatalogDraftPayloadV5 = value;
      if (predecessor) authored={ ...value,schemaVersion: 5,publication: { ...value.publication,operations: value.publication.operations.map(operation => operation.op === "create_sku" ? { ...operation,successorOf: predecessor } : operation) } };
      const declared = await publish(authored,draft,0,null);
      // Standing facts are installed owner fixture data, as in the existing admission journey.
      const old = (await db.query("SELECT * FROM public.catalog_publications WHERE id=$1",[declared.publicationId])).rows[0];
      const manifest = JSON.parse(old.canonical_state), previous = manifest.skus[0];
      const row = (await db.query("SELECT full_facts FROM public.catalog_sku_revisions WHERE id=$1",[previous.revisionId])).rows[0];
      const facts = { ...JSON.parse(row.full_facts),lifecycleState: "active",status: "active",sellableStandalone: true,sellableInSubscription: true,memberships: [{ offerVersion: "classic",admitted: true }] };
      manifest.schemaVersion=3; delete manifest.successors;
      manifest.product={ ...manifest.product,lifecycleState: "active",status: "active" };
      const publication = randomUUID(),revisionId = randomUUID(),fullFacts = canonicalCatalogDraftJson(facts),factDigest = hash(fullFacts);
      manifest.skus=[{ ...previous,revisionId,revision: 2,digest: factDigest }];
      const canonical=canonicalCatalogDraftJson(manifest),digest=hash(canonical);
      await db.query("INSERT INTO public.catalog_lifecycle_write_capabilities VALUES(pg_current_xact_id(),$1,$2)",[product,digest]);
      await db.query("UPDATE public.catalog_products SET status='active',publication_facts=$2::jsonb WHERE id=$1",[product,manifest.product]);
      await db.query("UPDATE public.catalog_skus SET status='active',sellable_standalone=true,sellable_in_subscription=true,publication_facts=$2::jsonb WHERE id=$1",[sku,facts]);
      await db.query("INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id) VALUES($1,$2,2,$3,$4,1,$5,$6,$7,$8,$6,$9)",[publication,product,old.id,draft,`standing:${publication}`,digest,old.document_revision_id,canonical,admin]);
      await db.query("INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest) VALUES($1,$2,$3,2,$4,$5,$6)",[revisionId,sku,product,publication,fullFacts,factDigest]);
      await db.query("UPDATE public.catalog_publication_heads SET publication_id=$2,revision=2 WHERE product_id=$1",[product,publication]);
      await db.query("DELETE FROM public.catalog_lifecycle_write_capabilities WHERE product_id=$1",[product]);
      const head={ ...declared,publicationId: publication,revision: 2 };
      const reference=catalogAcceptedReferenceV2Schema.parse({ schemaVersion: 2,skuId: sku,skuCode: code,skuRevisionId: revisionId,publicationHead: head,typeRef: manifest.product.type,
        definitionDigest: manifest.product.definitionDigest,optionDigest: facts.optionDigest,netContent: facts.netContent });
      return { product,sku,draft,code,value,head,reference,declared };
    }
    const predecessor=await article(),successor=await article(predecessor.sku);
    const client=randomUUID(),principal=randomUUID(),subscription=randomUUID(),activationCycle=randomUUID(),list=randomUUID(),entry=randomUUID(),destination=randomUUID();
    const clock=(await db.query(`SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
      to_char((now()-interval '1 day') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS anchor,
      to_char((now()-interval '56 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS authorized,
      to_char((now()-interval '10 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS claimed`)).rows[0];
    const at=String(clock.at),anchor=String(clock.anchor),authorized=String(clock.authorized),claimed=String(clock.claimed),source=`successor:${subscription}`;
    await db.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)",[client,`${client}@example.invalid`,principal]);
    await db.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Synthetic list','ZZ','XXX',now()-interval '2 days')",[list]);
    await db.query("INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,$3,'any',777,now()-interval '2 days')",[entry,list,successor.sku]);
    await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,started_at,currency_code,price_list_id) VALUES($1,$2,28,$3,$4,'XXX',$5)",[subscription,client,anchor,authorized,list]);
    await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code,catalog_sku_revision_id) VALUES($1,$2,1,0,617,'XXX',$3)",[subscription,predecessor.sku,predecessor.reference.skuRevisionId]);
    await db.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,$3::timestamptz-interval '28 days','paid')",[activationCycle,subscription,anchor]);
    await db.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref,next_cycle_number,catalog_acceptance) VALUES($1,'XXX',$2,'sandbox',$3,'synthetic',1,$4::jsonb)",[subscription,source,authorized,{ schemaVersion: 2,lines: [predecessor.reference] }]);
    await db.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,$2,1,617)",[subscription,predecessor.code]);
    await db.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')",[subscription]);
    await db.query("INSERT INTO public.commerce_destinations(id,client_id,address) VALUES($1,$2,$3)",[destination,client,{ recipientName: "Synthetic recipient",line1: "1 Synthetic Lane",city: "Synthetic",postalCode: "00000",country: "ZZ" }]);
    const money=(amountMinor:number)=>({ amountMinor,currency: "XXX" }),oldLine={ lineOrdinal: 1,sku: predecessor.code,quantity: 1,unitAmountMinor: 617 };
    const codec=createNativeCatalogRenewalCodecV2(value=>catalogAcceptedReferenceV2Schema.parse(value));
    const header={ subscription_id: subscription,client_id: client,scheduled_at: anchor,cadence_days: 28,currency_code: "XXX",stock_source_key: source,settlement_channel_key: "sandbox",authorization_ref: "synthetic",payer_account_ref: null,
      unattended_charge_authorized_at: authorized,activation_cycle_id: activationCycle,activation_cycle_paid: true,paid_cycle_count: 1,next_cycle_number: 1,template_version: 1,
      purchase_facts: { templateId: "synthetic",renewalTerms: { version: "native.renewal-terms.v1",shippingTerms: { version: "shipping-threshold.v1",currency: "XXX",flatMinor: 0,freeThresholdMinor: 0 },normalCadenceDays: [28] } },
      catalog_acceptance: { schemaVersion: 2,lines: [predecessor.reference] },lines: [oldLine] };
    const schedule={ subscriptionId: subscription,scheduledAt: anchor,scheduledInstant: Date.parse(anchor) };
    const frozen=codec.withDestination!(codec.freeze(header,schedule),destination),wire=codec.encode(frozen);
    const withdraw=structuredClone(predecessor.value); withdraw.product.sharedContent.catalogAction="revise";
    withdraw.publication.operations=[{ op: "set_product_lifecycle",productSlug: withdraw.product.slug!,expectedState: "active",state: "withdrawn",children: [{ skuCode: predecessor.code,expectedState: "active" }] }];
    const withdrawalHead=await publish(withdraw,predecessor.draft,1,predecessor.head);
    const stock=createPostgresFulfillmentStockSyncPort(db,{ sourceKey: source,readLocalInventoryStock: async()=>[] });
    for (const [sku,quantity] of [[predecessor.code,0],[successor.code,100]] as const) await stock.recordProviderStockCurrent({ requestKey: `stock:${sku}`,snapshot: { providerRef: "synthetic",collectedAt: at,sourceRevision: null,revisionSource: "collection",quantityKind: "snapshot",skuRef: sku,totalQuantity: quantity,forSaleQuantity: quantity,reservedOrUnavailableQuantity: 0,syncRunId: subscription },inventoryClass: "sellable",lastSyncedAt: at,staleAfter: (await db.query("SELECT now()+interval '1 day' AS until")).rows[0].until.toISOString() });
    const claimedOperation=await rpc(db,"subscription_claim_due_renewal",[codec.identity(frozen),codec.fingerprint(frozen),wire,"synthetic",300,claimed]);
    let admitted: Record<string,unknown>,preRecovery: Record<string,unknown>|null=null;
    if(options.creator==="recover") {
      expect(await rpc(db,"fulfillment_reserve_subscription_renewal",[claimedOperation.operationId,claimedOperation.claimToken,900,claimed])).toMatchObject({ reserved:false });
      preRecovery=(await db.query("SELECT to_jsonb(op) AS row FROM public.subscription_renewal_operations op WHERE id=$1",[claimedOperation.operationId])).rows[0].row;
      if(options.recoveryStock) {
        const recorded=(await db.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at;
        await stock.recordProviderStockCurrent({ requestKey:`recovery:${predecessor.code}`,snapshot:{ providerRef:"synthetic",collectedAt:recorded,sourceRevision:null,revisionSource:"collection",quantityKind:"snapshot",skuRef:predecessor.code,totalQuantity:options.recoveryStock,forSaleQuantity:options.recoveryStock,reservedOrUnavailableQuantity:0,syncRunId:subscription },inventoryClass:"sellable",lastSyncedAt:recorded,staleAfter:(await db.query("SELECT now()+interval '1 day' AS until")).rows[0].until.toISOString() });
      }
      admitted=await rpc(db,"subscription_stock_wait_recover_refusal",[claimedOperation.operationId,codec.fingerprint(frozen),"synthetic-recovery",at]);
      expect(admitted.waiting).toBe(!options.recoveryStock);
    } else {
      admitted=await rpc(db,"subscription_stock_wait_admit",[{ operationId: claimedOperation.operationId,claimToken: claimedOperation.claimToken,snapshot: wire,operationFingerprint: codec.fingerprint(frozen),identityKey: codec.identity(frozen),worker: "synthetic" },{},claimed]);
      expect(admitted.waiting).toBe(true);
    }
    const innerHash=hash(randomUUID()),line={ variantId: successor.sku,qty: 1,isAddon: false,quoteLine: { sku: successor.code,quantity: 1,unitPriceGross: money(777),lineSubtotalGross: money(777) } };
    const lineId=(await db.query("SELECT id FROM public.subscription_lines WHERE subscription_id=$1",[subscription])).rows[0].id;
    const consent:SubscriptionEditConsent={version:1,currency:"XXX",baselineFingerprint:hash(JSON.stringify([1,"XXX",1,[[1,lineId,predecessor.sku,predecessor.code,false,1,617]]])),innerQuoteHash:innerHash,
      lines:[{kind:"removed",variantId:predecessor.sku,sku:predecessor.code,isAddon:false,agreedQuantity:1,newQuantity:null,agreedUnitMinor:617,newUnitMinor:null,deltaMinor:null,subtotalDeltaMinor:-617,reason:"removed"},
        {kind:"added",variantId:successor.sku,sku:successor.code,isAddon:false,agreedQuantity:null,newQuantity:1,agreedUnitMinor:null,newUnitMinor:777,deltaMinor:null,subtotalDeltaMinor:777,reason:"added"}],agreedTotalMinor:617,newTotalMinor:777,subtotalDeltaMinor:160};
    const quoteHash=hash(JSON.stringify([consent.version,consent.innerQuoteHash,consent.currency,consent.baselineFingerprint,consent.lines.map(l=>[l.kind,l.variantId,l.sku,l.isAddon,l.agreedQuantity,l.newQuantity,l.agreedUnitMinor,l.newUnitMinor,l.deltaMinor,l.subtotalDeltaMinor,l.reason]),consent.agreedTotalMinor,consent.newTotalMinor,consent.subtotalDeltaMinor]));
    const admission={ heads: [{ productId: successor.product,head: successor.head }],skuRevisions: [{ reference: successor.reference,quantity: 1 }],mode: "subscription",
      offerEvidence: { offerVersion: "classic" },priceContextVersions: [{ skuId: successor.sku,priceListId: list,entryId: entry,entry: (await db.query("SELECT to_jsonb(p) AS row FROM public.price_entries p WHERE id=$1",[entry])).rows[0].row }],purpose: "account" };
    const core=[{ variantId: successor.sku,qty: 1 }],totals={ currentRecurringPrice: money(617),newRecurringPrice: money(777),delta: money(160) };
    const request={ planDays: 28,base: core,addons: [],expectedTemplateVersion: 1,acceptedQuoteHash: quoteHash };
    const evidence={ baseLines: [line],addonLines: [],compositionConstraint: null,catalogAdmission: admission,editConsent: consent };
    const quote=await rpc(db,"subscription_quote_preview_record",[principal,client,subscription,"update_package_template",quoteHash,1,(await db.query("SELECT now()+interval '1 hour' AS until")).rows[0].until.toISOString(),{ planDays: 28,base: core,addons: [] },evidence,totals,at]);
    const newFrozen=codec.withDestination!(codec.freeze({ ...header,template_version: 2,lines: [{ lineOrdinal: 1,sku: successor.code,quantity: 1,unitAmountMinor: 777 }],catalog_acceptance: { schemaVersion: 2,lines: [successor.reference] },graduation_pricing: [{ sku: successor.code,quantity: 1,unitAmountMinor: 777,isAddon: false,quoteLine: line.quoteLine }] },schedule),destination);
    const proposalId=randomUUID(),offer={ proposalId,predecessorSkuId: predecessor.sku,successorSkuId: successor.sku,publicationId: successor.declared.publicationId,
      previewId: quote.id,sourceBinding: { kind: "stock_wait",caseKind: "legacy",caseId: admitted.caseId },lane: "classic",action: "update_package_template",
      applyPayload: { ...request,request,planDays: 28,base: core,addons: [],...evidence,...totals },cycleSnapshot: codec.encode(newFrozen) };
    const proposal=await rpc(db,"subscription_successor_proposal_offer_v2",[subscription,client,offer,at]);
    await db.query("COMMIT");
    return { client,principal,subscription,predecessor,successor,withdrawalHead,at,anchor,source,codec,frozen,wire,preRecovery,operationId: String(claimedOperation.operationId),claimToken: String(admitted.claimToken??claimedOperation.claimToken),caseId: String(admitted.caseId),proposalId,quoteHash: String(proposal.quote_hash),offer };
  } catch(error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
