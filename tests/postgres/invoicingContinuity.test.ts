/** W7 D7/F13: real native continuity; synthetic facts/provider proof, no live I/O. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresPaymentTruthPort } from "@openlup/platform/payments";
import { createInvoicingDutyBinding } from "../../server/runtime/accounting/invoicingDutyBinding.js";
import { composeOrderPaidFulfillmentPort } from "../../api/_cron/outboxFulfillmentProvider.js";
import { closeOrderPaidShipmentSpinePort } from "../../server/runtime/fulfillment/shipmentSpineBinding.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined, pool: Pool;
const env = () => ({ PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: container!.connectionString, FULFILLMENT_PORT_KEY: "simulator", ACCOUNTING_REQUEST_ENABLED: "false" });
const truth = () => createPostgresPaymentTruthPort({ query: (text, values) => pool.query(text, values) }, {
  dunningTemplateSlug: "payment_failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "payment_recovered",
});
async function call(name: string, args: unknown[]) {
  return (await pool.query(`SELECT public.${name}(${args.map((_, i) => `$${i+1}`).join(",")}) AS result`, args)).rows[0].result;
}
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Invoicing continuity requires Docker PostgreSQL");
  container = await runPostgresContainer({ name: `invoicing-continuity-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Invoicing PostgreSQL unavailable");
  pool = new Pool({ connectionString: container.connectionString, statement_timeout: 5000 });
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  for (const unit of [manifest.baseline, ...manifest.forward]) {
    const bytes = readFileSync(unit.file);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(unit.sha256);
    await pool.query(bytes.toString());
  }
  await pool.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES ('simulator','simulator',true)");
  const db = await pool.connect();
  try { expect(createHash("sha256").update(selectedCatalogProjectionPayload(await readSelectedCatalogProjection(db))).digest("hex")).toBe(manifest.objectInventorySha256); }
  finally { db.release(); }
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

async function fixture(subscriptionDate?: string) {
  const client = randomUUID(), order = randomUUID(), intent = randomUUID();
  const subscription = randomUUID(), cycle = randomUUID();
  await pool.query("INSERT INTO public.clients(id,email) VALUES ($1,$2)", [client, `${client}@example.invalid`]);
  if (subscriptionDate) {
    await pool.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES ($1,$2,28,$3)", [subscription, client, subscriptionDate]);
    await pool.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at) VALUES ($1,$2,'2026-08-01T12:00:00Z')", [cycle, subscription]);
  }
  const db = await pool.connect();
  try {
  await db.query("BEGIN");
  await db.query("INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,currency_code,total_amount_minor) VALUES ($1,$2,$3,'XXX',900)", [order, client, subscriptionDate ? cycle : null]);
  await db.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES ($1,1,1,900,900)", [order]);
  await db.query("INSERT INTO public.commerce_settlement_intents(id,order_id,channel_key,amount_minor,currency_code,open_idempotency_key) VALUES ($1,$2,'provider-a',900,'XXX',$3)", [intent, order, `open-${intent}`]);
  await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  const input = {
    sourceEventId: `provider-a:${intent}`, idempotencyKey: `event-${intent}`, settlementIntentId: intent,
    outcome: "captured" as const, amountMinor: 900, currency: "XXX", occurredAt: "2026-08-12T12:00:00.000Z", failure: null,
    evidence: { sourceKind: "accepted_event" as const, sourceReference: `provider-a:${intent}`,
      observedStatus: "captured", observedAt: "2026-08-12T12:00:00.000Z", payloadFingerprint: "a".repeat(64) },
  };
  return { input, order, subscription, cycle };
}


async function installAndIssue(orderId: string) {
  const read = await call("invoicing_duty_readback", [orderId]);
  expect(read.duties).toHaveLength(1);
  const dutyId = read.duties[0].dutyId;
  const saved = {
    factRevision: "revision-a", policyVersion: "policy-a",
    refs: { orderId, orderRef: "EXAMPLE/1", invoiceRef: "invoice-a" },
    dates: { issueDate: "2026-10-22", sellDate: "2026-10-22" },
    buyer: { name: "Example buyer" }, currency: "XXX",
    totalNetMinor: 750, totalTaxMinor: 150, totalGrossMinor: 900,
    lines: [{ description: "Example item", quantity: 1, unitNetMinor: 750,
      unitGrossMinor: 900, totalNetMinor: 750, totalTaxMinor: 150,
      totalGrossMinor: 900, taxRateBps: 2000 }],
  };
  await call("invoicing_install_facts", [dutyId, saved, "revision-a"]);
  const binding = createInvoicingDutyBinding(env())!;
  try { expect(await binding.collect()).toMatchObject({ kind: "collected", failures: 0 }); }
  finally { await closePostgres(undefined, undefined, [() => binding.close()]); }
  const [claim] = await call("invoicing_claim_duties", [10, 300, "fiscal-a", orderId]);
  expect(claim.id).toBe(dutyId);
  expect(await call("invoicing_preflight_duty", [dutyId, claim.claim_token, claim.generation, { kind: "observed", outcome: "captured", amountMinor: 900, currency: "XXX" }])).toEqual({ kind: "ready" });
  const args = [dutyId, claim.claim_token, claim.generation, `external:${dutyId}`, "EXAMPLE/1", { kind: "issued", externalId: `external:${dutyId}`, providerCreateIdentity: `invoicing:${dutyId}` }];
  expect(await call("invoicing_finish_issue", args)).toEqual({ kind: "issued", replayed: false });
  expect(await call("invoicing_finish_issue", args)).toEqual({ kind: "issued", replayed: true });
  expect((await call("invoicing_duty_readback", [orderId])).duties[0].state).toBe("issued");
  expect((await pool.query("SELECT * FROM public.accounting_documents WHERE order_id=$1", [orderId])).rows).toHaveLength(1);
}

it("W7: locked accounting never gates renewal capture, recovery, parcel handoff or monotonic cycle; late repair issues once", async () => {
  const f = await fixture("2026-08-29T12:00:00Z");
  await truth().ingestEvent({ ...f.input, outcome: "refused", failure: { classification: "authorization_refused", reason: "refused" } });
  const lock = await pool.connect();
  const port = composeOrderPaidFulfillmentPort({ client: {} as never, env: env(), fulfillmentReady: true });
  try {
    await lock.query("BEGIN");
    await lock.query("LOCK TABLE public.accounting_documents IN SHARE MODE");
    const input = { ...f.input, sourceEventId: `${f.input.sourceEventId}:recovery`, idempotencyKey: `${f.input.idempotencyKey}:recovery` };
    expect(await truth().ingestEvent(input)).toMatchObject({ event: { state: "settled" }, effects: { accountingRequested: false }, financial: { orderStatus: "paid" } });
    expect(await truth().ingestEvent(input)).toMatchObject({ event: { replayed: true } });
    await expect(port!.ensureFulfilledFromPaidOrder({ orderUuid: f.order, outboxEventId: randomUUID(), signal: new AbortController().signal })).resolves.toMatchObject({ kind: "completed" });
    expect((await pool.query("SELECT status FROM public.subscription_dunning_cases WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{ status: "recovered" }]);
    expect((await pool.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].next_cycle_at.toISOString()).toBe("2026-09-09T12:00:00.000Z");
  } finally { await lock.query("ROLLBACK"); lock.release(); await closePostgres(undefined, undefined, [() => closeOrderPaidShipmentSpinePort(port)]); }
  // Paid + handoff aliases converge, no duplicate duty/document on repeated sweep.
  const binding = createInvoicingDutyBinding(env())!;
  try { await binding.collect(); await binding.collect(); } finally { await closePostgres(undefined, undefined, [() => binding.close()]); }
  await installAndIssue(f.order);
}, 20_000);

it("F13: capture conflicts, cancellation and permission errors cannot roll back settled renewal recovery", async () => {
  for (const code of ["23505", "57014", "42501"]) {
    const f = await fixture("2026-08-29T12:00:00Z");
    await truth().ingestEvent({ ...f.input, outcome: "refused", failure: { classification: "authorization_refused", reason: "refused" } });
    await pool.query(`CREATE OR REPLACE FUNCTION public.p4b_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_capture_failure' USING ERRCODE='${code}'; END $$`);
    await pool.query("CREATE TRIGGER p4b_fault BEFORE INSERT ON public.invoicing_duties FOR EACH ROW EXECUTE FUNCTION public.p4b_fault()");
    const input = { ...f.input, sourceEventId: `${f.input.sourceEventId}:recovery`, idempotencyKey: `${f.input.idempotencyKey}:recovery` };
    try {
      expect(await truth().ingestEvent(input)).toMatchObject({ event: { state: "settled" }, effects: { accountingRequested: false }, financial: { orderStatus: "paid" } });
      expect((await pool.query("SELECT status FROM public.subscription_dunning_cases WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{ status: "recovered" }]);
      expect((await call("invoicing_duty_readback", [f.order])).captureFaults).toHaveLength(1);
    } finally { await pool.query("DROP TRIGGER p4b_fault ON public.invoicing_duties"); await pool.query("DROP FUNCTION public.p4b_fault()"); }
    const binding = createInvoicingDutyBinding(env())!;
    try { expect(await binding.collect()).toMatchObject({ kind: "collected", failures: 0 }); }
    finally { await closePostgres(undefined, undefined, [() => binding.close()]); }
    await installAndIssue(f.order);
    expect(await truth().ingestEvent(input)).toMatchObject({ event: { replayed: true } });
  }
}, 20_000);

it("F13: capture and fault-marker locks still commit money; retained settlement recovers after locks release", async () => {
  const f = await fixture("2026-08-29T12:00:00Z"), lock = await pool.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("LOCK TABLE public.invoicing_duties, public.invoicing_capture_faults IN ACCESS EXCLUSIVE MODE");
    expect(await truth().ingestEvent(f.input)).toMatchObject({ event: { state: "settled" }, financial: { orderStatus: "paid" } });
    expect((await pool.query("SELECT * FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'", [f.input.settlementIntentId])).rows).toHaveLength(1);
  } finally { await lock.query("ROLLBACK"); lock.release(); }
  const binding = createInvoicingDutyBinding(env())!;
  try { expect(await binding.collect()).toMatchObject({ kind: "collected", failures: 0 }); }
  finally { await closePostgres(undefined, undefined, [() => binding.close()]); }
  await installAndIssue(f.order);
}, 20_000);
