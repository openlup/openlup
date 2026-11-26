import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { draftEffectCounts, draftHandoff, prelockDraft, runtimeSql, sampleDraftTime, seedGovernedDraft, type GovernedFixture } from "./catalogAdmissionOwnerWrite.fixture.js";
import { lifecycleInstallation, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";

let store: LifecycleInstallation, fixture: GovernedFixture;
beforeAll(async () => {
  store = await lifecycleInstallation("qualified-v2", { freshCluster: true });
  fixture = await seedGovernedDraft(store.owner);
  const { rows } = await store.owner.query<{ definition: string }>(
    "SELECT pg_get_functiondef('public.catalog_admission_runtime_checkout(text,text,uuid,jsonb)'::regprocedure) AS definition");
  // Keep the production signature, owner/ACL, prelock and settings on the isolated installation.
  await store.owner.query(rows[0]!.definition.replace("  <<prelock>>", `  IF p_operation='write' THEN
    RETURN public.catalog_admission_write_governed_draft(p_key,p_client,p_payload);
  END IF;
  <<prelock>>`));
}, postgresSetupTimeoutMs);
afterAll(async () => { await store?.close(); }, postgresTeardownTimeoutMs);

it.each([
  { table: "commerce_orders", guard: "commerce_orders_catalog_owner_origin_guard",
    mutation: "UPDATE public.commerce_orders SET total_amount_minor=total_amount_minor+1 WHERE id=$1",
    code: "23514", message: "commerce_order_line_sum_mismatch" },
  { table: "commerce_order_draft_receipts", guard: "commerce_order_draft_receipts_catalog_owner_origin_guard",
    mutation: "UPDATE public.commerce_order_draft_receipts SET request_fingerprint=repeat('a',32) WHERE order_id=$1",
    code: "22023", message: "catalog_acceptance_receipt_mismatch" },
])("surfaces a late $message after successful runtime DML at ordinary COMMIT", async ({ table, guard, mutation, code, message }) => {
  const baseline = await draftEffectCounts(store.owner);
  const current = { ...fixture, original: { ...fixture.original, key: randomUUID() } };
  const { key, clientId } = current.original;
  await store.owner.query(`ALTER TABLE public.${table} DISABLE TRIGGER ${guard}`);
  const db = await store.runtime.connect();
  const sql = "SELECT current_user,session_user,pg_backend_pid() pid,pg_current_xact_id()::text xid";
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const before = (await db.query(sql)).rows[0];
    expect(before).toMatchObject({ current_user: "service_role", session_user: "lifecycle_r" });
    await prelockDraft(db, current);
    const atTime = await sampleDraftTime(db), value = await draftHandoff(db, current, atTime);
    const { rows } = await db.query(runtimeSql, ["write", key, clientId, value]);
    const id = String(rows[0]!.result.orderDraft.orderId).slice(6);
    expect((await db.query(mutation, [id])).rowCount).toBe(1);
    expect((await db.query(sql)).rows[0]).toEqual(before);
    expect(await draftEffectCounts(store.owner)).toEqual(baseline);
    await expect(db.query("COMMIT")).rejects.toMatchObject({ code, message });
    expect(await draftEffectCounts(store.owner)).toEqual(baseline);
  } finally {
    await db.query("ROLLBACK");
    db.release();
    await store.owner.query(`ALTER TABLE public.${table} ENABLE TRIGGER ${guard}`);
  }
});
