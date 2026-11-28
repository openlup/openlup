import { createPostgresPurchaseReservationPort } from "@openlup/platform/inventory";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import * as renewal from "@openlup/platform/subscriptions";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPersonalDataContributorRegistry, createPostgresPrivacyStore, createPrivacyOperations } from "@openlup/platform/identity";
import { createPostgresSandboxPaymentSimulator } from "@openlup/platform/payments";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { connectedNativeStoreTables, type ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { renewalUpgradeCohort, tablesForRenewalUpgradeCohort } from "../../server/adapters/postgres/connectedStoreDomains/subscriptions.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { captureStoreJourney, journeySelection, storeJourneyResources, type JourneyTargetTemplate } from "../helpers/storeJourney.js";
import { readPlatformMigrationManifest, selectPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { readReviewedForwardRegistry } from "../../scripts/reviewed-platform-forward.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { nativePrivacyContributors } from "../../server/runtime/auth/privacyBinding.js";
import {
  bindDestinationOrder,
  destinationContext,
  documentTable,
  insertDestinationOrder,
  orderBindingTable,
  reachDestinationCutoff,
  readSnapshot,
  selectionTable,
  snapshot,
  snapshotCommand,
  testServicePin,
} from "./destinationDocumentFixture.js";
import {
  awaitReceiptWait,
  backendPid,
  idempotencyConflict,
  receiptArgs,
  receiptCall,
  receiptClient,
  receiptOutcome,
  receiptTable,
} from "./destinationReceiptFixture.js";
import {
  capture,
  census,
  paymentOptions,
  paymentPort,
  restoreInstallation,
  selection,
  transferredPrivacy,
  type Installation,
} from "./connectedStoreTransfer.fixture.js";
import { bind, bookCycle, edit, insertLocalAttempt, ownerTransaction, prepareGraph, subject } from "./renewalOrderDestinationV2.fixture.js";

// destinationDocumentFixture.snapshot() uses withCatalogAdmissionFence (pg_current_snapshot()),
// so keep this suite on its own isolated per-suite template container instead of the shared broker.
const resources = storeJourneyResources({ isolatedCluster: true });
let targetNumber = 0;
let sourceTemplates: JourneyTargetTemplate, targetTemplates: JourneyTargetTemplate;
let target: Installation, pristine: ConnectedNativeStoreCapture;

beforeAll(async () => {
  [sourceTemplates, targetTemplates] = await Promise.all([
    resources.targetTemplate("transfer-source"),
    resources.targetTemplate("transfer-target"),
  ]);
}, postgresSetupTimeoutMs);

afterAll(async () => {
  await resources.close();
}, postgresTeardownTimeoutMs);

const restore = (capturePacket: ConnectedNativeStoreCapture) => restoreInstallation(target, pristine, capturePacket);

const lineageIds = {
  root: "ffffffff-ffff-4fff-bfff-ffffffffffff",
  r1: "88888888-8888-4888-8888-888888888888",
  r2: "11111111-1111-4111-8111-111111111111",
  rootOnly: "00000000-0000-4000-8000-000000000001",
};

async function lineageStore() {
  const native = await sourceTemplates.nextTarget(`lineage-source-${targetNumber}`), client = randomUUID();
  await native.owner.query("INSERT INTO public.clients(id,email) VALUES($1,'lineage@example.invalid')", [client]);
  const db = await native.owner.connect();
  try {
    await db.query("BEGIN");
    for (const [id, root, predecessor] of [
      [lineageIds.root, null, null], [lineageIds.r1, lineageIds.root, lineageIds.root],
      [lineageIds.r2, lineageIds.root, lineageIds.r1], [lineageIds.rootOnly, lineageIds.root, null],
    ]) {
      await db.query(`INSERT INTO public.commerce_orders(id,client_id,total_amount_minor,currency_code,
        recovery_root_order_id,recreated_from_order_id,created_at,updated_at,metadata)
        VALUES($1,$2,100,'XXX',$3,$4,'2026-09-01T00:00:00.123456Z','2026-09-02T00:00:00.654321Z',
          '{"sequence":9007199254740993,"label":"Synthetic lineage"}')`, [id, client, root, predecessor]);
      await db.query(`INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
        VALUES($1,1,1,100,100)`, [id]);
    }
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  return native;
}

function sealLineageCapture(copy: ConnectedNativeStoreCapture) {
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const { sha256: _inner, ...inner } = copy.compatible; copy.compatible.sha256 = hash(inner);
  const { sha256: _outer, ...outer } = copy; copy.sha256 = hash(outer);
  return copy;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("declaration append boundary", () => {
  it("refuses a live declaration append before touching verified destination evidence", async () => {
    const clean = await sourceTemplates.clone("privacy-owner-append");
    const operator = randomUUID(), early = await receiptClient(clean.owner), context = await destinationContext(clean.owner);
    await clean.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [operator, `${operator}@example.invalid`]);
    await clean.owner.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',now())", [operator]);
    const document = await snapshot(clean.runtime, context);
    const order = await bindDestinationOrder(clean.owner, context, document);
    const store = createPostgresPrivacyStore(), owners = nativePrivacyContributors(store);
    const statements: string[] = [];
    const unitOfWork = { async run<T>(work: (db: PgQueryExecutor) => Promise<T>): Promise<T> {
      const client = await clean.runtime.connect();
      try {
        await client.query("BEGIN");
        const result = await work({ query: (sql, values) => { statements.push(sql); return client.query(sql, values ? [...values] : undefined); } });
        await client.query("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } };
    const operations = (contributors: typeof owners) => createPrivacyOperations({ store, unitOfWork,
      registry: createPersonalDataContributorRegistry(contributors, { requiredContributorIds: [] }), now: () => new Date(), randomId: randomUUID });
    const actor = { principalId: operator }, subject = { kind: "contact" as const, contactId: context.clientId };
    const input = { subject, idempotencyKey: randomUUID() }, missing = operations(owners.filter(owner => owner.id !== "destination-documents"));
    const qualified = operations(owners);
    // Disposable predecessor declaration, followed by the owner's ordered literal append.
    await clean.owner.query("DELETE FROM public.identity_privacy_required_contributors WHERE contributor_id='destination-documents'");
    expect((await missing.export(actor, subject)).missingContributors).toEqual([]);
    expect((await missing.erase(actor, { subject: { ...subject, contactId: early }, idempotencyKey: randomUUID() })).outcome).toBe("ERASED");
    await clean.owner.query("INSERT INTO public.identity_privacy_required_contributors(contributor_id) VALUES ('destination-documents') ON CONFLICT (contributor_id) DO NOTHING");
    const before = await census(clean.owner);
    statements.length = 0;
    for (const call of [() => missing.export(actor, subject), () => missing.erase(actor, input)]) {
      await expect(call()).rejects.toMatchObject({ code: "PRIVACY_CONTRIBUTOR_MISSING", facts: { observed: expect.stringContaining("destination-documents") } });
    }
    expect(statements).toEqual(Array(2).fill("SELECT public.identity_privacy_required_contributor_ids() AS ids"));
    expect(await census(clean.owner)).toEqual(before);
    await clean.owner.query("REVOKE EXECUTE ON FUNCTION public.identity_privacy_required_contributor_ids() FROM service_role");
    try {
      for (const call of [() => qualified.export(actor, subject), () => qualified.erase(actor, input)]) {
        await expect(call()).rejects.toMatchObject({ code: "PRIVACY_ASSESSMENT_UNAVAILABLE", facts: { fix: expect.stringContaining("EXECUTE") } });
      }
      expect(await census(clean.owner)).toEqual(before);
    } finally { await clean.owner.query("GRANT EXECUTE ON FUNCTION public.identity_privacy_required_contributor_ids() TO service_role"); }
    const exported = await qualified.export(actor, subject);
    expect(JSON.stringify(exported.documents.find(owner => owner.contributorId === "destination-documents")?.data)).toContain(order);
    expect((await qualified.erase(actor, input)).outcome).toBe("ERASED");
  }, 90_000);
});

describe("self-contained transfer scenarios", () => {
  // Each case owns a fresh qualified target and can run without another case.
  beforeEach(async () => {
    target = await targetTemplates.nextTarget(`target-${++targetNumber}`);
    pristine = await capture(target.owner, "owned-pristine-target");
  }, postgresSetupTimeoutMs);

  // About 4x the slowest hosted run (60,584 ms), rounded up to 5 s.
  it("preserves native checkout receipt identity, privacy and microseconds across transfer and restart", async () => {
    const { installSubscriptionConsumer } = await import("../helpers/installSubscriptionConsumer.js");
    const { execFileSync } = await import("node:child_process");
    const { writeFile } = await import("node:fs/promises");
    await mkdir(join(process.cwd(), ".context/scratch"), { recursive: true });
    const consumer = await mkdtemp(join(process.cwd(), ".context/scratch/checkout-transfer-consumer-"));
    try {
      const installed = await installSubscriptionConsumer(consumer);
      const checkout = await import(installed.resolve("@openlup/platform/commerce/server/native-checkout")) as typeof import("@openlup/platform/commerce/server/native-checkout");
      const native = await sourceTemplates.nextTarget("checkout-source");
      const clientId = randomUUID(), principalId = randomUUID(), skuId = randomUUID(), listId = randomUUID();
      await native.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'checkout-transfer@example.invalid')", [principalId]);
      await native.owner.query("INSERT INTO public.clients(id,principal_id,email) VALUES($1,$2,'checkout-transfer@example.invalid')", [clientId, principalId]);
      await native.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'checkout-transfer','Synthetic checkout')", [skuId]);
      await native.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,'CHECKOUT-TRANSFER','Synthetic checkout')", [skuId]);
      await native.owner.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Synthetic checkout','ZZ','XXX')", [listId]);
      await native.owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor) VALUES($1,$2,100)", [listId, skuId]);
      const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
      const request = { idempotencyKey: `checkout-transfer:${randomUUID()}`, quoteSnapshot: { contractVersion: "commerce.v0" as const, quote: {
        currency: "XXX", taxIncluded: true as const,
        lines: [{ sku: "CHECKOUT-TRANSFER", productSlug: "checkout-transfer", quantity: 2,
          unitPriceGross: money(100), lineSubtotalGross: money(200), tax: { included: true as const, country: "ZZ",
            category: "standard", vatRateBps: 2000, legalBasis: "Synthetic transfer tax", netAmount: money(167), vatAmount: money(33), grossAmount: money(200) } }],
        discounts: [], context: { mode: "one_time" as const, cadenceDays: null, promoCodes: [],
          hostFacts: { clientId, principalId, contact: "checkout-transfer@example.invalid" } },
        subtotalGross: money(200), discountTotalGross: money(0), shippingGross: money(0), shippingDiscountGross: money(0),
        totalGross: money(200), netTotal: money(167), taxTotal: money(33) } } };
      const created = await checkout.createPostgresNativeCheckoutPersistence(native.runtime).createOrderDraft(request, { clientId });
      const orderId = created.orderDraft.orderId.replace(/^order_/, "");
      // Precision fixture only: the public writer creates the receipt; its timestamp is not part of the request fingerprint.
      await native.owner.query("UPDATE public.commerce_order_draft_receipts SET created_at='2026-11-03T12:34:56.123456Z' WHERE order_id=$1", [orderId]);
      const carried = await capture(native.owner, "native-checkout-source");
      const receipt = carried.owned.find(data => data.table === "commerce_order_draft_receipts")!;
      expect(receipt.rows).toHaveLength(1);
      const receiptRow = JSON.parse(receipt.rows[0]!);
      const order = JSON.parse(carried.compatible.tables.find(data => data.table === "commerce_orders")!.rows[0]!);
      expect(receiptRow.response_payload.orderDraft.quoteSnapshot).toEqual(order.metadata.quoteSnapshot);
      expect(order.metadata.quoteSnapshot).toEqual(request.quoteSnapshot);
      expect(receiptRow.created_at).toBe("2026-11-03T12:34:56.123456+00:00");
      const throughReceipt = [...carried.compatible.tables, receipt];
      const rows = throughReceipt.reduce((total, data) => total + data.rows.length, 0);
      const bytes = throughReceipt.reduce((total, data) => total + data.rows.reduce((size, row) => size + Buffer.byteLength(row), 0), 0);
      await expect(capture(native.owner, "receipt-row-bound", { maximumRows: rows - 1, maximumBytes: 64 * 1024 * 1024 }))
        .rejects.toMatchObject({ code: "limit_exceeded", table: "commerce_order_draft_receipts" });
      await expect(capture(native.owner, "receipt-byte-bound", { maximumRows: 10000, maximumBytes: bytes - 1 }))
        .rejects.toMatchObject({ code: "limit_exceeded", table: "commerce_order_draft_receipts" });
      expect(await restore(carried)).toMatchObject({ replayed: false });
      expect((await census(target.owner)).commerce_order_draft_receipts).toEqual(receipt.rows);
      const retained = (await target.owner.query(`SELECT r.order_id,
        r.response_payload#>>'{orderDraft,orderId}' AS response_order,
        to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
        r.request_fingerprint=md5((o.metadata->'quoteSnapshot')::text||'|'||(o.metadata->'orderDraftSnapshot')::text||'|'||coalesce(o.client_id::text,'')) AS fingerprint_matches,
        o.client_id,c.principal_id FROM public.commerce_order_draft_receipts r JOIN public.commerce_orders o ON o.id=r.order_id
        JOIN public.clients c ON c.id=o.client_id WHERE r.order_id=$1`, [orderId])).rows;
      expect(retained).toEqual([{ order_id: orderId, response_order: created.orderDraft.orderId,
        created_at: "2026-11-03T12:34:56.123456Z", fingerprint_matches: true, client_id: clientId, principal_id: principalId }]);
      expect((await target.owner.query("SELECT principal_id FROM public.platform_human_principals WHERE principal_id=$1", [principalId])).rows)
        .toEqual([{ principal_id: principalId }]);
      await target.runtime.end();
      const script = join(consumer, "restart-checkout.mjs");
      await writeFile(script, `import {Pool} from "pg";
import {readFileSync} from "node:fs";
import {createPostgresNativeCheckoutPersistence} from "@openlup/platform/commerce/server/native-checkout";
const input=JSON.parse(readFileSync(0,"utf8")),db=new Pool({connectionString:input.url});
try {
  const port=createPostgresNativeCheckoutPersistence(db),replay=await port.createOrderDraft(input.request,{clientId:input.clientId});
  const changed=structuredClone(input.request);changed.quoteSnapshot.quote.context.hostFacts.contact="changed@example.invalid";
  let refusal=null;try {await port.createOrderDraft(changed,{clientId:input.clientId});}catch(error){refusal={name:error.name,details:error.details};}
  const counts=(await db.query("SELECT (SELECT count(*)::int FROM public.commerce_orders) orders,(SELECT count(*)::int FROM public.commerce_order_draft_receipts) receipts,(SELECT count(*)::int FROM public.outbox_events WHERE event_type='commerce.order_draft.created') events")).rows[0];
  const role=(await db.query("SELECT current_user,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) elevated")).rows[0];
  console.log(JSON.stringify({replay,refusal,counts,role}));
}finally {await db.end();}`);
      const restarted = JSON.parse(execFileSync(process.execPath, [script], { cwd: consumer, encoding: "utf8", timeout: 30_000,
        input: JSON.stringify({ url: target.runtimeUrl, request, clientId }) }));
      expect(restarted.replay).toEqual({ ...created, orderDraft: { ...created.orderDraft, replayed: true } });
      expect(restarted.refusal).toMatchObject({ name: "CommerceOrderDraftConflictError", details: { code: "23505" } });
      expect(restarted.counts).toEqual({ orders: 1, receipts: 1, events: 1 });
      expect(restarted.role).toEqual({ current_user: "transfer_runtime", elevated: false });
      expect((await census(target.owner)).commerce_order_draft_receipts).toEqual(receipt.rows);
      expect(await restore(carried)).toMatchObject({ replayed: true });
      console.info("Checkout transfer retained tables:", connectedNativeStoreTables.length);
    } finally { await rm(consumer, { recursive: true, force: true }); }
  }, 245_000);

  it("refuses a real sized opt-in before target writes while the classic source still transfers", async () => {
    const sizedSource = await sourceTemplates.nextTarget("sized-source");
    const clientId = randomUUID(), subscriptionId = randomUUID(), actorId = randomUUID(), sku = randomUUID(), priceList = randomUUID();
    const at = "2026-11-06T12:00:00.000Z", next = "2026-12-20T12:00:00.000Z";
    await sizedSource.owner.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,'sized@example.invalid',$2)", [clientId, actorId]);
    await sizedSource.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'sized-refill','Refill')", [sku]);
    await sizedSource.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$1,$2,'Refill',true)", [sku, sku]);
    await sizedSource.owner.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Configured','AA','XXX')", [priceList]);
    await sizedSource.owner.query(`INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,currency_code,price_list_id,composition_constraint)
      VALUES($1,$2,20,$3,'XXX',$4,'{"kind":"unit_count","value":4,"dailyNeed":4}')`, [subscriptionId, clientId, next, priceList]);
    await sizedSource.owner.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
      VALUES($1,'XXX','synthetic-stock','sandbox',$2,'sandbox-authorization')`, [subscriptionId, at]);
    await sizedSource.owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [subscriptionId]);
    await sizedSource.owner.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code)
      VALUES($1,$2,4,0,100,'XXX')`, [subscriptionId, sku]);
    await sizedSource.owner.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,$2,4,100)", [subscriptionId, sku]);
    const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
    const quoteLine: renewal.SizedQuoteLine = { sku, productSlug: "sized-refill", quantity: 4, unitPriceGross: money(100), lineSubtotalGross: money(400),
      tax: { included: true, country: "AA", category: "standard", vatRateBps: 0, legalBasis: "synthetic", netAmount: money(400), vatAmount: money(0), grossAmount: money(400) } };
    await sizedSource.owner.query(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
      VALUES($1,'subscription.starter_graduated',$2,$3,$4)`, [subscriptionId, randomUUID(),
      { linePricing: [{ sku, quantity: 4, unitAmountMinor: 100, isAddon: false, quoteLine }] }, at]);
    const classic = await capture(sizedSource.owner, "classic-before-opt-in");
    const classicRows = await census(sizedSource.owner);
    // This synthetic host has no mutable subject facts; the production preview
    // and apply still execute with the restricted runtime on one transaction.
    const editor = renewal.createPostgresSizedEditor({
      policy: { minimumCoreUnits: 4, maximumCoreLines: 3, maximumAddonLines: 5, maximumQuantity: 12,
        allowedCadences: [20], maximumExclusions: 8, maximumCatalogExclusions: 16, fixedThroughCycle: 2, graduationCycle: 3,
        portionModes: { full: { mode: "complete", factor: 1 }, reduced: { mode: "partial", factor: 0.5 } } },
      now: () => at,
      async withTransaction(work) {
        const db = await sizedSource.runtime.connect();
        try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
        catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
      },
      async readFacts() { return { subscriptionId, clientId, subjectRef: subscriptionId, exclusions: [], snapshot: {} }; },
      async resolveOptInNeed() { return { dailyNeed: 4, snapshot: {} }; },
      async assertCurrentFacts() {},
      async readCatalog() { return [{ variantId: sku, sku, groupId: sku, isAddon: false, sellable: true, physicalSize: 250, demandPerUnit: 20,
        documentRevisionId: sku, documentDigest: "a".repeat(64), verified: true, exclusions: [], sellableNow: 12 }]; },
      async proposePortion({ current }) { return current.map(line => ({ variantId: line.variantId, qty: line.qty })); },
      quotePort: { async createServerAuthoritativeQuote() { return { quote: { currency: "XXX", taxIncluded: true, lines: [quoteLine], discounts: [],
        subtotalGross: money(400), discountTotalGross: money(0), totalGross: money(400), netTotal: money(400), taxTotal: money(0) } }; } },
    });
    const actor = { clientId, actorId };
    const request: renewal.SizedEditRequest = { subscriptionId, action: "resize_bundle", cadenceDays: 20,
      compositionConstraint: { kind: "unit_count", value: 4, dailyNeed: 4 },
      resizeLever: { kind: renewal.SIZED_PARCEL_LEVER_KIND, value: { coreLines: [{ variantId: sku, qty: 4 }], optInToSized: true } } };
    const preview = await editor.preview(actor, request);
    expect(preview.preview.canApply).toBe(true);
    expect((await editor.apply(actor, randomUUID(), { ...request, expectedTemplateVersion: preview.preview.templateVersion, acceptedQuoteHash: preview.quoteHash })).status).toBe("applied");
    expect((await sizedSource.owner.query("SELECT configured_offer_version,status,next_cycle_at FROM public.subscriptions WHERE id=$1", [subscriptionId])).rows)
      .toEqual([{ configured_offer_version: "sized.v1", status: "active", next_cycle_at: new Date(next) }]);
    const sized = await capture(sizedSource.owner, "sized-after-opt-in"), before = await census(target.owner);
    // Observe the boundary as well as rollback: no retained-data SQL may start.
    const connect = target.owner.connect.bind(target.owner);
    const observed = { async connect() {
      const db = await connect();
      return { async query(sql: string, values?: unknown[]) {
        if (/^\s*(INSERT|UPDATE|DELETE)\b/iu.test(sql) || /public\.(client_import_retained_row|subscription_cycle_import_retained_row)\(/u.test(sql)) {
          throw new Error("sized refusal attempted a target data write");
        }
        return db.query(sql, values);
      }, release: (destroy?: boolean) => db.release(destroy) };
    } } as unknown as Pool;
    await expect(restoreConnectedNativeStore({ owner: observed, installation: selection, packet: sized, freshTarget: pristine }))
      .rejects.toMatchObject({ code: "unsupported_table", table: "subscriptions" });
    expect(await census(target.owner)).toEqual(before);
    expect((await restore(classic)).replayed).toBe(false);
    expect(await census(target.owner)).toEqual(classicRows);
  }, 140_000);

  it("restores both order-lineage parents before children without changing captured row text", async () => {
    const native = await lineageStore(), carried = await capture(native.owner, "lineage-source");
    const orders = carried.compatible.tables.find(table => table.table === "commerce_orders")!;
    expect(orders.rows.map(row => JSON.parse(row).id)).toEqual([lineageIds.rootOnly, lineageIds.r2, lineageIds.r1, lineageIds.root]);
    const before = await census(native.owner), originalPacket = JSON.stringify(carried);
    expect((await restore(carried)).replayed).toBe(false);
    expect(await census(target.owner)).toEqual(before);
    expect((await census(target.owner)).commerce_orders).toEqual(orders.rows);
    expect(JSON.stringify(carried)).toBe(originalPacket);
    expect((await restore(carried)).replayed).toBe(true);
    expect(await census(target.owner)).toEqual(before);
  }, 140_000);

  it.each(["recovery_root_order_id", "recreated_from_order_id"] as const)("refuses a captured order cycle through %s with no target writes", async field => {
    const native = await lineageStore();
    // Both referenced rows exist; PostgreSQL permits this cycle. The importer
    // must refuse it explicitly rather than depending on row insertion order.
    await native.owner.query(`UPDATE public.commerce_orders SET ${field}=$2 WHERE id=$1`, [lineageIds.root, lineageIds.r2]);
    const carried = await capture(native.owner, `lineage-cycle-${field}`), before = await census(target.owner);
    await expect(restore(carried)).rejects.toMatchObject({ code: "target_conflict", table: "commerce_orders" });
    expect(await census(target.owner)).toEqual(before);
  }, 110_000);

  it.each(["recovery_root_order_id", "recreated_from_order_id"] as const)("refuses a parent absent from the captured set for %s with no target writes", async field => {
    const native = await lineageStore(), carried = await capture(native.owner, `lineage-missing-${field}`);
    // Remove a real parent from the captured set. Keep the remaining PostgreSQL
    // row strings and their precision, including the now-dangling reference.
    const retained = new Set(field === "recovery_root_order_id" ? [lineageIds.rootOnly]
      : [lineageIds.root, lineageIds.r2, lineageIds.rootOnly]);
    const orders = carried.compatible.tables.find(table => table.table === "commerce_orders")!;
    orders.rows = orders.rows.filter(row => retained.has(JSON.parse(row).id));
    const items = carried.compatible.tables.find(table => table.table === "commerce_order_items")!;
    items.rows = items.rows.filter(row => retained.has(JSON.parse(row).order_id));
    const before = await census(target.owner);
    await expect(restore(sealLineageCapture(carried))).rejects.toMatchObject({ code: "target_conflict", table: "commerce_orders" });
    expect(await census(target.owner)).toEqual(before);
  }, 110_000);

  it("round-trips an actually recreated checkout and its root with complete row equality", async () => {
    const native = await sourceTemplates.nextTarget("recreated-checkout-source");
    const { createPostgresNativeCheckoutPersistence } = await import("@openlup/platform/commerce/server/native-checkout");
    const { createExpiredCheckoutRecoveryService, createPostgresCheckoutRecoveryOrderPort, createPostgresExpiredCheckoutRecoveryPort,
      createPostgresExpiredCheckoutDraftPort, createPostgresExpiredCheckoutRuntime, createPostgresExpiredCheckoutCompensation,
      checkoutRecoveryExecutionFingerprint } = await import("@openlup/platform/commerce/server");
    const { createPostgresSandboxExpiredCheckoutSafety } = await import("@openlup/platform/payments");
    // The maximal version-4 root ID sorts after the real writer's generated child.
    const root = "ffffffff-ffff-4fff-bfff-ffffffffffff", client = randomUUID(), skuId = randomUUID(), sourceKey = randomUUID();
    const sku = "RECREATED-TRANSFER", now = () => new Date().toISOString(), amount = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
    const frozen = { contractVersion: "commerce.v0" as const, quote: { currency: "XXX", taxIncluded: true as const,
      lines: [{ sku, productSlug: "recreated-transfer", quantity: 1, unitPriceGross: amount(100), lineSubtotalGross: amount(100),
        tax: { included: true as const, country: "ZZ", category: "standard", vatRateBps: 0, legalBasis: "Synthetic",
          netAmount: amount(100), vatAmount: amount(0), grossAmount: amount(100) } }], discounts: [],
      context: { mode: "one_time" as const, cadenceDays: null, promoCodes: [] }, subtotalGross: amount(100), discountTotalGross: amount(0),
      shippingGross: amount(0), shippingDiscountGross: amount(0), totalGross: amount(100), netTotal: amount(100), taxTotal: amount(0) } };
    await native.owner.query("INSERT INTO public.clients(id,email) VALUES($1,'recreated@example.invalid')", [client]);
    await native.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'recreated-transfer','Synthetic')", [skuId]);
    await native.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$2,'Synthetic')", [skuId, sku]);
    const list = (await native.owner.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES('Synthetic','ZZ','XXX') RETURNING id")).rows[0].id;
    await native.owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor) VALUES($1,$2,100)", [list, skuId]);
    await native.owner.query(`INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,
      inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
      VALUES($1,$2,10,10,0,'sellable',clock_timestamp(),clock_timestamp()+interval '30 days','recreated',$1,$3)`, [sourceKey, sku, "a".repeat(64)]);
    const db = await native.owner.connect();
    try {
      await db.query("BEGIN");
      await db.query(`INSERT INTO public.commerce_orders(id,client_id,total_amount_minor,currency_code,created_at,metadata)
        VALUES($1,$2,100,'XXX',clock_timestamp()-interval '2 hours',$3)`, [root, client,
        { quoteSnapshot: frozen, orderDraftSnapshot: { context: frozen.quote.context } }]);
      await db.query("INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,1,1,100,100)", [root, skuId]);
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
    await native.runtime.query("SELECT public.commerce_register_order_destination($1,$2,$3,$4)",
      [`destination:${root}`, root, { recipientName: "Example Buyer", line1: "Example 1", city: "Example", postalCode: "00000", country: "ZZ" }, now()]);
    const intent = (await native.runtime.query("SELECT public.commerce_open_settlement_intent($1,$2,'sandbox',100,'XXX','{}',$3) AS value",
      [`intent:${root}`, root, now()])).rows[0].value;
    const prior = await paymentPort(native.runtime).beginAttempt({ idempotencyKey: `attempt:${root}`, settlementIntentId: intent.settlement.id,
      requestFingerprint: "a".repeat(64), at: now() });
    await paymentPort(native.runtime).recordObservation({ attemptId: prior.id, idempotencyKey: `refused:${root}`, outcome: "refused", occurredAt: now() });
    await native.owner.query(`UPDATE public.commerce_orders SET status='expired',metadata=metadata||
      '{"paymentStatus":"expired","source":"checkout_reservation_expiry"}'::jsonb WHERE id=$1`, [root]);
    const lane = { async run<T>(work: (gateway: unknown) => Promise<T>): Promise<T> {
      const connection = await native.runtime.connect();
      try { await connection.query("BEGIN"); const value = await work(connection); await connection.query("COMMIT"); return value; }
      catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
    } };
    const runtime = createPostgresExpiredCheckoutRuntime(lane, { stockSourceKey: sourceKey, channelKey: "sandbox", reservationLifetimeMs: 1800000,
      verifyPriorPayment: (input, db) => createPostgresSandboxExpiredCheckoutSafety(db).verifyPriorPayment(input),
      reserveOrderItems: (input, executor) => createPostgresPurchaseReservationPort(executor).reserveOrderItems(input),
      startPayment: (input, executor) => createPostgresSandboxPaymentSimulator(executor, paymentOptions).beginAttempt({
        idempotencyKey: input.idempotencyKey, settlementIntentId: input.settlementIntentId,
        requestFingerprint: checkoutRecoveryExecutionFingerprint(input), at: now() }) });
    const service = createExpiredCheckoutRecoveryService({ supports: () => true, quoteRequest: () => ({}), quotePort: { createQuote: async () => frozen },
      orderDraftPort: createPostgresExpiredCheckoutDraftPort(native.runtime, createPostgresNativeCheckoutPersistence(native.runtime)),
      recoveryPort: createPostgresExpiredCheckoutRecoveryPort(native.runtime, { recoveryWindowMs: 7 * 86400000 }),
      paymentSafetyPort: createPostgresSandboxExpiredCheckoutSafety(native.runtime), runtimePort: runtime,
      compensationPort: createPostgresExpiredCheckoutCompensation(lane) });
    const order = await createPostgresCheckoutRecoveryOrderPort(native.runtime).getRecoveryOrder({ orderId: root });
    expect(order).not.toBeNull();
    const started = await service.recreate({ order: order!, clientId: client });
    expect((await native.owner.query("SELECT recovery_root_order_id,recreated_from_order_id FROM public.commerce_orders WHERE id=$1", [started.orderId])).rows)
      .toEqual([{ recovery_root_order_id: root, recreated_from_order_id: root }]);
    const carried = await capture(native.owner, "actually-recreated-checkout"), before = await census(native.owner);
    const rows = carried.compatible.tables.find(table => table.table === "commerce_orders")!.rows;
    expect(rows.map(row => JSON.parse(row).id)).toEqual([started.orderId, root]);
    expect((await restore(carried)).replayed).toBe(false);
    expect(await census(target.owner)).toEqual(before);
    expect((await census(target.owner)).commerce_orders).toEqual(rows);
    expect((await restore(carried)).replayed).toBe(true);
    expect(await census(target.owner)).toEqual(before);
  }, 160_000);

  it("destination_receipt_privacy_round_trip", async () => {
    const clean = await sourceTemplates.clone("destination-receipts");
    const operator = randomUUID();
    const [issued, erasedFirst, retained] = await Promise.all([
      receiptClient(clean.owner), receiptClient(clean.owner), receiptClient(clean.owner),
    ]);
    const now = (await clean.owner.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    await clean.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [operator, `${operator}@example.invalid`]);
    await clean.owner.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',$2)", [operator, now]);

    const store = createPostgresPrivacyStore();
    const contributors = nativePrivacyContributors(store);
    const documents = contributors.find(owner => owner.id === "destination-documents")!;
    const contributor = contributors.find(owner => owner.id === "destination-receipts")!;
    const registry = createPersonalDataContributorRegistry(contributors,
      { requiredContributorIds: ["identity", "destination-receipts", "destination-documents", "tax-calculations"] });
    const unitOfWork = (onStart?: (pid: number) => void) => ({
      async run<T>(work: (db: PgQueryExecutor) => Promise<T>): Promise<T> {
        const db = await clean.runtime.connect();
        try {
          await db.query("BEGIN");
          onStart?.(await backendPid(db));
          const result = await work(db);
          await db.query("COMMIT");
          return result;
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        } finally { db.release(); }
      },
    });
    const operations = (privacyStore = store, onStart?: (pid: number) => void) => createPrivacyOperations({
      store: privacyStore, registry, now: () => now, randomId: randomUUID, unitOfWork: unitOfWork(onStart),
    });
    const actor = { principalId: operator };
    const subject = (contactId: string) => ({ kind: "contact" as const, contactId });
    const request = (id: string) => ({ subject: subject(id), idempotencyKey: randomUUID() });
    const payload = async (id: string) => (await operations().export(actor, subject(id))).documents.find(d => d.contributorId === contributor.id)?.data;

    const documentPayload = async (id: string) => (await operations().export(actor, subject(id))).documents.find(d => d.contributorId === documents.id)?.data;
    const [issuedCtx, erasedFirstCtx, retainedCtx] = await Promise.all(
      [issued, erasedFirst, retained].map(id => destinationContext(clean.owner, id)));
    const firstDocument = await snapshot(clean.runtime, issuedCtx), expired = await snapshot(clean.runtime, retainedCtx);
    // Recovery transcript: altered stored bytes are withheld until owner expiry retires the payload.
    const alterStoredBytes = (ref: string) => clean.owner.query(`UPDATE ${documentTable} SET document_text=document_text||' ' WHERE snapshot_ref=$1`, [ref]);
    const documentExport = async (id: string) => (await operations().export(actor, subject(id))).documents.find(d => d.contributorId === documents.id);
    const withheld = (ref: string) => ({ snapshotRef: ref, issuedAt: expect.stringMatching(/Z$/u), evidenceDisposition: "available",
      verification: { status: "failed", code: "destination_digest_mismatch", field: "documentDigest" } });
    const included = ["private checkout destination documents", "destination document expiry and erasure metadata",
      "verified order binding pins", "order binding erasure markers",
      "verified subscription selection pins", "subscription selection erasure markers"];
    await alterStoredBytes(firstDocument.binding.snapshotRef);
    const recovery = await documentExport(issued);
    expect(recovery).toEqual({ contributorId: documents.id, version: "commerce.destination-documents.v1",
      data: [withheld(firstDocument.binding.snapshotRef)], obligations: expect.any(Array), coverage: { complete: false, included,
        unavailable: ["Review withheld destination evidence with the destination owner. After cutoff, run commerce_destination_v2_expire for unbound documents and export again."] } });
    await reachDestinationCutoff(clean.owner, firstDocument.binding);
    await reachDestinationCutoff(clean.owner, expired.binding);
    expect((await clean.owner.query("SELECT public.commerce_destination_v2_expire(clock_timestamp(),1000) AS count")).rows)
      .toEqual([{ count: 2 }]);
    expect(await documentExport(issued)).toEqual({ ...recovery, coverage: { complete: true, included, unavailable: [] },
      data: [{ snapshotRef: firstDocument.binding.snapshotRef, issuedAt: expect.stringMatching(/Z$/u), evidenceDisposition: "expired" }] });
    const live = await snapshot(clean.runtime, retainedCtx);
    const liveRead = await readSnapshot(clean.runtime, retainedCtx, live.binding);
    expect(await documentPayload(retained)).toEqual(expect.arrayContaining([
      { snapshotRef: expired.binding.snapshotRef, issuedAt: expect.any(String), evidenceDisposition: "expired" },
      { snapshotRef: live.binding.snapshotRef, issuedAt: expect.any(String), evidenceDisposition: "available",
        scopeRef: retainedCtx.scopeRef, document: liveRead.document, documentDigest: liveRead.documentDigest, evidenceExpiresAt: live.evidenceExpiresAt },
    ]));

    const issuedArgs = receiptArgs(issued), firstEraseArgs = receiptArgs(erasedFirst), retainedArgs = receiptArgs(retained);
    const outcome = await receiptOutcome(clean.owner);
    const available = await receiptCall(clean.owner, "commit", retainedArgs, outcome);
    expect(await payload(retained)).toEqual(expect.arrayContaining([{
      owner: retainedArgs[0].owner, dialect: retainedArgs[1], requestKey: retainedArgs[2], requestDigest: retainedArgs[3], outcome,
      eventId: available.eventId, eventSchemaVersion: 1, createdAt: expect.stringMatching(/Z$/u), evidenceDisposition: "available",
    }]));
    expect(await payload(issued)).toMatchObject([{ eventId: firstDocument.eventId, evidenceDisposition: "available" }]);

    const boundDocument = await snapshot(clean.runtime, issuedCtx);
    const boundOrder = await bindDestinationOrder(clean.owner, issuedCtx, boundDocument);
    const foreignOrder = await insertDestinationOrder(clean.owner, retainedCtx);
    await clean.owner.query(`INSERT INTO ${orderBindingTable} (order_id,snapshot_ref,selection,service)
      SELECT $2,snapshot_ref,selection,service FROM ${orderBindingTable} WHERE order_id=$1`, [boundOrder, foreignOrder]);
    const cleanBinding = { orderId: boundOrder, selection: boundDocument.selection, service: testServicePin };
    const incomplete = await documentExport(issued);
    expect(incomplete).toMatchObject({ coverage: { complete: false }, data: expect.arrayContaining([expect.objectContaining({
      snapshotRef: boundDocument.binding.snapshotRef,
      orderBindings: [cleanBinding],
      verification: { status: "failed", code: "destination_binding_invalid", field: "orderBindings" },
    })]) });
    expect(JSON.stringify(incomplete?.data)).not.toContain(foreignOrder);
    await clean.owner.query(`DELETE FROM ${orderBindingTable} WHERE order_id=$1`, [foreignOrder]);
    await clean.owner.query("DELETE FROM public.commerce_orders WHERE id=$1", [foreignOrder]);
    await clean.owner.query(`UPDATE ${orderBindingTable} SET service=jsonb_set(service,'{adapterRevision}','"withheld-pin"') || '{"extra":"malformed"}'
      WHERE order_id=$1`, [boundOrder]);
    await reachDestinationCutoff(clean.owner, boundDocument.binding);
    await clean.owner.query("SELECT public.commerce_destination_v2_expire(clock_timestamp(),1000)");
    const withheldBinding = await documentExport(issued);
    expect(withheldBinding?.coverage).toMatchObject({ complete: false });
    expect(JSON.stringify(withheldBinding?.data)).not.toContain(boundOrder);
    expect(JSON.stringify(withheldBinding?.data)).not.toContain("withheld-pin");
    await clean.owner.query(`UPDATE ${orderBindingTable} SET service=$2 WHERE order_id=$1`, [boundOrder, testServicePin]);

    const writer = await clean.owner.connect();
    let firstErasure: ReturnType<ReturnType<typeof operations>["erase"]> | undefined;
    const erasureRequest = request(issued);
    let issuedReceipt: { eventId: string };
    const { command: issuedCommand } = snapshotCommand(issuedCtx);
    let issuedDocument: Awaited<ReturnType<typeof snapshot>>;
    try {
      await writer.query("BEGIN");
      expect(await receiptCall(writer, "lock", issuedArgs)).toEqual({ kind: "absent" });
      issuedDocument = await snapshot(writer, issuedCtx, issuedCommand);
      const erasurePid = deferred<number>();
      firstErasure = operations(store, erasurePid.resolve).erase(actor, erasureRequest);
      void firstErasure.catch(erasurePid.reject);
      await awaitReceiptWait(clean.owner, await erasurePid.promise, "relation", "ShareRowExclusiveLock");
      issuedReceipt = await receiptCall(writer, "commit", issuedArgs, outcome);
      await writer.query("COMMIT");
    } finally { await writer.query("ROLLBACK"); writer.release(); }
    expect(await firstErasure).toMatchObject({ outcome: "ERASED" });
    expect(await operations().erase(actor, erasureRequest)).toMatchObject({ outcome: "ALREADY_ERASED" });
    expect(await payload(issued)).toEqual(expect.arrayContaining([{
      eventId: issuedReceipt.eventId, eventSchemaVersion: 1, createdAt: expect.stringMatching(/Z$/u), evidenceDisposition: "erased",
    }]));
    expect(await documentPayload(issued)).toEqual(expect.arrayContaining([firstDocument, issuedDocument, boundDocument].map(result => ({
      snapshotRef: result.binding.snapshotRef, issuedAt: expect.any(String), evidenceDisposition: "erased",
    }))));
    expect((await clean.owner.query(`SELECT owner_scope,scope_ref,binding,document_text,document_digest FROM ${documentTable}
      WHERE client_id=$1`, [issued])).rows).toEqual(Array.from({ length: 3 }, () => ({
      owner_scope: null, scope_ref: null, binding: null, document_text: null, document_digest: null,
    })));
    expect((await clean.owner.query(`SELECT snapshot_ref FROM ${selectionTable} WHERE scope_ref=$1`, [issuedCtx.scopeRef])).rows).toEqual([]);
    expect(await snapshot(clean.runtime, issuedCtx, issuedCommand)).toEqual({ evidenceDisposition: "erased" });
    await expect(readSnapshot(clean.runtime, issuedCtx, issuedDocument.binding)).resolves.toMatchObject({ code: "destination_evidence_unavailable" });
    await unitOfWork().run(async db => {
      await store.prepareErasure(db);
      expect((await db.query("SELECT public.commerce_destination_v2_receipts_erase($1) AS count", [issued])).rows).toEqual([{ count: 0 }]);
      expect((await db.query("SELECT public.commerce_destination_v2_erase($1) AS count", [issued])).rows).toEqual([{ count: 0 }]);
    });
    const tombstone = { kind: "receipt", eventId: issuedReceipt.eventId, evidenceDisposition: "erased", outcome: null };
    expect(await receiptCall(clean.runtime, "read", issuedArgs)).toEqual(tombstone);
    expect(await receiptCall(clean.owner, "lock", issuedArgs)).toEqual(tombstone);
    await expect(receiptCall(clean.runtime, "read", [issuedArgs[0], issuedArgs[1], issuedArgs[2], "e".repeat(64)]))
      .rejects.toMatchObject(idempotencyConflict);

    const withheldDocument = await snapshot(clean.runtime, erasedFirstCtx);
    await alterStoredBytes(withheldDocument.binding.snapshotRef);
    expect(await documentPayload(erasedFirst)).toEqual([withheld(withheldDocument.binding.snapshotRef)]);
    const prepared = deferred<void>(), release = deferred<void>();
    const erasure = operations({ ...store, async prepareErasure(db) {
      await store.prepareErasure(db);
      prepared.resolve();
      await release.promise;
    } }).erase(actor, request(erasedFirst));
    void erasure.catch(prepared.reject);
    const secondWriter = await clean.owner.connect();
    let fresh: Promise<unknown> | undefined;
    try {
      await prepared.promise;
      const pid = await backendPid(secondWriter);
      fresh = snapshot(secondWriter, erasedFirstCtx);
      void fresh.catch(() => undefined);
      await awaitReceiptWait(clean.owner, pid, "relation", "ShareLock");
      release.resolve();
      expect(await erasure).toMatchObject({ outcome: "ERASED" });
      await expect(fresh).resolves.toMatchObject({ outcome: "refused", code: "destination_evidence_erased", field: "owner",
        fix: "Review the privacy disposition." });
    } finally {
      release.resolve();
      await Promise.allSettled([erasure, fresh]);
      secondWriter.release();
    }
    expect(await receiptCall(clean.runtime, "read", firstEraseArgs)).toEqual({ kind: "absent" });
    expect(await documentPayload(erasedFirst)).toEqual([{
      snapshotRef: withheldDocument.binding.snapshotRef, issuedAt: expect.stringMatching(/Z$/u), evidenceDisposition: "erased",
    }]);
    expect((await clean.owner.query(`SELECT owner_scope,scope_ref,binding,document_text,document_digest FROM ${documentTable}
      WHERE client_id=$1`, [erasedFirst])).rows).toEqual([{
      owner_scope: null, scope_ref: null, binding: null, document_text: null, document_digest: null,
    }]);
    expect((await clean.owner.query(`SELECT snapshot_ref FROM ${selectionTable} WHERE scope_ref=$1`, [erasedFirstCtx.scopeRef])).rows).toEqual([]);

    const transferred = await captureStoreJourney(clean.owner, "destination-receipts-source");
    const invalid = structuredClone(transferred);
    invalid.compatible.catalogueId = "0".repeat(64);
    const untouched = { connect: vi.fn() };
    await expect(restoreConnectedNativeStore({ owner: untouched as unknown as Pool, installation: selection,
      packet: sealLineageCapture(invalid), freshTarget: pristine })).rejects.toMatchObject({ code: "schema_conflict" });
    expect(untouched.connect).not.toHaveBeenCalled();

    expect(await restore(transferred)).toMatchObject({ replayed: false, captureSha256: transferred.sha256 });
    const readback = await captureStoreJourney(target.owner, "destination-receipts-readback");
    const table = (value: ConnectedNativeStoreCapture, relation: string) => value.owned.find(rows => `public.${rows.table}` === relation);
    for (const [relation, count] of [[receiptTable, 8], [documentTable, 6], [selectionTable, 1], [orderBindingTable, 1]] as const) {
      expect(table(transferred, relation)?.rows).toHaveLength(count);
      expect(table(readback, relation)).toEqual(table(transferred, relation));
    }
    expect((await target.owner.query(`SELECT * FROM ${orderBindingTable} WHERE order_id=$1`, [boundOrder])).rows)
      .toEqual([{ order_id: boundOrder, snapshot_ref: boundDocument.binding.snapshotRef, selection: null, service: null }]);
    expect(await readSnapshot(target.runtime, retainedCtx, live.binding)).toEqual(liveRead);
    await expect(readSnapshot(target.runtime, retainedCtx, expired.binding)).resolves.toMatchObject({
      code: "destination_version_changed", field: "destination.snapshotRef",
    });
    expect(await snapshot(target.runtime, issuedCtx, issuedCommand)).toEqual({ evidenceDisposition: "erased" });
    expect(await receiptCall(target.runtime, "read", retainedArgs)).toEqual(available);
    expect(await receiptCall(target.runtime, "read", issuedArgs)).toEqual(tombstone);
    expect(await restore(transferred)).toMatchObject({ replayed: true, captureSha256: transferred.sha256 });
  }, 30_000);

  it("restores subscription destination pointers after both parents with exact live and erased rows", async () => {
    const native = await sourceTemplates.clone("subscription-destination-transfer");
    const db = native.owner, ctx = await destinationContext(db);
    const live = ctx.scopeRef, marker = randomUUID();
    for (const id of [live, marker]) await db.query(`INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,status)
      VALUES($1,$2,28,clock_timestamp()+interval '28 days','active')`, [id, ctx.clientId]);
    const issued = await snapshot(native.runtime, ctx);
    await db.query(`DELETE FROM ${selectionTable} WHERE scope_ref=$1`, [live]);
    await db.query(`UPDATE ${documentTable} SET purpose=NULL,evidence_expires_at=issued_at WHERE snapshot_ref=$1`, [issued.binding.snapshotRef]);
    const { rows: [erased] } = await db.query(`INSERT INTO ${documentTable}
      (snapshot_ref,client_id,issued_at,evidence_expires_at,evidence_disposition)
      VALUES(gen_random_uuid(),$1,statement_timestamp(),statement_timestamp(),'erased') RETURNING snapshot_ref`, [ctx.clientId]);
    await db.query(`INSERT INTO public.subscription_destination_v2_selections(subscription_id,snapshot_ref,selection_revision,service)
      VALUES($1,$2,$3,$4),($5,$6,NULL,NULL)`, [live, issued.binding.snapshotRef, issued.selection.selectionRevision,
      testServicePin, marker, erased!.snapshot_ref]);
    const carried = await capture(db, "subscription-destination-parent-first");
    const selectionRows = carried.owned.find(table => table.table === "subscription_destination_v2_selections")!.rows;
    expect(selectionRows).toHaveLength(2);
    expect((await restore(carried)).replayed).toBe(false);
    expect((await census(target.owner)).subscription_destination_v2_selections).toEqual([...selectionRows].sort());
    expect((await restore(carried)).replayed).toBe(true);
  }, 90_000);
});

it("exports class markers for restored cross-client destination links and preserves predecessor exports and grants", async () => {
  const manifest = JSON.parse(await readFile("config/platform-migration-manifest.json", "utf8")) as PlatformMigrationManifest;
  if (manifest.schemaVersion !== 3) throw new Error("Three platform catalogue plans required");
  const registry = readReviewedForwardRegistry(await readFile("config/reviewed-platform-forwards.json"));
  const path = registry.nativeStoreForwardClass?.slots.find(slot => slot.row === "commerce-destination-v2-export-ownership")?.path;
  if (!path) throw new Error("Destination export forward is missing from the reviewed registry");
  const candidate = selectPlatformMigrationManifest(manifest, "qualified-v2", { migrationIsBootstrap: false, hasRestore: true });
  const prefix = structuredClone(manifest);
  for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) {
    const end = plan.forward.findIndex(unit => unit.file === path);
    if (end < 1) throw new Error(`Missing predecessor for ${path} in the platform catalogue plan`);
    plan.forward.splice(end);
  }
  await withPlatformCatalog(prefix, async root => {
    const predecessor = storeJourneyResources({ catalogueRoot: root });
    try {
      const templates = await predecessor.targetTemplate("destination-export-predecessor");
      const measured = readPlatformMigrationManifest(root) as PlatformMigrationManifest;
      if (measured.schemaVersion !== 3) throw new Error("Three measured platform catalogue plans required");
      const catalogueId = measured.qualified.objectInventorySha256.separateMigrator.withRestore;
      const source = await templates.clone("source"), restored = await templates.clone("target");
      const db = source.owner;
      const [mixed, foreign, consistent] = await Promise.all(Array.from({ length: 3 }, () => destinationContext(db)));
      const actor = { principalId: randomUUID() };
      await db.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'export-review@example.invalid')", [actor.principalId]);
      await db.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',now())", [actor.principalId]);
      const selections = "public.subscription_destination_v2_selections";
      const bindOrder = async (ctx: typeof mixed, issued: Awaited<ReturnType<typeof snapshot>>, service: unknown = testServicePin) => {
        const orderId = await insertDestinationOrder(db, ctx);
        await db.query(`INSERT INTO ${orderBindingTable}(order_id,snapshot_ref,selection,service) VALUES($1,$2,$3,$4)`,
          [orderId, issued.binding.snapshotRef, service === null ? null : issued.selection, service]);
        return orderId;
      };
      const selectSubscription = async (ctx: typeof mixed, issued: Awaited<ReturnType<typeof snapshot>>, service: unknown = testServicePin) => {
        await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,status) VALUES($1,$2,28,clock_timestamp()+interval '28 days','active')",
          [ctx.scopeRef, ctx.clientId]);
        await db.query(`INSERT INTO ${selections}(subscription_id,snapshot_ref,selection_revision,service) VALUES($1,$2,$3,$4)`,
          [ctx.scopeRef, issued.binding.snapshotRef, service === null ? null : issued.selection.selectionRevision, service]);
      };
      const issue = (ctx: typeof mixed) => snapshot(source.runtime, ctx);
      const erased = async (ctx: typeof mixed) => {
        const issued = await issue(ctx);
        await db.query("SELECT public.commerce_destination_v2_erase($1)", [ctx.clientId]);
        return issued;
      };
      const foreignErased = await erased(foreign), foreignExpired = await issue(foreign);
      await reachDestinationCutoff(db, foreignExpired.binding);
      expect((await db.query("SELECT public.commerce_destination_v2_expire(clock_timestamp(),1000) AS count")).rows).toEqual([{ count: 1 }]);
      const foreignLive = await issue(foreign);
      const orderClass = "orderBindings", subscriptionClass = "subscriptionSelections";
      const verification = (field: string) => ({ status: "failed", code: "destination_binding_invalid", field });
      const marker = (field: string) => ({ verification: verification(field) });
      const isolated: { id: string; field: string }[] = [];
      for (const [document, service] of [[foreignLive, testServicePin], [foreignErased, null], [foreignExpired, testServicePin]] as const) {
        const orderSubject = await destinationContext(db), subscriptionSubject = await destinationContext(db);
        await bindOrder(orderSubject, document, service);
        await selectSubscription(subscriptionSubject, document, service);
        isolated.push({ id: orderSubject.clientId, field: orderClass }, { id: subscriptionSubject.clientId, field: subscriptionClass });
      }
      for (const document of [foreignLive, foreignExpired]) {
        await bindOrder(mixed, document);
        await selectSubscription({ ...mixed, scopeRef: randomUUID() }, document);
      }
      const failed = await issue(mixed), verified = await issue(mixed);
      await db.query(`UPDATE ${documentTable} SET document_text=document_text||' ' WHERE snapshot_ref=$1`, [failed.binding.snapshotRef]);
      for (const document of [failed, verified]) {
        await bindOrder(mixed, document, {});
        await selectSubscription({ ...mixed, scopeRef: randomUUID() }, document, {});
      }

      const ownErased = await erased(consistent);
      await bindOrder(consistent, ownErased, null);
      await selectSubscription({ ...consistent, scopeRef: randomUUID() }, ownErased, null);
      const checkout = await issue(consistent), checkoutOrder = await bindOrder(consistent, checkout);
      const renewalContext = { ...consistent, scopeRef: randomUUID() }, renewalDocument = await issue(renewalContext);
      await db.query(`DELETE FROM ${selectionTable} WHERE scope_ref=$1`, [renewalContext.scopeRef]);
      await db.query(`UPDATE ${documentTable} SET purpose=NULL,evidence_expires_at=issued_at WHERE snapshot_ref=$1`, [renewalDocument.binding.snapshotRef]);
      await selectSubscription(renewalContext, renewalDocument);
      const renewalOrder = await bindOrder(renewalContext, renewalDocument);
      await db.query(`WITH cycle AS (
        INSERT INTO public.subscription_cycles(subscription_id,scheduled_at)
        SELECT id,next_cycle_at FROM public.subscriptions WHERE id=$1 RETURNING id
      ) UPDATE public.commerce_orders SET subscription_cycle_id=cycle.id FROM cycle WHERE commerce_orders.id=$2`,
      [renewalContext.scopeRef, renewalOrder]);
      const empty = await receiptClient(db);

      const bindRenewal = async () => {
        const fixture = await subject(source);
        const { ctx, ny, pair } = fixture;
        const selected = await edit(db, ctx, ny.selectionRevision);
        expect(selected.outcome).toBe("applied_from_next_parcel");
        const cycle = await bookCycle(db, fixture);
        const order = await ownerTransaction(db, async connection => {
          const prepared = await prepareGraph(connection, fixture, selected, cycle);
          expect(await bind(connection, ctx, prepared.order, selected)).toEqual(selected.binding);
          await insertLocalAttempt(connection, fixture, prepared);
          return prepared.order;
        });
        return { ctx, binding: selected.binding, cycleKey: pair.cycle_key, order };
      };
      const withheldRenewal = await bindRenewal(), crossClientRenewal = await bindRenewal();
      const crossClientOrderOwner = await receiptClient(db);
      expect(await readSnapshot(db, withheldRenewal.ctx, withheldRenewal.binding, withheldRenewal.order, "order"))
        .toMatchObject({ binding: withheldRenewal.binding, documentPurpose: "subscription" });
      await db.query(`UPDATE public.subscription_cycle_tax_bindings
        SET live_evidence=jsonb_set(live_evidence,'{service,adapterRevision}','"different"') WHERE cycle_key=$1`,
      [withheldRenewal.cycleKey]);
      // Model restored ownership drift after the writer has pinned the renewal to its subscription document.
      await db.query("UPDATE public.commerce_orders SET client_id=$1 WHERE id=$2", [crossClientOrderOwner, crossClientRenewal.order]);
      isolated.push({ id: crossClientOrderOwner, field: orderClass });

      const ledger = async (owner: Pool) => (await owner.query("SELECT catalog_path,sha256,position FROM public.platform_schema_migrations ORDER BY position")).rows;
      const prefixLedger = [prefix.qualified.baseline, ...prefix.qualified.forward]
        .map(({ file, sha256 }, position) => ({ catalog_path: file, sha256, position }));
      expect(await ledger(source.owner)).toEqual(prefixLedger);
      expect(await ledger(restored.owner)).toEqual(prefixLedger);
      const packet = await captureStoreJourney(source.owner, "destination-export-source", { catalogueId });
      const freshTarget = await captureStoreJourney(restored.owner, "destination-export-target", { catalogueId });
      expect([packet.compatible.catalogueId, freshTarget.compatible.catalogueId]).toEqual([catalogueId, catalogueId]);
      const repositoryRoot = process.cwd();
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
      try {
        expect(await restoreConnectedNativeStore({ owner: restored.owner, installation: journeySelection, packet, freshTarget }))
          .toMatchObject({ replayed: false, captureSha256: packet.sha256 });
      } finally { cwd.mockRestore(); }
      expect(await ledger(restored.owner)).toEqual(prefixLedger);
      const predecessorTables = tablesForRenewalUpgradeCohort(connectedNativeStoreTables,
        prefix.qualified.forward.some(unit => renewalUpgradeCohort.forward.test(unit.file)));
      const retained = await census(restored.owner, predecessorTables);
      for (const table of [documentTable, orderBindingTable, selections]) {
        const name = table.slice("public.".length);
        expect(retained[name]).toEqual([...packet.owned.find(entry => entry.table === name)!.rows].sort());
      }

      const cases = [
        ...isolated.map(({ id, field }) => ({ id, fields: [field] })),
        { id: mixed.clientId, fields: [orderClass, subscriptionClass] },
        ...[foreign.clientId, consistent.clientId, empty, withheldRenewal.ctx.clientId].map(id => ({ id, fields: [] })),
      ];
      const observe = async () => {
        const reader = await restored.runtime.connect();
        try {
          await reader.query("BEGIN READ ONLY");
          const { rows: [acl] } = await reader.query(`SELECT
            pg_get_function_identity_arguments(p.oid) AS arguments, pg_get_function_result(p.oid) AS result,
            l.lanname AS language, p.provolatile, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
            NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) WHERE grantee=0) AS private,
            ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE has_function_privilege(r.oid,p.oid,'EXECUTE') ORDER BY r.rolname) AS roles,
            session_user AS login, has_function_privilege(p.oid,'EXECUTE') AS allowed
            FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid='public.commerce_destination_v2_export(uuid)'::regprocedure`);
          expect(acl).toMatchObject({ arguments: "p_client_id uuid", result: "jsonb", language: "plpgsql",
            provolatile: "s", prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"],
            private: true, login: journeySelection.runtimeLogin, allowed: true });
          expect(acl.roles.filter((role: string) => ["anon", "authenticated", "service_role"].includes(role))).toEqual(["service_role"]);
          const { rows } = await reader.query<{ id: string; bytes: string }>(`SELECT id, public.commerce_destination_v2_export(id)::text AS bytes
            FROM unnest($1::uuid[]) WITH ORDINALITY AS subjects(id,ordinal) ORDER BY ordinal`, [cases.map(({ id }) => id)]);
          const privacy = transferredPrivacy(restored);
          return { acl, exports: await Promise.all(rows.map(async ({ id, bytes }) => {
            const result = await privacy.export(actor, { kind: "contact", contactId: id });
            const contributor = result.documents.find(document => document.contributorId === "destination-documents")!;
            expect(contributor.data).toEqual(JSON.parse(bytes));
            return { bytes, contributor };
          })) };
        } finally { await reader.query("ROLLBACK"); reader.release(); }
      };
      const before = await observe();
      const [{ contributor: mixedBefore }, { contributor: foreignBefore }, { contributor: consistentBefore }, emptyBefore] = before.exports.slice(isolated.length);
      expect(mixedBefore!.data).toEqual(expect.arrayContaining([
        { snapshotRef: failed.binding.snapshotRef, issuedAt: expect.any(String), evidenceDisposition: "available",
          verification: { status: "failed", code: "destination_digest_mismatch", field: "documentDigest" } },
        expect.objectContaining({ snapshotRef: verified.binding.snapshotRef, document: expect.any(Object), verification: verification(orderClass) }),
      ]));
      expect(foreignBefore).toMatchObject({ coverage: { complete: false }, data: expect.arrayContaining([
        expect.objectContaining({ snapshotRef: foreignLive.binding.snapshotRef, document: expect.any(Object), verification: verification(orderClass) }),
        { snapshotRef: foreignErased.binding.snapshotRef, issuedAt: expect.any(String), evidenceDisposition: "erased" },
      ]) });
      expect(consistentBefore).toMatchObject({ coverage: { complete: true, unavailable: [] }, data: expect.arrayContaining([
        expect.objectContaining({ snapshotRef: checkout.binding.snapshotRef, orderBindings: [{ orderId: checkoutOrder, selection: checkout.selection, service: testServicePin }] }),
        expect.objectContaining({ snapshotRef: renewalDocument.binding.snapshotRef,
          document: expect.any(Object),
          orderBindings: [{ orderId: renewalOrder, selection: renewalDocument.selection, service: testServicePin }],
          subscriptionSelections: [{ subscriptionId: renewalContext.scopeRef, selectionRevision: renewalDocument.selection.selectionRevision, service: testServicePin }] }),
        { snapshotRef: ownErased.binding.snapshotRef, issuedAt: expect.any(String), evidenceDisposition: "erased" },
      ]) });
      expect(emptyBefore).toMatchObject({ bytes: "[]", contributor: { data: [], coverage: { complete: true, unavailable: [] } } });

      const runner = createPostgresMigrationRunner({ connectionString: restored.ownerUrl },
        { root: repositoryRoot, installation: journeySelection, poolFactory: () => restored.owner });
      expect(await runner.apply()).toEqual({ applied: candidate.forward.slice(prefix.qualified.forward.length).map(unit => unit.file) });
      expect((await runner.status()).pending).toEqual([]);
      const after = await observe();
      expect(after.acl).toEqual(before.acl);
      expect(await readSnapshot(restored.runtime, withheldRenewal.ctx, withheldRenewal.binding, withheldRenewal.order, "order"))
        .toMatchObject({ code: "destination_binding_invalid", field: orderClass });
      const withheldExport = JSON.parse(after.exports.at(-1)!.bytes) as { snapshotRef?: string }[];
      const renewalRow = withheldExport.find(row => row.snapshotRef === withheldRenewal.binding.snapshotRef);
      expect(renewalRow).toMatchObject({ document: expect.any(Object), verification: verification(orderClass) });
      expect(renewalRow).not.toHaveProperty(orderClass);
      expect(withheldExport.filter(row => !row.snapshotRef)).toEqual([]);
      for (const [index, { id, fields }] of cases.entries()) {
        const old = before.exports[index]!, next = after.exports[index]!;
        if (id === consistent.clientId) {
          const data = JSON.parse(old.bytes) as { snapshotRef: string; orderBindings?: unknown; verification?: unknown }[];
          const lineageLess = data.find(row => row.snapshotRef === renewalDocument.binding.snapshotRef)!;
          delete lineageLess.orderBindings;
          lineageLess.verification = verification(orderClass);
          expect(next.contributor).toEqual({ ...old.contributor, data,
            coverage: { ...old.contributor.coverage, complete: false, unavailable: [expect.stringContaining("destination owner")] } });
          continue;
        }
        if (!fields.length) { expect(next).toEqual(old); continue; }
        if (index < isolated.length) expect(old).toMatchObject({ bytes: "[]", contributor: { coverage: { complete: true } } });
        expect(next.contributor, `destination markers for order or subscription owner ${id}`).toEqual({ ...old.contributor, data: [...JSON.parse(old.bytes), ...fields.map(marker)],
          coverage: { ...old.contributor.coverage, complete: false, unavailable: [
            "Review withheld destination evidence with the destination owner. After cutoff, run commerce_destination_v2_expire for unbound documents and export again.",
          ] } });
      }
      expect(await census(restored.owner, predecessorTables)).toEqual(retained);
    } finally { await predecessor.close(); }
  });
}, 120_000);
