import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { OMS_OPERATIONAL_LADDER, OMS_ATTENTION_PRIORITY_LADDER, OMS_ATTENTION_PRIORITY_FALLBACK_RANK, resolveOmsOperationalState } from "@openlup/platform/commerce";
import type { OmsOperationalLadderInput } from "@openlup/platform/commerce/contracts";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined;
let pool: Pool;
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("OMS queue ladder store proof requires Docker PostgreSQL");
  container = await runPostgresContainer({ name: `openlup-k3a-queue-${process.pid}-${randomUUID().slice(0, 8)}`, password: "example-ephemeral-proof" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("OMS queue ladder PostgreSQL did not become TCP-ready");
  pool = new Pool({ connectionString: container.connectionString });
  // Test-only managed-platform environment, demanded by replay. These stand in
  // for the managed identity namespace/roles; no commerce or queue object is faked.
  await pool.query(`CREATE EXTENSION pg_trgm WITH SCHEMA public;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE ROLE openlup_mcp_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.sub', true), ''), NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
    $$;`);
  for (const name of readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort()) {
    // psql's transport-only restriction directives are not SQL. This is the
    // same PG driver loading convention as the managed correction store proof.
    await pool.query(readFileSync(`supabase/migrations/${name}`, "utf8").replace(/^\\(?:un)?restrict .*$/gmu, ""));
  }
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

const good: OmsOperationalLadderInput = { orderStatus: "paid", activeHoldCount: 0, paymentStatus: "succeeded", hasShippingAddress: true, inventoryStatus: "reserved", fulfillmentStatus: "in_transit", fulfillmentAllowed: true, accountingStatus: "issued" };
const cases: Array<{ rung: string; facts: OmsOperationalLadderInput }> = [
  { rung: "terminal_order", facts: { ...good, orderStatus: "cancelled", fulfillmentAllowed: false } },
  { rung: "terminal_order", facts: { ...good, orderStatus: "refunded", fulfillmentAllowed: false } },
  { rung: "active_hold", facts: { ...good, activeHoldCount: 1, fulfillmentAllowed: false } },
  { rung: "payment_not_succeeded", facts: { ...good, paymentStatus: "not_started", fulfillmentAllowed: false, accountingStatus: "missing" } },
  { rung: "missing_shipping_address", facts: { ...good, hasShippingAddress: false, fulfillmentAllowed: false } },
  { rung: "inventory_not_held", facts: { ...good, inventoryStatus: "missing", fulfillmentAllowed: false } },
  { rung: "fulfillment_absent_and_blocked", facts: { ...good, orderStatus: "draft", fulfillmentStatus: null, fulfillmentAllowed: false } },
  { rung: "fulfillment_absent", facts: { ...good, fulfillmentStatus: null } },
  ...(["created", "packed", "label_pending"] as const).map(fulfillmentStatus => ({ rung: "fulfillment_before_label", facts: { ...good, fulfillmentStatus } })),
  { rung: "fulfillment_label_created", facts: { ...good, fulfillmentStatus: "label_created" } },
  { rung: "fulfillment_exception", facts: { ...good, fulfillmentStatus: "exception" } },
  { rung: "accounting_missing", facts: { ...good, accountingStatus: "missing" } },
  { rung: "accounting_blocked", facts: { ...good, accountingStatus: "blocked" } },
  { rung: "accounting_issue_failed", facts: { ...good, accountingStatus: "rejected" } },
  { rung: "accounting_issue_failed", facts: { ...good, accountingStatus: "outbox_failed" } },
  { rung: "fallback", facts: good },
];

interface Queue { orderIds: string[]; totalCount: number }
async function queue(filters: { attention?: string; action?: string; status?: string; payment?: string; fulfillment?: string; inventory?: string; accounting?: string } = {}): Promise<Queue> {
  return (await pool.query(`SELECT public.commerce_oms_admin_list_queue(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) AS value`,
  [1, 100, "OPENLUP-OMS-LADDER", filters.status ?? null, null, filters.payment ?? null, filters.fulfillment ?? null, filters.inventory ?? null, filters.accounting ?? null, null, filters.attention ?? null, false, filters.action ?? null, null, null, "attention_priority_desc", false])).rows[0].value;
}

it("pairs every real managed queue rung, next action and attention-priority rank with TypeScript", async () => {
  const client = randomUUID(), address = randomUUID(), location = randomUUID(), product = randomUUID(), sku = randomUUID();
  await pool.query("INSERT INTO public.clients(id,email) VALUES($1,'queue@example.invalid')", [client]);
  await pool.query("INSERT INTO public.addresses(id,client_id,kind,line1,city,postal_code,country) VALUES($1,$2,'shipping','Example Road','Example City','00000','XX')", [address, client]);
  await pool.query("INSERT INTO public.inventory_locations(id,code,display_name,kind,status,region,fulfillable) VALUES($1,'example-queue','Example queue','internal_warehouse','active','XX',true)", [location]);
  await pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'example-queue','Example queue')", [product]);
  await pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,pet_type,net_weight_g,kcal_per_unit) VALUES($1,$2,'OPENLUP-EXAMPLE','Example item','other',100,1)", [sku, product]);
  const seeded: Array<{ id: string; at: number; facts: OmsOperationalLadderInput }> = [];
  for (const [index, { rung, facts }] of cases.entries()) {
    expect(OMS_OPERATIONAL_LADDER.find(candidate => candidate.matches(facts))?.id ?? "fallback").toBe(rung);
    const id = randomUUID(), item = randomUUID(), at = Date.parse("2030-01-01T00:00:00Z") + index * 1000;
    await pool.query("INSERT INTO public.commerce_orders(id,client_id,order_number,status,mode,currency,region_code,shipping_address_id,created_at,updated_at,subtotal_cents,total_cents) VALUES($1,$2,$3,$4,'one_time','XXX','XX',$5,$6,$6,1,1)", [id, client, `OPENLUP-OMS-LADDER-${index}`, facts.orderStatus, facts.hasShippingAddress ? address : null, new Date(at)]);
    await pool.query("INSERT INTO public.commerce_order_items(id,order_id,sku_id,quantity,unit_price_cents,total_cents,discount_allocated_cents,effective_total_cents,effective_net_cents,vat_rate_bps) VALUES($1,$2,$3,1,1,1,0,1,1,0)", [item, id, sku]);
    if (facts.paymentStatus === "succeeded") {
      const payment = randomUUID();
      await pool.query("INSERT INTO public.commerce_payments(id,order_id,provider,status,amount_cents,currency) VALUES($1,$2,'example','succeeded',1,'XXX')", [payment, id]);
      await pool.query("INSERT INTO public.commerce_payment_intents(order_id,payment_id,target_kind,status,amount_cents,currency) VALUES($1,$2,'one_time_order','succeeded',1,'XXX')", [id, payment]);
    }
    if (facts.activeHoldCount) await pool.query("INSERT INTO public.commerce_order_holds(order_id,reason,status) VALUES($1,'manual_support','active')", [id]);
    if (facts.inventoryStatus === "reserved") await pool.query("INSERT INTO public.inventory_reservations(idempotency_key,order_id,sku_id,location_id,order_item_id,quantity,status,kind) VALUES($1,$2,$3,$4,$5,1,'reserved','manual_ops')", [`example-${id}`, id, sku, location, item]);
    if (facts.fulfillmentStatus) await pool.query("INSERT INTO public.commerce_fulfillment_orders(order_id,shipping_address_id,create_idempotency_key,status,shipping_address_snapshot) VALUES($1,$2,$3,$4,'{}')", [id, address, `example-${id}`, facts.fulfillmentStatus]);
    if (facts.accountingStatus !== "missing") {
      const invoice = randomUUID();
      await pool.query("INSERT INTO public.accounting_invoices(id,order_id,order_ref,invoice_ref,status,currency,buyer_snapshot,order_snapshot,tax_snapshot,lines_snapshot,total_net_cents,total_gross_cents) VALUES($1,$2,$3,$3,$4,'XXX','{}','{}','{}','[]',1,1)", [invoice, id, `example-${id}`, facts.accountingStatus === "outbox_failed" ? "issued" : facts.accountingStatus]);
      if (facts.accountingStatus === "outbox_failed") await pool.query("INSERT INTO public.accounting_invoice_issue_outbox(invoice_id,provider_kind,status) VALUES($1,'example','failed')", [invoice]);
    }
    seeded.push({ id, at, facts });
  }
  expect(new Set(cases.map(row => row.rung))).toEqual(new Set([...OMS_OPERATIONAL_LADDER.map(row => row.id), "fallback"]));
  // The RPC exposes its derived state through filters, not projected columns.
  // Infer each SQL classification from membership in every attention/action
  // partition; no copied CASE expression stands in for the installed function.
  const states = seeded.map(row => resolveOmsOperationalState(row.facts));
  for (const attention of new Set(states.map(state => state.attentionReason))) {
    expect(new Set((await queue({ attention })).orderIds)).toEqual(new Set(seeded.filter((_, i) => states[i]!.attentionReason === attention).map(row => row.id)));
  }
  for (const action of new Set(states.map(state => state.nextAction))) {
    expect(new Set((await queue({ action })).orderIds)).toEqual(new Set(seeded.filter((_, i) => states[i]!.nextAction === action).map(row => row.id)));
  }
  for (const row of seeded) {
    const f = row.facts;
    expect((await queue({ status: f.orderStatus, payment: f.paymentStatus, fulfillment: f.fulfillmentStatus ?? undefined, inventory: f.inventoryStatus, accounting: f.accountingStatus })).orderIds).toContain(row.id);
  }
  const rank = (facts: OmsOperationalLadderInput) => OMS_ATTENTION_PRIORITY_LADDER.find(row => row.attentionReason === resolveOmsOperationalState(facts).attentionReason)?.rank ?? OMS_ATTENTION_PRIORITY_FALLBACK_RANK;
  const expected = [...seeded].sort((a, b) => rank(a.facts) - rank(b.facts) || b.at - a.at).map(row => row.id);
  const actual = await queue();
  expect(actual.totalCount).toBe(cases.length);
  expect(actual.orderIds).toEqual(expected);
}, 30_000);
