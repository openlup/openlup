import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { closePostgres, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { connectedStoreAllowedInsertTriggers } from "../../server/adapters/postgres/connectedStoreDomains/index.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { createSubscriptionsPrivacyContributor } from "../../server/runtime/auth/subscriptionsPrivacyContributor.js";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { installAccountMutations, type AccountMutationsStore, type AccountProfile } from "./customerAccountMutations.fixture.js";
import { capture, insert, rejected, transaction } from "./orderMoneyV2Storage.fixture.js";
import { AT, call, later, sandboxRenewal } from "./subscriptionNativeFixture.js";

const occurrence = "subscription_cycle_occurrences";
const lock = "subscriptions__lock_renewal_occurrence";
const read = "subscriptions__read_renewal_occurrence";
const check = "subscriptions__check_legacy_renewal_write";
type Profile = AccountProfile | "legacy-with-service";

type Store = Pick<AccountMutationsStore, "owner" | "migrator" | "runtime" | "installation" | "inventory" | "close">;
async function install(profile: Profile, side = "source"): Promise<Store> {
  if (profile !== "legacy-with-service") return installAccountMutations(profile, false, `renewal-occurrence-${side}`, undefined, undefined, { isolatedCluster: true });
  const container = await runPostgresContainer({ name: `renewal-occurrence-service-${process.pid}`, password: "synthetic-occurrence" });
  const owner = new Pool({ connectionString: container.connectionString });
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    await owner.query("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS");
    const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest;
    for (const entry of [manifest.baseline, ...manifest.forward]) await owner.query(readFileSync(entry.file, "utf8"));
    return { owner, migrator: owner, runtime: owner, installation: { generation: "legacy" },
      inventory: manifest.objectInventorySha256, close: () => closePostgres(container, [owner]) };
  } catch (error) {
    await closePostgres(container, [owner]);
    throw error;
  }
}

async function capturePristine(store: Store) {
  const restricted = store.installation.generation === "qualified-admin";
  if (restricted) await store.migrator.query("GRANT platform_acquisition_owner TO account_m WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY account_m");
  try {
    return await capture(store.migrator, store.inventory, "renewal-occurrence-pristine");
  } finally {
    if (restricted) await store.migrator.query("REVOKE platform_acquisition_owner FROM account_m GRANTED BY account_m");
  }
}

it.each(["legacy", "legacy-with-service", "bootstrap", "separate", "admin-managed", "admin-operator"] as const)(
  "reads the exact stable renewal occurrence with the installed owner and fences legacy work on %s",
  async profile => {
    const store = await install(profile);
    try {
      const owner = store.migrator;
      const renewal = await sandboxRenewal(owner);
      const legacy = await sandboxRenewal(owner);
      const cycleKey = randomUUID();
      const original = "2024-01-01T12:00:00.123456Z";
      const effective = original;
      await insert(owner, occurrence, {
        cycle_key: cycleKey, subscription_id: renewal.subscription, client_id: renewal.client,
        original_anchor_at: original, effective_due_at: effective, cadence_seconds: 604800,
        rail: "v3", lifecycle: "active", is_current: true,
      });
      const scope = [renewal.client, renewal.subscription, cycleKey];
      expect(await call(owner, read, scope)).toEqual({
        kind: "unavailable", code: "renewal_deadline_rule_unsupported", field: "/deadlineRuleRef",
      });
      await owner.query(`UPDATE public.${occurrence} SET deadline_rule_ref='accepted',
        deadline_rule_revision=1, lead_seconds=0, late_cancel_disposition='hold_current' WHERE cycle_key=$1`, [cycleKey]);
      await transaction(owner, async db => {
        for (const zone of ["America/New_York", "Etc/UTC"]) {
          await db.query("SELECT set_config('TimeZone',$1,true)", [zone]);
          expect(await call(db, lock, scope)).toEqual({
            clientId: renewal.client, subscriptionId: renewal.subscription, cycleKey,
            originalAnchorAt: original, effectiveDueAt: effective, cancellationDeadlineAt: effective,
            deadlineRuleRef: "accepted", deadlineRuleRevision: 1, cadenceSeconds: 604800, rail: "v3",
            lifecycle: "active", cancellationEffectiveAt: null, operationId: null, commercialGenerationId: null,
          });
        }
      }, "ROLLBACK");
      expect(await call(owner, read, [renewal.client, renewal.subscription, randomUUID()])).toEqual({
        kind: "unavailable", code: "renewal_cycle_unavailable", field: "/cycleKey",
      });
      await expect(call(owner, lock, [legacy.client, renewal.subscription, cycleKey])).rejects
        .toMatchObject({ code: "22023", detail: "/subscriptionId" });
      const generation = randomUUID(), initialToken = randomUUID();
      await transaction(owner, async db => {
        await call(db, lock, scope);
        await insert(db, "subscription_cycle_generations", {
          operation_id: renewal.operation, commercial_generation_id: generation, cycle_key: cycleKey,
          agreement: {}, agreement_fingerprint: "a".repeat(64), claim_token: initialToken,
          lease_expires_at: AT, lease_generation: 1,
        });
        await db.query(`UPDATE public.${occurrence} SET operation_id=$2,commercial_generation_id=$3
          WHERE cycle_key=$1`, [cycleKey, renewal.operation, generation]);
        const applyArrival = (at: string) => db.query(`UPDATE public.${occurrence}
          SET effective_due_at=greatest(effective_due_at,$2::timestamptz+interval '168 hours') WHERE cycle_key=$1`, [cycleKey, at]);
        for (const at of ["2024-01-04T12:00:00.123456Z", "2024-01-02T12:00:00.123456Z", "2024-01-04T12:00:00.123456Z"]) {
          await applyArrival(at);
          expect(await call(db, lock, scope)).toMatchObject({ cycleKey, originalAnchorAt: original,
            effectiveDueAt: "2024-01-11T12:00:00.123456Z", operationId: renewal.operation, commercialGenerationId: generation });
        }
        await db.query("UPDATE public.subscription_cycle_generations SET claim_token=$2,lease_generation=2 WHERE cycle_key=$1", [cycleKey, randomUUID()]);
        await db.query(`UPDATE public.${occurrence} SET effective_due_at='2024-03-10T12:00:00.123456Z',
          lead_seconds=86401 WHERE cycle_key=$1`, [cycleKey]);
        await applyArrival("2024-01-04T12:00:00.123456Z");
        for (const zone of ["America/New_York", "Etc/UTC"]) {
          await db.query("SELECT set_config('TimeZone',$1,true)", [zone]);
          expect(await call(db, lock, scope)).toMatchObject({ cycleKey, originalAnchorAt: original,
            effectiveDueAt: "2024-03-10T12:00:00.123456Z", cancellationDeadlineAt: "2024-03-09T11:59:59.123456Z",
            operationId: renewal.operation, commercialGenerationId: generation });
        }
      });
      await transaction(owner, async db => {
        await call(db, lock, scope);
        const busy = await rejected(store.runtime.query(
          "UPDATE public.subscription_renewal_operations SET claimed_by='competing-writer' WHERE id=$1", [renewal.operation]));
        expect(busy).toMatchObject({ code: "55P03" });
      }, "ROLLBACK");
      const compareWrite = (subscription: string) => transaction(store.runtime, db =>
        db.query(`UPDATE public.subscription_renewal_operations SET claimed_by='renewal-witness' WHERE subscription_id=$1`, [subscription]), "ROLLBACK");
      const denial = { code: "22023", message: "renewal_v3_unavailable", detail: "/rail" };
      expect(await rejected(compareWrite(renewal.subscription))).toMatchObject(denial);
      expect(await rejected(call(store.runtime, check, [renewal.subscription]))).toMatchObject(denial);
      expect((await compareWrite(legacy.subscription)).rowCount).toBe(1);
      await call(store.runtime, check, [legacy.subscription]);
      const missing = randomUUID();
      expect((await compareWrite(missing)).rowCount).toBe(0);
      await call(store.runtime, check, [missing]);
      const unscoped = store.installation.generation === "legacy"
        ? profile === "legacy-with-service" ? "service_role" : "anon" : "anon";
      const asUnscopedRole = (sql: string, subscription: string) => transaction(store.runtime, async db => {
        await db.query(unscoped === "anon" ? "SET LOCAL ROLE anon" : "SET LOCAL ROLE service_role");
        return db.query(sql, [subscription]);
      }, "ROLLBACK");
      if (unscoped === "anon") await owner.query("GRANT EXECUTE ON FUNCTION public.subscriptions__check_legacy_renewal_write(uuid) TO anon");
      try {
        for (const subscription of [missing, legacy.subscription, renewal.subscription]) {
          const denied = { code: "42501", detail: undefined };
          expect(await rejected(asUnscopedRole("SELECT public.subscriptions__check_legacy_renewal_write($1)", subscription)))
            .toMatchObject({ ...denied, message: "renewal_write_scope_unavailable" });
          expect(await rejected(asUnscopedRole("UPDATE public.subscription_renewal_operations SET claimed_by='renewal-witness' WHERE subscription_id=$1", subscription)))
            .toMatchObject(denied);
        }
      } finally {
        if (unscoped === "anon") await owner.query("REVOKE EXECUTE ON FUNCTION public.subscriptions__check_legacy_renewal_write(uuid) FROM anon");
      }
      const privacy = createSubscriptionsPrivacyContributor();
      const subject = { contactId: renewal.client, principalId: null, identity: {} };
      expect(await privacy.export(store.runtime, subject)).toMatchObject({
        data: [{ id: renewal.subscription, renewalOccurrences: [{ cycleKey }] }],
      });
      expect(await privacy.export(store.runtime, { ...subject, contactId: legacy.client })).toMatchObject({ data: [{ id: legacy.subscription, status: "active" }] });
      await transaction(store.runtime, async db => {
        await db.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1", [renewal.subscription]);
        await privacy.prepareErasure(db);
        const assessment = await privacy.assessErasure(db, subject);
        const retained = { disposition: "retain", resource: "subscriptions.occurrence-evidence" };
        expect(assessment.obligations).toContainEqual(expect.objectContaining(retained));
        const disposition = await privacy.eraseOrRetain(db, subject, assessment, { principalId: randomUUID() });
        expect(disposition.obligations).toContainEqual(expect.objectContaining(retained));
        expect(await privacy.export(db, subject)).toMatchObject({ data: [{ id: renewal.subscription, renewalOccurrences: [{ cycleKey }] }] });
      }, "ROLLBACK");

      const claimArgs = [renewal.identity, renewal.fingerprint, renewal.snapshot, "fixture", 300, later(1)];
      const stockArgs = [renewal.operation, renewal.token, 900, AT];
      const admission = { operationId: renewal.operation, claimToken: renewal.token, snapshot: renewal.snapshot,
        operationFingerprint: renewal.fingerprint, identityKey: renewal.identity, worker: "fixture" };
      for (const [entry, args] of [
        ["subscription_claim_due_renewal", claimArgs],
        ["fulfillment_reserve_subscription_renewal", stockArgs],
        ["subscription_stock_wait_admit", [admission, {}, AT]],
        ["subscription_stock_wait_recover_refusal", [renewal.operation, renewal.fingerprint, "fixture", later(1)]],
      ] as const) {
        await expect(call(store.runtime, entry, [...args])).rejects.toMatchObject(denial);
      }
      await transaction(store.runtime, async db => {
        await db.query("UPDATE public.subscriptions SET next_cycle_at=$2 WHERE id=$1", [renewal.subscription, later(2)]);
        await expect(call(db, "subscription_stock_wait_admit", [admission, {}, later(1)])).rejects.toMatchObject(denial);
      }, "ROLLBACK");
      await expect(insert(store.runtime, "subscription_cycles", {
        subscription_id: renewal.subscription, scheduled_at: AT, renewal_operation_id: renewal.operation,
        renewal_operation_fingerprint: renewal.fingerprint,
      })).rejects.toMatchObject(denial);
      await expect(insert(store.runtime, "subscription_stock_wait_cases", {
        subscription_id: renewal.subscription, client_id: renewal.client, renewal_operation_id: renewal.operation,
        scheduled_at: AT, cycle_number: 2, state: "waiting", due_snapshot: {}, cycle_snapshot: renewal.snapshot,
        fingerprint: renewal.fingerprint, identity_key: renewal.identity, deficits: [],
      })).rejects.toMatchObject(denial);
      // An original hold predates the seeded rail. Its replay conveys no fresh authority.
      await owner.query(`UPDATE public.${occurrence} SET rail='legacy' WHERE cycle_key=$1`, [cycleKey]);
      const originalHold = await call(store.runtime, "fulfillment_reserve_subscription_renewal", stockArgs);
      await owner.query(`UPDATE public.${occurrence} SET rail='v3' WHERE cycle_key=$1`, [cycleKey]);
      expect(await call(store.runtime, "fulfillment_reserve_subscription_renewal", stockArgs))
        .toEqual({ ...originalHold, replayed: true });
      await expect(call(store.runtime, "commerce_prepare_subscription_renewal", [renewal.operation, renewal.token, AT]))
        .rejects.toMatchObject(denial);
      await expect(store.runtime.query("UPDATE public.fulfillment_inventory_reservations SET expires_at=$2 WHERE id=$1",
        [originalHold.reservationId, later(2)])).rejects.toMatchObject(denial);
      await expect(insert(store.runtime, "fulfillment_inventory_reservation_lines", {
        reservation_id: originalHold.reservationId, operation_fingerprint: renewal.fingerprint, sku: "extra", quantity: 1,
      })).rejects.toMatchObject(denial);
      expect((await call(store.runtime, "fulfillment_reserve_subscription_renewal", [legacy.operation, legacy.token, 900, AT])).reserved).toBe(true);
      expect(await call(store.runtime, "fulfillment_expire_subscription_renewals", [later(1), 1])).toBe(1);
      expect((await owner.query("SELECT status FROM public.fulfillment_inventory_reservations WHERE id=$1", [originalHold.reservationId])).rows).toEqual([{ status: "held" }]);
      expect(await call(store.runtime, "fulfillment_release_subscription_renewal", [renewal.operation, renewal.token, "fixture-cleanup", AT]))
        .toMatchObject({ state: "refused" });

      if (profile === "legacy") {
        const prior = await sandboxRenewal(owner);
        await call(store.runtime, "fulfillment_reserve_subscription_renewal", [prior.operation, prior.token, 900, AT]);
        await call(store.runtime, "commerce_prepare_subscription_renewal", [prior.operation, prior.token, AT]);
        await insert(owner, occurrence, {
          cycle_key: randomUUID(), subscription_id: prior.subscription, client_id: prior.client,
          original_anchor_at: AT, effective_due_at: AT, cadence_seconds: 604800, rail: "v3", lifecycle: "active", is_current: true,
        });
        await call(store.runtime, "commerce_acknowledge_subscription_renewal_attempt", [prior.operation, prior.fingerprint, "original", AT]);
        const terminal = [prior.operation, "retained-result", prior.fingerprint, "refused", "original", "fixture", AT];
        expect(await call(store.runtime, "commerce_record_subscription_renewal_outcome", terminal)).toMatchObject({ state: "refused" });
        expect(await call(store.runtime, "commerce_record_subscription_renewal_outcome", terminal)).toMatchObject({ replayed: true });
      }
      const triggerRows = (await owner.query(`SELECT tgname AS name,tgrelid::regclass::text AS relation FROM pg_trigger
        WHERE tgname LIKE 'subscriptions_guard_renewal_%' ORDER BY tgname`)).rows;
      expect(triggerRows).toHaveLength(6);
      for (const row of triggerRows) expect(connectedStoreAllowedInsertTriggers[row.relation as keyof typeof connectedStoreAllowedInsertTriggers]).toContain(row.name);
      const packet = await capture(store.owner, store.inventory, "renewal-occurrence-source");
      if (store.installation.generation === "legacy") {
        await expect(restoreConnectedNativeStore({ owner, installation: store.installation as never, packet, freshTarget: packet }))
          .rejects.toMatchObject({ code: "invalid_input" });
      } else {
        const target = await install(profile, "target");
        try {
          if (target.installation.generation === "legacy") throw new Error("Qualified restore required");
          const freshTarget = await capturePristine(target);
          const restore = { owner: target.migrator, installation: target.installation, packet, freshTarget };
          for (const replayed of [false, true]) {
            expect(await restoreConnectedNativeStore(restore)).toMatchObject({ replayed });
            expect(await call(target.migrator, read, scope)).toEqual(await call(owner, read, scope));
            expect((await capture(target.owner, target.inventory, "renewal-occurrence-restored")).owned).toEqual(packet.owned);
          }
        } finally { await target.close(); }
      }
    } finally {
      await store.close();
    }
  },
  postgresSetupTimeoutMs,
);
