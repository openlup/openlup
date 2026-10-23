import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readReviewedForwardRegistry } from "../../scripts/reviewed-platform-forward.js";
import { createSupabaseAccountingInvoicePort } from "../../server/adapters/supabase/accountingInvoicePort.js";
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const ids = { client: "b6100000-0000-4000-8000-000000000001", order: "b6200000-0000-4000-8000-000000000001", invoice: "b6300000-0000-4000-8000-000000000001", outbox: "b6400000-0000-4000-8000-000000000001" };
let container: PostgresContainer | undefined;
let pool: Pool;
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Managed correction proof requires real PostgreSQL");
  container = await runPostgresContainer({ name: `m09-managed-correction-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Managed correction PostgreSQL unavailable");
  pool = new Pool({ connectionString: container.connectionString });
  await pool.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT null::text $$;`);
  await pool.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
  for (const name of readdirSync("supabase/migrations").filter(name => name < "20261022193000").sort()) {
    await pool.query(readFileSync(`supabase/migrations/${name}`, "utf8").replace(/^\\(?:un)?restrict .*$/gmu, ""));
  }
  const entries = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json")).managedInvoicingForwards!.slice(0, 2);
  for (const entry of entries) {
    const bytes = readFileSync(entry.path);
    expect(bytes.equals(readFileSync(`scripts/fixtures/${entry.path.split("/").at(-1)}`))).toBe(true);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    await pool.query(bytes.toString("utf8"));
  }
}, 120_000);
afterAll(async () => { await pool?.end(); await container?.remove(); });
async function seeded(run: (db: PoolClient) => Promise<void>) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(`INSERT INTO public.clients(id,email) VALUES ($1,'correction@example.invalid');
    `, [ids.client]);
    await db.query(`INSERT INTO public.commerce_orders(id,client_id,order_number,status,currency,subtotal_cents,tax_cents,total_cents)
      VALUES($1,$2,'MANAGED-CORRECTION','paid','XTS',1080,80,1080)`, [ids.order, ids.client]);
    await db.query(`INSERT INTO public.accounting_invoices(id,order_id,order_ref,invoice_ref,status,currency,buyer_snapshot,order_snapshot,tax_snapshot,lines_snapshot,total_net_cents,total_gross_cents,provider_kind,provider_invoice_id,document_kind,ksef_required,ksef_status,email_status,correction_status)
      VALUES($1,$2,'MANAGED-CORRECTION','MANAGED-CORRECTION:base','correction_requested','XTS','{"name":"Saved buyer"}','{}','{}','[{"name":"Saved item","quantity":1,"totalGrossMinor":1080,"vatRate":"8"}]',1000,1080,'test_provider','parent','b2c_named',false,'not_required','sent','requested')`,[ids.invoice,ids.order]);
    await db.query(`INSERT INTO public.accounting_invoice_correction_outbox(id,invoice_id,provider_kind,correction_reason,payload)
      VALUES($1,$2,'test_provider','full refund','{"manualAuthorization":"saved"}')`,[ids.outbox,ids.invoice]);
    await run(db);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
}
async function claim(db: PoolClient) {
  return (await db.query("SELECT public.accounting_invoice_correction_outbox_claim(10,300,'accounting.correction.v2') result")).rows[0].result;
}
async function finish(db: PoolClient, attempt: number, ref = "correction") {
  return (await db.query("SELECT public.accounting_invoice_correction_outbox_succeed($1,$2,'CORR/1','{}',$3) result",[ids.outbox,ref,attempt])).rows[0].result;
}
// The first three cases pass on both original fdf0cc2a and narrowed P3.
it("persists identity before work, reclaims lost ACK with the same key and rejects stale success/failure without side effects", async () => seeded(async db => {
  const first = await claim(db);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ outboxId: ids.outbox, attemptCount: 1, providerInvoiceId: "parent", payload: { manualAuthorization: "saved", providerCreateIdentity: `accounting-correction:${ids.outbox}` } });
  expect(await claim(db)).toEqual([]);
  await db.query("SAVEPOINT lost_ack");
  expect(await finish(db,1)).toMatchObject({ok:true,replayed:false});
  await db.query("ROLLBACK TO lost_ack");
  await db.query("UPDATE public.accounting_invoice_correction_outbox SET next_attempt_at=now()-interval '1 minute' WHERE id=$1",[ids.outbox]);
  const retry = await claim(db);
  expect(retry[0]).toMatchObject({ attemptCount:2,payload:first[0].payload });
  expect(await finish(db,1)).toEqual({ok:false,code:"accounting_invoice_correction_claim_generation_mismatch"});
  expect((await db.query("SELECT public.accounting_invoice_correction_outbox_fail($1,'{}',60,1) result",[ids.outbox])).rows[0].result)
    .toEqual({ok:false,code:"accounting_invoice_correction_claim_generation_mismatch"});
  expect(await finish(db,2,"parent")).toEqual({ok:false,code:"accounting_invoice_correction_claim_provider_identity_invalid"});
  expect(await finish(db,2)).toMatchObject({ok:true,replayed:false});
  const snapshot = async () => (await db.query("SELECT to_jsonb(i) invoice,to_jsonb(o) outbox FROM public.accounting_invoices i JOIN public.accounting_invoice_correction_outbox o ON o.invoice_id=i.id WHERE i.id=$1",[ids.invoice])).rows;
  const before = await snapshot();
  expect(await finish(db,2)).toEqual({ok:true,replayed:true});
  expect(await finish(db,2,"different")).toEqual({ok:false,code:"accounting_invoice_correction_claim_provider_identity_conflict"});
  expect(await claim(db)).toEqual([]);
  expect(await snapshot()).toEqual(before);
  expect((await db.query("SELECT operation FROM public.accounting_invoice_operations WHERE invoice_id=$1",[ids.invoice])).rows).toEqual([{operation:"correction_issued"}]);
  expect((await db.query("SELECT metadata->>'providerInvoiceId' ref FROM public.accounting_invoice_delivery_outbox WHERE invoice_id=$1",[ids.invoice])).rows).toEqual([{ref:"correction"}]);
}));
it("keeps legacy attempted work visibly unresolved, old callers closed and actual browser privileges denied", async () => seeded(async db => {
  await db.query("UPDATE public.accounting_invoice_correction_outbox SET status='failed',attempt_count=1,last_error='{\"code\":\"unknown\"}',payload='{}',next_attempt_at=now()-interval '1 minute' WHERE id=$1",[ids.outbox]);
  expect(await claim(db)).toEqual([]);
  expect((await db.query("SELECT status,attempt_count,payload,last_error FROM public.accounting_invoice_correction_outbox WHERE id=$1",[ids.outbox])).rows)
    .toEqual([{status:"failed",attempt_count:1,payload:{},last_error:{code:"unknown"}}]);
  expect((await db.query("SELECT public.accounting_invoice_correction_outbox_succeed($1,'guessed','CORR/1','{}') result",[ids.outbox])).rows[0].result)
    .toEqual({ok:false,code:"accounting_invoice_correction_claim_fence_required"});
  expect((await db.query("SELECT public.accounting_invoice_correction_outbox_fail($1,'{}',60) result",[ids.outbox])).rows[0].result)
    .toEqual({ok:false,code:"accounting_invoice_correction_claim_fence_required"});
  for (const query of ["SELECT public.accounting_invoice_correction_outbox_claim(10,300)", "SELECT public.accounting_invoice_correction_outbox_claim(10,300,'wrong')"]) {
    await db.query("SAVEPOINT refusal"); await expect(db.query(query)).rejects.toMatchObject({code:"22023"}); await db.query("ROLLBACK TO refusal");
  }
  for (const role of ["anon","authenticated"]) {
    await db.query("SAVEPOINT denied"); await db.query(`SET LOCAL ROLE ${role}`);
    await expect(db.query("SELECT public.accounting_invoice_correction_outbox_claim(10,300,'accounting.correction.v2')")).rejects.toMatchObject({code:"42501"});
    await db.query("ROLLBACK TO denied");
  }
  expect((await db.query("SELECT status,correction_status FROM public.accounting_invoices WHERE id=$1",[ids.invoice])).rows).toEqual([{status:"correction_requested",correction_status:"requested"}]);
}));
it("uses the real v2 adapter for fenced service writes and preserves immutable parent and positive history", async () => seeded(async db => {
  const port = createSupabaseAccountingInvoicePort({
    async rpc(name: string, params: Record<string, unknown>) {
      const args = Object.keys(params); const values = Object.values(params);
      const result = await db.query(`SELECT public.${name}(${args.map((key,i)=>`${key} => $${i+1}`).join(",")}) result`,values);
      return {data:result.rows[0].result,error:null};
    },
  });
  const reversal = { idempotencyKey: "managed-reversal", orderId: ids.order, reason: "order_refunded" as const, providerKind: "test_provider" };
  // Reversal reuses the confirmed parent's existing obligation for the same reason only.
  await db.query("UPDATE public.accounting_invoice_correction_outbox SET correction_reason='order_refunded' WHERE id=$1", [ids.outbox]);
  for (let replay = 0; replay < 2; replay++) {
    expect(await port.requestInvoiceReversalFromOrderStatus(reversal)).toMatchObject({ action: "correction_requested", invoice: { status: "correction_requested", providerInvoiceId: "parent" } });
  }
  expect((await db.query("SELECT count(*)::int count FROM public.accounting_invoice_correction_outbox WHERE invoice_id=$1", [ids.invoice])).rows).toEqual([{ count: 1 }]);
  const claims = await port.claimInvoiceCorrections(10);
  const current = claims[0]!;
  await port.markInvoiceCorrectionFailed({outboxId:current.outboxId,claimAttemptCount:current.attemptCount,error:{code:"unknown"},retrySeconds:60});
  await expect(port.markInvoiceCorrectionSucceeded({outboxId:current.outboxId,claimAttemptCount:current.attemptCount,providerInvoiceId:"correction",providerInvoiceNumber:null,providerRaw:{}})).rejects.toMatchObject({causeCode:"accounting_invoice_correction_claim_inactive"});
  await db.query("UPDATE public.accounting_invoice_correction_outbox SET next_attempt_at=now()-interval '1 minute' WHERE id=$1",[ids.outbox]);
  const [retry] = await port.claimInvoiceCorrections(10);
  await port.markInvoiceCorrectionSucceeded({outboxId:retry!.outboxId,claimAttemptCount:retry!.attemptCount,providerInvoiceId:"correction",providerInvoiceNumber:null,providerRaw:{}});
  expect((await db.query("SELECT provider_invoice_id,total_gross_cents,lines_snapshot,status FROM public.accounting_invoices WHERE id=$1",[ids.invoice])).rows)
    .toEqual([{provider_invoice_id:"parent",total_gross_cents:1080,lines_snapshot:[{name:"Saved item",quantity:1,totalGrossMinor:1080,vatRate:"8"}],status:"corrected"}]);
  expect(await port.requestInvoiceReversalFromOrderStatus(reversal)).toMatchObject({ action: "corrected", replayed: true });
  expect(await port.claimInvoiceCorrections(10)).toEqual([]);
}));

function managedPort(db: PoolClient) {
  return createSupabaseAccountingInvoicePort({
    async rpc(name: string, params: Record<string, unknown>) {
      const result = await db.query(`SELECT public.${name}(${Object.keys(params).map((key,i)=>`${key} => $${i+1}`).join(",")}) result`, Object.values(params));
      return {data:result.rows[0].result,error:null};
    },
  });
}
async function requestReversal(db: PoolClient, reason: "order_canceled" | "order_refunded") {
  return managedPort(db).requestInvoiceReversalFromOrderStatus({
    idempotencyKey: `managed-${reason}`, orderId: ids.order, reason, providerKind: "test_provider",
  });
}
async function prepareReversals(db: PoolClient, reasons: readonly ("order_canceled" | "order_refunded")[]) {
  await db.query("DELETE FROM public.accounting_invoice_correction_outbox WHERE invoice_id=$1", [ids.invoice]);
  for (const reason of reasons) await requestReversal(db, reason);
}
// Original fdf0cc2a and narrowed P3 both claim distinct cancel/refund rows.
// This pins the registered incumbent limit, without collapsing their reasons.
it("characterizes the incumbent multi-reason limit: cancel and refund both claim a full correction", async () => seeded(async db => {
  await prepareReversals(db, ["order_canceled", "order_refunded"]);
  const rows = await claim(db);
  expect(rows).toHaveLength(2);
  expect(rows.map((row: { correctionReason: string }) => row.correctionReason).sort()).toEqual(["order_canceled", "order_refunded"]);
  expect(new Set(rows.map((row: { outboxId: string }) => row.outboxId)).size).toBe(2);
  expect(rows.every((row: { attemptCount: number }) => row.attemptCount === 1)).toBe(true);
  expect((await db.query("SELECT status,attempt_count FROM public.accounting_invoice_correction_outbox WHERE invoice_id=$1", [ids.invoice])).rows)
    .toEqual([{status:"processing",attempt_count:1},{status:"processing",attempt_count:1}]);
  expect((await db.query("SELECT metadata->>'correctionOutboxId' receipt FROM public.accounting_invoices WHERE id=$1", [ids.invoice])).rows).toEqual([{receipt:null}]);
}));

// Original fdf0cc2a refuses both finalizers after sync; F4 settles either receipt shape.
for (const matchingReceipt of [false, true]) {
  it(`settles sync-first correction acceptance with ${matchingReceipt ? "a matching" : "no"} outbox identity`, async () => seeded(async db => {
    const [current] = await managedPort(db).claimInvoiceCorrections(10);
    expect(current).toBeDefined();
    expect((await db.query("SELECT metadata->>'correctionOutboxId' receipt FROM public.accounting_invoices WHERE id=$1", [ids.invoice])).rows).toEqual([{receipt:null}]);
    if (matchingReceipt) await db.query("UPDATE public.accounting_invoices SET metadata=metadata || jsonb_build_object('correctionOutboxId',$2::text) WHERE id=$1", [ids.invoice,current!.outboxId]);
    await db.query(`SELECT public.accounting_record_provider_sync_event(
      'sync-first-acceptance',$1,'test_provider','sync-first-acceptance','correction.accepted',
      NULL,NULL,NULL,NULL,'provider_webhook',NULL,NULL,now(),'synthetic-sync-hash','{}')`, [ids.invoice]);
    expect((await db.query("SELECT status FROM public.accounting_invoices WHERE id=$1", [ids.invoice])).rows)
      .toEqual([{status:"corrected"}]);
    await db.query("SAVEPOINT sync_first");
    // Conflicting receipts still fence both finalizers without audit or delivery effects.
    await db.query("UPDATE public.accounting_invoices SET metadata=metadata || '{\"correctionOutboxId\":\"conflicting\"}' WHERE id=$1", [ids.invoice]);
    const succeed = () => managedPort(db).markInvoiceCorrectionSucceeded({outboxId:current!.outboxId,claimAttemptCount:current!.attemptCount,
      providerInvoiceId:"sync-first-correction",providerInvoiceNumber:"CORR/SYNC",providerRaw:{}});
    const fail = () => managedPort(db).markInvoiceCorrectionFailed({outboxId:current!.outboxId,claimAttemptCount:current!.attemptCount,error:{code:"unknown"},retrySeconds:60});
    await expect(succeed()).rejects.toMatchObject({causeCode:"accounting_invoice_correction_claim_inactive"});
    await expect(fail()).rejects.toMatchObject({causeCode:"accounting_invoice_correction_claim_inactive"});
    expect((await db.query("SELECT count(*)::int count FROM public.accounting_invoice_operations WHERE invoice_id=$1 AND operation IN ('correction_issued','correction_failed')", [ids.invoice])).rows).toEqual([{count:0}]);
    await db.query("ROLLBACK TO sync_first");
    // The failure path also accepts sync-first, retaining the known corrected parent.
    await fail();
    expect((await db.query("SELECT metadata->>'correctionOutboxId' receipt FROM public.accounting_invoices WHERE id=$1", [ids.invoice])).rows)
      .toEqual([{receipt:matchingReceipt ? current!.outboxId : null}]);
    expect((await db.query("SELECT status FROM public.accounting_invoice_correction_outbox WHERE id=$1", [current!.outboxId])).rows).toEqual([{status:"failed"}]);
    expect((await db.query("SELECT operation FROM public.accounting_invoice_operations WHERE invoice_id=$1 AND operation='correction_failed'", [ids.invoice])).rows).toEqual([{operation:"correction_failed"}]);
    await db.query("ROLLBACK TO sync_first");
    await succeed();
    await succeed(); // Exact replay adds neither another operation nor another delivery.
    expect((await db.query("SELECT metadata->>'correctionOutboxId' receipt FROM public.accounting_invoices WHERE id=$1", [ids.invoice])).rows).toEqual([{receipt:current!.outboxId}]);
    expect((await db.query("SELECT status,next_attempt_at FROM public.accounting_invoice_correction_outbox WHERE id=$1", [current!.outboxId])).rows).toEqual([{status:"succeeded",next_attempt_at:null}]);
    expect((await db.query("SELECT operation FROM public.accounting_invoice_operations WHERE invoice_id=$1 AND operation='correction_issued'", [ids.invoice])).rows).toEqual([{operation:"correction_issued"}]);
    expect((await db.query("SELECT status,metadata->>'providerInvoiceId' ref FROM public.accounting_invoice_delivery_outbox WHERE invoice_id=$1", [ids.invoice])).rows).toEqual([{status:"pending",ref:"sync-first-correction"}]);
  }));
}
// Original fdf0cc2a schedules every error; F9 parks classified permanent errors only.
it("parks blocked, unsupported and explicitly non-retryable failures while retaining ordinary retry timing", async () => seeded(async db => {
  const [current] = await managedPort(db).claimInvoiceCorrections(10);
  for (const error of [{kind:"blocked"},{kind:"unsupported"},{retryable:false},{kind:"retryable"},{message:"reference host"},{}]) {
    await db.query("SAVEPOINT failure_kind");
    await managedPort(db).markInvoiceCorrectionFailed({outboxId:current!.outboxId,claimAttemptCount:current!.attemptCount,error,retrySeconds:120});
    const terminal = "retryable" in error ? error.retryable === false : error.kind === "blocked" || error.kind === "unsupported";
    expect((await db.query("SELECT status,last_error,next_attempt_at='infinity'::timestamptz terminal,next_attempt_at=now()+interval '120 seconds' timed FROM public.accounting_invoice_correction_outbox WHERE id=$1", [current!.outboxId])).rows)
      .toEqual([{status:"failed",last_error:error,terminal,timed:!terminal}]);
    expect(await claim(db)).toEqual([]);
    await db.query("ROLLBACK TO failure_kind");
  }
}));
