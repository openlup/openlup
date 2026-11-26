import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Pool } from "pg";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { connectedStoreRestoreOrder } from "../../server/adapters/postgres/connectedStoreDomains/index.js";
import { fixture as fulfillmentFixture } from "../helpers/fulfillmentNative.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { installAccountMutations, type AccountMutationsStore } from "./customerAccountMutations.fixture.js";
import { capture, checkMessage, expectSqlError, foreignKeyMessage, insert, rejected, seedPrivateFacts, seedSku, transaction, uniqueMessage, version } from "./orderMoneyV2Storage.fixture.js";
import { exerciseLegacyRenewals, observeRenewalWrites } from "./nativeRenewalV3Legacy.fixture.js";
import { AT, prepareOriginal, sandboxRenewal, type Renewal } from "./subscriptionNativeFixture.js";

const currentManifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (currentManifest?.schemaVersion !== 3) throw new Error("Complete native catalogue required");
const manifest = currentManifest;
const forward = manifest.forward.find(entry => entry.file.endsWith("_native_renewal_v3_storage.sql"))!;
if (!forward) throw new Error("Renewal storage migration missing");
const shapes = {
  occurrences: "cycle_key subscription_id client_id original_anchor_at effective_due_at cadence_seconds rail lifecycle is_current deadline_rule_ref deadline_rule_revision lead_seconds late_cancel_disposition cancellation_receipt_id cancellation_effective_at operation_id commercial_generation_id",
  delivery_assignments: "obligation_ref assigned_cycle_key marker_cycle_key qualifying_actual_arrival_at applied_due_at",
  delivery_evidence: "observation_event_key obligation_ref shipment_id dispatch_ref_id provider_ref actual_arrival_at evidence_digest",
  generations: "operation_id commercial_generation_id cycle_key agreement agreement_fingerprint claim_token lease_expires_at lease_generation last_binding_seq current_binding_ref first_failure_at failure_cause failure_count next_eligible_at",
  stock_holds: "hold_incarnation_id cycle_key operation_id commercial_generation_id reservation_id expires_at state",
  tax_issuances: "evaluation_id operation_id commercial_generation_id binding_seq hold_incarnation_id issued_calculation_id request_digest request_evidence erased_at",
  tax_bindings: "binding_ref evaluation_id cycle_key operation_id commercial_generation_id binding_seq calculation_id bind_digest accepted_money_digest payable_minor currency tax_point expires_at live_evidence erased_at",
  cases: "case_id operation_id commercial_generation_id case_kind state cause revision opened_at closed_at",
  preparations: "preparation_id cycle_key cycle_id operation_id commercial_generation_id binding_ref binding_seq hold_incarnation_id order_id settlement_intent_id payment_attempt_id opening_key accepted_money_digest prepared_at closed_unsent_at replaces_preparation_id",
  payment_attempts: "payment_attempt_id preparation_id attempt_kind predecessor_attempt_id retry_key recovery_authorization_ref non_capture_proof_ref non_capture_verified_at",
  dispatch_grants: "grant_id payment_attempt_id confirmation_step_ref confirmation_kind authorized_hold_ref authorized_hold_expires_at provider_account_ref provider_mode request_digest idempotency_key checked_at send_by notice_decision",
  calculation_rebinds: "rebind_id order_id preparation_id retry_attempt_id sale_key sequence previous_calculation_id effective_calculation_id accepted_money_digest proof_digest rebound_at",
};
const table = (name: keyof typeof shapes) => `subscription_cycle_${name}` as const;
const tables = (Object.keys(shapes) as (keyof typeof shapes)[]).map(table).sort();
const occurrence = table("occurrences");
let store: AccountMutationsStore, renewal: Renewal;
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

const rowCensus = (db: Pool) => db.query(`SELECT
  (SELECT count(*) FROM public.commerce_orders) AS orders,
  (SELECT count(*) FROM public.commerce_settlement_intents) AS intents,
  (SELECT count(*) FROM public.payment_provider_attempts) AS attempts,
  (SELECT count(*) FROM public.payment_simulator_attempts) AS simulator_attempts,
  (SELECT count(*) FROM public.commerce_order_draft_receipts) AS checkout,
  (SELECT count(*) FROM public.customer_account_consent_events) AS consents,
  (SELECT count(*) FROM public.communication_recipient_consents) AS communication_consents`).then(result => result.rows);
function renewalCatalogs() {
  const candidate = structuredClone(manifest);
  for (const plan of [candidate, candidate.qualified, candidate.qualifiedAdmin]) {
    plan.forward = plan.forward.slice(0, plan.forward.findIndex(entry => entry.file === forward.file) + 1);
  }
  candidate.qualified.objectInventorySha256.bootstrapMigrator.withRestore = "a9d0f834ca62b1bf4341a522fdc8dcda2219c2ee97eb80583027610779c27acd";
  const prefix = structuredClone(candidate);
  for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) expect(plan.forward.pop()).toEqual(forward);
  prefix.qualified.objectInventorySha256.bootstrapMigrator.withRestore = "bb5b2abb5a1cad98e598cfdb2bb39ba73f13eaa7160ff942419036359ed1487b";
  return { candidate, prefix };
}

beforeAll(async () => {
  const { candidate, prefix } = renewalCatalogs();
  await withPlatformCatalog(candidate, upgrade => withPlatformCatalog(prefix, async root => {
    store = await installAccountMutations("bootstrap", false, "renewal-storage-prefix", root, upgrade);
    renewal = await sandboxRenewal(store.owner);
    await prepareOriginal(store.owner, renewal);
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
  const keys = await store.owner.query(`SELECT conname AS name, confrelid::regclass::text AS target,
    conrelid::regclass::text AS source,
    ARRAY(SELECT a.attname::text FROM unnest(conkey) WITH ORDINALITY k(num,pos)
      JOIN pg_attribute a ON a.attrelid=conrelid AND a.attnum=k.num ORDER BY k.pos) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(confkey) WITH ORDINALITY k(num,pos)
      JOIN pg_attribute a ON a.attrelid=confrelid AND a.attnum=k.num ORDER BY k.pos) AS referenced,
    confdeltype::text AS deletion, confupdtype::text AS update,
    condeferrable AS deferrable, condeferred AS deferred FROM pg_constraint WHERE contype='f'
    AND conrelid::regclass::text=ANY($1) ORDER BY conname`, [tables]);
  expect(keys.rows).toHaveLength(39);
  const deferred = keys.rows.filter(key => key.deferred).map(({ source, columns, target, referenced }) =>
    [source, columns.join(" "), target, referenced.join(" ")]);
  expect(deferred).toEqual(expect.arrayContaining([
    [occurrence, "cycle_key operation_id commercial_generation_id", table("generations"), "cycle_key operation_id commercial_generation_id"],
    [table("generations"), "operation_id commercial_generation_id current_binding_ref", table("tax_bindings"), "operation_id commercial_generation_id binding_ref"],
    [table("preparations"), "order_id", "commerce_orders", "id"],
    [table("preparations"), "settlement_intent_id", "commerce_settlement_intents", "id"],
    [table("preparations"), "payment_attempt_id", "payment_provider_attempts", "id"],
    [table("preparations"), "replaces_preparation_id", table("preparations"), "preparation_id"],
    [table("payment_attempts"), "predecessor_attempt_id", table("payment_attempts"), "payment_attempt_id"],
  ]));
  expect(deferred).toHaveLength(7);
  for (const key of keys.rows) expect(key).toMatchObject({ deletion: "a", update: "a", deferrable: key.deferred });
  expect(keys.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "subscription_cycle_delivery_assignments_obligation_ref_fkey", target: "commerce_orders", deferrable: false }),
    expect.objectContaining({ name: "subscription_cycle_preparations_cycle_id_fkey", target: "subscription_cycles", deferrable: false }),
  ]));
  const indexes = await store.owner.query(`SELECT c.relname AS name, i.indrelid::regclass::text AS relation,
    pg_get_expr(i.indpred,i.indrelid) AS predicate, i.indisunique AS unique,
    ARRAY(SELECT pg_get_indexdef(i.indexrelid,k,true) FROM generate_series(1,i.indnkeyatts) k) AS columns,
    EXISTS (SELECT FROM pg_constraint p WHERE p.conindid=i.indexrelid AND p.contype IN ('p','u')) AS implicit
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE i.indrelid::regclass::text=ANY($1) ORDER BY c.relname`, [tables]);
  expect(indexes.rows.filter(index => !index.implicit).map(({ name, predicate, unique, columns }) =>
    [name, columns.join(" "), unique, predicate])).toEqual([
    ["subscription_cycle_cases_open_idx", "operation_id commercial_generation_id case_kind", true, "(state = 'open'::text)"],
    ["subscription_cycle_delivery_assignments_cycle_idx", "assigned_cycle_key", false, null],
    ["subscription_cycle_delivery_evidence_obligation_idx", "obligation_ref shipment_id", false, null],
    ["subscription_cycle_occurrences_current_idx", "subscription_id", true, "is_current"],
    ["subscription_cycle_payment_attempts_preparation_idx", "preparation_id", false, null],
    ["subscription_cycle_stock_holds_live_cycle_idx", "cycle_key", true, "(state = 'held'::text)"],
    ["subscription_cycle_stock_holds_live_reservation_idx", "reservation_id", true, "(state = 'held'::text)"],
  ]);
  const implicitKeys = {
    occurrences: ["cycle_key", "subscription_id cycle_key"], delivery_assignments: ["obligation_ref"],
    delivery_evidence: ["observation_event_key"], generations: ["operation_id commercial_generation_id", "cycle_key operation_id commercial_generation_id"],
    stock_holds: ["hold_incarnation_id"], tax_issuances: ["evaluation_id", "issued_calculation_id", "operation_id commercial_generation_id binding_seq"],
    tax_bindings: ["binding_ref", "evaluation_id", "operation_id commercial_generation_id binding_seq", "operation_id commercial_generation_id binding_ref"],
    cases: ["case_id"], preparations: ["preparation_id", "cycle_id", "binding_ref", "order_id", "settlement_intent_id", "payment_attempt_id",
      "opening_key", "replaces_preparation_id", "operation_id commercial_generation_id binding_seq"],
    payment_attempts: ["payment_attempt_id", "preparation_id retry_key"],
    dispatch_grants: ["grant_id", "payment_attempt_id confirmation_step_ref", "provider_account_ref provider_mode idempotency_key"],
    calculation_rebinds: ["rebind_id", "retry_attempt_id", "effective_calculation_id", "order_id sequence"],
  } satisfies Record<keyof typeof shapes, string[]>;
  expect(indexes.rows.filter(index => index.implicit).map(({ relation, columns, unique, predicate }) =>
    [relation, columns.join(" "), unique, predicate]).sort()).toEqual(Object.entries(implicitKeys).flatMap(([name, keys]) =>
    keys.map(key => [`subscription_cycle_${name}`, key, true, null])).sort());
});

it("installs the order, booked cycle and dispatch coordinates with their declared nullability and keys", async () => {
  const columns = await store.owner.query(`SELECT attname AS name, format_type(atttypid,atttypmod) AS type, attnotnull AS required
    FROM pg_attribute WHERE (attrelid,attname) IN (
      ('public.subscription_cycle_delivery_assignments'::regclass,'obligation_ref'),
      ('public.subscription_cycle_delivery_assignments'::regclass,'assigned_cycle_key'),
      ('public.subscription_cycle_delivery_assignments'::regclass,'marker_cycle_key'),
      ('public.subscription_cycle_delivery_assignments'::regclass,'qualifying_actual_arrival_at'),
      ('public.subscription_cycle_delivery_assignments'::regclass,'applied_due_at'),
      ('public.subscription_cycle_preparations'::regclass,'cycle_id'),
      ('public.subscription_cycle_dispatch_grants'::regclass,'confirmation_step_ref'),
      ('public.subscription_cycle_dispatch_grants'::regclass,'authorized_hold_ref'),
      ('public.subscription_cycle_dispatch_grants'::regclass,'authorized_hold_expires_at')
    ) ORDER BY attname`);
  expect(columns.rows.map(({ name, type, required }) => [name, type, required])).toEqual([
    ["applied_due_at", "timestamp with time zone", false],
    ["assigned_cycle_key", "uuid", true],
    ["authorized_hold_expires_at", "timestamp with time zone", false],
    ["authorized_hold_ref", "text", false],
    ["confirmation_step_ref", "text", true],
    ["cycle_id", "uuid", true],
    ["marker_cycle_key", "uuid", false],
    ["obligation_ref", "uuid", true],
    ["qualifying_actual_arrival_at", "timestamp with time zone", false],
  ]);
  const { rows } = await store.owner.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid::regclass::text=ANY($1) AND contype IN ('p','u')`,
  [[table("delivery_assignments"), table("delivery_evidence"), table("preparations"), table("dispatch_grants")]]);
  expect(rows.map(row => row.definition)).toEqual(expect.arrayContaining([
    "PRIMARY KEY (obligation_ref)", "PRIMARY KEY (observation_event_key)",
    "UNIQUE (cycle_id)", "UNIQUE (payment_attempt_id, confirmation_step_ref)",
  ]));
  expect((await store.owner.query(`SELECT to_regprocedure(
    'public.payments__check_renewal_intent_write(uuid,uuid,uuid,uuid,uuid,uuid)') AS helper`)).rows).toEqual([{ helper: null }]);
});

it("requires paired hold coordinates for capture and detects a disabled hold check", async () => {
  const relation = table("dispatch_grants"), key = "cycle_dispatch_hold_check";
  const row = { grant_id: randomUUID(), payment_attempt_id: randomUUID(), confirmation_step_ref: "step",
    confirmation_kind: "server_capture", provider_account_ref: "account", provider_mode: "test", request_digest: "a".repeat(64),
    idempotency_key: "request", checked_at: AT, send_by: "2026-09-01T12:01:00Z", notice_decision: {} };
  for (const patch of [{}, { authorized_hold_ref: "hold" }, { confirmation_kind: "server_confirmation", authorized_hold_ref: "hold" }]) {
    expectSqlError(await rejected(insert(store.owner, relation, { ...row, ...patch })), "23514", checkMessage(relation, key), key);
  }
  await transaction(store.owner, async db => {
    // Temporarily disabled the hold check in a disposable database.
    await db.query(`ALTER TABLE public.${relation} DROP CONSTRAINT ${key}`);
    const fk = "subscription_cycle_dispatch_grants_payment_attempt_id_fkey";
    expectSqlError(await rejected(insert(db, relation, row)), "23503", foreignKeyMessage(relation, fk), fk);
  }, "ROLLBACK");
});

it("retains nullable non-capture evidence and rejects a half-populated proof", async () => {
  const relation = table("payment_attempts"), key = "cycle_attempt_non_capture_proof_check";
  const { rows } = await store.owner.query(`SELECT attname AS name, format_type(atttypid,atttypmod) AS type,
    attnotnull AS required, atthasdef AS has_default FROM pg_attribute WHERE attrelid=$1::regclass
    AND attname IN ('non_capture_proof_ref','non_capture_verified_at') ORDER BY attname`, [`public.${relation}`]);
  expect(rows).toEqual([
    { name: "non_capture_proof_ref", type: "text", required: false, has_default: false },
    { name: "non_capture_verified_at", type: "timestamp with time zone", required: false, has_default: false },
  ]);
  await transaction(store.owner, async db => {
    // Copy the installed CHECKs so the shape can be exercised without seeding an attempt graph.
    await db.query(`CREATE TEMP TABLE attempt_shape (LIKE public.${relation} INCLUDING CONSTRAINTS)`);
    const writeProof = (ref: string | null, at: string | null) => db.query(`INSERT INTO attempt_shape (
      payment_attempt_id, preparation_id, attempt_kind, non_capture_proof_ref, non_capture_verified_at
    ) VALUES ($1,$2,'initial',$3,$4) RETURNING non_capture_proof_ref AS ref, non_capture_verified_at AS at`,
    [randomUUID(), randomUUID(), ref, at]);
    const proof = "opaque:non-capture:fixture";
    expect((await writeProof(null, null)).rows).toEqual([{ ref: null, at: null }]);
    expect((await writeProof(proof, AT)).rows).toEqual([{ ref: proof, at: new Date(AT) }]);
    for (const [ref, at] of [[proof, null], [null, AT]] as const) {
      await db.query("SAVEPOINT partial_proof");
      expectSqlError(await rejected(writeProof(ref, at)), "23514", checkMessage("attempt_shape", key), key);
      await db.query("ROLLBACK TO SAVEPOINT partial_proof; RELEASE SAVEPOINT partial_proof");
    }
  }, "ROLLBACK");
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

it("rejects partial, oversized and whitespace-only policies and preserves a valid opaque reference", async () => {
  const row = { cycle_key: randomUUID(), subscription_id: renewal.subscription, client_id: renewal.client,
    original_anchor_at: AT, effective_due_at: AT, cadence_seconds: 86400, rail: "v3", lifecycle: "active", is_current: true };
  const key = "cycle_occurrence_policy_check";
  const policy = { deadline_rule_revision: 1, lead_seconds: 0, late_cancel_disposition: "hold_current" };
  const unicodeWhitespace = "\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
  for (const patch of [{ deadline_rule_ref: "policy" }, ...["é".repeat(101), "\t", "\n", " \t\n\r\v\f", unicodeWhitespace].map(deadline_rule_ref =>
    ({ ...policy, deadline_rule_ref }))]) {
    expectSqlError(await rejected(insert(store.owner, occurrence, { ...row, ...patch })), "23514", checkMessage(occurrence, key), key);
  }
  const valid = "\t policy\u00a0\n";
  await transaction(store.owner, async db => {
    await insert(db, occurrence, { ...row, ...policy, deadline_rule_ref: valid });
    expect((await db.query(`SELECT deadline_rule_ref FROM public.${occurrence} WHERE cycle_key=$1`, [row.cycle_key])).rows)
      .toEqual([{ deadline_rule_ref: valid }]);
  }, "ROLLBACK");
  await transaction(store.owner, async db => {
    // Replay the previous space-only check in a disposable transaction.
    await db.query(`ALTER TABLE public.${occurrence} DROP CONSTRAINT ${key}, ADD CONSTRAINT ${key}
      CHECK (octet_length(deadline_rule_ref) BETWEEN 1 AND 200 AND NOT (btrim(deadline_rule_ref) = ''))`);
    await insert(db, occurrence, { ...row, ...policy, deadline_rule_ref: "\t\n" });
  }, "ROLLBACK");
});

it("keeps fresh legacy paths and their mounted effects identical across the forward", async () => {
  const { prefix, candidate } = renewalCatalogs();
  async function exercise(root: string, hasForward: boolean) {
    const isolated = await installAccountMutations("bootstrap", false, "renewal-storage-parity", root);
    try {
      const writes = hasForward ? await observeRenewalWrites(isolated, tables) : [];
      const effects = await exerciseLegacyRenewals(isolated);
      expect(writes).toEqual([]);
      if (hasForward) for (const relation of tables) {
        expect((await isolated.owner.query(`SELECT count(*)::int AS count FROM public.${relation}`)).rows).toEqual([{ count: 0 }]);
      }
      const [authority] = await rowCensus(isolated.owner);
      expect(authority).toMatchObject({ checkout: "0", consents: "0", communication_consents: "0" });
      return { effects, authority };
    } finally { await isolated.close(); }
  }
  const predecessor = await withPlatformCatalog(prefix, root => exercise(root, false));
  expect(await withPlatformCatalog(candidate, root => exercise(root, true))).toEqual(predecessor);
}, postgresSetupTimeoutMs);

it("keeps the owner-only rolled-back money graph dormant", async () => {
  const census = await rowCensus(store.owner);
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

async function seedDeliveryReceipt(db: Pool) {
  const { client, subscription, order, shipment } = await fulfillmentFixture(db, null);
  const cycleKey = randomUUID(), dispatchId = randomUUID(), eventKey = `delivery:${shipment}`;
  const assignments = table("delivery_assignments"), evidence = table("delivery_evidence");
  await transaction(db, async owner => {
    await insert(owner, "fulfillment_dispatch_refs", { id: dispatchId, request_key: eventKey, shipment_id: shipment, order_id: order,
      mode: "live", status: "created", evidence: { providerRef: "carrier" } });
    await insert(owner, "fulfillment_observations", { event_key: eventKey, shipment_id: shipment, first_received_at: AT,
      observation: { eventKey, fact: { providerKind: "carrier", canonicalStatus: "delivered", occurredAt: AT } } });
    await insert(owner, occurrence, { cycle_key: cycleKey, subscription_id: subscription, client_id: client,
      original_anchor_at: AT, effective_due_at: AT, cadence_seconds: 86400, rail: "v3", lifecycle: "active", is_current: true });
    const assignment = { obligation_ref: order, assigned_cycle_key: cycleKey };
    const fk = "subscription_cycle_delivery_assignments_obligation_ref_fkey";
    await owner.query("SAVEPOINT order_obligation");
    // Temporarily restored the case-level target in a disposable database.
    await owner.query(`ALTER TABLE public.${assignments} DROP CONSTRAINT ${fk},
      ADD CONSTRAINT ${fk} FOREIGN KEY (obligation_ref) REFERENCES public.subscription_delivery_alignment_cases(id)`);
    expectSqlError(await rejected(insert(owner, assignments, assignment)), "23503", foreignKeyMessage(assignments, fk), fk);
    await owner.query("ROLLBACK TO SAVEPOINT order_obligation; RELEASE SAVEPOINT order_obligation");
    await insert(owner, assignments, assignment);
    const receipt = { observation_event_key: eventKey, obligation_ref: order, shipment_id: shipment,
      dispatch_ref_id: dispatchId, provider_ref: "carrier", actual_arrival_at: AT, evidence_digest: "a".repeat(64) };
    await insert(owner, evidence, receipt);
    const changed = { ...receipt, evidence_digest: "b".repeat(64) }, pk = "subscription_cycle_delivery_evidence_pkey";
    await owner.query("SAVEPOINT receipt_identity");
    expectSqlError(await rejected(insert(owner, evidence, changed)), "23505", uniqueMessage(pk), pk);
    await owner.query("ROLLBACK TO SAVEPOINT receipt_identity");
    // Temporarily disabled the unique receipt identity in a disposable database.
    await owner.query(`ALTER TABLE public.${evidence} DROP CONSTRAINT ${pk}`);
    await insert(owner, evidence, changed);
    await owner.query("ROLLBACK TO SAVEPOINT receipt_identity; RELEASE SAVEPOINT receipt_identity");
  });
}

async function seedSelectedPointers(db: Pool, f: Renewal) {
  const generations = table("generations"), bindings = table("tax_bindings");
  const selectedPair = "cycle_occurrence_selected_pair_fkey", currentBinding = "cycle_generation_current_binding_fkey";
  const reservationId = (await db.query("SELECT id FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1", [f.operation])).rows[0].id;
  const digest = "a".repeat(64);
  await transaction(db, async owner => {
    const paths: { cycleKey: string; generationId: string; bindingRef: string }[] = [];
    for (const isCurrent of [true, false]) {
      const cycleKey = randomUUID(), generationId = randomUUID(), bindingRef = randomUUID();
      const holdId = randomUUID(), evaluationId = randomUUID(), calculationId = randomUUID();
      const scope = { operation_id: f.operation, commercial_generation_id: generationId };
      // Write the selected pointers before their targets, as exact-current restore does.
      await insert(owner, occurrence, { ...scope, cycle_key: cycleKey, subscription_id: f.subscription, client_id: f.client,
        original_anchor_at: AT, effective_due_at: AT, cadence_seconds: 86400, rail: "v3", lifecycle: "active", is_current: isCurrent });
      await insert(owner, generations, { ...scope, cycle_key: cycleKey, agreement: {}, agreement_fingerprint: digest,
        claim_token: randomUUID(), lease_expires_at: AT, lease_generation: 1, last_binding_seq: 1, current_binding_ref: bindingRef });
      await insert(owner, table("stock_holds"), { ...scope, cycle_key: cycleKey, hold_incarnation_id: holdId,
        reservation_id: reservationId, expires_at: AT, state: "committed" });
      await insert(owner, table("tax_issuances"), { ...scope, evaluation_id: evaluationId, binding_seq: 1,
        hold_incarnation_id: holdId, issued_calculation_id: calculationId, request_digest: digest, erased_at: AT });
      await insert(owner, "tax_calculations", { calculation_id: calculationId, state: "erased" });
      await insert(owner, bindings, { ...scope, cycle_key: cycleKey, binding_ref: bindingRef, evaluation_id: evaluationId,
        binding_seq: 1, calculation_id: calculationId, bind_digest: digest, accepted_money_digest: digest,
        payable_minor: 200, currency: "XXX", tax_point: AT, expires_at: AT, erased_at: AT });
      paths.push({ cycleKey, generationId, bindingRef });
    }
    await owner.query("SET CONSTRAINTS ALL IMMEDIATE");
    await owner.query("SET CONSTRAINTS ALL DEFERRED");
    const [selected, other] = paths;
    const liveIndex = "subscription_cycle_occurrences_current_idx";
    const promoteOther = () => owner.query(`UPDATE public.${occurrence} SET is_current=true WHERE cycle_key=$1`, [other!.cycleKey]);
    await owner.query("SAVEPOINT current_occurrence");
    expectSqlError(await rejected(promoteOther()), "23505", uniqueMessage(liveIndex), liveIndex);
    await owner.query("ROLLBACK TO SAVEPOINT current_occurrence");
    // A nonunique copy with the same name, key and predicate permits the duplicate current row.
    await owner.query(`DROP INDEX public.${liveIndex}; CREATE INDEX ${liveIndex} ON public.${occurrence} (subscription_id) WHERE is_current`);
    expect((await promoteOther()).rowCount).toBe(1);
    await owner.query("ROLLBACK TO SAVEPOINT current_occurrence; RELEASE SAVEPOINT current_occurrence");
    for (const [relation, key, sql, values] of [
      [occurrence, selectedPair, `UPDATE public.${occurrence} SET commercial_generation_id=$2 WHERE cycle_key=$1`,
        [selected!.cycleKey, other!.generationId]],
      [generations, currentBinding, `UPDATE public.${generations} SET current_binding_ref=$3 WHERE operation_id=$1 AND commercial_generation_id=$2`,
        [f.operation, selected!.generationId, other!.bindingRef]],
    ] as const) {
      await owner.query("SAVEPOINT crossed_pointer");
      expect((await owner.query(sql, [...values])).rowCount).toBe(1);
      expectSqlError(await rejected(owner.query(`SET CONSTRAINTS ${key} IMMEDIATE`)), "23503", foreignKeyMessage(relation, key), key);
      await owner.query("ROLLBACK TO SAVEPOINT crossed_pointer; RELEASE SAVEPOINT crossed_pointer");
    }
  });
}

it.each([false, true])("restores legacy bytes and replays with an owner-seeded delivery receipt=%s", async populated => {
  const current = !populated && manifest.forward.at(-1) === forward
    ? store : await installAccountMutations("bootstrap", false, "renewal-storage-current");
  let source: Awaited<ReturnType<typeof capture>>;
  try {
    const retainedRenewal = current === store ? renewal : await sandboxRenewal(current.owner);
    if (current !== store) await prepareOriginal(current.owner, retainedRenewal);
    if (populated) {
      await seedDeliveryReceipt(current.owner);
      await seedSelectedPointers(current.owner, retainedRenewal);
    }
    source = await capture(current.owner, current.inventory, "renewal-storage-source");
  } finally { if (current !== store) await current.close(); }
  const populatedTables = new Map<string, number>([[occurrence, 3], [table("delivery_assignments"), 1], [table("delivery_evidence"), 1],
    [table("generations"), 2], [table("stock_holds"), 2], [table("tax_issuances"), 2], [table("tax_bindings"), 2]]);
  expect(source.owned.filter(entry => tables.some(name => name === entry.table)).map(entry => [entry.table, entry.rows.length]).sort())
    .toEqual(tables.map(name => [name, populated ? (populatedTables.get(name) ?? 0) : 0]));
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
  insertBefore("commerce_orders", table("delivery_assignments"));
  insertBefore(table("occurrences"), table("delivery_assignments"));
  insertBefore(table("delivery_assignments"), table("delivery_evidence"));
  for (const parent of ["fulfillment_observations", "fulfillment_dispatch_refs", "fulfillment_shipments"]) {
    insertBefore(parent, table("delivery_evidence"));
  }
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
