import { randomUUID } from "node:crypto";
import { createPostgresProviderInlineRecoveryAttemptPort } from "@openlup/platform/payments";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined, pool: Pool, db: PoolClient;
beforeAll(async () => {
  // Reuse the pinned extension-enabled PostgreSQL supply for the native pgTAP twins.
  container = await runManagedCompatPostgres({ name: `provider-native-pgtap-${process.pid}`, password: "synthetic-conformance" });
  pool = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:") });
  db = await pool.connect();
  // The native actor forward creates its own groups. Remove the extension
  // helper's managed groups so this suite executes the native SQL unchanged.
  await db.query("DROP SCHEMA auth CASCADE; DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role");
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  for (const unit of [manifest.baseline, ...manifest.forward]) await db.query(readFileSync(unit.file, "utf8"));
  await db.query("CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions; SET search_path=public,extensions");
  await db.query(readFileSync("tests/postgres/fixtures/paymentProvider/setup.sql", "utf8"));
}, postgresSetupTimeoutMs);
afterAll(async () => { db?.release(); await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

it.each([
  ["durability.sql", 56], ["blockedPreflight.sql", 9], ["eventFingerprint.sql", 8], ["zeroAmountAndAttribution.sql", 44],
  ["notChargeableCleanup.sql", 15],
  ["terminalizedCycle.sql", 104],
  ["intentReplay.sql", 4], ["duplicateFailure.sql", 6],
] as const)("retains the native assertions in %s", async (file, count) => {
  try {
    const response = await db.query(readFileSync(`tests/postgres/fixtures/paymentProvider/${file}`, "utf8").replace(/ROLLBACK;\s*$/u, ""));
    const results = Array.isArray(response) ? response : [response];
    const lines = results.flatMap(result => result.rows.flatMap((row: Record<string, unknown>) => Object.values(row).filter((value): value is string => typeof value === "string")));
    expect(lines.filter(line => /^(?:not ok|# Looks like)/u.test(line))).toEqual([]);
    expect(lines.filter(line => /^(?:ok|not ok) \d+/u.test(line))).toHaveLength(count);
    if (file === "durability.sql") {
      // Continue the existing inline fixture with a real wrapper admission and
      // response-loss replay, retaining the provider identity recorded by SQL.
      const f = (await db.query(`SELECT o.id AS order_id,o.client_id,i.id AS intent_id,a.id AS predecessor,a.provider
        FROM public.commerce_settlement_intents i JOIN public.commerce_orders o ON o.id=i.order_id
        JOIN public.payment_provider_states ps ON ps.id=i.id JOIN public.payment_provider_attempts a ON a.id=ps.active_attempt_id
        WHERE i.id=(SELECT intent_id FROM _inline_intent)`)).rows[0];
      await db.query("UPDATE public.commerce_orders SET metadata=metadata-'paymentStatus' WHERE id=$1", [f.order_id]);
      await db.query("UPDATE public.commerce_settlement_intents SET channel_key=$2 WHERE id=$1", [f.intent_id, f.provider]);
      const request = { orderId: f.order_id, clientId: f.client_id, paymentIntentId: f.intent_id, expectedPaymentAttemptId: f.predecessor,
        retryRequestId: randomUUID(), executionRail: f.provider, methodKey: "card" };
      const method = { provider: f.provider, providerIdempotencyKey: `inline-provider:${f.order_id}`, providerRequestFingerprint: "f".repeat(64),
        providerFlow: "one_time_payment", paymentMethodRef: null, requestPayload: { method: "card" } };
      const fresh = await createPostgresProviderInlineRecoveryAttemptPort(db, () => "card").begin({ request, method,
        admission: { replayOnly: false, purchaseContext: "one_time", previousMethodKey: "card", actions: ["change_instrument"], restriction: null } });
      expect(fresh).toMatchObject({ replayed: false, status: "processing" });
      const replay = createPostgresProviderInlineRecoveryAttemptPort(db, () => { throw new Error("replay_must_not_resolve_method"); });
      const input = { request, method: { ...method, providerRequestFingerprint: "transient-changed", requestPayload: {} },
        admission: { replayOnly: true, purchaseContext: null, previousMethodKey: null, actions: [], restriction: null } };
      const recorded = async () => (await db.query(`SELECT jsonb_build_array(
        (SELECT to_jsonb(ps) FROM public.payment_provider_states ps WHERE id=$1),
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.payment_provider_attempts a WHERE settlement_intent_id=$1),
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY scope,idempotency_key) FROM public.payment_provider_receipts r WHERE metadata->>'paymentIntentId'=$1::text)) AS value`, [f.intent_id])).rows[0].value;
      const before = await recorded();
      expect(before[1]).toHaveLength(3);
      expect(await replay.begin(input)).toMatchObject({ paymentAttemptId: fresh.paymentAttemptId, replayed: true, status: "processing" });
      for (const change of [{ retryRequestId: randomUUID() }, { expectedPaymentAttemptId: randomUUID() }, { executionRail: "other_rail" },
        { expectedPaymentAttemptId: fresh.paymentAttemptId }]) {
        await db.query("SAVEPOINT replay_refusal");
        try { await expect(replay.begin({ ...input, request: { ...request, ...change } })).rejects.toThrow("checkout_inline_retry_refused"); }
        finally { await db.query("ROLLBACK TO SAVEPOINT replay_refusal"); }
      }
      expect(await recorded()).toEqual(before);
    }
  } finally { await db.query("ROLLBACK"); }
});
