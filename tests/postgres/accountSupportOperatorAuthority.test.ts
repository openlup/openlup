import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { nativeHarness } from "../helpers/fulfillmentNative.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { renewal, AT, later, call, prepareOriginal } from "./subscriptionNativeFixture.js";
import { createPostgresOperatorAuthority } from "@openlup/platform/account-support";
import { createPostgresSubscriptionCommands } from "@openlup/platform/subscriptions";
import type { SubscriptionCommand } from "@openlup/platform/subscriptions/contracts";
const h = nativeHarness("m12-operator-authority");
beforeAll(() => h.start(), postgresSetupTimeoutMs);
afterAll(() => h.stop(), postgresTeardownTimeoutMs);
async function fixture(keepOperation = false) {
  const f = await renewal(h.pool); const operator = randomUUID(), principal = randomUUID();
  if (!keepOperation) await h.pool.query("DELETE FROM public.subscription_renewal_operations WHERE id=$1", [f.operation]);
  await h.pool.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2),($3,$4)", [operator, `${operator}@example.invalid`, principal, `${principal}@example.invalid`]);
  await h.pool.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',$2)", [operator, AT]);
  await h.pool.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)", [operator]);
  await h.pool.query("UPDATE public.clients SET principal_id=$2,lifecycle_stage='customer' WHERE id=$1", [f.client, principal]);
  // A prepared operation can survive a later schedule change.
  if (keepOperation) await prepareOriginal(h.pool, f);
  await h.pool.query("UPDATE public.subscriptions SET next_cycle_at=$2,started_at='2026-01-01' WHERE id=$1", [f.subscription, later(240)]);
  await h.pool.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [f.subscription]);
  return { ...f, operator, principal };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const invoke = (f: Fixture, key: string, action: string, payload: unknown = {}, version = 1, db: Pool | PoolClient = h.pool) =>
  call(db, "customer_support_apply_subscription_action_v1", [f.operator, f.subscription, action, payload, version, key, AT]);
async function snapshot(db: Pool | PoolClient = h.pool) {
  const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const result: Record<string, unknown[]> = {};
  for (const { tablename } of tables) {
    const name = String(tablename).replaceAll('"', '""');
    result[name] = (await db.query(`SELECT to_jsonb(t) AS row,xmin::text AS xmin FROM public."${name}" t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
async function assertRefusalDelta(before: Awaited<ReturnType<typeof snapshot>>, sql: boolean, key: string, outcome = "refused") {
  const after = await snapshot();
  if (sql) {
    for (const table of ["customer_support_subscription_commands", "customer_support_subscription_audit_events"]) {
      expect(after[table].length - before[table].length, table).toBe(1);
      const added = after[table].filter(row => !before[table].some(old => JSON.stringify(old) === JSON.stringify(row)));
      expect(added).toHaveLength(1); expect(added[0]).toMatchObject({ row: { idempotency_key: key, command_kind: "subscription_action" } });
      if (table === "customer_support_subscription_commands") {
        expect(added[0]).toMatchObject({ row: { response: { outcome,
          ...(outcome === "refused" ? { refusalCode: "operator_subscription_authority_unavailable" } : {}) } } });
      } else expect(added[0]).toMatchObject({ row: { outcome,
        refusal_code: outcome === "refused" ? "operator_subscription_authority_unavailable" : null } });
      delete after[table]; delete before[table];
    }
  }
  expect(after).toEqual(before);
}
it.each(["2_weeks", "1_month", "indefinite"] as const)("delegates pause %s then resume in one owner/support transaction, replays and conflicts without writes", async preset => {
  const f = await fixture(); const key = `pause-${randomUUID()}`;
  const paused = await invoke(f, key, "pause", { pausePreset: preset, reason: "customer request" });
  expect(paused).toMatchObject({ outcome: "applied", subscriptionStatus: "paused", appliedBy: null, ownerReceipt: { actorId: f.operator } });
  const receipt = (await h.pool.query("SELECT * FROM public.subscription_command_receipts WHERE id=$1", [paused.ownerReceipt.id])).rows[0];
  expect(paused.ownerReceipt).toEqual({ id: receipt.id, actorId: receipt.actor_id, idempotencyKey: receipt.idempotency_key, commandFingerprint: receipt.command_fingerprint, result: receipt.result });
  expect(receipt.idempotency_key).toMatch(/^m12-support:[0-9a-f]{64}$/);
  expect((await h.pool.query("SELECT pause_preset,starts_at,ends_at,reason FROM public.subscription_pause_windows WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{
    pause_preset: preset, starts_at: new Date(AT), reason: "customer request",
    ends_at: preset === "indefinite" ? null : new Date(preset === "2_weeks" ? later(14 * 24) : "2026-10-01T12:00:00.000Z"),
  }]);
  expect((await h.pool.query("SELECT payload FROM public.subscription_events WHERE id=$1", [paused.eventId])).rows[0].payload).toMatchObject({ payload: { actorKind: "operator", operatorId: f.operator } });
  const before = await snapshot();
  expect(await invoke(f, key, "pause", { pausePreset: preset, reason: "customer request" })).toEqual({ ...paused, outcome: "replayed" });
  expect(await snapshot()).toEqual(before);
  await expect(invoke(f, key, "resume")).rejects.toMatchObject({ code: "23505", message: "customer_support_idempotency_conflict" });
  expect(await snapshot()).toEqual(before);
  const refusedKey = `already-paused-${randomUUID()}`;
  const refused = await invoke(f, refusedKey, "pause");
  expect(refused).toMatchObject({ outcome: "refused", refusalCode: "invalid_transition", ownerReceipt: {
    actorId: f.operator, result: { status: "refused", reason: "subscription_lifecycle_invalid_transition" },
  } });
  expect((await h.pool.query("SELECT id FROM public.subscription_command_receipts WHERE id=$1", [refused.ownerReceipt.id])).rows).toHaveLength(1);
  expect((await h.pool.query("SELECT outcome FROM public.customer_support_subscription_audit_events WHERE idempotency_key=$1", [refusedKey])).rows).toEqual([{ outcome: "refused" }]);
  const refusedBefore = await snapshot(); expect(await invoke(f, refusedKey, "pause")).toEqual(refused); expect(await snapshot()).toEqual(refusedBefore);
  expect(await invoke(f, `resume-${randomUUID()}`, "resume", {}, paused.templateVersion)).toMatchObject({ outcome: "applied", subscriptionStatus: "active", ownerReceipt: { actorId: f.operator } });
});
it.each([3, 60])("delegates the %s-day slide window edge without changing the operator actor", async days => {
  const f = await fixture(); const target = later(days * 24);
  const result = await invoke(f, `slide-${randomUUID()}`, "slide_next_cycle", { newNextCycleAt: target });
  expect(result).toMatchObject({ outcome: "applied", appliedBy: null, ownerReceipt: { actorId: f.operator } });
  expect(new Date(result.nextCycleAt).toISOString()).toBe(new Date(target).toISOString());
  expect((await h.pool.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].next_cycle_at.toISOString()).toBe(new Date(target).toISOString());
});
it.each(["short band", "address", "expired-dunning resume", "residual-unpaid resume", "prepared-attempt pause", "email", "phone", "link"] as const)("native named refusal: %s", async name => {
  const f = await fixture(name === "prepared-attempt pause"); const key = `refusal-${randomUUID()}`;
  let action = "pause", payload: unknown = {};
  if (name === "short band") { action = "slide_next_cycle"; payload = { slideMinDays: 1, newNextCycleAt: later(48) }; }
  if (name === "address") { action = "change_shipping_address"; payload = { shippingAddressId: randomUUID() }; }
  if (name.includes("resume")) {
    action = "resume"; await h.pool.query("UPDATE public.subscriptions SET status='paused' WHERE id=$1", [f.subscription]);
    const cycle = randomUUID();
    await h.pool.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,$3,$4)", [cycle, f.subscription, AT, name.startsWith("expired") ? "paid" : "payment_pending"]);
    if (name.startsWith("expired")) await h.pool.query("INSERT INTO public.subscription_dunning_cases(id,subscription_id,cycle_id,client_id,status,opened_at,expired_at,idempotency_key) VALUES($1::uuid,$2,$3,$4,'expired',$5,$5,$1::uuid::text)", [randomUUID(), f.subscription, cycle, f.client, AT]);
  }
  const before = await snapshot();
  const native = createPostgresOperatorAuthority({ run: work => work(h.pool) }, { operatorId: f.operator, now: () => Date.parse(AT), recoveryPath: token => `/repair?token=${token}` });
  const result = name === "email" ? await native.correctSubjectEmail({ operatorId: f.operator, subjectId: f.client, expectedEmail: "old@example.invalid", newEmail: "new@example.invalid", idempotencyKey: key })
    : name === "phone" ? await native.correctSubjectPhone({ operatorId: f.operator, subjectId: f.client, expectedPhone: "old", newPhone: "new", idempotencyKey: key })
    : name === "link" ? await native.linkSubjectAccount({ operatorId: f.operator, subjectId: f.client, expectedEmail: "old@example.invalid", authUserId: null, idempotencyKey: key })
    : await invoke(f, key, action, payload);
  expect(result).toMatchObject({ outcome: "refused", refusalCode: "operator_subscription_authority_unavailable" });
  await assertRefusalDelta(before, !["email", "phone", "link"].includes(name), key);
});
it("resume refuses with a payment_pending cycle and proceeds without one", async () => {
  const f = await fixture(); const cycle = randomUUID(), refusedKey = `pending-resume-${randomUUID()}`;
  await h.pool.query("UPDATE public.subscriptions SET status='paused' WHERE id=$1", [f.subscription]);
  await h.pool.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,$3,'payment_pending')", [cycle, f.subscription, AT]);
  expect((await h.pool.query("SELECT id FROM public.subscription_dunning_cases WHERE subscription_id=$1 AND status IN ('open','expired')", [f.subscription])).rows).toEqual([]);
  const before = await snapshot();
  expect(await invoke(f, refusedKey, "resume")).toMatchObject({ outcome: "refused", refusalCode: "operator_subscription_authority_unavailable" });
  await assertRefusalDelta(before, true, refusedKey);
  expect((await h.pool.query("SELECT status FROM public.subscriptions WHERE id=$1", [f.subscription])).rows).toEqual([{ status: "paused" }]);
  await h.pool.query("UPDATE public.subscription_cycles SET status='paid' WHERE id=$1", [cycle]);
  const applied = await invoke(f, `paid-resume-${randomUUID()}`, "resume");
  expect(applied).toMatchObject({ outcome: "applied", subscriptionStatus: "active", appliedBy: null, ownerReceipt: { actorId: f.operator } });
  const receipt = (await h.pool.query("SELECT * FROM public.subscription_command_receipts WHERE id=$1", [applied.ownerReceipt.id])).rows[0];
  expect(applied.ownerReceipt).toEqual({ id: receipt.id, actorId: receipt.actor_id, idempotencyKey: receipt.idempotency_key, commandFingerprint: receipt.command_fingerprint, result: receipt.result });
  expect((await h.pool.query("SELECT status FROM public.subscriptions WHERE id=$1", [f.subscription])).rows).toEqual([{ status: "active" }]);
});
it.each(["owner exception", "owner receipt mismatch"] as const)("rolls back %s and every support/owner row atomically", async failure => {
  const f = await fixture(); const db = await h.pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(`CREATE FUNCTION pg_temp.break_m12_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${failure === "owner exception" ? "RAISE EXCEPTION 'injected owner exception';" : "RETURN NULL;"} END $$`);
    await db.query("CREATE TRIGGER break_m12_owner BEFORE INSERT ON public.subscription_command_receipts FOR EACH ROW EXECUTE FUNCTION pg_temp.break_m12_owner()");
    await db.query("SAVEPOINT attempted"); const before = await snapshot(db);
    await expect(invoke(f, `atomic-${randomUUID()}`, "pause", {}, 1, db)).rejects.toThrow();
    await db.query("ROLLBACK TO attempted"); expect(await snapshot(db)).toEqual(before);
  } finally { await db.query("ROLLBACK"); db.release(); }
});
it("same-UTC-day slide writes only support receipt/audit; stale version becomes a conflict", async () => {
  const f = await fixture(), key = `noop-${randomUUID()}`; const before = await snapshot();
  expect(await invoke(f, key, "slide_next_cycle", { newNextCycleAt: later(240 + 1) })).toMatchObject({ outcome: "noop", templateVersion: 1 });
  await assertRefusalDelta(before, true, key, "noop");
  expect(await invoke(f, `stale-${randomUUID()}`, "pause", {}, 99)).toMatchObject({ outcome: "conflict", refusalCode: "version_conflict" });
});
it.each(["apply", "recovery", "absorption"] as const)("machine %s is fenced before state reads and writes", async action => {
  const f = await fixture(); await h.pool.query("INSERT INTO public.platform_control_operators(principal_id,active) VALUES($1,true)", [f.operator]);
  const before = await snapshot();
  const command = action === "apply" ? invoke(f, `machine-${randomUUID()}`, "pause")
    : action === "recovery" ? call(h.pool, "customer_support_issue_recovery", [f.operator, randomUUID(), randomUUID(), `machine-${randomUUID()}`, "a".repeat(64), "b".repeat(64), later(24), "/repair"])
    : call(h.pool, "customer_support_absorb_lead_v1", [f.operator, randomUUID(), randomUUID(), "lead@example.invalid", `machine-${randomUUID()}`, AT]);
  await expect(command).rejects.toMatchObject({ code: "42501", message: "customer_support_command_requires_human" });
  expect(await snapshot()).toEqual(before);
});
it("inactive operator is refused before all writes", async () => {
  const f = await fixture(); await h.pool.query("UPDATE public.platform_communication_operators SET active=false WHERE principal_id=$1", [f.operator]);
  const before = await snapshot(); await expect(invoke(f, `inactive-${randomUUID()}`, "pause")).rejects.toMatchObject({ code: "42501" }); expect(await snapshot()).toEqual(before);
});
it("same-key racers produce one effect and one replay", async () => {
  const f = await fixture(), key = `race-${randomUUID()}`;
  const results = await Promise.all([invoke(f, key, "pause"), invoke(f, key, "pause")]);
  expect(results.map(r => r.outcome).sort()).toEqual(["applied", "replayed"]);
  expect((await h.pool.query("SELECT count(*)::int AS n FROM public.customer_support_subscription_commands WHERE idempotency_key=$1", [key])).rows[0].n).toBe(1);
  expect(results[0].ownerReceipt.id).toBe(results[1].ownerReceipt.id);
});
it("different-key racers serialize on the same anchor without stacking", async () => {
  const f = await fixture(); const target = later(20 * 24);
  const results = await Promise.all([invoke(f, `race-a-${randomUUID()}`, "slide_next_cycle", { newNextCycleAt: target }), invoke(f, `race-b-${randomUUID()}`, "slide_next_cycle", { newNextCycleAt: target })]);
  expect(results.map(r => r.outcome).sort()).toEqual(["applied", "noop"]);
  expect((await h.pool.query("SELECT next_cycle_at,template_version FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0]).toEqual({ next_cycle_at: new Date(target), template_version: 1 });
});

it("prices a trusted operator edit and preserves the support RPC action boundary", async () => {
  const f = await fixture();
  const variant = randomUUID(), list = randomUUID(), sku = `Example-${variant}`;
  const { rows: [clock] } = await h.pool.query("SELECT clock_timestamp()::text AS now");
  await h.pool.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Fixture','ZZ','XXX')", [list]);
  await h.pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Fixture')", [variant, sku]);
  await h.pool.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription)
    VALUES($1,$1,$2,'Fixture',true)`, [variant, sku]);
  await h.pool.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor)
    VALUES($1,$2,'one_time',125)`, [list, variant]);
  await h.pool.query(`WITH policy AS (SELECT gen_random_uuid() AS id,now() AS starts)
    INSERT INTO public.subscription_price_policy_revisions
      (id,price_list_id,region_code,currency,channel,revision_no,discount_bps,rounding_quantum_minor,rounding_rule,effective_from,digest)
    SELECT id,$1,'ZZ','XXX','D2C',1,500,10,'FLOOR_TO_QUANTUM',starts,
      public.catalog_price_setup_policy_digest(id,1,$1,'ZZ','XXX','D2C',starts,NULL,500,10,'FLOOR_TO_QUANTUM') FROM policy`, [list]);
  const anchor = (await h.pool.query(`UPDATE public.subscriptions SET price_list_id=$2,currency_code='XXX',
    next_cycle_at=now()+interval '30 days' WHERE id=$1 RETURNING next_cycle_at::text`, [f.subscription, list])).rows[0].next_cycle_at;
  let translated = 3, translations = 0;
  const commands = createPostgresSubscriptionCommands({
    async withTransaction(work) {
      const db = await h.pool.connect();
      try {
        await db.query("BEGIN");
        const value = await work(db);
        await db.query("COMMIT");
        return value;
      } catch (error) { await db.query("ROLLBACK"); throw error; }
      finally { db.release(); }
    },
    async futureTerms() {
      translations++;
      return { coreLines: [{ variantId: variant, qty: translated }], addonLines: [],
        compositionConstraint: { kind: "units", value: translated } };
    },
  });
  const command: Extract<SubscriptionCommand, { action: "edit_future_terms" }> = {
    action: "edit_future_terms", actor: { kind: "operator", actorId: f.operator, clientId: f.client },
    idempotencyKey: randomUUID(), subscriptionId: f.subscription, now: clock.now, shippingAddressId: "host-address",
    planDays: 21, cadenceDays: 21, expectedTemplateVersion: 1, acceptedQuoteHash: "", confirmedChargeTiming: true,
    coreLines: [{ sku, quantity: 3 }], addonLines: [], compositionConstraint: "host-units",
  };
  const preview = await commands.preview(command);
  expect(preview).toMatchObject({ status: "previewed", canApply: true, newTotalMinor: 330,
    lines: [{ variantId: variant, quantity: 3, unitPriceMinor: 110, currency: "XXX" }] });
  expect(translations).toBe(1);
  translated = 7;
  expect(await commands.apply({ ...command, acceptedQuoteHash: String("quoteHash" in preview ? preview.quoteHash : "") }))
    .toMatchObject({ outcome: "applied", actorId: f.operator, revision: "2" });
  expect(translations).toBe(1);
  expect((await h.pool.query(`SELECT command#>'{payload,coreLines}' AS core FROM public.subscription_command_receipts
    WHERE actor_id=$1 AND idempotency_key=$2`, [f.operator, command.idempotencyKey])).rows).toEqual([{ core: [{ variantId: variant, qty: 3 }] }]);
  expect((await h.pool.query(`SELECT line_ordinal,sku,quantity,unit_amount_minor::int,subscription_renewal_terms.currency_code,next_cycle_at::text
    FROM public.subscription_renewal_term_lines JOIN public.subscription_renewal_terms USING (subscription_id)
    JOIN public.subscriptions s ON s.id=subscription_id WHERE subscription_id=$1`,
  [f.subscription])).rows).toEqual([{ line_ordinal: 1, sku, quantity: 3, unit_amount_minor: 110, currency_code: "XXX", next_cycle_at: anchor }]);
  const before = await snapshot();
  await expect(call(h.pool, "customer_support_apply_subscription_action_v1",
    [f.operator, f.subscription, "edit_future_terms", {}, 2, randomUUID(), clock.now]))
    .rejects.toMatchObject({ code: "22023", message: "customer_support_subscription_command_invalid" });
  expect(await snapshot()).toEqual(before);
});
