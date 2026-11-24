import { readFileSync } from "node:fs";
import { assertNativeStoreForward, readReviewedForwardRegistry } from "../../scripts/reviewed-platform-forward.js";
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { expect, it } from "vitest";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { api, executor, admin, runtime, facts, purchase, rpc, transaction, days, at } from "./subscriptionPublicRenewalFixture.js";

import {
  activationEffects, alternateFingerprint, callCommit, callEntry, commitSignatures, entrySignatures,
  expectedActivationEffects, refusal, seedCapturedActivation,
} from "./subscriptionActivationFixture.js";

const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
async function row(orderId: string) {
  return (await runtime.query(`SELECT s.id,s.edit_window_hours,s.next_cycle_at::text FROM public.subscriptions s
    JOIN public.subscription_activations a ON a.subscription_id=s.id WHERE a.order_id=$1`, [orderId])).rows[0];
}
async function activate(editWindowHours?: number) {
  const p = await purchase();
  const result = await api.activateNativePurchaseWithRenewal(executor, { ...p, facts, editWindowHours });
  expect(result.renewalAttachment).toBe("complete");
  return { ...p, subscriptionId: String(result.activation.subscriptionId) };
}

it("retains the legacy activation, commit-helper and repair signatures at 72", async () => {
  const p = await purchase();
  const initial = await rpc("subscription_activate_from_captured_payment", [p.idempotencyKey, p.orderId, fingerprint(p.capturedReference)]);
  expect(await row(p.orderId)).toMatchObject({ edit_window_hours: 72 });
  expect(await rpc("subscription_activate_from_captured_payment", [p.idempotencyKey, p.orderId, fingerprint(p.capturedReference)]))
    .toEqual({ ...initial, replayed: true });
  const helper = await purchase();
  await admin.query(`SELECT public.subscription_activation_commit(a,$2,$3,$4::timestamptz,false)
    FROM public.subscription_activations a WHERE order_id=$1`, [helper.orderId, helper.idempotencyKey, fingerprint(helper.capturedReference), at]);
  expect(await row(helper.orderId)).toMatchObject({ edit_window_hours: 72 });
  const repair = await purchase();
  expect(await rpc("subscription_reconcile_paid_activation_gaps", [200, days(at, 1)])).toMatchObject({ repaired: 1 });
  expect(await row(repair.orderId)).toMatchObject({ edit_window_hours: 72 });
  expect(await row((await activate()).orderId)).toMatchObject({ edit_window_hours: 72 });
});

it("uses 72 for omitted and NULL SQL input", async () => {
  for (const explicitNull of [false, true]) {
    const p = await purchase();
    const values: unknown[] = [p.idempotencyKey, p.orderId, fingerprint(p.capturedReference)];
    if (explicitNull) values.push(null);
    await rpc("subscription_activate_from_captured_payment_with_edit_window", values);
    expect(await row(p.orderId)).toMatchObject({ edit_window_hours: 72 });
  }
});

it.each([1, 24, 72, 720])("stores opt-in %s through the entry point and commit helper", async hours => {
  expect(await row((await activate(hours)).orderId)).toMatchObject({ edit_window_hours: hours });
  const p = await purchase();
  await admin.query(`SELECT public.subscription_activation_commit_with_edit_window(a,$2,$3,$4::timestamptz,false,$5)
    FROM public.subscription_activations a WHERE order_id=$1`, [p.orderId, p.idempotencyKey, fingerprint(p.capturedReference), at, hours]);
  expect(await row(p.orderId)).toMatchObject({ edit_window_hours: hours });
});

async function writes() {
  return (await admin.query(`SELECT
    (SELECT count(*)::int FROM public.subscriptions) subscriptions,
    (SELECT count(*)::int FROM public.subscription_cycles) cycles,
    (SELECT count(*)::int FROM public.subscription_events) events,
    (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY order_id),'[]') FROM public.subscription_renewal_attachments a) attachments`)).rows[0];
}
it.each([0, 721])("refuses %s before activation, facts or helper writes", async hours => {
  const p = await purchase(), before = await writes();
  await expect(api.activateNativePurchaseWithRenewal(executor, { ...p, facts, editWindowHours: hours }))
    .rejects.toThrow("subscription_activation_edit_window_invalid");
  await expect(rpc("subscription_activate_from_captured_payment_with_edit_window", [p.idempotencyKey, p.orderId, fingerprint(p.capturedReference), hours]))
    .rejects.toMatchObject({ code: "22023", message: "subscription_activation_edit_window_invalid" });
  await expect(admin.query(`SELECT public.subscription_activation_commit_with_edit_window(a,$2,$3,$4::timestamptz,false,$5)
    FROM public.subscription_activations a WHERE order_id=$1`, [p.orderId, p.idempotencyKey, fingerprint(p.capturedReference), at, hours]))
    .rejects.toMatchObject({ code: "22023", message: "subscription_activation_edit_window_invalid" });
  expect(await row(p.orderId)).toBeUndefined();
  expect(await writes()).toEqual(before);
  expect((await runtime.query("SELECT state FROM public.subscription_activations WHERE order_id=$1", [p.orderId])).rows[0].state).toBe("provisional");
});

it("freezes existing rows across configuration changes and completed replay", async () => {
  const older = await activate(), prior = await row(older.orderId);
  const p = await activate(24), frozen = await row(p.orderId);
  const next = await activate(72);
  const replay = await api.activateNativePurchaseWithRenewal(executor, { ...p, facts, editWindowHours: 72 });
  expect(replay.activation).toMatchObject({ subscriptionId: p.subscriptionId, replayed: true });
  expect(await row(p.orderId)).toEqual(frozen);
  expect(await row(older.orderId)).toEqual(prior);
  expect(await row(next.orderId)).toMatchObject({ edit_window_hours: 72 });
});

it("the existing edit fence reads the stored cutoff without changing the renewal date", async () => {
  const p = await activate(24), legacy = await activate(72);
  const stored = await row(p.orderId), due = new Date(stored.next_cycle_at).toISOString();
  const sku = (await runtime.query("SELECT variant_id FROM public.subscription_lines WHERE subscription_id=$1", [p.subscriptionId])).rows[0].variant_id;
  const store = api.createPostgresSubscriptionCommandStore({ withTransaction: transaction });
  const preview = (f: typeof p, now: string) => store.preview({ actorId: randomUUID(), clientId: f.clientId,
    subscriptionId: f.subscriptionId, idempotencyKey: randomUUID(), action: "resize_bundle", now,
    payload: { expectedTemplateVersion: 1, cadenceDays: 28, coreLines: [{ variantId: sku, qty: 3 }], compositionConstraint: { kind: "units", value: 3 } } });
  // A 72h cutoff closes earlier: at 36h before renewal the 24h window is still open.
  expect(await preview(p, days(due, -1.5))).toMatchObject({ status: "previewed" });
  expect(await preview(legacy, days(due, -1.5))).toMatchObject({ status: "refused", reason: "subscription_edit_window_closed" });
  expect(await preview(p, days(due, -1))).toMatchObject({ status: "refused", reason: "subscription_edit_window_closed" });
  expect(await row(p.orderId)).toEqual(stored);
});

const forwardPath = "db/platform/migrations/20261123120000_subscription_edit_window_activation.sql";
const activationFunctions = [
  ["public.subscription_activation_commit(public.subscription_activations,text,text,timestamptz,boolean)",
    "public.subscription_activation_commit_with_edit_window(public.subscription_activations,text,text,timestamptz,boolean,integer)"],
  ["public.subscription_activate_from_captured_payment(text,uuid,text)",
    "public.subscription_activate_from_captured_payment_with_edit_window(text,uuid,text,integer)"],
] as const;
async function functionCatalog(db: typeof executor, signature: string) {
  return (await db.query(`SELECT prosrc,proconfig,proacl,proowner,prosecdef,
    pg_get_functiondef(p.oid) definition
    FROM pg_proc p WHERE p.oid=$1::regprocedure`, [signature])).rows[0];
}
async function assertOptInSecurity(db: typeof executor) {
  const hasServiceRole = (await db.query("SELECT 1 FROM pg_roles WHERE rolname='service_role'")).rows.length > 0;
  for (const [, successor] of activationFunctions) {
    expect(await functionCatalog(db, successor), successor).toMatchObject({
      prosecdef: false, proconfig: ["search_path=public, pg_catalog"],
    });
    const { owner, acl } = (await db.query(`SELECT pg_get_userbyid(p.proowner) owner,
      (SELECT jsonb_agg(jsonb_build_object('role', pg_get_userbyid(a.grantee),
        'privilege', a.privilege_type, 'grantable', a.is_grantable) ORDER BY a.grantee)
        FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a) acl
      FROM pg_proc p WHERE p.oid=$1::regprocedure`, [successor])).rows[0];
    expect(acl, successor).toEqual(expect.arrayContaining([
      { role: owner, privilege: "EXECUTE", grantable: false },
      ...(hasServiceRole ? [{ role: "service_role", privilege: "EXECUTE", grantable: false }] : []),
    ]));
    expect(acl, successor).toHaveLength(hasServiceRole ? 2 : 1);
  }
}
it("gives new functions only owner and service_role EXECUTE on the qualified installation", async () => {
  await assertOptInSecurity(admin);
});

it("leaves predecessor catalogs identical and new functions owner-only without service_role", async () => {
  const container = await runPostgresContainer({ name: `k6-legacy-acl-${process.pid}`, password: "synthetic-conformance" });
  const db = new Pool({ connectionString: container.connectionString });
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
    const units: { file: string }[] = [manifest.baseline, ...manifest.forward];
    const index = units.findIndex(unit => unit.file === forwardPath);
    expect(index).toBeGreaterThan(0);
    for (const unit of units.slice(0, index)) await db.query(readFileSync(unit.file, "utf8"));
    expect((await db.query("SELECT 1 FROM pg_roles WHERE rolname='service_role'")).rows).toEqual([]);
    const before = await Promise.all(activationFunctions.map(([signature]) => functionCatalog(db, signature)));
    await db.query(readFileSync(forwardPath, "utf8"));
    for (const [index, [predecessor]] of activationFunctions.entries()) {
      expect(await functionCatalog(db, predecessor), predecessor).toEqual(before[index]);
      expect(before[index].proacl).toBeNull();
      expect((await db.query(`SELECT EXISTS(SELECT 1 FROM pg_proc p,
        aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') allowed`, [predecessor])).rows[0].allowed).toBe(true);
    }
    await assertOptInSecurity(db);
  } finally { await closePostgres(container, db); }
}, postgresSetupTimeoutMs);

it("admits the exact forward and approval pins through the existing native validator", () => {
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  const units: { file: string }[] = [manifest.baseline, ...manifest.forward];
  const preceding = units.slice(0, units.findIndex(unit => unit.file === forwardPath))
    .map(unit => ({ path: unit.file, bytes: readFileSync(unit.file) }));
  const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
  expect(() => assertNativeStoreForward(registry, forwardPath, readFileSync(forwardPath), preceding)).not.toThrow();
});

it("keeps legacy and opt-in activation independent in both directions", async () => {
  const legacy = await purchase(), optedIn = await purchase(), db = await admin.connect();
  try {
    await db.query("BEGIN");
    const originals = await Promise.all(activationFunctions.map(async ([, signature]) =>
      String((await functionCatalog(db, signature)).definition)));
    for (const definition of originals) {
      await db.query(definition.replace("\nBEGIN\n", "\nBEGIN\n  RAISE EXCEPTION 'k6_new_function_probe';\n"));
    }
    await db.query("SELECT public.subscription_activate_from_captured_payment($1,$2,$3)",
      [legacy.idempotencyKey, legacy.orderId, fingerprint(legacy.capturedReference)]);
    for (const definition of originals) await db.query(definition);
    for (const [signature] of activationFunctions) {
      const definition = String((await functionCatalog(db, signature)).definition);
      await db.query(definition.replace("\nBEGIN\n", "\nBEGIN\n  RAISE EXCEPTION 'k6_predecessor_probe';\n"));
    }
    await db.query("SELECT public.subscription_activate_from_captured_payment_with_edit_window($1,$2,$3,$4)",
      [optedIn.idempotencyKey, optedIn.orderId, fingerprint(optedIn.capturedReference), 24]);
    for (const [purchase, hours] of [[legacy, 72], [optedIn, 24]] as const) {
      expect((await db.query(`SELECT s.edit_window_hours FROM public.subscriptions s JOIN public.subscription_activations a
        ON a.subscription_id=s.id WHERE a.order_id=$1`, [purchase.orderId])).rows).toEqual([{ edit_window_hours: hours }]);
    }
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it("preserves predecessor bodies, config, raw ACLs and owners while narrowing new browser-role defaults", async () => {
  const db = await admin.connect();
  try {
    await db.query("BEGIN");
    for (const role of ["k6 custom caller", "k6 custom owner"]) {
      await db.query(`CREATE ROLE "${role}" NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`);
    }
    await db.query('GRANT USAGE,CREATE ON SCHEMA public TO "k6 custom owner"');
    // Reapply only this unissued forward inside a rollback. The old function
    // owner and a grant option deliberately differ from the new-function ACL.
    for (const [, successor] of activationFunctions) await db.query(`DROP FUNCTION ${successor}`);
    await db.query(`REVOKE ALL ON FUNCTION ${activationFunctions[0][0]},${activationFunctions[1][0]} FROM PUBLIC;
      ALTER FUNCTION ${activationFunctions[0][0]} OWNER TO "k6 custom owner";
      GRANT EXECUTE ON FUNCTION ${activationFunctions[0][0]} TO "k6 custom caller" WITH GRANT OPTION;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated`);
    const before = await Promise.all(activationFunctions.map(([signature]) => functionCatalog(db, signature)));
    await db.query(readFileSync(forwardPath, "utf8"));
    for (const [index, [predecessor]] of activationFunctions.entries()) {
      expect(await functionCatalog(db, predecessor), predecessor).toEqual(before[index]);
    }
    await assertOptInSecurity(db);
  } finally { await db.query("ROLLBACK"); db.release(); }
});

async function rolledBack(work: (db: PoolClient) => Promise<void>) {
  const db = await admin.connect();
  try {
    await db.query("BEGIN");
    await work(db);
  } finally { await db.query("ROLLBACK"); db.release(); }
}

const stateRefusals = [
  ["not_declared", "DELETE FROM public.subscription_activations WHERE order_id=$1"],
  ["order_compensated", "UPDATE public.subscription_activations SET state='compensated',compensated_at=clock_timestamp() WHERE order_id=$1"],
  ["order_not_paid", "UPDATE public.commerce_orders SET status='pending_payment' WHERE id=$1"],
  ["payment_not_captured", "DELETE FROM public.commerce_settlement_intents WHERE order_id=$1"],
  ["payment_not_captured", "UPDATE public.commerce_settlement_intents SET status='created',settled_at=NULL WHERE order_id=$1"],
] as const;

for (const variant of [0, 1] as const) {
  const entry = entrySignatures[variant]!, commit = commitSignatures[variant]!;
  const expected = (suffix: string, code?: string) => refusal(`subscription_activation_${suffix}`, code);

  it(`${entry} preserves typed input and NULL precedence`, async () => rolledBack(async db => {
    const p = await seedCapturedActivation(db);
    const cases = [
      [{ key: " short ", orderId: randomUUID() }, expected("invalid_input")],
      [{ key: null }, expected("invalid_input")],
      [{ orderId: null }, expected("invalid_input")],
      [{ fingerprint: "invalid" }, expected("invalid_input")],
      [{ orderId: randomUUID() }, expected("order_not_found")],
      [{ orderId: randomUUID(), fingerprint: null }, expected("order_not_found")],
      [{ fingerprint: null }, expected("payment_fingerprint_conflict", "23505")],
      [{ fingerprint: alternateFingerprint }, expected("payment_fingerprint_conflict", "23505")],
    ] as const;
    for (const [input, error] of cases) {
      await db.query("SAVEPOINT entry_refusal");
      await expect(callEntry(db, variant, p, input)).rejects.toMatchObject(error);
      await db.query("ROLLBACK TO SAVEPOINT entry_refusal");
    }
  }));

  it.each(stateRefusals)(`${entry} preserves %s after %s`, async (suffix, sql) => rolledBack(async db => {
    const p = await seedCapturedActivation(db);
    expect((await db.query(sql, [p.orderId])).rowCount).toBe(1);
    await expect(callEntry(db, variant, p)).rejects.toMatchObject(expected(suffix));
  }));

  it(`${entry} separates stored replay fingerprint conflicts from the incoming check`, async () => rolledBack(async db => {
    const p = await seedCapturedActivation(db);
    const answer = await callEntry(db, variant, p, { hours: 24 });
    expect(answer).toMatchObject({ state: "active", replayed: false, orderId: p.orderId });
    expect(await activationEffects(db, p.orderId)).toEqual(expectedActivationEffects(false, variant ? 24 : 72));
    expect(await callEntry(db, variant, p, { hours: 720 })).toEqual({ ...answer, replayed: true });
    await db.query("UPDATE public.subscription_activations SET payment_fingerprint=$2 WHERE order_id=$1", [p.orderId, alternateFingerprint]);
    await expect(callEntry(db, variant, p)).rejects.toMatchObject(expected("payment_fingerprint_conflict", "23505"));
  }));

  it(`${commit} rolls back all write effects on attachment refusal`, async () => rolledBack(async db => {
    const p = await seedCapturedActivation(db);
    await db.query("DELETE FROM public.subscription_activations WHERE order_id=$1", [p.orderId]);
    const effects = async () => (await db.query(`SELECT
      (SELECT count(*)::int FROM public.subscriptions WHERE client_id=$2) AS subscriptions,
      (SELECT count(*)::int FROM public.subscription_cycles) AS cycles,
      (SELECT count(*)::int FROM public.subscription_events) AS events,
      (SELECT count(*)::int FROM public.subscription_renewal_attachments WHERE order_id=$1) AS attachments,
      (SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=$1) AS order_link`, [p.orderId, p.clientId])).rows;
    const before = await effects();
    await db.query("SAVEPOINT capture_refusal");
    await expect(callCommit(db, variant, p, { actualRow: false }))
      .rejects.toMatchObject(refusal("subscription_renewal_attachment_not_active"));
    await db.query("ROLLBACK TO SAVEPOINT capture_refusal");
    expect(await effects()).toEqual(before);
  }));

  it.each([entry, commit])(`${entry} reaches its parent %s`, async signature => rolledBack(async db => {
    const p = await seedCapturedActivation(db);
    const { definition } = await functionCatalog(db, signature);
    const marker = "activation_parent_probe";
    const sabotaged = String(definition).replace("\nBEGIN\n", `\nBEGIN\n  RAISE EXCEPTION '${marker}';\n`);
    expect(sabotaged).not.toEqual(definition);
    await db.query(sabotaged);
    await expect(callEntry(db, variant, p)).rejects.toMatchObject(refusal(marker, "P0001"));
  }));
}

it.each([0, 721])("preserves typed opt-in refusals and precedence at %s hours", async hours => rolledBack(async db => {
  const p = await seedCapturedActivation(db);
  const invalid = refusal("subscription_activation_edit_window_invalid");
  await db.query("SAVEPOINT edit_window_refusal");
  await expect(callEntry(db, 1, p, { hours, key: null, fingerprint: null })).rejects.toMatchObject(invalid);
  await db.query("ROLLBACK TO SAVEPOINT edit_window_refusal");
  await expect(callCommit(db, 1, p, { hours })).rejects.toMatchObject(invalid);
}));
