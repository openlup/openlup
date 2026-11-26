import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Pool } from "pg";
import { expect, it } from "vitest";
import type { PgQueryExecutor } from "@openlup/platform/data";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import { createCustomerPreferencePrivacyContributor, createPostgresPrivacyStore,
  createPostgresPrivacyUnitOfWork, createPrivacyEraseHandler } from "@openlup/platform/identity";
import type { ErasureReceipt } from "@openlup/platform/identity/contracts";
import { closePostgres, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { composeNativePrivacy } from "../../server/runtime/auth/privacyBinding.js";
import { createSubscriptionsPrivacyContributor } from "../../server/runtime/auth/subscriptionsPrivacyContributor.js";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { installAccountMutations, type AccountMutationsStore, type AccountProfile } from "./customerAccountMutations.fixture.js";
import { capture, insert, transaction } from "./orderMoneyV2Storage.fixture.js";
import { AT, call, later, sandboxRenewal, type Renewal } from "./subscriptionNativeFixture.js";

const occurrence = "subscription_cycle_occurrences";
const lock = "subscriptions__lock_renewal_occurrence";
const read = "subscriptions__read_renewal_occurrence";
type Profile = AccountProfile | "legacy-with-service";

type Store = Pick<AccountMutationsStore, "owner" | "migrator" | "runtime" | "installation" | "inventory" | "close">;
async function legacyRuntime(owner: Pool, connectionString: string, withServiceRole: boolean) {
  const password = randomUUID();
  await owner.query(`CREATE ROLE occurrence_privacy LOGIN PASSWORD '${password}'`);
  if (withServiceRole) await owner.query("GRANT service_role TO occurrence_privacy");
  const recipient = withServiceRole ? "service_role" : "occurrence_privacy";
  // Keep the grants for the incumbent subscription veto and mounted privacy export.
  await owner.query(`GRANT SELECT, UPDATE ON public.subscriptions TO ${recipient}`);
  if (!withServiceRole) await owner.query(`GRANT EXECUTE ON FUNCTION public.customer_preferences_export(uuid),
    public.customer_preferences_prepare_erasure(), public.customer_preferences_erase(uuid) TO occurrence_privacy`);
  const url = new URL(connectionString);
  url.username = "occurrence_privacy";
  url.password = password;
  return new Pool({ connectionString: url.href, options: withServiceRole ? "-c role=service_role" : undefined });
}

async function install(profile: Profile, side = "source"): Promise<Store> {
  if (profile !== "legacy-with-service") {
    const store = await installAccountMutations(profile, false, `renewal-occurrence-${side}`, undefined, undefined, { isolatedCluster: true });
    if (profile !== "legacy") return store;
    try {
      const runtime = await legacyRuntime(store.owner, store.owner.options.connectionString!, false);
      return { ...store, runtime, close: async () => { await runtime.end(); await store.close(); } };
    } catch (error) { await store.close(); throw error; }
  }
  const container = await runPostgresContainer({ name: `renewal-occurrence-service-${process.pid}`, password: "synthetic-occurrence" });
  const owner = new Pool({ connectionString: container.connectionString });
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    await owner.query("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS");
    const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest;
    for (const entry of [manifest.baseline, ...manifest.forward]) await owner.query(readFileSync(entry.file, "utf8"));
    const runtime = await legacyRuntime(owner, container.connectionString, true);
    return { owner, migrator: owner, runtime, installation: { generation: "legacy" },
      inventory: manifest.objectInventorySha256, close: () => closePostgres(container, [runtime, owner]) };
  } catch (error) {
    await closePostgres(container, [owner]);
    throw error;
  }
}

function expectUnavailable(db: Pool, scope: string[], field: string) {
  return transaction(db, async tx => {
    expect(await call(tx, read, scope)).toEqual({ kind: "unavailable", code: "renewal_cycle_unavailable", field });
    await expect(call(tx, lock, scope)).rejects.toMatchObject({ code: "22023", message: "renewal_cycle_unavailable", detail: field });
  }, "ROLLBACK");
}

async function retainInvalid(owner: Pool, root: Renewal, anchor: string, due: string) {
  const cycleKey = randomUUID(), generation = randomUUID();
  await transaction(owner, async db => {
    await insert(db, occurrence, {
      cycle_key: cycleKey, subscription_id: root.subscription, client_id: root.client,
      original_anchor_at: anchor, effective_due_at: due, cadence_seconds: 604800,
      rail: "v3", lifecycle: "active", is_current: true, operation_id: root.operation, commercial_generation_id: generation,
      deadline_rule_ref: "accepted", deadline_rule_revision: 1, lead_seconds: 0, late_cancel_disposition: "hold_current",
    });
    await insert(db, "subscription_cycle_generations", {
      operation_id: root.operation, commercial_generation_id: generation, cycle_key: cycleKey,
      agreement: {}, agreement_fingerprint: "a".repeat(64), claim_token: randomUUID(), lease_expires_at: AT, lease_generation: 1,
    });
  });
  return [root.client, root.subscription, cycleKey];
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
      const privacy = createSubscriptionsPrivacyContributor();
      const subject = { contactId: renewal.client, principalId: null, identity: {} };
      const retention = expect.objectContaining({ disposition: "retain", resource: "subscriptions.occurrence-evidence" });
      const verifyPrivacy = async (populated: boolean) => {
        const evidence = populated ? { renewalOccurrences: [expect.objectContaining({ cycleKey })] } : {};
        expect((await privacy.export(store.runtime, subject)).data).toEqual([{ id: renewal.subscription, status: "active", ...evidence }]);
        await transaction(store.runtime, async db => {
          await db.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1", [renewal.subscription]);
          await privacy.prepareErasure(db);
          const assessment = await privacy.assessErasure(db, subject);
          if (populated) expect(assessment.obligations).toContainEqual(retention);
          else expect(assessment.obligations).not.toContainEqual(retention);
          const result = await privacy.eraseOrRetain(db, subject, assessment, { principalId: randomUUID() });
          expect(result.obligations).toEqual(assessment.obligations);
          expect((await privacy.export(db, subject)).data).toEqual([{ id: renewal.subscription, status: "cancelled", ...evidence }]);
        }, "ROLLBACK");
      };
      if (store.installation.generation === "legacy") {
        const role = (await store.runtime.query(`SELECT session_user AS login,current_user AS effective,
          coalesce((SELECT pg_has_role(session_user,oid,'MEMBER') FROM pg_roles WHERE rolname='service_role'),false) AS service`)).rows[0];
        expect(role).toEqual({ login: "occurrence_privacy", effective: profile === "legacy-with-service" ? "service_role" : "occurrence_privacy",
          service: profile === "legacy-with-service" });
      }
      await verifyPrivacy(false);
      await insert(owner, occurrence, {
        cycle_key: cycleKey, subscription_id: renewal.subscription, client_id: renewal.client,
        original_anchor_at: original, effective_due_at: original, cadence_seconds: 604800,
        rail: "v3", lifecycle: "active", is_current: true,
      });
      const scope = [renewal.client, renewal.subscription, cycleKey];
      for (const entry of [read, lock]) await expect(call(store.runtime, entry, scope)).rejects.toMatchObject({
        code: "42501", message: `permission denied for function ${entry}`,
      });
      await expect(call(store.runtime, "subscriptions__export_renewal_occurrences", [renewal.client])).rejects.toMatchObject({
        code: "42501", message: "permission denied for function subscriptions__export_renewal_occurrences",
      });
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
        await db.query(`UPDATE public.${occurrence} SET operation_id=$2,commercial_generation_id=$3 WHERE cycle_key=$1`,
          [cycleKey, renewal.operation, generation]);
        expect(await call(db, read, scope)).toEqual({ kind: "unavailable", code: "renewal_cycle_unavailable", field: "/cycleKey" });
        await expect(call(db, lock, scope)).rejects.toMatchObject({ code: "22023", message: "renewal_cycle_unavailable", detail: "/cycleKey" });
      }, "ROLLBACK");
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
      await verifyPrivacy(true);
      expect((await createCustomerPreferencePrivacyContributor().export(store.runtime, subject)).data).toEqual({ payment: [], delivery: [] });
      expect(await privacy.export(store.runtime, { ...subject, contactId: legacy.client })).toMatchObject({ data: [{ id: legacy.subscription, status: "active" }] });

      const earlier = later(-24);
      const ambiguous = await retainInvalid(owner, legacy, earlier, original);
      const shortened = await retainInvalid(owner, await sandboxRenewal(owner), original, earlier);
      await expectUnavailable(owner, ambiguous, "/cycleKey");
      await expectUnavailable(owner, shortened, "/effectiveDueAt");
      const receipt = randomUUID(), cancellationEffectiveAt = "2040-03-10T11:58:58.765432Z";
      const result = { status: "applied", cancellationEffectiveAt };
      await transaction(owner, async db => {
        await insert(db, "subscription_command_receipts", {
          id: receipt, actor_id: randomUUID(), idempotency_key: `cancel:${receipt}`, subscription_id: renewal.subscription, client_id: renewal.client,
          command_fingerprint: "a".repeat(64), command: { action: "cancel", subscriptionId: renewal.subscription, clientId: renewal.client, payload: {} },
          result, status: "applied", created_at: cancellationEffectiveAt,
        });
        await db.query(`UPDATE public.${occurrence} SET lifecycle='stopped',cancellation_receipt_id=$2,cancellation_effective_at=$3
          WHERE cycle_key=$1`, [cycleKey, receipt, cancellationEffectiveAt]);
      });
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
            const restoredView = await call(target.migrator, read, scope);
            expect(restoredView).toEqual(await call(owner, read, scope));
            expect(restoredView).toMatchObject({ cancellationEffectiveAt, lifecycle: "stopped" });
            expect((await target.migrator.query(`SELECT r.id,r.result FROM public.${occurrence} c
              JOIN public.subscription_command_receipts r ON r.id=c.cancellation_receipt_id WHERE c.cycle_key=$1`, [cycleKey])).rows)
              .toEqual([{ id: receipt, result }]);
            await expectUnavailable(target.migrator, ambiguous, "/cycleKey");
            await expectUnavailable(target.migrator, shortened, "/effectiveDueAt");
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

it("commits the occurrence retention obligation through mounted legacy erasure with erase-only grants", async () => {
  const fixture = await install("legacy", "erase-only");
  const { owner, runtime } = fixture;
  try {
    await owner.query(`REVOKE EXECUTE ON FUNCTION public.customer_preferences_export(uuid) FROM occurrence_privacy;
      GRANT SELECT, UPDATE ON public.clients TO occurrence_privacy;
      CREATE POLICY occurrence_privacy_clients_select ON public.clients FOR SELECT TO occurrence_privacy USING (true);
      CREATE POLICY occurrence_privacy_clients_update ON public.clients FOR UPDATE TO occurrence_privacy USING (true) WITH CHECK (true);
      GRANT SELECT ON public.platform_human_memberships, public.platform_control_operators TO occurrence_privacy;
      GRANT UPDATE (membership_revocation_reason) ON public.platform_human_memberships TO occurrence_privacy;
      GRANT SELECT, INSERT, UPDATE ON public.identity_privacy_erasures TO occurrence_privacy;
      GRANT SELECT, DELETE ON public.customer_identity_challenges TO occurrence_privacy;
      GRANT EXECUTE ON FUNCTION public.identity_privacy_required_contributor_ids(), public.identity_privacy_reconciled_contributor_ids(uuid),
        public.fulfillment_erase_parcel_contacts(uuid), public.customer_billing_prepare_erasure(), public.customer_billing_erase(uuid),
        public.communication_event_prepare_erasure(), public.communication_event_privacy(uuid,boolean),
        public.commerce_destination_v2_receipts_erase(uuid), public.commerce_destination_v2_erase(uuid),
        public.customer_saved_addresses_prepare_erasure(), public.customer_saved_addresses_erase(uuid),
        public.tax_calculation_erase_v1(uuid) TO occurrence_privacy`);
    expect((await runtime.query(`SELECT session_user AS login,
      coalesce((SELECT pg_has_role(session_user,oid,'MEMBER') FROM pg_roles WHERE rolname='service_role'),false) AS service,
      has_function_privilege('public.customer_preferences_export(uuid)','EXECUTE') AS export,
      has_function_privilege('public.customer_preferences_prepare_erasure()','EXECUTE') AS prepare,
      has_function_privilege('public.customer_preferences_erase(uuid)','EXECUTE') AS erase,
      has_column_privilege('public.subscription_cycle_occurrences','client_id','SELECT') AS carrier`)).rows[0])
      .toEqual({ login: "occurrence_privacy", service: false, export: false, prepare: true, erase: true, carrier: false });

    const principalId = randomUUID();
    await owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES ($1,'admin@example.invalid')", [principalId]);
    await owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
      VALUES ($1,'admin','active','legacy',now())`, [principalId]);
    const store = createPostgresPrivacyStore();
    const connected = createPostgresPrivacyUnitOfWork({ connectionString: runtime.options.connectionString! }, { pool: runtime });
    const failures: string[] = [];
    const unitOfWork = { run: <T>(work: (db: PgQueryExecutor) => Promise<T>) => connected.run(db => work({
      async query(sql, values) {
        try { return await db.query(sql, values); }
        catch (error) {
          failures.push(`${sql.trim().split("\n")[0]}: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      },
    })) };
    const { operations } = composeNativePrivacy({ store, unitOfWork });
    const handler = createPrivacyEraseHandler({ operations, authorizeAdmin: async () => ({ ok: true, principalId, role: "admin", isMachineActor: false }) });
    const erase = async (contactId: string) => {
      const idempotencyKey = randomUUID();
      const req: HttpRequest = Object.assign(new IncomingMessage(new Socket()), {
        method: "POST", query: {}, body: { subject: { kind: "contact", contactId }, idempotencyKey },
      });
      let status = 0, body: unknown;
      const res: HttpResponse = Object.assign(new ServerResponse(req), {
        status(code: number) { status = code; res.statusCode = code; return res; },
        json(value: unknown) { body = value; return res; },
        send() { throw new Error("Expected a JSON erasure response"); },
        redirect() { throw new Error("Expected a JSON erasure response"); },
      });
      await handler(req, res);
      expect({ status, body }, failures.join("\n")).toMatchObject({ status: 200, body: { ok: true, data: { outcome: "ERASED" } } });
      const { data } = body as { data: ErasureReceipt };
      const { rows } = await owner.query("SELECT retained_obligations FROM public.identity_privacy_erasures WHERE idempotency_key=$1", [idempotencyKey]);
      expect(rows).toEqual([{ retained_obligations: data.obligations }]);
      return data.obligations;
    };
    const seed = async () => {
      const client = randomUUID(), subscription = randomUUID();
      await insert(owner, "clients", { id: client, email: `${client}@example.invalid` });
      await insert(owner, "subscriptions", { id: subscription, client_id: client, status: "cancelled", cadence_days: 7, next_cycle_at: AT });
      return { client, subscription };
    };
    const empty = await seed();
    const emptyObligations = await erase(empty.client);
    expect(emptyObligations.map(value => value.resource)).toContain("subscriptions.lifecycle");
    expect(emptyObligations.map(value => value.resource)).not.toContain("subscriptions.occurrence-evidence");

    const populated = await seed(), cycleKey = randomUUID();
    await insert(owner, occurrence, { cycle_key: cycleKey, subscription_id: populated.subscription, client_id: populated.client,
      original_anchor_at: AT, effective_due_at: AT, cadence_seconds: 604800, rail: "legacy", lifecycle: "stopped", is_current: true });
    const evidence = { owner: "subscriptions", resource: "subscriptions.occurrence-evidence", disposition: "retain",
      reasonCode: "RENEWAL_OCCURRENCE_RETENTION", remote: false };
    const populatedObligations = await erase(populated.client);
    expect(populatedObligations.filter(value => value.resource === evidence.resource)).toEqual([evidence]);
    expect(populatedObligations.filter(value => value.resource !== evidence.resource)).toEqual(emptyObligations);

    // Export authority does not imply permission to assess or erase.
    await owner.query(`REVOKE EXECUTE ON FUNCTION public.customer_preferences_prepare_erasure(), public.customer_preferences_erase(uuid) FROM occurrence_privacy;
      GRANT EXECUTE ON FUNCTION public.customer_preferences_export(uuid) TO occurrence_privacy`);
    const contributor = createSubscriptionsPrivacyContributor();
    const subject = { contactId: populated.client, principalId: null, identity: {} };
    expect((await contributor.export(runtime, subject)).data).toEqual([{ id: populated.subscription, status: "cancelled",
      renewalOccurrences: [expect.objectContaining({ cycleKey })] }]);
    await expect(contributor.assessErasure(runtime, subject)).rejects.toMatchObject({ code: "PRIVACY_ASSESSMENT_UNAVAILABLE" });
  } finally { await fixture.close(); }
}, postgresSetupTimeoutMs);
