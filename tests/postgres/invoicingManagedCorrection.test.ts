import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readReviewedForwardRegistry } from "../../scripts/reviewed-platform-forward.js";
import { withAccountingInvoiceShadowTrigger, withAutoDispatchAccountingInvoiceTrigger } from "../../server/domains/accounting/fulfillmentInvoiceTrigger.js";
import { createFulfillmentHandoffInvoiceHandler } from "@openlup/platform/invoicing";
import { AccountingInvoicePersistenceError } from "../../src/domains/accounting/ports.js";
import { createSupabaseAccountingInvoicePort } from "../../server/adapters/supabase/accountingInvoicePort.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const managedSeller = {name:"Managed seller",street:"Seller street",postalCode:"12345",city:"Seller city",taxId:"seller-tax",krs:"seller-register",bankAccount:null,departmentId:null};
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
  const entries = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json")).managedInvoicingForwards!;
  for (const entry of entries) {
    const bytes = readFileSync(entry.path);
    expect(bytes.equals(readFileSync(`scripts/fixtures/${entry.path.split("/").at(-1)}`))).toBe(true);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    await pool.query(bytes.toString("utf8"));
  }
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, pool); }, postgresTeardownTimeoutMs);
async function seeded(run: (db: PoolClient) => Promise<void>, initialStatus = "correction_requested") {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(`INSERT INTO public.clients(id,email) VALUES ($1,'correction@example.invalid');
    `, [ids.client]);
    await db.query(`INSERT INTO public.commerce_orders(id,client_id,order_number,status,currency,subtotal_cents,tax_cents,total_cents)
      VALUES($1,$2,'MANAGED-CORRECTION','paid','XTS',1080,80,1080)`, [ids.order, ids.client]);
    if (initialStatus === "issue_requested") {
      await db.query(`INSERT INTO public.commerce_order_items(order_id,quantity,unit_price_cents,total_cents,discount_allocated_cents,effective_total_cents,effective_net_cents,vat_rate_bps,allocation_ordinal,product_snapshot)
        VALUES($1,1,1080,1080,0,1080,1000,800,1,'{"name":"Saved product"}')`, [ids.order]);
      await db.query("INSERT INTO public.commerce_payments(id,order_id,provider,status,amount_cents,currency) VALUES('b6900000-0000-4000-8000-000000000009',$1,'test_provider','succeeded',1080,'XTS')", [ids.order]);
      await db.query("INSERT INTO public.commerce_payment_intents(id,target_kind,order_id,payment_id,status,amount_cents,currency) VALUES('b7000000-0000-4000-8000-000000000010','one_time_order',$1,'b6900000-0000-4000-8000-000000000009','succeeded',1080,'XTS')", [ids.order]);
    }
    await db.query(`INSERT INTO public.accounting_invoices(id,order_id,order_ref,invoice_ref,status,currency,buyer_snapshot,order_snapshot,tax_snapshot,lines_snapshot,total_net_cents,total_gross_cents,provider_kind,provider_invoice_id,document_kind,ksef_required,ksef_status,email_status,correction_status)
      VALUES($1,$2,'MANAGED-CORRECTION','MANAGED-CORRECTION:base',$3,'XTS','{"name":"Saved buyer"}','{}','{}','[{"name":"Saved item","quantity":1,"totalGrossMinor":1080,"vatRate":"8"}]',1000,1080,'test_provider',$4,'b2c_named',false,'not_required','sent',$5)`,[ids.invoice,ids.order,initialStatus,initialStatus === 'issue_requested' ? null : 'parent',initialStatus === 'correction_requested' ? 'requested' : 'none']);
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
  }, { readSeller: async () => ({kind:"found",seller:managedSeller,revisionRef:"managed-first"}) });
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
  }, { readSeller: async () => ({kind:"found",seller:managedSeller,revisionRef:"managed-first"}) });
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

// PART B: all managed seller seams execute the actual adapter and pinned SQL.
const sellerArms = ["paid lock refusal", "handoff lock refusal", "lock contention", "paid", "handoff", "correction", "order reversal", "old reversal", "preissue reversal", "exact replay", "key conflict", "evidence conflict", "frozen retry", "correction legacy retry", "issue legacy retry", "unknown", "unsupported", "scoped correction", "rollback"] as const;
it.each(sellerArms)("P7 installed managed seller adapter: %s", async arm => seeded(async db => {
  const snapshot = async () => (await db.query(`SELECT to_jsonb(i) invoice,
    (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.id),'[]') FROM public.accounting_invoice_correction_outbox o WHERE o.invoice_id=i.id) corrections,
    (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.obligation_id),'[]') FROM public.invoicing_managed_seller_revisions s WHERE s.invoice_id=i.id) revisions
    FROM public.accounting_invoices i WHERE i.id=$1`, [ids.invoice])).rows;
  let revision = "managed-first";
  let requestCalls = 0;
  const adapter = (selection: "found" | "unknown" | "unsupported" = "found") => createSupabaseAccountingInvoicePort({
    async rpc(name, params) {
      requestCalls++;
      await db.query("SAVEPOINT adapter_rpc");
      try {
        const result = await db.query(`SELECT public.${name}(${Object.keys(params).map((key,i)=>`${key} => $${i+1}`).join(",")}) result`, Object.values(params));
        await db.query("RELEASE SAVEPOINT adapter_rpc");
        return { data: result.rows[0].result, error: null };
      } catch (error) {
        await db.query("ROLLBACK TO adapter_rpc");
        await db.query("RELEASE SAVEPOINT adapter_rpc");
        return { data: null, error: { code: (error as { code?: string }).code } };
      }
    },
  }, { readSeller: async () => selection === "found" ? { kind: "found", seller: { ...managedSeller, name: revision === "managed-first" ? managedSeller.name : "Changed seller" }, revisionRef: revision }
    : selection === "unknown" ? { kind: "unknown", code: "unknown" } : { kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false } });
  if (arm === "unknown" || arm === "unsupported" || arm === "scoped correction") {
    const before = await snapshot(), port = adapter(arm === "unknown" ? "unknown" : arm === "unsupported" ? "unsupported" : "found");
    await expect(arm === "scoped correction" ? port.claimInvoiceCorrections(1, { orderId: ids.order }) : port.claimInvoiceIssues(1, { orderId: ids.order }))
      .rejects.toMatchObject({ causeCode: arm === "unknown" ? "unknown" : "unsupported" });
    expect(await snapshot()).toEqual(before);
    return;
  }
  await db.query("DELETE FROM public.accounting_invoice_correction_outbox WHERE invoice_id=$1", [ids.invoice]);
  const port = adapter();
  const issue = arm.endsWith("lock refusal") || arm === "lock contention" || arm === "paid" || arm === "handoff" || arm === "issue legacy retry";
  let invoiceId: string = ids.invoice;
  let obligation: string;
  const payload = { originalEvidence: "saved-payload", source: "contract-source" };
  const scaffold = { invoiceId, reason: "manual-reversal", providerKind: "test_provider", payload };
  if (issue) {
    await db.query("DELETE FROM public.accounting_invoices WHERE id=$1", [ids.invoice]);
    const address = "b6500000-0000-4000-8000-000000000005", payment = "b6600000-0000-4000-8000-000000000006", intent = "b6700000-0000-4000-8000-000000000007";
    await db.query("INSERT INTO public.addresses(id,client_id,kind,line1,city,postal_code,country) VALUES($1,$2,'both','Buyer street','Buyer city','54321','XX')", [address,ids.client]);
    await db.query("UPDATE public.commerce_orders SET shipping_address_id=$2 WHERE id=$1", [ids.order,address]);
    await db.query(`INSERT INTO public.commerce_order_items(order_id,quantity,unit_price_cents,total_cents,discount_allocated_cents,effective_total_cents,effective_net_cents,vat_rate_bps,allocation_ordinal,product_snapshot)
      VALUES($1,1,1080,1080,0,1080,1000,800,1,'{"name":"Saved product"}')`, [ids.order]);
    await db.query("INSERT INTO public.commerce_payments(id,order_id,provider,status,amount_cents,currency) VALUES($1,$2,'test_provider','succeeded',1080,'XTS')", [payment,ids.order]);
    await db.query("INSERT INTO public.commerce_payment_intents(id,target_kind,order_id,payment_id,status,amount_cents,currency) VALUES($1,'one_time_order',$2,$3,'succeeded',1080,'XTS')", [intent,ids.order,payment]);
    if (arm === "handoff" || arm === "lock contention" || arm.endsWith("lock refusal")) {
      const fulfillment = "b6800000-0000-4000-8000-000000000008";
      await db.query(`INSERT INTO public.commerce_fulfillment_orders(id,order_id,client_id,shipping_address_id,create_idempotency_key,status,shipping_address_snapshot,handed_over_at)
        VALUES($1,$2,$3,$4,'fulfillment-key','handed_over','{}','2026-10-20T11:12:13Z')`, [fulfillment,ids.order,ids.client,address]);
      if (arm.endsWith("lock refusal")) {
        const locker = await pool.connect();
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        const kind = arm === "paid lock refusal" ? "paid" : "handoff";
        const diagnostic = {
          kind: "refused", name: "AccountingInvoicePersistenceError", causeCode: "55P03",
          sourceKind: kind, sourceId: kind === "paid" ? ids.order : fulfillment,
          retryable: true, effectMayHaveSucceeded: false,
        };
        const noEffects = async () => {
          expect((await db.query("SELECT id FROM public.accounting_invoices WHERE order_id=$1", [ids.order])).rows).toEqual([]);
          expect((await db.query("SELECT id FROM public.accounting_invoice_issue_outbox")).rows).toEqual([]);
          expect((await db.query("SELECT obligation_id FROM public.invoicing_managed_seller_revisions")).rows).toEqual([]);
        };
        try {
          // Block the sidecar INSERT after the incumbent wrote invoice/outbox.
          await locker.query("BEGIN; LOCK TABLE public.invoicing_managed_seller_revisions IN SHARE MODE");
          const dispatched = { kind: "completed" as const, detail: { fulfillmentOrderId: fulfillment } };
          const dispatch = vi.fn(async () => dispatched);
          const trigger = withAutoDispatchAccountingInvoiceTrigger({ ensureFulfilledFromPaidOrder: dispatch }, {
            accountingPort: port, providerKind: "test_provider", issueTrigger: kind,
          });
          expect(await trigger.ensureFulfilledFromPaidOrder({ orderUuid: ids.order, outboxEventId: "paid-event", signal: new AbortController().signal })).toBe(dispatched);
          expect(dispatch).toHaveBeenCalledTimes(1);
          expect(requestCalls).toBe(1);
          expect(warning).toHaveBeenCalledExactlyOnceWith("[accounting] invoice request refused", diagnostic);
          await noEffects();
          if (kind === "handoff") {
            warning.mockClear();
            const handedOver = { ok: true };
            const handoff = vi.fn(async (_request: { idempotencyKey: string; fulfillmentOrderId: string; actorUserId: string }) => handedOver);
            const operator = withAccountingInvoiceShadowTrigger({ handOffCommerceFulfillmentOrder: handoff }, {
              accountingPort: port, providerKind: "test_provider",
            });
            expect(await operator.handOffCommerceFulfillmentOrder({ idempotencyKey: "operator-key", fulfillmentOrderId: fulfillment, actorUserId: "operator" })).toBe(handedOver);
            expect(handoff).toHaveBeenCalledTimes(1);
            expect(requestCalls).toBe(2);
            expect(warning).toHaveBeenCalledExactlyOnceWith("[accounting] invoice request refused", diagnostic);
            await noEffects();
          }
        } finally { warning.mockRestore(); await locker.query("ROLLBACK"); locker.release(); }
        return;
      }
      if (arm === "lock contention") {
        const effects = async () => (await db.query(`SELECT
          (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM public.accounting_invoices i) invoices,
          (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM public.accounting_invoice_issue_outbox o) issues,
          (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM public.accounting_invoice_correction_outbox o) corrections,
          (SELECT jsonb_agg(to_jsonb(s) ORDER BY obligation_kind,obligation_id) FROM public.invoicing_managed_seller_revisions s) revisions`)).rows;
        const before = await effects(), locker = await pool.connect();
        try {
          // Compatible with this fixture's reads; blocks the wrapper's INSERT.
          await locker.query("BEGIN; LOCK TABLE public.invoicing_managed_seller_revisions IN SHARE MODE");
          for (const request of [
            () => port.requestInvoiceIssueFromPaidOrder({ idempotencyKey: "paid-busy", orderId: ids.order, providerKind: "test_provider" }),
            () => port.requestInvoiceIssueFromFulfillmentHandoff({ idempotencyKey: "handoff-request-key", fulfillmentOrderId: fulfillment, providerKind: "test_provider" }),
          ]) {
            await expect(request()).rejects.toMatchObject({ name: "AccountingInvoicePersistenceError", causeCode: "55P03" });
            const handler = createFulfillmentHandoffInvoiceHandler({
              descriptor: { eventType: "contract", timeoutMs: 10000 },
              parsePayload: () => ({ success: true, data: {} }), decide: async () => ({ issue: true, action: "issue", detail: {} }),
              request: async () => ({ invoice: (await request()).invoice }), errorDetails: error => ({ message: (error as Error).message,
                causeCode: error instanceof AccountingInvoicePersistenceError ? error.causeCode : undefined }),
            });
            expect(await handler.handle({ payload: {} }, new AbortController().signal)).toMatchObject({ kind: "retry", reason: expect.stringContaining("55P03") });
            expect(await effects()).toEqual(before);
          }
        } finally { await locker.query("ROLLBACK"); locker.release(); }
        const paid = await port.requestInvoiceIssueFromPaidOrder({ idempotencyKey: "paid-busy", orderId: ids.order, providerKind: "test_provider" });
        expect(paid.invoice).toMatchObject({ replayed: false });
        const stable = await effects();
        expect(await port.requestInvoiceIssueFromPaidOrder({ idempotencyKey: "paid-busy", orderId: ids.order, providerKind: "test_provider" })).toEqual(paid);
        expect(await effects()).toEqual(stable);
      }
      invoiceId = (await port.requestInvoiceIssueFromFulfillmentHandoff({ idempotencyKey: "handoff-request-key", fulfillmentOrderId: fulfillment, providerKind: "test_provider" })).invoice.id;
    } else invoiceId = (await port.requestInvoiceIssueFromPaidOrder({ idempotencyKey: "paid-request-key", orderId: ids.order, providerKind: "test_provider" })).invoice.id;
    obligation = (await db.query("SELECT id FROM public.accounting_invoice_issue_outbox WHERE invoice_id=$1", [invoiceId])).rows[0].id;
  } else if (arm.includes("reversal")) {
    if (arm === "old reversal") await db.query("SELECT public.accounting_invoice_request_reversal_from_order_status('old-reversal-key',$1,'order_refunded',$2,'test_provider')", [ids.order,payload]);
    const result = await port.requestInvoiceReversalFromOrderStatus({ idempotencyKey: "order-reversal-key", orderId: ids.order, reason: "order_refunded", payload, providerKind: "test_provider" });
    expect(result).toMatchObject({ action: arm === "preissue reversal" ? "voided" : "correction_requested", invoice: { id: invoiceId } });
    if (arm === "preissue reversal") {
      expect((await db.query("SELECT status,provider_invoice_id FROM public.accounting_invoices WHERE id=$1", [invoiceId])).rows).toEqual([{ status: "voided", provider_invoice_id: null }]);
      expect((await db.query("SELECT * FROM public.invoicing_managed_seller_revisions WHERE invoice_id=$1", [invoiceId])).rows).toEqual([]);
      expect((await db.query("SELECT id FROM public.accounting_invoice_correction_outbox WHERE invoice_id=$1", [invoiceId])).rows).toEqual([]);
      return;
    }
    obligation = (await db.query("SELECT id FROM public.accounting_invoice_correction_outbox WHERE invoice_id=$1", [invoiceId])).rows[0].id;
    expect((await db.query("SELECT payload FROM public.accounting_invoice_correction_outbox WHERE id=$1", [obligation])).rows[0].payload).toMatchObject({ ...payload, source: "order_status_reversal" });
  } else {
    const created = await port.requestCorrectionScaffold(scaffold);
    obligation = created.correctionOutbox.id;
    expect(created).toMatchObject({ correctionOutbox: { id: obligation, invoiceId } });
  }
  const kind = issue ? "issue" : "correction";
  const revisions = async () => (await db.query("SELECT revision_ref,seller_facts,capture_generation FROM public.invoicing_managed_seller_revisions WHERE obligation_kind=$1 AND obligation_id=$2", [kind,obligation])).rows;
  expect(await revisions()).toEqual(arm === "old reversal" ? [] : [{ revision_ref: null, seller_facts: null, capture_generation: null }]);
  if (arm === "exact replay" || arm === "key conflict" || arm === "evidence conflict") {
    const before = await snapshot();
    if (arm === "exact replay") expect(await port.requestCorrectionScaffold(scaffold)).toMatchObject({ correctionOutbox: { id: obligation, invoiceId } });
    else {
      if (arm === "key conflict") await db.query("UPDATE public.accounting_invoice_correction_outbox SET payload=jsonb_set(payload,'{sellerRequestKey}','\"different-key\"') WHERE id=$1", [obligation]);
      const stable = await snapshot();
      await expect(port.requestCorrectionScaffold(arm === "evidence conflict" ? { ...scaffold, payload: { ...payload, originalEvidence: "changed" } } : scaffold))
        .rejects.toMatchObject({ name: "AccountingControlConflictError", details: { code: "identity_mismatch" } });
      expect(await snapshot()).toEqual(stable);
      return;
    }
    expect(await snapshot()).toEqual(before);
  }
  const claim = () => issue ? port.claimInvoiceIssues(1, { orderId: ids.order }) : port.claimInvoiceCorrections(1);
  const outbox = issue ? "accounting_invoice_issue_outbox" : "accounting_invoice_correction_outbox";
  if (arm === "correction legacy retry" || arm === "issue legacy retry") {
    await db.query(issue ? "SELECT public.accounting_invoice_issue_outbox_claim(1,300,$1,'accounting.issue.v2')" : "SELECT public.accounting_invoice_correction_outbox_claim(1,300,'accounting.correction.v2')", issue ? [ids.order] : []);
    await db.query(`UPDATE public.${outbox} SET next_attempt_at=now()-interval '1 second' WHERE id=$1`, [obligation]);
  }
  await db.query("SAVEPOINT seller_claim");
  const [first] = await claim();
  const legacy = arm === "old reversal" || arm === "correction legacy retry" || arm === "issue legacy retry";
  expect(first).toMatchObject({ outboxId: obligation, attemptCount: arm.endsWith("legacy retry") ? 2 : 1, seller: managedSeller, sellerRevision: "managed-first", sellerMode: legacy ? "legacy_fallback" : "frozen" });
  expect((await db.query(`SELECT status,attempt_count FROM public.${outbox} WHERE id=$1`, [obligation])).rows).toEqual([{ status: "processing", attempt_count: first!.attemptCount }]);
  if (arm === "rollback") {
    await db.query("ROLLBACK TO seller_claim");
    expect(await revisions()).toEqual([{ revision_ref: null, seller_facts: null, capture_generation: null }]);
    expect((await db.query(`SELECT status,attempt_count FROM public.${outbox} WHERE id=$1`, [obligation])).rows).toEqual([{ status: "pending", attempt_count: 0 }]);
    return;
  }
  expect(await revisions()).toEqual(arm === "old reversal" ? [] : [{ revision_ref: legacy ? null : "managed-first", seller_facts: legacy ? null : managedSeller, capture_generation: legacy ? null : 1 }]);
  await db.query(`UPDATE public.${outbox} SET next_attempt_at=now()-interval '1 second' WHERE id=$1`, [obligation]);
  revision = "managed-next";
  expect(await claim()).toMatchObject([{ outboxId: obligation, attemptCount: first!.attemptCount + 1,
    seller: legacy ? { ...managedSeller, name: "Changed seller" } : managedSeller, sellerRevision: legacy ? revision : "managed-first", sellerMode: legacy ? "legacy_fallback" : "frozen" }]);
  expect((await db.query(`SELECT status,attempt_count FROM public.${outbox} WHERE id=$1`, [obligation])).rows).toEqual([{ status: "processing", attempt_count: first!.attemptCount + 1 }]);
  expect(await revisions()).toEqual(arm === "old reversal" ? [] : [{ revision_ref: legacy ? null : "managed-first", seller_facts: legacy ? null : managedSeller, capture_generation: legacy ? null : 1 }]);
}, arm === "preissue reversal" ? "issue_requested" : "issued"));
