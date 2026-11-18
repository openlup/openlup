import { createSuccessorJourney } from "../helpers/storeJourney.js";
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

it.each([{ branch:"shortage",stock:0 },{ branch:"full_stock",stock:100 }])("lc10_D6_C6_recovery_capture $branch",async ({stock})=>{
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
it.each(["legacy_first","resolver_first"])("lc10_D6_direct_legacy_outcome_root_contention $schedule",async schedule=>{
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
