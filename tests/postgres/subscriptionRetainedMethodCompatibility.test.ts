import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import * as renewal from "@openlup/platform/subscriptions";
import type { CompatiblePostgresSnapshot } from "@openlup/platform/portability";
import { createPostgresFulfillmentStockSyncPort } from "@openlup/platform/fulfillment";
import type { RenewalFrozenSnapshot, RenewalReadback, RenewalPaymentEvidence, RenewalPreparedSettlement, RenewalReservationResult } from "@openlup/platform/subscriptions/contracts";
import { captureManagedSourceGraph, mapManagedRetainedBusiness } from "../../server/adapters/postgres/connectedManagedRetained.js";
import { captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

const scheduledAt = "2026-09-29T12:00:00.000Z", now = "2026-09-29T12:01:00.000Z";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// The incumbent host's legacy dialect is a labelled fixture. Imported counters
// and saved term lines supply its cycle facts; it does not claim new-purchase
// activation lineage or migrate historical snapshots to a different dialect.
function legacyCodec(): renewal.NativeRenewalCodec {
  const native = renewal.createNativeRenewalCodec();
  const codec: renewal.NativeRenewalCodec = {
    due(row) {
      const due = native.due(row), counter = Number(row.next_cycle_number ?? row.cycle_number);
      return { ...due, cycle: { status: "correlated", nativeRenewalCounter: counter,
        logicalCycleNumber: counter, activationCycleId: null, evidenceRef: "retained-host-cycle-fixture" } };
    },
    freeze(row, schedule) {
      const due = codec.due({ ...row, scheduled_at: schedule.scheduledAt });
      const lines = row.lines as RenewalFrozenSnapshot["orderSnapshot"]["lines"];
      const snapshot: RenewalFrozenSnapshot = { ...schedule, clientId: due.clientId,
        contractVersion: "platform.subscription.renewal.v1", frozenRevision: "retained-host-fixture.v1", frozenFingerprint: "",
        cycle: due.cycle, retryAttempt: 0, externalAttemptSequence: 0,
        templateSnapshot: { templateId: "retained-host-template", version: Number(row.template_version), cadenceDays: due.cadenceDays, lines },
        pricingSnapshot: { currency: due.currency, totalAmountMinor: lines.reduce((sum, line) => sum + line.quantity * line.unitAmountMinor, 0),
          shippingAmountMinor: 0, agreementPolicy: "lock_until_edit", proration: "none" },
        orderSnapshot: { shippingAddressRef: null, shippingQuoteRef: null, acquisitionRef: null, lines },
        stockSourceKey: due.stockSourceKey, settlementChannelKey: due.settlementChannelKey,
        authorizationRef: due.authorizationRef, payerAccountRef: due.payerAccountRef,
        unattendedChargeAuthorizedAt: due.unattendedChargeAuthorizedAt };
      snapshot.frozenFingerprint = hash(snapshot);
      return snapshot;
    },
    encode: snapshot => ({ ...snapshot, cycleNumber: snapshot.cycle.nativeRenewalCounter,
      currency: snapshot.pricingSnapshot.currency, totalAmountMinor: snapshot.pricingSnapshot.totalAmountMinor,
      lines: snapshot.orderSnapshot.lines }),
    decode: wire => wire as unknown as RenewalFrozenSnapshot,
    identity: snapshot => `subscription:${snapshot.subscriptionId}:cycle:${snapshot.scheduledAt}`,
    fingerprint: snapshot => snapshot.frozenFingerprint,
    readback(row) {
      const snapshot = codec.decode(row.cycleSnapshot as Record<string, unknown>);
      return { ...row, scheduledInstant: Date.parse(String(row.scheduledAt)), cycle: snapshot.cycle,
        cycleSnapshot: snapshot } as unknown as RenewalReadback;
    },
  };
  return codec;
}

it("renews projected managed terms without a method row after connected restore through the restricted runtime", async () => {
  let sourceContainer: PostgresContainer | undefined, targetContainer: PostgresContainer | undefined;
  const pools: Pool[] = [];
  const pool = (connectionString: string) => { const db = new Pool({ connectionString }); pools.push(db); return db; };
  try {
    sourceContainer = await runManagedCompatPostgres({ name: `retained-health-source-${process.pid}`, password: "synthetic-transfer" });
    expect(await waitForPostgresTcpReady(sourceContainer.connectionString)).toBe(true);
    const source = pool(sourceContainer.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"));
    await source.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
    for (const role of ["postgres", "supabase_admin"]) for (const scope of ["", " IN SCHEMA public"])
      for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"])
        await source.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC,anon,authenticated,service_role`);
    await source.query("SET ROLE postgres; SET search_path=public,extensions");
    await source.query(readFileSync("supabase/migrations/00000000000000_platform_schema_baseline.sql", "utf8").replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
    for (const file of ["20261030121000_channel_retained_basis.sql", "20261030122000_channel_purchased_source.sql"])
      await source.query(readFileSync(`supabase/migrations/${file}`, "utf8"));
    await source.query("RESET ROLE");
    const client = randomUUID(), user = randomUUID(), subscription = randomUUID(), product = randomUUID(), sku = randomUUID(), price = randomUUID(), line = randomUUID();
    // Synthetic source-rail history, not target renewal terms or method state.
    await source.query("INSERT INTO auth.users(id,email) VALUES($1,'retained-health@example.invalid')", [user]);
    await source.query("INSERT INTO public.clients(id,email,auth_user_id,lifecycle_stage) VALUES($1,'retained-health@example.invalid',$2,'customer')", [client, user]);
    await source.query("INSERT INTO public.catalog_products(id,slug,status,name) VALUES($1,'retained-health','active','Retained fixture')", [product]);
    await source.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,pet_type,status,net_weight_g,kcal_per_unit,sellable_in_subscription) VALUES($1,$2,'retained-health','Retained fixture','other','active',100,100,true)", [sku, product]);
    await source.query("UPDATE public.catalog_products SET primary_sku_id=$2 WHERE id=$1", [product, sku]);
    await source.query("INSERT INTO public.price_lists(id,name,region_code,currency,status,valid_from) VALUES($1,'Retained prices','ZZ','XXX','active','2026-01-01')", [price]);
    await source.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'subscription',100,'2026-01-01')", [price, sku]);
    await source.query(`INSERT INTO public.subscriptions(id,client_id,cadence_days,currency,region_code,status,next_cycle_at,payment_method_ref,payment_method_kind)
      VALUES($1,$2,28,'XXX','ZZ','active',$3,'retained-method','card')`, [subscription, client, scheduledAt]);
    await source.query(`INSERT INTO public.commerce_payment_method_refs(client_id,subscription_id,provider_kind,method_kind,provider_customer_ref,provider_method_ref,provider_mandate_ref,status,active,consent_snapshot)
      VALUES($1,$2,'retained-fixture','card','retained-payer','retained-method','retained-authorization','active',true,'{"recurringModel":"O","acceptedAt":"2026-09-01T12:00:00.000Z"}')`, [client, subscription]);
    await source.query("INSERT INTO public.subscription_lines(id,subscription_id,variant_id,qty,sort_order) VALUES($1,$2,$3,2,0)", [line, subscription, sku]);
    await source.query(`INSERT INTO public.subscription_price_agreements(subscription_id,subscription_line_id,variant_id,currency,unit_price_gross_minor,template_version,source_action,idempotency_key)
      VALUES($1,$2,$3,'XXX',100,1,'synthetic_setup','retained-health-price')`, [subscription, line, sku]);
    // Match the admitted retained cohort: this synthetic source has no
    // external email delivery work to transfer. Its unrelated welcome queue
    // is cleared just as in the existing retained-source qualification.
    await source.query("DELETE FROM public.communication_email_deliveries");
    targetContainer = await runPostgresContainer({ name: `retained-health-target-${process.pid}`, password: "synthetic-transfer" });
    expect(await waitForPostgresTcpReady(targetContainer.connectionString)).toBe(true);
    const bootstrap = pool(targetContainer.connectionString);
    await bootstrap.query(`CREATE ROLE retained_owner LOGIN INHERIT SUPERUSER PASSWORD 'synthetic-transfer'; ALTER DATABASE postgres OWNER TO retained_owner;
      CREATE ROLE retained_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-transfer';
      CREATE ROLE retained_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-transfer'`);
    const selection = { generation: "qualified-v2", roleMode: "installer-managed", migrationLogin: "retained_owner", bootstrapLogin: "postgres",
      runtimeLogin: "retained_runtime", restoreLogin: "retained_restore" } as const;
    const url = new URL(targetContainer.connectionString); url.username = selection.migrationLogin;
    const ownerUrl = url.toString(); url.searchParams.set("options", qualifiedPostgresStartupOptions(selection));
    const owner = pool(url.toString());
    const runner = createPostgresMigrationRunner({ connectionString: ownerUrl }, { installation: selection, poolFactory: () => owner });
    await runner.apply();
    const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "qualified-v2", { migrationIsBootstrap: false, hasRestore: true });
    const snapshot = (db: Pool, managed = false): CompatiblePostgresSnapshot => ({ async withSnapshot(work) {
      const connection = await db.connect();
      try {
        await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        if (managed) await connection.query("SET LOCAL ROLE postgres");
        const result = await work({ query: (sql, values) => connection.query(sql, values ? [...values] : undefined) });
        await connection.query("COMMIT"); return result;
      } catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
    } });
    const limits = { maximumRows: 10000, maximumBytes: 64 * 1024 * 1024 };
    const fresh = await captureConnectedNativeStore({ sourceId: "retained-health-target", catalogueId: manifest.objectInventorySha256, ...limits, source: snapshot(owner) });
    const captured = await captureManagedSourceGraph({ sourceId: "retained-health-source", ...limits, source: snapshot(source, true) });
    const mapped = await mapManagedRetainedBusiness({ capture: captured, issuer: "https://issuer.example.invalid/retained-health", freshTarget: fresh, targetOwner: owner });
    expect(mapped.packet.compatible.tables.find(table => table.table === "subscription_renewal_terms")?.rows).toHaveLength(1);
    expect(await restoreConnectedNativeStore({ owner, installation: selection, packet: mapped.packet, freshTarget: fresh })).toMatchObject({ replayed: false });
    url.username = selection.runtimeLogin; url.searchParams.set("options", "-c role=service_role");
    const runtime = pool(url.toString());
    expect((await runtime.query(`SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows)
      .toEqual([{ current_user: "service_role", session_user: "retained_runtime", rolsuper: false, rolbypassrls: false }]);
    expect((await runtime.query("SELECT * FROM public.subscription_method_states WHERE subscription_id=$1", [subscription])).rows).toEqual([]);
    const stock = createPostgresFulfillmentStockSyncPort(runtime, { sourceKey: "retained-health", readLocalInventoryStock: async () => [] });
    await stock.recordProviderStockCurrent({ requestKey: "retained-stock", snapshot: { providerRef: "retained-stock", collectedAt: now, sourceRevision: null,
      revisionSource: "collection", quantityKind: "snapshot", skuRef: "retained-health", totalQuantity: 100, forSaleQuantity: 100,
      reservedOrUnavailableQuantity: 0, syncRunId: "retained-health" }, inventoryClass: "sellable", lastSyncedAt: now, staleAfter: "2027-01-01T00:00:00.000Z" });
    const codec = legacyCodec(), store = renewal.createPostgresRenewalStore(runtime, codec);
    const due = (await store.listDue(10, now)).find(row => row.subscriptionId === subscription)!;
    expect(due).toBeDefined();
    expect(await store.readMandateEvidence(due)).toMatchObject({ authorized: true, authorizationRef: "retained-authorization" });
    expect(await store.admitDeliveryAlignment({ ...due, occurredAt: now })).toMatchObject({ allowed: false, reason: "managed-source-address-binding-required" });
    const rpc = async <T>(name: string, values: unknown[]): Promise<T> => (await runtime.query(`SELECT public.${name}(${values.map((_, i) => `$${i + 1}`).join(",")}) AS result`, values)).rows[0].result;
    let prepared: RenewalPreparedSettlement;
    const execute = vi.fn(async () => ({ status: "pending" as const, externalAttemptRef: "retained-host-attempt" }));
    const result = await renewal.runOneAutomaticSubscriptionRenewal({ store: { ...store,
      // Explicit host destination-admission fixture. The preserved mapper block
      // above is tested separately; this does not qualify destination wiring.
      admitDeliveryAlignment: async () => ({ allowed: true, state: "static", reason: "allowed" }) },
      inventory: { expireReservations: async () => 0, reserve: input => rpc<RenewalReservationResult>("fulfillment_reserve_subscription_renewal", [input.operationId, input.claimToken, 900, input.now]) },
      settlement: {
        prepareRenewal: async input => prepared = await rpc<RenewalPreparedSettlement>("commerce_prepare_subscription_renewal", [input.operationId, input.claimToken, input.now]),
        acknowledgeExternalAttempt: async input => codec.readback(await rpc("commerce_acknowledge_subscription_renewal_attempt", [input.operationId, input.operationFingerprint, input.externalAttemptRef, input.acknowledgedAt])),
        recordTerminalOutcome: async input => codec.readback(await rpc("commerce_record_subscription_renewal_outcome", [input.operationId, input.eventKey, input.operationFingerprint, input.outcome, input.externalRef ?? null, input.reason ?? null, input.occurredAt])) },
      paymentRails: { resolve: () => ({ execute, findExternalAttempt: async () => null,
        readOutcome: async (): Promise<RenewalPaymentEvidence> => ({ disposition: "observed", status: "succeeded", operationId: prepared.operationId,
          eventKey: "retained-host-outcome", requestFingerprint: prepared.operationFingerprint, verifiedEvidenceRef: "retained-host-evidence",
          externalAttemptRef: "retained-host-attempt", occurredAt: now, observedAt: now, firstRecordedAt: now, amountMinor: 200, currency: "XXX", reason: null }) }) },
      policy: renewal.createSandboxRenewalPolicy("retained-method"), failureHandoff: { handoffFailure: async () => { throw new Error("unexpected_failure"); } }, workerId: "retained-health" }, due, now);
    expect(result.status).toBe("succeeded"); expect(execute).toHaveBeenCalledTimes(1);
    expect((await runtime.query(`SELECT status,to_char(next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS next_cycle_at FROM public.subscriptions WHERE id=$1`, [subscription])).rows)
      .toEqual([{ status: "active", next_cycle_at: "2026-10-27T12:00:00.000000Z" }]);
    expect((await runtime.query("SELECT * FROM public.subscription_method_states WHERE subscription_id=$1", [subscription])).rows).toEqual([]);
  } finally {
    await Promise.all(pools.map(db => db.end()));
    await closePostgres(sourceContainer, []); await closePostgres(targetContainer, []);
  }
}, postgresSetupTimeoutMs);
