import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { closePostgres, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { createSubscriptionsPrivacyContributor } from "../../server/runtime/auth/subscriptionsPrivacyContributor.js";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { installAccountMutations, type AccountMutationsStore, type AccountProfile } from "./customerAccountMutations.fixture.js";
import { capture, insert, transaction } from "./orderMoneyV2Storage.fixture.js";
import { AT, call, later, sandboxRenewal } from "./subscriptionNativeFixture.js";

const occurrence = "subscription_cycle_occurrences";
const lock = "subscriptions__lock_renewal_occurrence";
const read = "subscriptions__read_renewal_occurrence";
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
  "reads, retains and transfers the exact renewal occurrence on %s",
  async profile => {
    const store = await install(profile);
    try {
      const owner = store.migrator;
      const renewal = await sandboxRenewal(owner);
      const legacy = await sandboxRenewal(owner);
      const cycleKey = randomUUID();
      const original = AT.replace(".000Z", ".000000Z");
      await insert(owner, occurrence, {
        cycle_key: cycleKey, subscription_id: renewal.subscription, client_id: renewal.client,
        original_anchor_at: original, effective_due_at: original, cadence_seconds: 604800,
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
            originalAnchorAt: original, effectiveDueAt: original, cancellationDeadlineAt: original,
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
        for (const hours of [72, 24, 72]) {
          await applyArrival(later(hours).replace(".000Z", ".123456Z"));
          expect(await call(db, lock, scope)).toMatchObject({ cycleKey, originalAnchorAt: original,
            effectiveDueAt: later(240).replace(".000Z", ".123456Z"), operationId: renewal.operation, commercialGenerationId: generation });
        }
        await db.query("UPDATE public.subscription_cycle_generations SET claim_token=$2,lease_generation=2 WHERE cycle_key=$1", [cycleKey, randomUUID()]);
        await db.query(`UPDATE public.${occurrence} SET effective_due_at='2040-03-11T12:00:00.123456Z',
          lead_seconds=86401 WHERE cycle_key=$1`, [cycleKey]);
        await applyArrival(later(72));
        for (const zone of ["America/New_York", "Etc/UTC"]) {
          await db.query("SELECT set_config('TimeZone',$1,true)", [zone]);
          expect(await call(db, lock, scope)).toMatchObject({ cycleKey, originalAnchorAt: original,
            effectiveDueAt: "2040-03-11T12:00:00.123456Z", cancellationDeadlineAt: "2040-03-10T11:59:59.123456Z",
            operationId: renewal.operation, commercialGenerationId: generation });
        }
      });
      await transaction(owner, async db => {
        await call(db, lock, scope);
        await expect(owner.query("SELECT 1 FROM public.subscriptions WHERE id=$1 FOR UPDATE NOWAIT", [renewal.subscription]))
          .rejects.toMatchObject({ code: "55P03" });
        await expect(owner.query(`SELECT 1 FROM public.${occurrence} WHERE cycle_key=$1 FOR UPDATE NOWAIT`, [cycleKey]))
          .rejects.toMatchObject({ code: "55P03" });
      }, "ROLLBACK");
      await transaction(owner, async db => {
        await db.query(`UPDATE public.${occurrence} SET original_anchor_at=$2 WHERE cycle_key=$1`, [cycleKey, later(-24)]);
        expect(await call(db, read, scope)).toEqual({
          kind: "unavailable", code: "renewal_cycle_unavailable", field: "/cycleKey",
        });
        await expect(call(db, lock, scope)).rejects.toMatchObject({
          code: "22023", message: "renewal_cycle_unavailable", detail: "/cycleKey",
        });
      }, "ROLLBACK");
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
