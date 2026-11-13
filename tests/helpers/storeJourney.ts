import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { expect } from "vitest";
import { createPostgresNativeCheckoutPersistence, type NativeCheckoutDraftRequest } from "@openlup/platform/commerce/server/native-checkout";
import { createPostgresAccountLinkStore } from "@openlup/platform/identity";
import { createPostgresSandboxPaymentSimulator } from "@openlup/platform/payments";
import { createNativeRenewalCodec, createPostgresRenewalStore, createPostgresRenewalSettlementPort, createPostgresRetryLifecycleBinding,
  createPostgresSandboxRenewalRail, createSandboxRenewalPolicy, createPostgresPurchaseRenewalWriter,
  type AutomaticRenewalRunDeps, type SandboxRenewalScenario, type SubscriptionQueryExecutor, type NativeRenewalPurchaseFacts } from "@openlup/platform/subscriptions";
import { createPostgresDestinationPort } from "@openlup/platform/commerce/server/destinations";
import { createPostgresFulfillmentStockSyncPort } from "@openlup/platform/fulfillment";
import { createPostgresRenewalReservationPort } from "@openlup/platform/inventory";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { captureSandboxPurchase } from "./captureSandboxPurchase.js";
import { closePostgres, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "./postgresContainer.js";

export const journeyPaidAt = "2026-09-01T12:00:00.123456Z";
export const journeyScheduledAt = "2026-09-29T12:00:00.123456Z";
export const journeySelection: QualifiedPostgresInstallation = {
  generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres",
  migrationLogin: "transfer_owner", runtimeLogin: "transfer_runtime", restoreLogin: "transfer_restore",
};
const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")),
  "qualified-v2", { migrationIsBootstrap: false, hasRestore: true });
const paymentOptions = { dunningTemplateSlug: "sandbox_failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "sandbox_recovered" };
export const journeyFacts: NativeRenewalPurchaseFacts = {
  settlementChannelKey: "sandbox", authorizationRef: "sandbox:authorization:001", unattendedChargeAuthorizedAt: journeyPaidAt,
  payerAccountRef: "sandbox:payer:001", methodRef: "sandbox:method:001", methodEvidenceRef: "sandbox:evidence:001",
  stockSourceKey: "journey-stock", templateId: "journey-refill", cadenceDays: 28, currency: "XXX",
  lines: [{ lineOrdinal: 1, sku: "JOURNEY-A", quantity: 2, unitAmountMinor: 137 },
    { lineOrdinal: 2, sku: "JOURNEY-B", quantity: 3, unitAmountMinor: 251 }], shippingAmountMinor: 0,
  acquisitionRef: "acquisition:001",
};
export type JourneyInstallation = { owner: Pool; runtime: Pool; runtimeUrl: string };

/** Own resources per suite; no ambient database, owner fallback or extra runtime grants. */
export function storeJourneyResources() {
  const containers: PostgresContainer[] = [], pools: Pool[] = [];
  // The standard runner TZ selects only the two explicit fixture zones.
  // Every other runner zone preserves PostgreSQL's permanent default.
  const runnerZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = ["Etc/GMT-9", "Etc/GMT+5"].includes(runnerZone) ? runnerZone : undefined;
  const pool = (connectionString: string) => { const value = new Pool({ connectionString }); pools.push(value); return value; };
  return {
    async installation(label: string): Promise<JourneyInstallation> {
      if (!await dockerAvailable()) throw new Error("Store journey requires disposable PostgreSQL; Docker absence is missing proof");
      const container = await runPostgresContainer({ name: `store-journey-${label}-${process.pid}`, password: "synthetic-journey",
        ...(zone ? { command: ["postgres", "-c", `timezone=${zone}`] } : {}) });
      containers.push(container);
      if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Store journey PostgreSQL TCP unavailable");
      const bootstrap = pool(container.connectionString);
      await bootstrap.query(`CREATE ROLE transfer_owner LOGIN INHERIT SUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-journey';
        ALTER DATABASE postgres OWNER TO transfer_owner;
        CREATE ROLE transfer_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-journey';
        CREATE ROLE transfer_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-journey'`);
      const url = (login: string, migration = false) => {
        const value = new URL(container.connectionString); value.username = login;
        if (migration) value.searchParams.set("options", qualifiedPostgresStartupOptions(journeySelection));
        return value.toString();
      };
      const owner = pool(url(journeySelection.migrationLogin, true));
      const runner = createPostgresMigrationRunner({ connectionString: url(journeySelection.migrationLogin) },
        { installation: journeySelection, poolFactory: () => owner });
      expect(await runner.apply()).toEqual({ applied: [manifest.baseline, ...manifest.forward].map(unit => unit.file) });
      expect((await runner.status()).pending).toEqual([]);
      expect((await owner.query("SELECT catalog_path,sha256,position FROM public.platform_schema_migrations ORDER BY position")).rows)
        .toEqual([manifest.baseline, ...manifest.forward].map((unit, position) => ({ catalog_path: unit.file, sha256: unit.sha256, position })));
      await bootstrap.end();
      const runtimeUrl = url(journeySelection.runtimeLogin), runtime = pool(runtimeUrl);
      await assertJourneyRuntime(runtime);
      if (zone) for (const db of [owner, runtime]) expect((await db.query("SHOW TimeZone")).rows).toEqual([{ TimeZone: zone }]);
      return { owner, runtime, runtimeUrl };
    },
    close: () => closePostgres(containers, pools),
  };
}

export async function assertJourneyRuntime(runtime: Pool) {
  expect((await runtime.query("SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
    .toEqual([{ current_user: journeySelection.runtimeLogin, session_user: journeySelection.runtimeLogin, rolsuper: false, rolbypassrls: false }]);
}
export async function journeyRpc<T = Record<string, unknown>>(runtime: Pool, name: string, values: unknown[]): Promise<T> {
  if (!/^[a-z_]+$/.test(name)) throw new Error("Invalid fixture routine");
  return (await runtime.query(`SELECT public.${name}(${values.map((_, index) => `$${index + 1}`).join(",")}) AS value`, values)).rows[0].value as T;
}

export async function draftStoreJourney(store: JourneyInstallation) {
  const accounts = createPostgresAccountLinkStore({ connectionString: store.runtimeUrl });
  let clientId: string;
  try { clientId = (await accounts.createAccount({ email: "journey-001@example.invalid", principalId: randomUUID(),
    acquisitionSource: "synthetic", lifecycleStage: "customer" })).id; }
  finally { await accounts.close(); }
  const listId = randomUUID();
  await store.owner.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Synthetic list','ZZ','XXX','2026-01-01T00:00:00Z')", [listId]);
  for (const line of journeyFacts.lines) {
    const id = randomUUID();
    await store.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Synthetic product')", [id, line.sku.toLowerCase()]);
    await store.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$1,$2,'Synthetic item',true)", [id, line.sku]);
    await store.owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'any',$3,'2026-01-01T00:00:00Z')", [listId, id, line.unitAmountMinor]);
  }
  const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
  const lines = journeyFacts.lines.map(line => {
    const gross = line.quantity * line.unitAmountMinor, net = Math.round(gross / 1.2);
    return { sku: line.sku, productSlug: line.sku.toLowerCase(), quantity: line.quantity,
      unitPriceGross: money(line.unitAmountMinor), lineSubtotalGross: money(gross), tax: { included: true as const,
        country: "ZZ", category: "standard", vatRateBps: 2000, legalBasis: "Synthetic tax fixture",
        netAmount: money(net), vatAmount: money(gross - net), grossAmount: money(gross) } };
  });
  const request: NativeCheckoutDraftRequest = { idempotencyKey: `journey-draft:${randomUUID()}`, quoteSnapshot: {
    contractVersion: "commerce.v0", quote: { currency: "XXX", taxIncluded: true, lines, discounts: [],
      context: { mode: "subscription", cadenceDays: 28, promoCodes: [] }, subtotalGross: money(1027), discountTotalGross: money(0),
      shippingGross: money(0), shippingDiscountGross: money(0), totalGross: money(1027), netTotal: money(856), taxTotal: money(171) } } };
  const created = await createPostgresNativeCheckoutPersistence(store.runtime).createOrderDraft(request, { clientId });
  const orderId = created.orderDraft.orderId.replace(/^order_/, ""), key = `journey:${orderId}`;
  const intent = await journeyRpc<{ settlement: { id: string } }>(store.runtime, "commerce_open_settlement_intent",
    [`open:${key}`, orderId, "sandbox", 1027, "XXX", "{}", journeyPaidAt]);
  await journeyRpc(store.runtime, "subscription_declare_provisional_activation", [`declare:${key}`, orderId, 28, journeyPaidAt]);
  return { clientId, orderId, key, request, created, settlementIntentId: intent.settlement.id };
}
export type JourneyDraft = Awaited<ReturnType<typeof draftStoreJourney>>;

/** Activation deliberately leaves its real durable attachment duty for the next worker. */
export async function captureAndActivateJourney(store: JourneyInstallation, draft: JourneyDraft) {
  const simulator = createPostgresSandboxPaymentSimulator(store.runtime, paymentOptions);
  expect(await captureSandboxPurchase(simulator, { settlementIntentId: draft.settlementIntentId, key: draft.key, at: journeyPaidAt }))
    .toMatchObject({ status: 200 });
  const attempt = await simulator.readAttempt({ settlementIntentId: draft.settlementIntentId });
  expect(attempt).toMatchObject({ settlementIntentId: draft.settlementIntentId, state: "captured", latestObservation: { outcome: "captured" } });
  const settlement = (await store.runtime.query("SELECT coalesce(external_ref,id::text) AS captured_reference FROM public.commerce_settlement_intents WHERE id=$1", [draft.settlementIntentId])).rows[0];
  const fingerprint = createHash("sha256").update(settlement.captured_reference).digest("hex");
  await createPostgresPurchaseRenewalWriter(store.runtime).register(draft.orderId, journeyFacts);
  const activation = await journeyRpc<{ subscriptionId: string; replayed: boolean }>(store.runtime, "subscription_activate_from_captured_payment",
    [`activate:${draft.key}`, draft.orderId, fingerprint]);
  expect(activation.replayed).toBe(false);
  return { ...draft, activation, subscriptionId: activation.subscriptionId, fingerprint, attempt };
}
export type StoreJourney = Awaited<ReturnType<typeof captureAndActivateJourney>>;

export async function captureStoreJourney(owner: Pool, sourceId: string) {
  return captureConnectedNativeStore({ sourceId, catalogueId: manifest.objectInventorySha256, maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
    source: { async withSnapshot(work) {
      const client = await owner.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const value = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
        await client.query("COMMIT"); return value;
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    } } });
}

/** Independent whole-public-row readback, including tables outside the capture list. */
export async function journeyCensus(owner: Pool) {
  const client = await owner.connect(), rows: Record<string, string[]> = {};
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL TimeZone='UTC'");
    const tables = (await client.query<{ name: string }>(`SELECT c.relname AS name FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND c.relname<>'platform_schema_migrations' ORDER BY c.relname`)).rows;
    const statements = tables.map(({ name }, ordinal) => {
      if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("Unexpected fixture relation");
      return `SELECT ${ordinal} AS table_ordinal, 0::bigint AS row_ordinal, NULL::text AS value
        UNION ALL
        (SELECT ${ordinal} AS table_ordinal, row_number() OVER (ORDER BY to_jsonb(t)::text) AS row_ordinal,
          to_jsonb(t)::text AS value FROM public."${name}" t ORDER BY to_jsonb(t)::text)`;
    });
    // One round trip, one text datum per original row: no per-table value-size cap.
    // Ordinals retain discovery/row order; NULL sentinels retain empty tables.
    // PostgreSQL still encodes each whole row in the same UTC/read-only snapshot.
    if (statements.length) {
      const result = await client.query<{ table_ordinal: number; value: string | null }>(
        `${statements.join(" UNION ALL ")} ORDER BY table_ordinal, row_ordinal`);
      for (const { table_ordinal, value } of result.rows) {
        const name = tables[table_ordinal]!.name;
        if (value === null) rows[name] = [];
        else rows[name]!.push(value);
      }
    }
    await client.query("COMMIT"); return rows;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}


/** New joined cases start without acquisition intake, never by pruning it. */
export async function assertJourneyWithoutIntake(store: JourneyInstallation) {
  expect((await store.owner.query("SELECT count(*)::int AS count FROM acquisition_private.address_references")).rows)
    .toEqual([{ count: 0 }]);
}

/** Native purchase prerequisites: bind its immutable destination before activation. */
export async function prepareJourneyRenewal(store: JourneyInstallation) {
  await assertJourneyWithoutIntake(store);
  const draft = await draftStoreJourney(store);
  const destination = await createPostgresDestinationPort(store.runtime).registerOrder({
    idempotencyKey: "journey-renewal-destination", orderId: draft.orderId, now: journeyPaidAt,
    address: { recipientName: "Synthetic Buyer", line1: "1 Synthetic Lane", city: "Synthetic", postalCode: "00000", country: "ZZ" },
  });
  const purchase = await captureAndActivateJourney(store, draft);
  expect(await createPostgresPurchaseRenewalWriter(store.runtime).complete(purchase.orderId))
    .toEqual({ subscriptionId: purchase.subscriptionId, replayed: false });
  const stock = createPostgresFulfillmentStockSyncPort(store.runtime, {
    sourceKey: journeyFacts.stockSourceKey, readLocalInventoryStock: async () => [],
  });
  for (const line of journeyFacts.lines) await stock.recordProviderStockCurrent({ requestKey: `renewal-stock:${line.sku}`, snapshot: {
    providerRef: "synthetic-stock", collectedAt: journeyPaidAt, sourceRevision: null, revisionSource: "collection", quantityKind: "snapshot",
    skuRef: line.sku, totalQuantity: 100, forSaleQuantity: 100, reservedOrUnavailableQuantity: 0, syncRunId: "renewal-stock" },
    inventoryClass: "sellable", lastSyncedAt: journeyPaidAt, staleAfter: "2027-01-01T00:00:00.000000Z" });
  await store.owner.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('journey-parcel','3pl',true)");
  return { ...purchase, destination };
}

/** Compose the shipped renewal, reservation, settlement and sandbox observation ports. */
export async function composeJourneyRenewal(store: JourneyInstallation, subscriptionId: string,
  scenario: SandboxRenewalScenario, at: string) {
  const withTransaction = async <T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) => {
    const db = await store.runtime.connect();
    try { await db.query("BEGIN"); const value = await work(db); await db.query("COMMIT"); return value; }
    catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  };
  const codec = createNativeRenewalCodec(), renewal = createPostgresRenewalStore(store.runtime, codec, withTransaction);
  const rail = createPostgresSandboxRenewalRail(store.runtime, { scenario, now: () => at });
  let executions = 0;
  const lifecycle = createPostgresRetryLifecycleBinding({ executor: store.runtime, withTransaction,
    settlement: db => createPostgresRenewalSettlementPort(db, codec, withTransaction),
    correlate: wire => codec.decode(wire).cycle, failureTemplate: "subscription-payment-failed-1", recoveryPath: "/recover" });
  const method = await createPostgresPurchaseRenewalWriter(store.runtime).readMethod(subscriptionId);
  expect(method).toMatchObject({ healthState: "healthy", methodRef: journeyFacts.methodRef });
  if (typeof method?.methodRef !== "string") throw new Error("Fixture renewal method reference missing");
  const input: AutomaticRenewalRunDeps = { store: renewal, settlement: lifecycle.settlement, failureHandoff: lifecycle.failureHandoff,
    inventory: createPostgresRenewalReservationPort(store.runtime), workerId: "journey-renewal", policy: createSandboxRenewalPolicy(method.methodRef),
    paymentRails: { resolve: key => key === "sandbox" ? { ...rail, async execute(request) { executions++; return rail.execute(request); } } : null } };
  const due = (await renewal.listDue(100, at)).find(row => row.subscriptionId === subscriptionId);
  expect(due).toBeDefined();
  return { input, due: due!, codec, executions: () => executions };
}
