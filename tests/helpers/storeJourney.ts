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
import type { PgQueryExecutor } from "@openlup/platform/data";

/** Owner fixture setup follows the same single-use pointer fence as publication. */
export async function setFixtureCatalogDocument(db: PgQueryExecutor, productId: string, revisionId: string): Promise<void> {
  await db.query(`WITH capability AS (INSERT INTO public.catalog_publication_pointer_capabilities(transaction_id,product_id,revision_id,command_fingerprint)
    SELECT pg_current_xact_id(),id,$2::uuid,$3 FROM public.catalog_products WHERE id=$1::uuid AND current_document_revision_id IS DISTINCT FROM $2::uuid RETURNING product_id)
    UPDATE public.catalog_products SET current_document_revision_id=$2::uuid WHERE id IN (SELECT product_id FROM capability)`,
  [productId, revisionId, createHash("sha256").update(`fixture:${productId}:${revisionId}`).digest("hex")]);
}

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

/** Existing journey resources, with real publication, frozen wait and consent owners. */
export async function createSuccessorJourney(pool: Pool, options: { creator?: "admit" | "recover"; recoveryStock?: number } = {}) {
  const { input,registry,definition,rules } = await import("../../packages/platform/test/catalog/fixtures/publicationInput.js");
  const { createPostgresCatalogPublication } = await import("../../packages/platform/src/catalog/publicationStore.js");
  const { installCatalogDefinitions } = await import("../../packages/platform/src/catalog/installCatalogDefinitions.js");
  const { catalogDefinitionDigest } = await import("../../packages/platform/src/catalog/catalogDefinitionDigest.js");
  const { canonicalCatalogDraftJson } = await import("../../packages/platform/src/catalog/contracts/draft.js");
  const { catalogAcceptedReferenceV2Schema } = await import("../../packages/platform/src/catalog/lifecycleV2.js");
  const { createNativeCatalogRenewalCodecV2 } = await import("../../packages/platform/src/subscriptions/nativeRenewalCodec.js");
  const { readCompleteEditBaseline } = await import("../../packages/platform/src/subscriptions/editConsentBaseline.js");
  const { buildEditConsent,hashEditConsent } = await import("../../packages/platform/src/subscriptions/editConsent.js");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex"), admin = randomUUID();
  const rpc = async (db: PgQueryExecutor, name: string, args: unknown[]) =>
    (await db.query(`SELECT public.${name}(${args.map((_,index) => `$${index + 1}`).join(",")}) AS result`,args)).rows[0]!.result as Record<string, unknown>;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await installCatalogDefinitions(db,{ id: "example:successor",namespace: "example",version: 1,openlupRange: "0.44.x",capabilities: { publish: false },types: [definition],taxClasses: [] });
    await db.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)",[admin,`${admin}@example.invalid`]);
    await db.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())",[admin]);
    await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_minimum_base_units','1') ON CONFLICT(key) DO NOTHING");
    const authority = createPostgresCatalogPublication({ registry,rules,authorizeHuman: async () => ({ ok: true as const,userId: admin,role: "admin",isMachineActor: false }),
      readiness: async () => ({ ready: true,reasons: [] }),globalReadiness: async () => ({ ready: true,reasons: [] }),verifyMedia: async () => false,
      transactions: { async run(work) { await db.query("SAVEPOINT publisher"); try { const result = await work(db); await db.query("RELEASE SAVEPOINT publisher"); return result; } catch (error) { await db.query("ROLLBACK TO SAVEPOINT publisher"); throw error; } } } });
    const actor = (await authority.authorize(null))!;
    async function publish(payload: import("../../packages/platform/src/catalog/contracts/lifecycleV2.js").CatalogDraftPayloadV4 | import("../../packages/platform/src/catalog/contracts/successors.js").CatalogDraftPayloadV5,
      draftId: string,revision: number,head: import("../../packages/platform/src/catalog/contracts/lifecycle.js").CatalogHeadRef | null) {
      const command = { schemaVersion: payload.schemaVersion,action: revision ? "revise" : "create",draftId,commandKey: `draft:${revision}`,expectedRevision: revision,payload }, canonical = canonicalCatalogDraftJson(command);
      expect(await rpc(db,"catalog_draft_apply",[canonical,hash(canonical),"operator:synthetic"])).toMatchObject({ outcome: "committed" });
      const candidateRef = `v1:${draftId}@${revision + 1}/${head ? `${head.publicationId}@${head.revision}` : "unpublished"}`;
      const candidateDigest = hash('["catalog-candidate",1,'+canonicalCatalogDraftJson(payload)+','+canonicalCatalogDraftJson([{ ...payload.product.type,definitionDigest: catalogDefinitionDigest(definition) }])+','+canonicalCatalogDraftJson(head)+']');
      expect(await authority.decision({ schemaVersion: 2,action: "approve",productId: payload.product.id,commandKey: `approve:${revision}`,candidateRef,candidateDigest,reason: "Exact synthetic candidate" },actor)).toMatchObject({ outcome: "committed" });
      const result = await authority.publish({ productId: payload.product.id,commandKey: `publish:${revision}`,candidateRef,candidateDigest,expectedHead: head,changes: [] },actor);
      if (!("receipt" in result)) throw new Error(JSON.stringify(result));
      return result.receipt.head;
    }
    async function article(predecessor?: string) {
      const product = randomUUID(),sku = randomUUID(),draft = randomUUID(),document = randomUUID(),code = `ARTICLE-${sku}`,slug = `article-${product}`;
      const digits=(BigInt(`0x${sku.replaceAll("-","").slice(0,14)}`)%1_000_000_000_000n).toString().padStart(12,"0");
      const gtin=digits+String((10-[...digits].reduce((sum,digit,index)=>sum+Number(digit)*(index%2?3:1),0)%10)%10);
      const original = input().payload;
      const text = JSON.stringify(original).replaceAll(original.product.id,product).replaceAll(original.skus[0]!.id,sku).replaceAll(original.product.documentRevision!.id,document)
        .replaceAll('"ARTICLE"',JSON.stringify(code)).replaceAll('"article"',JSON.stringify(slug)).replaceAll("5901234123457",gtin);
      const value = JSON.parse(text) as import("../../packages/platform/src/catalog/contracts/lifecycleV2.js").CatalogDraftPayloadV4;
      value.schemaVersion=4;
      let authored: typeof value | import("../../packages/platform/src/catalog/contracts/successors.js").CatalogDraftPayloadV5 = value;
      if (predecessor) authored={ ...value,schemaVersion: 5,publication: { ...value.publication,operations: value.publication.operations.map(operation => operation.op === "create_sku" ? { ...operation,successorOf: predecessor } : operation) } };
      const declared = await publish(authored,draft,0,null);
      // Standing facts are installed owner fixture data, as in the existing admission journey.
      const old = (await db.query("SELECT * FROM public.catalog_publications WHERE id=$1",[declared.publicationId])).rows[0];
      const manifest = JSON.parse(old.canonical_state), previous = manifest.skus[0];
      const row = (await db.query("SELECT full_facts FROM public.catalog_sku_revisions WHERE id=$1",[previous.revisionId])).rows[0];
      const facts = { ...JSON.parse(row.full_facts),lifecycleState: "active",status: "active",sellableStandalone: true,sellableInSubscription: true,memberships: [{ offerVersion: "classic",admitted: true }] };
      manifest.schemaVersion=3; delete manifest.successors;
      manifest.product={ ...manifest.product,lifecycleState: "active",status: "active" };
      const publication = randomUUID(),revisionId = randomUUID(),fullFacts = canonicalCatalogDraftJson(facts),factDigest = hash(fullFacts);
      manifest.skus=[{ ...previous,revisionId,revision: 2,digest: factDigest }];
      const canonical=canonicalCatalogDraftJson(manifest),digest=hash(canonical);
      await db.query("INSERT INTO public.catalog_lifecycle_write_capabilities VALUES(pg_current_xact_id(),$1,$2)",[product,digest]);
      await db.query("UPDATE public.catalog_products SET status='active',publication_facts=$2::jsonb WHERE id=$1",[product,manifest.product]);
      await db.query("UPDATE public.catalog_skus SET status='active',sellable_standalone=true,sellable_in_subscription=true,publication_facts=$2::jsonb WHERE id=$1",[sku,facts]);
      await db.query("INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id) VALUES($1,$2,2,$3,$4,1,$5,$6,$7,$8,$6,$9)",[publication,product,old.id,draft,`standing:${publication}`,digest,old.document_revision_id,canonical,admin]);
      await db.query("INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest) VALUES($1,$2,$3,2,$4,$5,$6)",[revisionId,sku,product,publication,fullFacts,factDigest]);
      await db.query("UPDATE public.catalog_publication_heads SET publication_id=$2,revision=2 WHERE product_id=$1",[product,publication]);
      await db.query("DELETE FROM public.catalog_lifecycle_write_capabilities WHERE product_id=$1",[product]);
      const head={ ...declared,publicationId: publication,revision: 2 };
      const reference=catalogAcceptedReferenceV2Schema.parse({ schemaVersion: 2,skuId: sku,skuCode: code,skuRevisionId: revisionId,publicationHead: head,typeRef: manifest.product.type,
        definitionDigest: manifest.product.definitionDigest,optionDigest: facts.optionDigest,netContent: facts.netContent });
      return { product,sku,draft,code,value,head,reference,declared };
    }
    const predecessor=await article(),successor=await article(predecessor.sku);
    const client=randomUUID(),principal=randomUUID(),subscription=randomUUID(),activationCycle=randomUUID(),list=randomUUID(),entry=randomUUID(),destination=randomUUID();
    const clock=(await db.query(`SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
      to_char((now()-interval '1 day') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS anchor,
      to_char((now()-interval '56 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS authorized,
      to_char((now()-interval '10 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS claimed`)).rows[0];
    const at=String(clock.at),anchor=String(clock.anchor),authorized=String(clock.authorized),claimed=String(clock.claimed),source=`successor:${subscription}`;
    await db.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)",[client,`${client}@example.invalid`,principal]);
    await db.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Synthetic list','ZZ','XXX',now()-interval '2 days')",[list]);
    await db.query("INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,$3,'any',777,now()-interval '2 days')",[entry,list,successor.sku]);
    await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,started_at,currency_code,price_list_id) VALUES($1,$2,28,$3,$4,'XXX',$5)",[subscription,client,anchor,authorized,list]);
    await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code,catalog_sku_revision_id) VALUES($1,$2,1,0,617,'XXX',$3)",[subscription,predecessor.sku,predecessor.reference.skuRevisionId]);
    await db.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,$3::timestamptz-interval '28 days','paid')",[activationCycle,subscription,anchor]);
    await db.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref,next_cycle_number,catalog_acceptance) VALUES($1,'XXX',$2,'sandbox',$3,'synthetic',1,$4::jsonb)",[subscription,source,authorized,{ schemaVersion: 2,lines: [predecessor.reference] }]);
    await db.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,$2,1,617)",[subscription,predecessor.code]);
    await db.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')",[subscription]);
    await db.query("INSERT INTO public.commerce_destinations(id,client_id,address) VALUES($1,$2,$3)",[destination,client,{ recipientName: "Synthetic recipient",line1: "1 Synthetic Lane",city: "Synthetic",postalCode: "00000",country: "ZZ" }]);
    const money=(amountMinor:number)=>({ amountMinor,currency: "XXX" }),oldLine={ lineOrdinal: 1,sku: predecessor.code,quantity: 1,unitAmountMinor: 617 };
    const codec=createNativeCatalogRenewalCodecV2(value=>catalogAcceptedReferenceV2Schema.parse(value));
    const header={ subscription_id: subscription,client_id: client,scheduled_at: anchor,cadence_days: 28,currency_code: "XXX",stock_source_key: source,settlement_channel_key: "sandbox",authorization_ref: "synthetic",payer_account_ref: null,
      unattended_charge_authorized_at: authorized,activation_cycle_id: activationCycle,activation_cycle_paid: true,paid_cycle_count: 1,next_cycle_number: 1,template_version: 1,
      purchase_facts: { templateId: "synthetic",renewalTerms: { version: "native.renewal-terms.v1",shippingTerms: { version: "shipping-threshold.v1",currency: "XXX",flatMinor: 0,freeThresholdMinor: 0 },normalCadenceDays: [28] } },
      catalog_acceptance: { schemaVersion: 2,lines: [predecessor.reference] },lines: [oldLine] };
    const schedule={ subscriptionId: subscription,scheduledAt: anchor,scheduledInstant: Date.parse(anchor) };
    const frozen=codec.withDestination!(codec.freeze(header,schedule),destination),wire=codec.encode(frozen);
    const withdraw=structuredClone(predecessor.value); withdraw.product.sharedContent.catalogAction="revise";
    withdraw.publication.operations=[{ op: "set_product_lifecycle",productSlug: withdraw.product.slug!,expectedState: "active",state: "withdrawn",children: [{ skuCode: predecessor.code,expectedState: "active" }] }];
    const withdrawalHead=await publish(withdraw,predecessor.draft,1,predecessor.head);
    const stock=createPostgresFulfillmentStockSyncPort(db,{ sourceKey: source,readLocalInventoryStock: async()=>[] });
    for (const [sku,quantity] of [[predecessor.code,0],[successor.code,100]] as const) await stock.recordProviderStockCurrent({ requestKey: `stock:${sku}`,snapshot: { providerRef: "synthetic",collectedAt: at,sourceRevision: null,revisionSource: "collection",quantityKind: "snapshot",skuRef: sku,totalQuantity: quantity,forSaleQuantity: quantity,reservedOrUnavailableQuantity: 0,syncRunId: subscription },inventoryClass: "sellable",lastSyncedAt: at,staleAfter: (await db.query("SELECT now()+interval '1 day' AS until")).rows[0].until.toISOString() });
    const claimedOperation=await rpc(db,"subscription_claim_due_renewal",[codec.identity(frozen),codec.fingerprint(frozen),wire,"synthetic",300,claimed]);
    let admitted: Record<string,unknown>,preRecovery: Record<string,unknown>|null=null;
    if(options.creator==="recover") {
      expect(await rpc(db,"fulfillment_reserve_subscription_renewal",[claimedOperation.operationId,claimedOperation.claimToken,900,claimed])).toMatchObject({ reserved:false });
      preRecovery=(await db.query("SELECT to_jsonb(op) AS row FROM public.subscription_renewal_operations op WHERE id=$1",[claimedOperation.operationId])).rows[0].row;
      if(options.recoveryStock) {
        const recorded=(await db.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at;
        await stock.recordProviderStockCurrent({ requestKey:`recovery:${predecessor.code}`,snapshot:{ providerRef:"synthetic",collectedAt:recorded,sourceRevision:null,revisionSource:"collection",quantityKind:"snapshot",skuRef:predecessor.code,totalQuantity:options.recoveryStock,forSaleQuantity:options.recoveryStock,reservedOrUnavailableQuantity:0,syncRunId:subscription },inventoryClass:"sellable",lastSyncedAt:recorded,staleAfter:(await db.query("SELECT now()+interval '1 day' AS until")).rows[0].until.toISOString() });
      }
      admitted=await rpc(db,"subscription_stock_wait_recover_refusal",[claimedOperation.operationId,codec.fingerprint(frozen),"synthetic-recovery",at]);
      expect(admitted.waiting).toBe(!options.recoveryStock);
    } else {
      admitted=await rpc(db,"subscription_stock_wait_admit",[{ operationId: claimedOperation.operationId,claimToken: claimedOperation.claimToken,snapshot: wire,operationFingerprint: codec.fingerprint(frozen),identityKey: codec.identity(frozen),worker: "synthetic" },{},claimed]);
      expect(admitted.waiting).toBe(true);
    }
    const innerHash=hash(randomUUID()),line={ variantId: successor.sku,qty: 1,isAddon: false,quoteLine: { sku: successor.code,quantity: 1,unitPriceGross: money(777),lineSubtotalGross: money(777) } };
    const consent=buildEditConsent(await readCompleteEditBaseline(db,subscription),innerHash,[line]),quoteHash=hashEditConsent(consent);
    const admission={ heads: [{ productId: successor.product,head: successor.head }],skuRevisions: [{ reference: successor.reference,quantity: 1 }],mode: "subscription",
      offerEvidence: { offerVersion: "classic" },priceContextVersions: [{ skuId: successor.sku,priceListId: list,entryId: entry,entry: (await db.query("SELECT to_jsonb(p) AS row FROM public.price_entries p WHERE id=$1",[entry])).rows[0].row }],purpose: "account" };
    const core=[{ variantId: successor.sku,qty: 1 }],totals={ currentRecurringPrice: money(617),newRecurringPrice: money(777),delta: money(160) };
    const request={ planDays: 28,base: core,addons: [],expectedTemplateVersion: 1,acceptedQuoteHash: quoteHash };
    const evidence={ baseLines: [line],addonLines: [],compositionConstraint: null,catalogAdmission: admission,editConsent: consent };
    const quote=await rpc(db,"subscription_quote_preview_record",[principal,client,subscription,"update_package_template",quoteHash,1,(await db.query("SELECT now()+interval '1 hour' AS until")).rows[0].until.toISOString(),{ planDays: 28,base: core,addons: [] },evidence,totals,at]);
    const newFrozen=codec.withDestination!(codec.freeze({ ...header,template_version: 2,lines: [{ lineOrdinal: 1,sku: successor.code,quantity: 1,unitAmountMinor: 777 }],catalog_acceptance: { schemaVersion: 2,lines: [successor.reference] },graduation_pricing: [{ sku: successor.code,quantity: 1,unitAmountMinor: 777,isAddon: false,quoteLine: line.quoteLine }] },schedule),destination);
    const proposalId=randomUUID(),offer={ proposalId,predecessorSkuId: predecessor.sku,successorSkuId: successor.sku,publicationId: successor.declared.publicationId,
      previewId: quote.id,sourceBinding: { kind: "stock_wait",caseKind: "legacy",caseId: admitted.caseId },lane: "classic",action: "update_package_template",
      applyPayload: { ...request,request,planDays: 28,base: core,addons: [],...evidence,...totals },cycleSnapshot: codec.encode(newFrozen) };
    const proposal=await rpc(db,"subscription_successor_proposal_offer_v2",[subscription,client,offer,at]);
    await db.query("COMMIT");
    return { client,principal,subscription,predecessor,successor,withdrawalHead,at,anchor,source,codec,frozen,wire,preRecovery,operationId: String(claimedOperation.operationId),claimToken: String(admitted.claimToken??claimedOperation.claimToken),caseId: String(admitted.caseId),proposalId,quoteHash: String(proposal.quote_hash),offer };
  } catch(error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
