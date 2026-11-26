import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { expect, it } from "vitest";
import type { CatalogAcceptanceV2 } from "@openlup/core/catalog";
import { closePostgres, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { installAccountMutations, type AccountMutationsStore, type AccountProfile } from "./customerAccountMutations.fixture.js";
import { capture, insert, transaction } from "./orderMoneyV2Storage.fixture.js";
import { AT, call, later, sandboxRenewal, seedRenewal, type Renewal, type RenewalSeed } from "./subscriptionNativeFixture.js";

const viewForward = "db/platform/migrations/20261129140000_native_renewal_occurrence_guards.sql";
const original = AT.replace(".000Z", ".000000Z");
const cadenceSeconds = 604800;
const occurrence = "subscription_cycle_occurrences";
const lock = "subscriptions__lock_renewal_occurrence";
const read = "subscriptions__read_renewal_occurrence";
type Profile = AccountProfile | "legacy-with-service";

type Store = Pick<AccountMutationsStore, "owner" | "migrator" | "runtime" | "installation" | "inventory" | "close">;
async function legacyRuntime(owner: Pool, connectionString: string, withServiceRole: boolean) {
  const password = randomUUID();
  await owner.query(`CREATE ROLE occurrence_runtime LOGIN PASSWORD '${password}'`);
  if (withServiceRole) await owner.query("GRANT service_role TO occurrence_runtime");
  const url = new URL(connectionString);
  url.username = "occurrence_runtime";
  url.password = password;
  return new Pool({ connectionString: url.href, options: withServiceRole ? "-c role=service_role" : undefined });
}

async function privacyDefinitions(db: Pool) {
  const { rows } = await db.query(`SELECT
    pg_get_functiondef('public.customer_preferences_export(uuid)'::regprocedure) AS export_definition,
    pg_get_functiondef('public.customer_preferences_prepare_erasure()'::regprocedure) AS prepare_definition`);
  return rows[0];
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
    let verifiedPredecessor = false;
    for (const entry of [manifest.baseline, ...manifest.forward]) {
      if (entry.file === viewForward) {
        const before = await privacyDefinitions(owner);
        await owner.query(readFileSync(entry.file, "utf8"));
        expect(await privacyDefinitions(owner)).toEqual(before);
        verifiedPredecessor = true;
      } else {
        await owner.query(readFileSync(entry.file, "utf8"));
      }
    }
    expect(verifiedPredecessor).toBe(true);
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

async function seedV3Subscription(owner: Pool) {
  const seed = await seedRenewal(owner, 10, 1, randomUUID(), true, "sandbox");
  await owner.query("UPDATE public.subscriptions SET cadence_days=7 WHERE id=$1", [seed.subscription]);
  return seed;
}

async function insertV3Root(db: PoolClient, seed: RenewalSeed, cycleKey: string, operation: string) {
  const { cycle, currency } = seed.snapshot;
  if (!cycle) throw new Error("The synthetic v3 agreement requires activation evidence");
  const priceEvidenceRef = "fixture:accepted-price:1";
  const digest = createHash("sha256").update(cycleKey).digest("hex");
  const lines = seed.snapshot.lines.map(({ lineOrdinal, sku, quantity, unitAmountMinor }) => ({
    lineKey: `line:${lineOrdinal}`, sourceOrdinal: lineOrdinal, sku, quantity, unitBasisMinor: unitAmountMinor,
    taxClassKey: "merchandise", assignmentRef: "fixture:merchandise-class:1",
  }));
  const roster = await Promise.all(lines.map(async line => {
    const { rows: [sku] } = await db.query<{ id: string; product_id: string }>(
      "SELECT id, product_id FROM public.catalog_skus WHERE sku=$1", [line.sku]);
    if (!sku) throw new Error("The synthetic catalogue roster requires a seeded SKU");
    const publicationHead = { publicationId: randomUUID(), revision: 1, documentDigest: digest };
    return { line, productId: sku.product_id, accepted: {
      schemaVersion: 2 as const, skuId: sku.id, skuCode: line.sku, skuRevisionId: randomUUID(), publicationHead,
      typeRef: { key: "fixture:article", version: 1 }, definitionDigest: digest, optionDigest: digest,
      netContent: { dimension: "count" as const, unscaled: "1", scale: 0, unit: "openlup:piece" },
    } };
  }));
  const catalogAcceptance = {
    schemaVersion: 2, lines: roster.map(({ accepted }) => accepted),
    admission: {
      quoteRef: `fixture:accepted-quote:${cycleKey}`, quoteDigest: digest, moneyVersion: "v0",
      priceEvidenceRef, policyEvidenceRef: "fixture:catalogue-policy:1",
      consultedHeads: roster.map(({ productId, accepted }) => ({ productId, ...accepted.publicationHead })),
      lineBindings: roster.map(({ line, accepted }) => ({
        source: "retained", mode: "subscription", role: "core", lineKey: line.lineKey, sourceOrdinal: line.sourceOrdinal,
        skuId: accepted.skuId, skuCode: accepted.skuCode, skuRevisionId: accepted.skuRevisionId, quantity: line.quantity,
      })),
    },
  } satisfies CatalogAcceptanceV2;
  const agreement = {
    frozenRevision: "native.purchase-renewal.v3", contractVersion: "platform.subscription.renewal.v3",
    clientId: seed.client, subscriptionId: seed.subscription, cycleKey, originalAnchorAt: original,
    operationId: operation, commercialGenerationId: operation, cadenceSeconds, cycleNumber: seed.snapshot.cycleNumber,
    cycle, templateSnapshot: { version: 1, templateId: seed.subscription, cadenceDays: cadenceSeconds / 86400 },
    catalogAcceptance, lines,
    terms: { version: "native.renewal-terms.v3", currency, amountBasis: "gross_fixed",
      priceListRef: "fixture:list:1", priceEvidenceRef, priceContextDigest: digest, classMapRevision: "fixture:classes:1" },
    discountTerms: { kind: "none", evidenceRef: priceEvidenceRef },
    acquisitionEvidenceRef: cycle.evidenceRef,
    shippingTerms: { version: "shipping-threshold.v1", currency, flatMinor: 15, freeThresholdMinor: 500,
      assignmentRef: "fixture:shipping-class:1", taxClassKey: "shipping" },
    handlingTerms: { currency, flatMinor: 5, separatelyStated: true, assignmentRef: "fixture:handling-class:1", taxClassKey: "handling" },
    destinationSelectionPolicy: { kind: "current_validated", policyRevision: "fixture:destination-policy:1",
      deliverySelectionRef: "fixture:delivery:1", providerRef: "fixture:delivery-provider", carrierRef: "fixture:carrier",
      serviceRef: "fixture:service", servicePolicyRevision: "1", adapterRevision: "1" },
    unattendedChargeAuthorizedAt: original,
    stockSourceKey: seed.source, settlementChannelKey: seed.snapshot.settlementChannelKey,
    payerAccountRef: seed.snapshot.payerAccountRef, authorizationRef: seed.snapshot.authorizationRef,
  };
  const canonical = JSON.stringify(agreement, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const row = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]]));
  });
  const fingerprint = createHash("sha256").update(canonical).digest("hex");
  const claimToken = randomUUID(), expiresAt = later(1);
  // Plant the dormant root as its owner. The incumbent Catalogue acceptance columns use their null defaults.
  await insert(db, "subscription_renewal_operations", {
    id: operation, subscription_id: seed.subscription, scheduled_at: original, cycle_number: seed.snapshot.cycleNumber,
    identity_key: `subscription:${seed.subscription}:renewal-v3:${cycleKey}`, operation_fingerprint: fingerprint,
    cycle_snapshot: { ...agreement, frozenFingerprint: fingerprint }, claim_token: claimToken,
    claimed_by: "fixture", claimed_at: AT, lease_expires_at: expiresAt, created_at: AT, updated_at: AT,
  });
  return {
    operation_id: operation, commercial_generation_id: operation, cycle_key: cycleKey,
    agreement, agreement_fingerprint: fingerprint, claim_token: claimToken, lease_expires_at: expiresAt, lease_generation: 1,
  };
}

async function retainSelection(owner: Pool, root: RenewalSeed | Renewal, anchor: string, due: string, rail: "v3" | "legacy" = "v3", history = false): Promise<[string, string, string]> {
  const cycleKey = randomUUID();
  await transaction(owner, async db => {
    await insert(db, occurrence, {
      cycle_key: cycleKey, subscription_id: root.subscription, client_id: root.client,
      original_anchor_at: anchor, effective_due_at: due, cadence_seconds: cadenceSeconds,
      rail, lifecycle: history ? "retired" : "active", is_current: !history,
      deadline_rule_ref: "accepted", deadline_rule_revision: 1, lead_seconds: 0, late_cancel_disposition: "hold_current",
    });
    const generation = "operation" in root ? {
      operation_id: root.operation, commercial_generation_id: root.operation, cycle_key: cycleKey,
      agreement: root.snapshot, agreement_fingerprint: root.fingerprint, claim_token: root.token, lease_expires_at: later(1), lease_generation: 1,
    } : await insertV3Root(db, root, cycleKey, randomUUID());
    await insert(db, "subscription_cycle_generations", generation);
    await db.query(`UPDATE public.${occurrence} SET operation_id=$2,commercial_generation_id=$2 WHERE cycle_key=$1`,
      [cycleKey, generation.operation_id]);
  });
  return [root.client, root.subscription, cycleKey];
}

function applyArrival(db: Pool | PoolClient, cycleKey: string, at: string) {
  return db.query(`UPDATE public.${occurrence}
    SET effective_due_at=greatest(effective_due_at,$2::timestamptz+interval '168 hours') WHERE cycle_key=$1
    RETURNING to_char(effective_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due`, [cycleKey, at]);
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
      const renewal = await seedV3Subscription(owner);
      const legacy = await sandboxRenewal(owner);
      const cycleKey = randomUUID(), operation = randomUUID();
      if (store.installation.generation === "legacy") {
        const role = (await store.runtime.query(`SELECT session_user AS login,current_user AS effective,
          coalesce((SELECT pg_has_role(session_user,oid,'MEMBER') FROM pg_roles WHERE rolname='service_role'),false) AS service`)).rows[0];
        expect(role).toEqual({ login: "occurrence_runtime", effective: profile === "legacy-with-service" ? "service_role" : "occurrence_runtime",
          service: profile === "legacy-with-service" });
      }
      await insert(owner, occurrence, {
        cycle_key: cycleKey, subscription_id: renewal.subscription, client_id: renewal.client,
        original_anchor_at: original, effective_due_at: original, cadence_seconds: cadenceSeconds,
        rail: "v3", lifecycle: "active", is_current: true,
      });
      const scope = [renewal.client, renewal.subscription, cycleKey];
      for (const entry of [read, lock]) await expect(call(store.runtime, entry, scope)).rejects.toMatchObject({
        code: "42501", message: `permission denied for function ${entry}`,
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
            deadlineRuleRef: "accepted", deadlineRuleRevision: 1, cadenceSeconds, rail: "v3",
            lifecycle: "active", cancellationEffectiveAt: null, operationId: null, commercialGenerationId: null,
          });
        }
      }, "ROLLBACK");
      expect(await call(owner, read, [renewal.client, renewal.subscription, randomUUID()])).toEqual({
        kind: "unavailable", code: "renewal_cycle_unavailable", field: "/cycleKey",
      });
      await expect(call(owner, lock, [legacy.client, renewal.subscription, cycleKey])).rejects
        .toMatchObject({ code: "22023", detail: "/subscriptionId" });
      await transaction(owner, async db => {
        await insertV3Root(db, renewal, cycleKey, operation);
        await db.query(`UPDATE public.${occurrence} SET operation_id=$2,commercial_generation_id=$2 WHERE cycle_key=$1`, [cycleKey, operation]);
        expect(await call(db, read, scope)).toEqual({ kind: "unavailable", code: "renewal_cycle_unavailable", field: "/cycleKey" });
        await expect(call(db, lock, scope)).rejects.toMatchObject({ code: "22023", message: "renewal_cycle_unavailable", detail: "/cycleKey" });
      }, "ROLLBACK");
      await transaction(owner, async db => {
        await call(db, lock, scope);
        await insert(db, "subscription_cycle_generations", await insertV3Root(db, renewal, cycleKey, operation));
        await db.query(`UPDATE public.${occurrence} SET operation_id=$2,commercial_generation_id=$2 WHERE cycle_key=$1`, [cycleKey, operation]);
        for (const hours of [72, 24, 72]) {
          await applyArrival(db, cycleKey, later(hours).replace(".000Z", ".123456Z"));
          expect(await call(db, lock, scope)).toMatchObject({ cycleKey, originalAnchorAt: original,
            effectiveDueAt: later(240).replace(".000Z", ".123456Z"), operationId: operation, commercialGenerationId: operation });
        }
        await db.query("UPDATE public.subscription_cycle_generations SET claim_token=$2,lease_generation=2 WHERE cycle_key=$1", [cycleKey, randomUUID()]);
        await db.query(`UPDATE public.${occurrence} SET effective_due_at='2040-03-11T12:00:00.123456Z',
          lead_seconds=86401 WHERE cycle_key=$1`, [cycleKey]);
        await applyArrival(db, cycleKey, later(72));
        for (const zone of ["America/New_York", "Etc/UTC"]) {
          await db.query("SELECT set_config('TimeZone',$1,true)", [zone]);
          expect(await call(db, lock, scope)).toMatchObject({ cycleKey, originalAnchorAt: original,
            effectiveDueAt: "2040-03-11T12:00:00.123456Z", cancellationDeadlineAt: "2040-03-10T11:59:59.123456Z",
            operationId: operation, commercialGenerationId: operation });
        }
      });
      await transaction(owner, async db => {
        await call(db, lock, scope);
        await expect(owner.query("SELECT 1 FROM public.subscriptions WHERE id=$1 FOR UPDATE NOWAIT", [renewal.subscription]))
          .rejects.toMatchObject({ code: "55P03" });
        await expect(owner.query(`SELECT 1 FROM public.${occurrence} WHERE cycle_key=$1 FOR UPDATE NOWAIT`, [cycleKey]))
          .rejects.toMatchObject({ code: "55P03" });
      }, "ROLLBACK");
      const earlier = later(-24);
      const ambiguous = await retainSelection(owner, await seedV3Subscription(owner), earlier, original);
      const shortened = await retainSelection(owner, await seedV3Subscription(owner), original, earlier);
      await expectUnavailable(owner, ambiguous, "/cycleKey");
      await expectUnavailable(owner, shortened, "/effectiveDueAt");

      const historicalRoot = await sandboxRenewal(owner);
      const legacyHistory = await retainSelection(owner, historicalRoot, original, original, "legacy", true);
      const historyView = await call(owner, read, legacyHistory);
      expect(historyView).toMatchObject({ cycleKey: legacyHistory[2], rail: "legacy", lifecycle: "retired",
        originalAnchorAt: original, operationId: historicalRoot.operation, commercialGenerationId: historicalRoot.operation });
      const mismatchedRails = [
        await retainSelection(owner, legacy, original, original),
        await retainSelection(owner, await seedV3Subscription(owner), original, original, "legacy"),
      ];
      for (const mismatch of mismatchedRails) {
        await expectUnavailable(owner, mismatch, "/cycleKey");
        for (const hours of [72, 24, 72]) {
          const { rows } = await applyArrival(owner, mismatch[2], later(hours).replace(".000Z", ".123456Z"));
          expect(rows).toEqual([{ due: later(240).replace(".000Z", ".123456Z") }]);
          await expectUnavailable(owner, mismatch, "/cycleKey");
        }
      }

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
            expect(restoredView).toMatchObject({ cycleKey, rail: "v3", lifecycle: "stopped", cancellationEffectiveAt,
              operationId: operation, commercialGenerationId: operation });
            expect((await target.migrator.query(`SELECT r.id,r.result FROM public.${occurrence} c
              JOIN public.subscription_command_receipts r ON r.id=c.cancellation_receipt_id WHERE c.cycle_key=$1`, [cycleKey])).rows)
              .toEqual([{ id: receipt, result }]);
            await expectUnavailable(target.migrator, ambiguous, "/cycleKey");
            await expectUnavailable(target.migrator, shortened, "/effectiveDueAt");
            expect(await call(target.migrator, read, legacyHistory)).toEqual(historyView);
            for (const mismatch of mismatchedRails) await expectUnavailable(target.migrator, mismatch, "/cycleKey");
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
