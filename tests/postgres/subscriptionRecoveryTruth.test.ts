import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresRetryStore } from "@openlup/platform/subscriptions";
import { createPostgresCommerceOmsPort } from "@openlup/platform/commerce/server/postgres";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions,
  type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  type PostgresContainer } from "../helpers/postgresContainer.js";
import { AT, call, failure, later, prepareOriginal, renewal } from "./subscriptionNativeFixture.js";

describe.each(["legacy", "qualified-v2", "qualified-admin"] as const)("retry recovery truth on %s", profile => {
  let container: PostgresContainer, owner: Pool, runtime: Pool;
  const pools: Pool[] = [];
  beforeAll(async () => {
    container = await runPostgresContainer({ name: `recovery-truth-${profile}-${process.pid}`, password: "synthetic-conformance" });
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const pool = (url: string, options?: string) => { const db = new Pool({ connectionString: url, options: `${options ?? ""} -c timezone=UTC` }); pools.push(db); return db; };
    const bootstrap = pool(container.connectionString), password = randomUUID();
    const login = (name: string) => { const url = new URL(container.connectionString); url.username = name; if (name !== "postgres") url.password = password; return url.toString(); };
    let installation: { generation: "legacy" } | QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation = { generation: "legacy" };
    if (profile !== "legacy") {
      await bootstrap.query(`CREATE ROLE recovery_m LOGIN ${profile === "qualified-admin" ? "NOINHERIT NOSUPERUSER CREATEROLE" : "INHERIT SUPERUSER NOCREATEROLE"} NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}';
        ALTER DATABASE postgres OWNER TO recovery_m;
        CREATE ROLE recovery_r LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}';
        CREATE ROLE recovery_s LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      installation = { generation: profile, roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: "recovery_m", runtimeLogin: "recovery_r", restoreLogin: "recovery_s" };
    }
    owner = profile === "legacy" ? bootstrap : pool(login("recovery_m"), installation.generation === "qualified-v2" ? qualifiedPostgresStartupOptions(installation)
      : installation.generation === "qualified-admin" ? qualifiedAdminPostgresStartupOptions(installation) : undefined);
    const runner = createPostgresMigrationRunner({ connectionString: "injected" }, { installation, poolFactory: () => owner });
    await runner.apply();
    expect(await runner.apply()).toEqual({ applied: [] });
    runtime = profile === "legacy" ? owner : pool(login("recovery_r"), "-c role=service_role");
  }, postgresSetupTimeoutMs);
  afterAll(async () => { await closePostgres(container, pools); }, postgresTeardownTimeoutMs);

  async function capturedDecline() {
    const f = await renewal(owner), original = await prepareOriginal(owner, f), operator = randomUUID();
    await owner.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Synthetic operator')", [operator]);
    await call(runtime, "subscription_retry_apply_failure", [f.operation, `failure:${f.operation}`, failure()]);
    await call(runtime, "subscription_retry_open_case", [f.operation, "payment_failed", "/recover"]);
    await owner.query("UPDATE public.commerce_settlement_intents SET channel_key='sandbox' WHERE id=$1", [original.settlementIntentId]);
    const attempt = await call(runtime, "payment_simulator_begin_attempt", [`capture:${f.operation}`, original.settlementIntentId, "a".repeat(64), {}, AT]);
    const at = later(1), observation = await call(runtime, "payment_simulator_record_observation", [attempt.id, `capture:${attempt.id}`, "b".repeat(64), "captured", at]);
    const input = { evidenceKey: `sandbox:${observation.id}`, occurredAt: at, firstRecordedAt: at, externalRef: `capture:${observation.id}`,
      amountMinor: f.snapshot.totalAmountMinor, currency: "XXX", template: "payment_recovered", sourceKind: "accepted_event",
      sourceReference: observation.id, attemptRef: attempt.id, observedStatus: "captured", observedAt: at, payloadFingerprint: "b".repeat(64) };
    return { ...f, original, input, operator };
  }
  type Subject = Awaited<ReturnType<typeof capturedDecline>>;
  async function effects(f: Subject) {
    return (await owner.query(`SELECT jsonb_build_object(
      'terms',(SELECT to_jsonb(t) FROM public.subscription_renewal_terms t WHERE subscription_id=$2),
      'obligation',(SELECT to_jsonb(o) FROM public.subscription_retry_obligations o WHERE renewal_operation_id=$1),
      'stock',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.fulfillment_inventory_reservations r WHERE renewal_operation_id=$1),
      'cases',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.subscription_dunning_cases c WHERE subscription_id=$2),
      'notices',(SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM public.subscription_dunning_notifications n WHERE case_id IN (SELECT id FROM public.subscription_dunning_cases WHERE subscription_id=$2)),
      'recoveryReceipts',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]'::jsonb) FROM public.subscription_retry_receipts r WHERE obligation_id=(SELECT id FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1) AND kind='recovery')) AS value`, [f.operation, f.subscription])).rows[0].value;
  }
  it("keeps cancelled-order capture in review through the public recovery entry and exact redelivery", async () => {
    const f = await capturedDecline(), store = createPostgresRetryStore(runtime), key = `recover:${f.operation}`;
    await createPostgresCommerceOmsPort(runtime).cancelOrder({ idempotencyKey: `cancel:${f.original.orderId}`, orderId: f.original.orderId, reason: "synthetic cancellation", actorUserId: f.operator });
    const before = await effects(f);
    expect(before.terms.next_cycle_number).toBe(2);
    expect(before.stock).toEqual([expect.objectContaining({ status: "released", expires_at: null })]);
    const result = await store.recordRecovery(f.operation, key, f.input);
    expect(result).toMatchObject({ state: "waiting", disposition: "payment_failed" });
    expect(await effects(f)).toEqual(before);
    const truth = (await owner.query("SELECT id FROM public.payment_truth_events WHERE settlement_intent_id=$1", [f.original.settlementIntentId])).rows;
    expect(truth).toHaveLength(1);
    expect(await call(owner, "payment_truth_readback", [truth[0].id, false])).toMatchObject({
      event: { applicationStatus: "review_required", outcome: "captured" }, effects: { paymentResultRecorded: false },
      financial: { orderStatus: "cancelled", settlementStatus: "failed" } });
    expect(await store.recordRecovery(f.operation, key, f.input)).toEqual(result);
    expect(await effects(f)).toEqual(before);
    expect((await owner.query("SELECT count(*)::int AS n FROM public.payment_truth_events WHERE settlement_intent_id=$1", [f.original.settlementIntentId])).rows).toEqual([{ n: 1 }]);
    await expect(store.recordRecovery(f.operation, key, { ...f.input, externalRef: "changed" })).rejects.toMatchObject({ code: "23505" });
    expect(await effects(f)).toEqual(before);
  }, 30_000);
  it("does not replay a released false-paid receipt as paid and preserves its history", async () => {
    const f = await capturedDecline(), store = createPostgresRetryStore(runtime), key = `historical:${f.operation}`;
    await createPostgresCommerceOmsPort(runtime).cancelOrder({ idempotencyKey: `historical-cancel:${f.original.orderId}`, orderId: f.original.orderId, reason: "synthetic cancellation", actorUserId: f.operator });
    const released = readFileSync("db/platform/migrations/20261024184500_subscription_retry_late_positive_stock.sql", "utf8");
    try {
      await owner.query(released.slice(released.indexOf("CREATE OR REPLACE FUNCTION")));
      expect(await store.recordRecovery(f.operation, key, f.input)).toMatchObject({ state: "recovered", disposition: "paid" });
    } finally { await owner.query(readFileSync("db/platform/migrations/20261106060000_subscription_retry_recovery_truth.sql", "utf8")); }
    const history = await effects(f);
    expect(history.recoveryReceipts).toHaveLength(1);
    expect(history.recoveryReceipts[0].result.state).toBe("recovered");
    const result = await store.recordRecovery(f.operation, key, f.input);
    expect(result.disposition).toBe("payment_failed");
    expect(await store.recordRecovery(f.operation, key, f.input)).toEqual(result);
    expect(await effects(f)).toEqual(history);
  }, 30_000);

  it("keeps genuinely paid late recovery and its effects exactly once", async () => {
    const f = await capturedDecline(), store = createPostgresRetryStore(runtime), key = `paid:${f.operation}`;
    const before = await effects(f);
    expect(before.terms.next_cycle_number).toBe(2);
    expect(before.stock[0].status).toBe("released");
    const result = await store.recordRecovery(f.operation, key, f.input), after = await effects(f);
    expect(result).toMatchObject({ state: "recovered", disposition: "paid" });
    expect(after.terms.next_cycle_number).toBe(3);
    expect(after.stock).toEqual([expect.objectContaining({ status: "committed", expires_at: null })]);
    expect(after.cases[0].status).toBe("recovered");
    expect(after.recoveryReceipts).toEqual([expect.objectContaining({ kind: "recovery", result: expect.objectContaining({ state: "recovered" }) })]);
    expect((await owner.query("SELECT status FROM public.commerce_orders WHERE id=$1", [f.original.orderId])).rows).toEqual([{ status: "paid" }]);
    expect((await owner.query("SELECT count(*)::int AS n FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'", [f.original.settlementIntentId])).rows).toEqual([{ n: 1 }]);
    expect(await store.recordRecovery(f.operation, key, f.input)).toEqual(result);
    expect(await effects(f)).toEqual(after);
    await expect(store.recordRecovery(f.operation, key, { ...f.input, externalRef: "changed" })).rejects.toMatchObject({ code: "23505" });
    expect(await effects(f)).toEqual(after);
  }, 30_000);
});
