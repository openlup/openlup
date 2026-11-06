import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresStockWaitStore, runRenewalBatchRows, type NativeRenewalCodec, type SubscriptionQueryExecutor } from "@openlup/platform/subscriptions";
import { createPostgresMigrationRunner, type PostgresMigrationRunnerOptions } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import type { RenewalFrozenSnapshot } from "@openlup/platform/subscriptions/contracts";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { allPublicRows } from "./subscriptionStockWaitCases.js";
import { AT, later, renewal } from "./subscriptionNativeFixture.js";

for (const generation of ["legacy", "qualified-v2", "qualified-admin"] as const) {
  describe(`stock-wait busy reporting on ${generation}`, () => {
    let container: PostgresContainer | undefined, owner: Pool, runtime: Pool, migration: Pool;
    beforeAll(async () => {
      const timezone = "UTC";
      container = await runPostgresContainer({ name: `stock-wait-busy-${generation}-${process.pid}`, password: "synthetic-conformance",
        command: ["postgres", "-c", `timezone=${timezone}`] });
      expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
      owner = new Pool({ connectionString: container.connectionString });
      let migrationUrl = container.connectionString;
      if (generation !== "legacy") {
        for (const name of [...(generation === "qualified-admin" ? ["busy_migration"] : []), "busy_runtime", "busy_restore"]) {
          await owner.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB ${name === "busy_migration" ? "CREATEROLE" : "NOCREATEROLE"} NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
        }
        if (generation === "qualified-admin") {
          const database = (await owner.query("SELECT current_database() AS name")).rows[0].name as string;
          await owner.query(`ALTER DATABASE "${database.replaceAll('"', '""')}" OWNER TO busy_migration`);
          const url = new URL(container.connectionString); url.username = "busy_migration"; migrationUrl = url.toString();
        }
      }
      const installation: NonNullable<PostgresMigrationRunnerOptions["installation"]> = generation === "legacy"
        ? { generation } : { generation, roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: generation === "qualified-admin" ? "busy_migration" : "postgres", runtimeLogin: "busy_runtime", restoreLogin: "busy_restore" };
      migration = new Pool({ connectionString: migrationUrl, options: installation.generation === "legacy" ? undefined
        : installation.generation === "qualified-v2" ? qualifiedPostgresStartupOptions(installation) : qualifiedAdminPostgresStartupOptions(installation) });
      await createPostgresMigrationRunner({ connectionString: migrationUrl }, { installation, poolFactory: () => migration }).apply();
      const url = new URL(container.connectionString);
      if (generation !== "legacy") url.username = "busy_runtime";
      runtime = new Pool({ connectionString: url.toString(), ...(generation === "legacy" ? {} : { options: "-c role=service_role" }) });
      expect((await runtime.query("SHOW timezone")).rows).toEqual([{ TimeZone: timezone }]);
      expect((await runtime.query("SELECT current_user,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated")).rows)
        .toEqual([{ current_user: generation === "legacy" ? "postgres" : "service_role", elevated: generation === "legacy" }]);
    }, postgresSetupTimeoutMs);
    afterAll(() => closePostgres(container, [owner, runtime, migration]), postgresTeardownTimeoutMs);

    async function fixture() {
      const f = await renewal(owner, 0);
      const snapshot: RenewalFrozenSnapshot = { contractVersion: "platform.subscription.renewal.v1",
        subscriptionId: f.subscription, clientId: f.client, scheduledAt: AT, scheduledInstant: Date.parse(AT),
        frozenRevision: "original", frozenFingerprint: f.fingerprint, stockSourceKey: f.source,
        cycle: { status: "correlated", logicalCycleNumber: 3, nativeRenewalCounter: 2, activationCycleId: null, evidenceRef: "fixture" },
        retryAttempt: 0, externalAttemptSequence: 0,
        templateSnapshot: { templateId: "original", version: 1, cadenceDays: 28, lines: f.snapshot.lines },
        pricingSnapshot: { currency: "XXX", totalAmountMinor: f.snapshot.totalAmountMinor, shippingAmountMinor: 0, agreementPolicy: "lock_until_edit", proration: "none" },
        orderSnapshot: { shippingAddressRef: null, shippingQuoteRef: null, acquisitionRef: null, lines: f.snapshot.lines },
        settlementChannelKey: "fixture", authorizationRef: "frozen-mandate", payerAccountRef: null, unattendedChargeAuthorizedAt: AT };
      const due = { ...snapshot, cadenceDays: 28, currency: "XXX", deliveryAdmission: "allowed" as const, deliveryBlockReason: null };
      const codec: NativeRenewalCodec = { due: () => due, freeze: () => snapshot, encode: () => f.snapshot,
        decode: () => snapshot, fingerprint: () => f.fingerprint, identity: () => f.identity,
        readback: () => { throw new Error("fixture_unexpected_recovery_success"); } };
      const store = createPostgresStockWaitStore({ executor: runtime, codec, workerId: "stock-busy",
        async withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) {
          const db = await runtime.connect();
          try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
          catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
        } });
      return { ...f, snapshot, due, store, input: { operationId: f.operation.toUpperCase(), claimToken: f.token.toUpperCase(), snapshot, now: AT } };
    }

    // Runtime profiles and session zones measured below 0.33 s per case; retain a bounded 10 s deadline.
    it.each(["admit", "recover_refusal", "deficits", "row_lock"] as const)("omits %s busy without an error result, retry or durable outcome", async site => {
      const f = await fixture();
      const waiting = await f.store.admit(f.input);
      expect(waiting.waiting).toBe(true);
      const before = await allPublicRows(owner), blocker = await owner.connect();
      let attempts = 0, observed: unknown;
      try {
        await blocker.query("BEGIN");
        if (site === "row_lock") await blocker.query("SELECT sku FROM public.fulfillment_stock_current WHERE source_key=$1 FOR UPDATE", [f.source]);
        else await blocker.query("SELECT pg_advisory_xact_lock(846832106,1)");
        const result = await runRenewalBatchRows([f.due], async () => {
          attempts++;
          try {
            if (site === "admit") await f.store.admit({ ...f.input, now: later(1) });
            else if (site === "recover_refusal") await f.store.recoverRefusedSchedule({ operationId: f.operation.toUpperCase(), caseId: waiting.caseId!.toUpperCase(),
              claimGeneration: 1, frozenFingerprint: f.fingerprint, scheduledAt: AT, now: later(1) });
            else await f.store.deficits({ snapshot: f.snapshot, operationId: f.operation.toUpperCase(), now: later(1) });
          } catch (error) { observed = error; throw error; }
          throw new Error("fixture_expected_busy");
        }, { identityKey: () => f.identity });
        expect(observed).toMatchObject({ details: { code: "55P03", reason: site === "row_lock" ? "inventory_lock_unavailable" : "inventory_admission_busy" } });
        expect(result).toEqual([]);
        expect(result.filter(row => row.status === "error")).toHaveLength(0);
        expect(attempts).toBe(1);
        expect(await allPublicRows(owner)).toEqual(before);
      } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    }, 10_000);

    it("keeps a non-busy stock error as renewal_processing_failed", async () => {
      const f = await fixture();
      await owner.query("DELETE FROM public.fulfillment_stock_current WHERE source_key=$1", [f.source]);
      const before = await allPublicRows(owner);
      const result = await runRenewalBatchRows([f.due], async () => {
        await f.store.admit(f.input);
        throw new Error("fixture_expected_stock_error");
      }, { identityKey: () => f.identity });
      expect(result).toEqual([{ subscriptionId: f.subscription, identityKey: f.identity, operationId: "", status: "error", replayed: false, reason: "renewal_processing_failed" }]);
      expect(await allPublicRows(owner)).toEqual(before);
    }, 10_000);
  });
}
