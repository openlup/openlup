import { readFileSync } from "node:fs";
import { assertNativeStoreForward, readReviewedForwardRegistry } from "../../scripts/reviewed-platform-forward.js";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { api, executor, admin, runtime, facts, purchase, rpc, transaction, days, at } from "./subscriptionPublicRenewalFixture.js";

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

it("uses the installed default for omitted and NULL SQL input", async () => {
  for (const explicitNull of [false, true]) {
    const p = await purchase();
    const values: unknown[] = [p.idempotencyKey, p.orderId, fingerprint(p.capturedReference)];
    if (explicitNull) values.push(null);
    await rpc("subscription_activate_from_captured_payment_with_edit_window", values);
    expect(await row(p.orderId)).toMatchObject({ edit_window_hours: 72 });
  }
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
async function functionSecurity(db: typeof executor, signature: string) {
  return (await db.query(`SELECT prosecdef,proconfig,proowner,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.grantor,a.grantee,a.privilege_type,a.is_grantable)
      FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a) acl
    FROM pg_proc p WHERE p.oid=$1::regprocedure`, [signature])).rows[0];
}
async function assertActivationSecurity(db: typeof executor) {
  for (const [predecessor, successor] of activationFunctions) {
    expect(await functionSecurity(db, successor), successor).toEqual(await functionSecurity(db, predecessor));
  }
}
it("copies exact security attributes and normalized ACLs on the default qualified installation", async () => {
  await assertActivationSecurity(admin);
});

it("copies PUBLIC default ACLs on the legacy inventory profile without service_role", async () => {
  const container = await runPostgresContainer({ name: `k6-legacy-acl-${process.pid}`, password: "synthetic-conformance" });
  const db = new Pool({ connectionString: container.connectionString });
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
    for (const unit of [manifest.baseline, ...manifest.forward]) await db.query(readFileSync(unit.file, "utf8"));
    expect((await db.query("SELECT 1 FROM pg_roles WHERE rolname='service_role'")).rows).toEqual([]);
    await assertActivationSecurity(db);
    for (const [predecessor] of activationFunctions) {
      expect((await db.query("SELECT proacl FROM pg_proc WHERE oid=$1::regprocedure", [predecessor])).rows[0].proacl).toBeNull();
      expect((await db.query("SELECT EXISTS(SELECT 1 FROM pg_proc p,aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') allowed", [predecessor])).rows[0].allowed).toBe(true);
    }
  } finally { await closePostgres(container, db); }
}, postgresSetupTimeoutMs);

it("admits the exact forward and approval pins through the existing native validator", () => {
  const path = "db/platform/migrations/20261123120000_subscription_edit_window_activation.sql";
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  const units: { file: string }[] = [manifest.baseline, ...manifest.forward];
  const preceding = units.slice(0, units.findIndex(unit => unit.file === path))
    .map(unit => ({ path: unit.file, bytes: readFileSync(unit.file) }));
  const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
  expect(() => assertNativeStoreForward(registry, path, readFileSync(path), preceding)).not.toThrow();
});

it("delegates both legacy signatures for the selected runtime before writes", async () => {
  const signature = "public.subscription_activation_commit_with_edit_window(public.subscription_activations,text,text,timestamptz,boolean,integer)";
  const original = String((await admin.query("SELECT pg_get_functiondef($1::regprocedure) AS definition", [signature])).rows[0].definition);
  const entry = "public.subscription_activate_from_captured_payment_with_edit_window(text,uuid,text,integer)";
  const entryOriginal = String((await admin.query("SELECT pg_get_functiondef($1::regprocedure) AS definition", [entry])).rows[0].definition);
  const p = await purchase(), before = await writes();
  try {
    await admin.query(entryOriginal.replace("\nBEGIN\n", "\nBEGIN\n  RAISE EXCEPTION 'k6_entry_delegation_probe';\n"));
    await admin.query(original.replace("\nBEGIN\n", "\nBEGIN\n  RAISE EXCEPTION 'k6_delegation_probe';\n"));
    await expect(rpc("subscription_activate_from_captured_payment", [p.idempotencyKey, p.orderId, fingerprint(p.capturedReference)]))
      .rejects.toThrow("k6_entry_delegation_probe");
    await expect(executor.query(`SELECT public.subscription_activation_commit(a,$2,$3,$4::timestamptz,false)
      FROM public.subscription_activations a WHERE order_id=$1`, [p.orderId, p.idempotencyKey, fingerprint(p.capturedReference), at]))
      .rejects.toThrow("k6_delegation_probe");
    expect(await writes()).toEqual(before);
  } finally { await admin.query(original); await admin.query(entryOriginal); }
});

it("copies pre-forward custom grants, grant options and ownership while removing new default grants", async () => {
  const p = await purchase(), db = await admin.connect();
  const tables = ["commerce_orders", "commerce_settlement_intents", "subscription_activations", "subscriptions", "subscription_cycles", "subscription_events"];
  try {
    await db.query("BEGIN");
    for (const role of ["k6 custom caller", "k6 custom owner", "k6 default only"]) {
      await db.query(`CREATE ROLE "${role}" NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`);
    }
    await db.query(`GRANT USAGE,CREATE ON SCHEMA public TO "k6 custom owner";
      GRANT USAGE ON SCHEMA public TO "k6 custom caller";
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO "k6 custom caller";
      GRANT INSERT,UPDATE ON ${tables.map(table => `public.${table}`).join(",")} TO "k6 custom caller";
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "k6 custom caller"`);
    for (const table of tables) await db.query(`CREATE POLICY k6_custom_probe ON public.${table}
      FOR ALL TO "k6 custom caller" USING (true) WITH CHECK (true)`);
    // Reapply only this unissued forward, inside a rollback, after changing the
    // installed predecessors. No full fixture reinstall or catalog pin bypass.
    for (const [, successor] of activationFunctions) await db.query(`DROP FUNCTION ${successor}`);
    await db.query(`REVOKE ALL ON FUNCTION ${activationFunctions[0][0]},${activationFunctions[1][0]} FROM PUBLIC;
      ALTER FUNCTION ${activationFunctions[0][0]} OWNER TO "k6 custom owner";
      GRANT EXECUTE ON FUNCTION ${activationFunctions[0][0]} TO "k6 custom caller" WITH GRANT OPTION;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO "k6 default only"`);
    const before = await Promise.all(activationFunctions.map(([signature]) => functionSecurity(db, signature)));
    await db.query(readFileSync(forwardPath, "utf8"));
    await assertActivationSecurity(db);
    for (const [index, [predecessor, successor]] of activationFunctions.entries()) {
      expect(await functionSecurity(db, predecessor)).toEqual(before[index]);
      expect((await db.query("SELECT has_function_privilege('k6 default only',$1,'EXECUTE') allowed", [successor])).rows[0].allowed).toBe(false);
    }
    await db.query('SET LOCAL ROLE "k6 custom caller"');
    const activated = (await db.query("SELECT public.subscription_activate_from_captured_payment($1,$2,$3) answer",
      [p.idempotencyKey, p.orderId, fingerprint(p.capturedReference)])).rows[0].answer;
    expect(activated).toMatchObject({ replayed: false });
    expect((await db.query(`SELECT s.edit_window_hours FROM public.subscriptions s JOIN public.subscription_activations a
      ON a.subscription_id=s.id WHERE a.order_id=$1`, [p.orderId])).rows[0]).toEqual({ edit_window_hours: 72 });
  } finally { await db.query("ROLLBACK"); db.release(); }
});
