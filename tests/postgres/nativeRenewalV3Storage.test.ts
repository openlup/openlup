import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Pool } from "pg";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { connectedStoreRestoreOrder } from "../../server/adapters/postgres/connectedStoreDomains/index.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { installAccountMutations, type AccountMutationsStore } from "./customerAccountMutations.fixture.js";
import { capture, checkMessage, expectSqlError, insert, rejected, seedPrivateFacts, seedSku, transaction, version } from "./orderMoneyV2Storage.fixture.js";
import { AT, call, prepareOriginal, sandboxRenewal, type Renewal } from "./subscriptionNativeFixture.js";

const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest;
if (manifest.schemaVersion !== 3) throw new Error("Complete native catalogue required");
const forward = manifest.forward.find(entry => entry.file.endsWith("_native_renewal_v3_storage.sql"))!;
if (!forward) throw new Error("Renewal storage migration missing");
const shapes = {
  occurrences: "cycle_key subscription_id client_id original_anchor_at effective_due_at cadence_seconds rail lifecycle is_current deadline_rule_ref deadline_rule_revision lead_seconds late_cancel_disposition cancellation_receipt_id cancellation_effective_at operation_id commercial_generation_id",
  delivery_assignments: "obligation_ref assigned_cycle_key marker_cycle_key qualifying_actual_arrival_at applied_due_at",
  generations: "operation_id commercial_generation_id cycle_key agreement agreement_fingerprint claim_token lease_expires_at lease_generation last_binding_seq current_binding_ref first_failure_at failure_cause failure_count next_eligible_at",
  stock_holds: "hold_incarnation_id cycle_key operation_id commercial_generation_id reservation_id expires_at state",
  tax_issuances: "evaluation_id operation_id commercial_generation_id binding_seq hold_incarnation_id issued_calculation_id request_digest request_evidence erased_at",
  tax_bindings: "binding_ref evaluation_id cycle_key operation_id commercial_generation_id binding_seq calculation_id bind_digest accepted_money_digest payable_minor currency tax_point expires_at live_evidence erased_at",
  cases: "case_id operation_id commercial_generation_id case_kind state cause revision opened_at closed_at",
  preparations: "preparation_id cycle_key cycle_id operation_id commercial_generation_id binding_ref binding_seq hold_incarnation_id order_id settlement_intent_id payment_attempt_id opening_key accepted_money_digest prepared_at closed_unsent_at replaces_preparation_id",
  payment_attempts: "payment_attempt_id preparation_id attempt_kind predecessor_attempt_id retry_key recovery_authorization_ref",
  dispatch_grants: "grant_id payment_attempt_id confirmation_step_ref confirmation_kind authorized_hold_ref authorized_hold_expires_at provider_account_ref provider_mode request_digest idempotency_key checked_at send_by notice_decision",
  calculation_rebinds: "rebind_id order_id preparation_id retry_attempt_id sale_key sequence previous_calculation_id effective_calculation_id accepted_money_digest proof_digest rebound_at",
};
const table = (name: keyof typeof shapes) => `subscription_cycle_${name}` as const;
const tables = (Object.keys(shapes) as (keyof typeof shapes)[]).map(table).sort();
const occurrence = table("occurrences");
let store: AccountMutationsStore, renewal: Renewal, prior: Awaited<ReturnType<typeof legacy>>;
let before: unknown, applied: string[];

function incumbent(db: Pool) {
  return db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p WHERE pronamespace='public'::regnamespace) AS routines,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) FROM pg_constraint c
      WHERE connamespace='public'::regnamespace AND NOT (conrelid::regclass::text=ANY($1))) AS constraints,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal) AS attachments,
    (SELECT jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity) ORDER BY c.oid)
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND NOT (c.relname=ANY($1))) AS access`, [tables]).then(r => r.rows);
}

async function legacy(db: Pool, f: Renewal) {
  return {
    claim: await call(db, "subscription_claim_due_renewal", [f.identity, f.fingerprint, f.snapshot, "fixture", 300, AT]),
    prepared: await call(db, "commerce_prepare_subscription_renewal", [f.operation, f.token, AT]),
    readback: await call(db, "subscription_read_renewal", [f.identity]),
    expiry: await call(db, "fulfillment_expire_subscription_renewals", [AT, 100]),
    retry: await call(db, "subscription_retry_candidates", [50, AT]),
    stockWait: await call(db, "subscription_stock_wait_candidates", [50, AT]),
    due: await call(db, "subscription_stock_wait_normal_due", [50, AT]),
  };
}

const rowCensus = (db: Pool) => db.query(`SELECT
  (SELECT count(*) FROM public.commerce_orders) AS orders,
  (SELECT count(*) FROM public.commerce_settlement_intents) AS intents,
  (SELECT count(*) FROM public.payment_provider_attempts) AS attempts,
  (SELECT count(*) FROM public.payment_simulator_attempts) AS simulator_attempts,
  (SELECT count(*) FROM public.commerce_order_draft_receipts) AS checkout,
  (SELECT count(*) FROM public.customer_account_consent_events) AS consents,
  (SELECT count(*) FROM public.communication_recipient_consents) AS communication_consents`).then(result => result.rows);
let census: unknown;

beforeAll(async () => {
  const candidate = structuredClone(manifest);
  for (const plan of [candidate, candidate.qualified, candidate.qualifiedAdmin]) {
    plan.forward = plan.forward.slice(0, plan.forward.findIndex(entry => entry.file === forward.file) + 1);
  }
  candidate.qualified.objectInventorySha256.bootstrapMigrator.withRestore = "0f266e4882cbc9b7e01ddc4779cfcfe170a59eeac638c12ad38a285bad4163c9";
  const prefix = structuredClone(candidate);
  for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) expect(plan.forward.pop()).toEqual(forward);
  prefix.qualified.objectInventorySha256.bootstrapMigrator.withRestore = "6ffc2de73b50852f70c99fb1529521d753e2859a7d1f6e8f618a4aae33f967fb";
  await withPlatformCatalog(candidate, upgrade => withPlatformCatalog(prefix, async root => {
    store = await installAccountMutations("bootstrap", false, "renewal-storage-prefix", root, upgrade);
    renewal = await sandboxRenewal(store.owner);
    await prepareOriginal(store.owner, renewal);
    prior = await legacy(store.runtime, renewal);
    census = await rowCensus(store.owner);
    before = await incumbent(store.owner);
    applied = (await store.runner.apply()).applied;
  }));
}, postgresSetupTimeoutMs);
afterAll(async () => { await store?.close(); }, postgresTeardownTimeoutMs);

it("installs private relations, exact columns, deferred pointers and live indexes without altering incumbent authority", async () => {
  expect(applied).toEqual([forward.file]);
  expect(await incumbent(store.owner)).toEqual(before);
  const columns = await store.owner.query(`SELECT c.relname AS name, array_agg(a.attname::text ORDER BY a.attnum) AS columns,
    c.relowner::regrole::text AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
    FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
      AND c.relname LIKE 'subscription_cycle_%' AND c.relname=ANY($1) AND a.attnum>0 AND NOT a.attisdropped
    GROUP BY c.oid ORDER BY c.relname`, [tables]);
  expect(columns.rows).toEqual(Object.entries(shapes).map(([name, fields]) => ({
    name: `subscription_cycle_${name}`, columns: fields.split(" "), owner: "postgres", rls: true, force: false,
  })).sort((a, b) => a.name.localeCompare(b.name)));
  const keys = await store.owner.query(`SELECT conname AS name, confdeltype::text AS deletion, confupdtype::text AS update,
    condeferrable AS deferrable, condeferred AS deferred FROM pg_constraint WHERE contype='f'
    AND conrelid::regclass::text=ANY($1) ORDER BY conname`, [tables]);
  expect(keys.rows).toHaveLength(35);
  expect(keys.rows.filter(key => key.deferred)).toHaveLength(8);
  for (const key of keys.rows) expect(key).toMatchObject({ deletion: "a", update: "a", deferrable: key.deferred });
  expect((await store.owner.query(`SELECT c.relname AS name, pg_get_expr(i.indpred,i.indrelid) AS predicate
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE i.indrelid::regclass::text=ANY($1) AND i.indpred IS NOT NULL ORDER BY c.relname`, [tables])).rows).toEqual([
    { name: "subscription_cycle_cases_open_idx", predicate: "(state = 'open'::text)" },
    { name: "subscription_cycle_occurrences_current_idx", predicate: "is_current" },
    { name: "subscription_cycle_stock_holds_live_cycle_idx", predicate: "(state = 'held'::text)" },
    { name: "subscription_cycle_stock_holds_live_reservation_idx", predicate: "(state = 'held'::text)" },
  ]);
});

it("denies reads and writes as the installed non-owner except for the client-column census", async () => {
  if (store.installation.generation === "legacy") throw new Error("Qualified runtime login required");
  expect((await store.runtime.query("SELECT session_user::text AS login")).rows).toEqual([{ login: store.installation.runtimeLogin }]);
  for (const relation of tables) {
    for (const sql of [`SELECT * FROM public.${relation}`, `INSERT INTO public.${relation} DEFAULT VALUES`]) {
      expectSqlError(await rejected(store.runtime.query(sql)), "42501", `permission denied for table ${relation}`);
    }
  }
  expect((await store.runtime.query(`SELECT client_id FROM public.${occurrence}`)).rows).toEqual([]);
});

it("rejects partial policies and detects a temporarily disabled policy check in a disposable transaction", async () => {
  const row = { cycle_key: randomUUID(), subscription_id: renewal.subscription, client_id: renewal.client,
    original_anchor_at: AT, effective_due_at: AT, cadence_seconds: 86400, rail: "v3", lifecycle: "active", is_current: true };
  const key = "cycle_occurrence_policy_check";
  for (const patch of [{ deadline_rule_ref: "policy" }, { deadline_rule_ref: "é".repeat(101), deadline_rule_revision: 1,
    lead_seconds: 0, late_cancel_disposition: "hold_current" }]) {
    expectSqlError(await rejected(insert(store.owner, occurrence, { ...row, ...patch })), "23514", checkMessage(occurrence, key), key);
  }
  await transaction(store.owner, async db => {
    await db.query(`ALTER TABLE public.${occurrence} DROP CONSTRAINT ${key}`);
    await insert(db, occurrence, { ...row, deadline_rule_ref: "partial" });
  }, "ROLLBACK");
});

it("keeps legacy work and an owner-only rolled-back money graph dormant", async () => {
  expect(await legacy(store.runtime, renewal)).toEqual(prior);
  expect(await rowCensus(store.owner)).toEqual(census);
  for (const relation of tables) expect((await store.owner.query(`SELECT * FROM public.${relation}`)).rows).toEqual([]);
  const sku = await seedSku(store.owner);
  await transaction(store.owner, async db => {
    const graph = await seedPrivateFacts(db, sku);
    await db.query(`UPDATE public.commerce_order_tax_snapshots SET accepted_quote_id=NULL,accepted_quote_digest=NULL,
      token_digest=NULL,acceptance_ref=NULL,cycle_binding_ref=$2 WHERE order_id=$1`, [graph.orderId, randomUUID()]);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    expect((await db.query("SELECT money_version FROM public.commerce_orders WHERE id=$1", [graph.orderId])).rows)
      .toEqual([{ money_version: version }]);
  }, "ROLLBACK");
  expect(await rowCensus(store.owner)).toEqual(census);
});

it("registers every empty carrier and restores an occupied legacy store byte for byte and once", async () => {
  const current = manifest.forward.at(-1) === forward ? store : await installAccountMutations("bootstrap", false, "renewal-storage-current");
  let source: Awaited<ReturnType<typeof capture>>;
  try {
    if (current !== store) await prepareOriginal(current.owner, await sandboxRenewal(current.owner));
    source = await capture(current.owner, current.inventory, "renewal-storage-source");
  } finally { if (current !== store) await current.close(); }
  expect(source.owned.filter(entry => tables.some(name => name === entry.table)).map(entry => [entry.table, entry.rows]).sort())
    .toEqual(tables.map(name => [name, []]));
  expect(source.compatible.tables.find(entry => entry.table === "subscription_renewal_operations")?.rows).toHaveLength(1);
  const order = [...connectedStoreRestoreOrder] as string[];
  const insertBefore = (parent: string, child: string) => {
    expect(order.indexOf(parent)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(parent)).toBeLessThan(order.indexOf(child));
  };
  insertBefore("subscription_renewal_operations", table("occurrences"));
  insertBefore("fulfillment_inventory_reservations", table("stock_holds"));
  insertBefore(table("tax_issuances"), "tax_calculations");
  insertBefore(table("tax_bindings"), table("preparations"));
  insertBefore(table("payment_attempts"), table("dispatch_grants"));
  insertBefore("subscription_delivery_alignment_cases", table("delivery_assignments"));
  const target = await installAccountMutations("bootstrap", false, "renewal-storage-target");
  try {
    if (target.installation.generation === "legacy") throw new Error("Qualified restore required");
    const freshTarget = await capture(target.migrator, target.inventory, "renewal-storage-pristine");
    const input = { owner: target.migrator, installation: target.installation, packet: source, freshTarget };
    for (const replayed of [false, true]) {
      expect(await restoreConnectedNativeStore(input)).toMatchObject({ replayed, captureSha256: source.sha256 });
      const retained = await capture(target.migrator, target.inventory, "renewal-storage-restored");
      expect(retained.compatible.tables).toEqual(source.compatible.tables);
      expect(retained.owned).toEqual(source.owned);
    }
  } finally { await target.close(); }
}, postgresSetupTimeoutMs);
