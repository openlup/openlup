import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { utc } from "./nativeRenewalOccurrence.fixture.js";
import { args, capturePristine, generations, incumbentRoot, installOccurrenceStore, lock, measuredOccurrencePlan, occurrence,
  operations, original, read, rootFixture, writer, writerPlan, type RootFixture } from "./nativeRenewalOccurrenceWriter.fixture.js";
import { capture, insert, transaction } from "./orderMoneyV2Storage.fixture.js";
import { call, type Db } from "./subscriptionNativeFixture.js";

function expectUnavailable(owner: Pool, f: RootFixture, field: string) {
  return transaction(owner, db => unavailable(db, f, field), "ROLLBACK");
}

async function unavailable(db: Db, f: RootFixture, field: string) {
  expect(await call(db, read, f.scope)).toEqual({ kind: "unavailable", code: "renewal_cycle_unavailable", field });
  await expect(call(db, lock, f.scope)).rejects.toMatchObject({ code: "22023", message: "renewal_cycle_unavailable", detail: field });
}

async function retainLegacy(db: Db, f: RootFixture) {
  const root = await incumbentRoot(db, f);
  await insert(db, generations, { operation_id: root.operationId, commercial_generation_id: root.operationId,
    cycle_key: f.cycleKey, agreement: root.snapshot, agreement_fingerprint: root.fingerprint,
    claim_token: root.claimToken, lease_expires_at: "2004-03-02Z", lease_generation: 1 });
  await db.query(`UPDATE public.${occurrence} SET operation_id=$2,commercial_generation_id=$2 WHERE cycle_key=$1`, [f.cycleKey, root.operationId]);
  return root.operationId;
}

async function moveDue(db: Db, f: RootFixture, validPair = true) {
  for (const day of [4, 2, 4]) {
    const { rows } = await db.query(`UPDATE public.${occurrence}
      SET effective_due_at=greatest(effective_due_at,$2::timestamptz+cadence_seconds*interval '1 second') WHERE cycle_key=$1
      RETURNING to_char(effective_due_at AT TIME ZONE 'UTC',${utc}) AS due`,
    [f.cycleKey, `2004-03-0${day}T12:00:00.123456Z`]);
    expect(rows).toEqual([{ due: "2004-03-11T12:00:00.123456Z" }]);
    if (validPair) {
      for (const view of [read, lock]) expect(await call(db, view, f.scope)).toMatchObject({
        cycleKey: f.cycleKey, originalAnchorAt: original, effectiveDueAt: rows[0].due,
        operationId: f.agreement.operationId, commercialGenerationId: f.agreement.operationId });
    }
  }
}

it.for(["legacy", "legacy-with-service", "bootstrap", "separate", "admin-managed", "admin-operator"] as const)(
  "retains the exact views, original-anchor clamp, and qualified transfer on %s", { timeout: postgresSetupTimeoutMs }, async (profile, { onTestFinished }) => {
    const store = await installOccurrenceStore(profile);
    onTestFinished(store.close);
    const owner = store.migrator, f = await rootFixture(owner);
    const operationId = f.agreement.operationId;
    const initial = { clientId: f.clientId, subscriptionId: f.subscriptionId, cycleKey: f.cycleKey,
      originalAnchorAt: original, effectiveDueAt: original, cancellationDeadlineAt: original,
      deadlineRuleRef: "fixture-policy", deadlineRuleRevision: 1, cadenceSeconds: 604800,
      rail: "v3", lifecycle: "active", cancellationEffectiveAt: null, operationId: null, commercialGenerationId: null };
    expect(await call(owner, read, f.scope)).toEqual(initial);
    await transaction(owner, async db => {
      expect(await call(db, lock, f.scope)).toEqual(initial);
      for (const [table, key, value] of [["subscriptions", "id", f.subscriptionId], [occurrence, "cycle_key", f.cycleKey]]) {
        await expect(owner.query(`SELECT 1 FROM public.${table} WHERE ${key}=$1 FOR UPDATE NOWAIT`, [value]))
          .rejects.toMatchObject({ code: "55P03" });
      }
    });
    await transaction(owner, async db => {
      await db.query(`UPDATE public.${occurrence} SET deadline_rule_ref=NULL,deadline_rule_revision=NULL,
        lead_seconds=NULL,late_cancel_disposition=NULL WHERE cycle_key=$1`, [f.cycleKey]);
      const expected = { code: "renewal_deadline_rule_unsupported", field: "/deadlineRuleRef" };
      expect(await call(db, read, f.scope)).toEqual({ kind: "unavailable", ...expected });
      await expect(call(db, lock, f.scope)).rejects.toMatchObject({ code: "22023", message: expected.code, detail: expected.field });
    }, "ROLLBACK");
    await transaction(owner, db => call(db, writer, args(f)));
    await transaction(owner, async db => {
      await db.query(`DELETE FROM public.${generations} WHERE cycle_key=$1`, [f.cycleKey]);
      expect((await db.query(`SELECT id FROM public.${operations} WHERE id=$1`, [operationId])).rows).toEqual([{ id: operationId }]);
      await unavailable(db, f, "/cycleKey");
    }, "ROLLBACK");
    await moveDue(owner, f);
    await owner.query(`UPDATE public.${generations} SET claim_token=$2,lease_generation=2 WHERE cycle_key=$1`, [f.cycleKey, randomUUID()]);
    await owner.query(`UPDATE public.${occurrence} SET effective_due_at='2040-03-11T12:00:00.123456Z',lead_seconds=86401 WHERE cycle_key=$1`, [f.cycleKey]);
    await transaction(owner, async db => {
      for (const zone of ["America/New_York", "Etc/UTC"]) {
        await db.query("SELECT set_config('TimeZone',$1,true)", [zone]);
        expect(await call(db, lock, f.scope)).toMatchObject({ cycleKey: f.cycleKey, originalAnchorAt: original,
          effectiveDueAt: "2040-03-11T12:00:00.123456Z", cancellationDeadlineAt: "2040-03-10T11:59:59.123456Z",
          operationId, commercialGenerationId: operationId });
      }
    });
    const history = await rootFixture(owner, "legacy");
    for (const key of [history.cycleKey, randomUUID()])
      await expectUnavailable(owner, { ...f, scope: [f.clientId, f.subscriptionId, key] }, "/cycleKey");
    for (const routine of [read, lock]) await expect(call(owner, routine, [history.clientId, f.subscriptionId, f.cycleKey]))
      .rejects.toMatchObject({ code: "22023", message: "subscription_command_forbidden", detail: "/subscriptionId" });
    const legacyId = await transaction(owner, async db => {
      const id = await retainLegacy(db, history);
      await db.query(`UPDATE public.${occurrence} SET lifecycle='retired',is_current=false WHERE cycle_key=$1`, [history.cycleKey]);
      return id;
    });
    const historyView = await call(owner, read, history.scope);
    expect(historyView).toMatchObject({ cycleKey: history.cycleKey, rail: "legacy", lifecycle: "retired", operationId: legacyId });
    await expect(call(owner, lock, history.scope)).rejects.toMatchObject({ code: "22023", detail: "/cycleKey" });
    const legacyOnV3 = await rootFixture(owner), v3OnLegacy = await rootFixture(owner);
    await transaction(owner, db => retainLegacy(db, legacyOnV3));
    await call(owner, writer, args(v3OnLegacy));
    await owner.query(`UPDATE public.${occurrence} SET rail='legacy' WHERE cycle_key=$1`, [v3OnLegacy.cycleKey]);
    for (const mixed of [legacyOnV3, v3OnLegacy]) {
      await expectUnavailable(owner, mixed, "/cycleKey");
      await moveDue(owner, mixed, false);
      await expectUnavailable(owner, mixed, "/cycleKey");
    }
    const wrongAnchor = await rootFixture(owner), invalidDue = await rootFixture(owner);
    for (const test of [wrongAnchor, invalidDue]) await call(owner, writer, args(test));
    await owner.query(`UPDATE public.${operations} SET scheduled_at=scheduled_at+interval '1 hour' WHERE id=$1`,
      [wrongAnchor.agreement.operationId]);
    await owner.query(`UPDATE public.${occurrence} SET effective_due_at=original_anchor_at-interval '1 hour' WHERE cycle_key=$1`, [invalidDue.cycleKey]);
    const invalidViews = [[wrongAnchor, "/cycleKey"], [invalidDue, "/effectiveDueAt"]] as const;
    for (const [test, field] of invalidViews) await expectUnavailable(owner, test, field);

    const receipt = randomUUID();
    const result = { status: "applied", cancellationEffectiveAt: "2040-03-10T11:58:58.765432Z" };
    await transaction(owner, async db => {
      await insert(db, "subscription_command_receipts", {
        id: receipt, actor_id: randomUUID(), idempotency_key: `cancel:${receipt}`, subscription_id: f.subscriptionId, client_id: f.clientId,
        command_fingerprint: "a".repeat(64), command: { action: "cancel", subscriptionId: f.subscriptionId, clientId: f.clientId, payload: {} },
        result, status: "applied", created_at: result.cancellationEffectiveAt,
      });
      await db.query(`UPDATE public.${occurrence} SET lifecycle='stopped',cancellation_receipt_id=$2,cancellation_effective_at=$3 WHERE cycle_key=$1`,
        [f.cycleKey, receipt, result.cancellationEffectiveAt]);
    });
    const active = await rootFixture(owner);
    const created = await call(owner, writer, args(active));
    const packet = await capture(store.owner, store.inventory, "renewal-occurrence-source");
    if (profile === "legacy" || profile === "legacy-with-service") {
      await expect(restoreConnectedNativeStore({ owner, installation: store.installation as never, packet, freshTarget: packet }))
        .rejects.toMatchObject({ code: "invalid_input" });
      return;
    }
    const target = await installOccurrenceStore(profile, "target");
    onTestFinished(target.close);
    const { installation } = target;
    if (installation.generation === "legacy") throw new Error("Qualified restore required");
    const restore = { owner: target.migrator, installation, packet, freshTarget: await capturePristine(target) };
    for (const replayed of [false, true]) {
      await withPlatformCatalog(measuredOccurrencePlan(writerPlan(), profile, target.inventory), async root => {
        const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
        try { expect(await restoreConnectedNativeStore(restore)).toMatchObject({ replayed }); }
        finally { cwd.mockRestore(); }
      });
      const view = await call(target.migrator, read, f.scope);
      expect(view).toEqual(await call(owner, read, f.scope));
      expect(view).toMatchObject({ lifecycle: "stopped", cancellationEffectiveAt: result.cancellationEffectiveAt, operationId, commercialGenerationId: operationId });
      expect((await target.migrator.query(`SELECT r.id,r.result FROM public.${occurrence} c
        JOIN public.subscription_command_receipts r ON r.id=c.cancellation_receipt_id WHERE c.cycle_key=$1`, [f.cycleKey])).rows)
        .toEqual([{ id: receipt, result }]);
      expect(await call(target.migrator, lock, active.scope)).toEqual(await call(owner, read, active.scope));
      expect(await call(target.migrator, writer, args(active))).toEqual({ ...created, outcome: "existing", claimToken: null, leaseExpiresAt: null });
      expect(await call(target.migrator, read, history.scope)).toEqual(historyView);
      for (const [test, field] of [...invalidViews, [legacyOnV3, "/cycleKey"], [v3OnLegacy, "/cycleKey"]] as const)
        await expectUnavailable(target.migrator, test, field);
      expect((await capture(target.owner, target.inventory, "renewal-occurrence-restored")).owned).toEqual(packet.owned);
    }
  });
