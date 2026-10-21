import type { HttpRequest } from "@openlup/platform/http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { Pool, TypeOverrides, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { CATALOG_MIGRATIONS, canonicalCatalogDraftJson, createCatalogProductTypeRegistry, createPostgresCatalogSkuEnvelopeReadPort, type BundleStockPort } from "@openlup/platform/catalog";
import { createDbBackedCommerceQuotePort, projectCommerceOfferPricing, type CreateQuoteRequest, type CommerceQuoteCatalogReadPort } from "@openlup/platform/pricing";
import { createPostgresGatewayTypeOverrides } from "@openlup/platform/data";
import { createNewPurchaseStockAvailabilityPort, type NewPurchaseStockReadPort, type NewPurchaseStockRow, type NewPurchaseStockMode, type NewPurchaseStockAvailabilityOptions } from "@openlup/platform/inventory";
import { createPostgresCommercePromoDataPort } from "@openlup/platform/promotions";
import { resolveAdminAuthBinding } from "../../server/runtime/auth/adminAuthBinding.js";
import { createSchemaProbe } from "@openlup/core/readiness";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { createPostgresCommercePriceAuthorityPort } from "../../server/adapters/postgres/pricingResolver.js";
import { createM05CatalogBinding } from "../../server/runtime/public-reference/m05CatalogBinding.js";
import { m05CatalogSchema } from "../../server/runtime/public-reference/m05CatalogSchema.js";
import { resolveAutomaticQuotePromotions } from "../../server/domains/commerce/quoteAutomaticPromotions.js";
import { applyPromotionCodesV2 } from "../../server/domains/commerce/quotePromotionCodeAdjustments.js";
import { createRoutePromotionAcceptanceIssuer } from "../../server/bff/commerce/promotionCodeQuoteComposition.js";
import { deriveOfferAvailability } from "../../src/domains/commerce/offerAvailability.js";
import { createResponse } from "../helpers/catalogRouteResponse.js";
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined, pool: Pool;
const actor = "c7000000-0000-4000-8000-000000000001";
const token = "synthetic-operator-credential-000000000000";
const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
// The complete position-70 prerequisite includes the native operator authority.
const catalogueMigration = "db/platform/migrations/20261019200000_communications_native_operations.sql";
const executor = (db: Pool | PoolClient) => ({ query: (sql: string, values?: readonly unknown[]) => db.query(sql, values ? [...values] : undefined) });
const component = { sku: "P7-UNIT", quantity: 1, is_addon: false, sort_order: 0 };
const compose = async (db: Pool | PoolClient, code: string, quantity: number, key: string) =>
  (await db.query("SELECT public.admin_set_bundle_composition($1,$2,$3,'commit',$4) AS result", [actor, code, JSON.stringify([{ ...component, quantity }]), key])).rows[0].result;
const readComposition = async (code: string) => (await pool.query("SELECT c.quantity FROM public.catalog_bundle_components c JOIN public.catalog_bundles b ON b.id=c.bundle_id WHERE b.code=$1", [code])).rows;
const events = async (key: string) => (await pool.query("SELECT bundle_code,action FROM public.catalog_bundle_write_events WHERE idempotency_key=$1", [key])).rows;

beforeAll(async () => {
  expect(manifest.forward[69].file).toBe(catalogueMigration);
  if (!await dockerAvailable()) throw new Error("M05 composition proof requires real PostgreSQL");
  container = await runPostgresContainer({ name: `m05-p7-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("M05 PostgreSQL unavailable");
  pool = new Pool({ connectionString: container.connectionString });
  await createPostgresMigrationRunner({ connectionString: container.connectionString }, { poolFactory: () => pool }).apply();
  const product = (await pool.query("INSERT INTO public.catalog_products(slug,name) VALUES ('p7-unit','Synthetic unit') RETURNING id")).rows[0].id;
  const sku = (await pool.query("INSERT INTO public.catalog_skus(product_id,sku,title,net_weight_g,status,sellable_standalone,sellable_in_subscription) VALUES ($1,'P7-UNIT','Synthetic unit',100,'active',true,true) RETURNING id", [product])).rows[0].id;
  const revision = (await pool.query("INSERT INTO public.catalog_product_document_revisions(product_id,revision_no,schema_id,document_ref,document_payload,provenance,source_ref,digest) VALUES ($1,1,'synthetic:unit','document:unit','{}','{}','source:unit',$2) RETURNING id", [product, "a".repeat(64)])).rows[0].id;
  await pool.query("UPDATE public.catalog_products SET primary_sku_id=$2,current_document_revision_id=$3 WHERE id=$1", [product, sku, revision]);
  await pool.query("INSERT INTO public.catalog_sku_identifiers(catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,is_primary) VALUES ($1,'synthetic','gtin','00000000000000','unit',1,true)", [sku]);
  const list = (await pool.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES ('Synthetic list','ZZ','XXX') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor) VALUES ($1,$2,'one_time',1000),($1,$2,'subscription',900)", [list, sku]);
  await pool.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES ($1,true)", [actor]);
}, 120_000);
afterAll(async () => { await pool?.end(); await container?.remove(); });

it("native-mounted-bundle-admin-stock-readback", async () => {
  const code = "p7-stock";
  await pool.query("INSERT INTO public.catalog_skus(product_id,sku,title,status,sellable_standalone) SELECT product_id,'P7-SECOND','Synthetic second unit','active',true FROM public.catalog_skus WHERE sku='P7-UNIT'");
  await pool.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor) SELECT p.price_list_id,s.id,'one_time',1000 FROM public.price_entries p CROSS JOIN public.catalog_skus s WHERE p.variant_id=(SELECT id FROM public.catalog_skus WHERE sku='P7-UNIT') AND p.mode='one_time' AND s.sku='P7-SECOND'");
  await pool.query("SELECT public.admin_upsert_bundle_draft($1,$2,'Synthetic stock set','virtual')", [actor, code]);
  await pool.query("SELECT public.admin_set_bundle_composition($1,$2,$3,'commit','p7-stock-composition')", [actor, code, JSON.stringify([
    { ...component, quantity: 2 },
    { sku: "P7-SECOND", quantity: 1, is_addon: false, sort_order: 1 },
  ])]);
  await pool.query("SELECT public.admin_set_bundle_target_price($1,$2,'one_time',3000,'XXX','gross','commit','p7-stock-price')", [actor, code]);
  await pool.query("SELECT public.admin_activate_bundle($1,$2)", [actor, code]);

  // Port-boundary test double only: catalog/composition rows use PostgreSQL;
  // the native NewPurchaseStockReadPort implementation remains M06 P5a work.
  const stockRow = (sku: string, availableForNewPurchases: number): NewPurchaseStockRow => ({
    sku, catalogSkuId: null, source: "local", providerForSale: null, activeHolds: 0, safetyStock: 0,
    available: 40, stale: false, renewalDemand: 40 - availableForNewPurchases, availableForNewPurchases, excludedOrderHolds: 0,
  });
  const injectedRows = new Map<string, NewPurchaseStockRow>([
    ["P7-UNIT", stockRow("P7-UNIT", 12)], ["P7-SECOND", stockRow("P7-SECOND", 4)],
  ]);
  const injectedStockReaderDouble: NewPurchaseStockReadPort = {
    read: vi.fn<NewPurchaseStockReadPort["read"]>(async ({ skus }) => new Map(skus.map(sku => {
      const row = injectedRows.get(sku);
      if (!row) throw new Error(`Unexpected injected stock SKU: ${sku}`);
      return [sku, row];
    }))),
  };
  const mode: NewPurchaseStockMode = "new_purchase";
  const options: NewPurchaseStockAvailabilityOptions = { mode, horizonDays: 7, lowStockThreshold: 2 };
  const observe = { warn: vi.fn() };
  const stock: BundleStockPort = createNewPurchaseStockAvailabilityPort({
    readPort: injectedStockReaderDouble, functionMissingFallback: null, functionMissingError: "synthetic_missing_function",
    defaultLowStockThreshold: 20, defaultHorizonDays: 30, deriveOfferAvailability, observe,
  }, options);
  const auth = resolveAdminAuthBinding({ PLATFORM_BUNDLE: "node-postgres", PLATFORM_OPERATOR_ID: actor, PLATFORM_OPERATOR_TOKEN: token, DATABASE_URL: container!.connectionString });
  if (!auth.binding) throw new Error("native auth unavailable");
  const unused = () => { throw new Error("unselected_callback"); };
  // Match the native gateway's timestamp contract for validated HTTP readback.
  const readPool = new Pool({ connectionString: container!.connectionString, types: createPostgresGatewayTypeOverrides(TypeOverrides) });
  const binding = createM05CatalogBinding({
    executor: executor(readPool), data: { connectionString: container!.connectionString }, auth: auth.binding, stock,
    registry: createCatalogProductTypeRegistry([]), version: JSON.parse(readFileSync("packages/platform/package.json", "utf8")).version,
    catalogue: { version: "complete-catalogue", migration: catalogueMigration },
    quote: unused, offer: unused, applyPromotions: unused, flags: { read: true },
  });
  const readMounted = async (path: string, query: HttpRequest["query"]) => {
    const handler = binding.handlers[path];
    expect(binding.routes[`@openlup/platform/catalog:${path}`]).toBe(handler);
    const req: HttpRequest = Object.assign(new IncomingMessage(new Socket()), {
      method: "GET", query, headers: { authorization: `Bearer ${token}` },
    });
    const res = createResponse();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    return vi.mocked(res.json).mock.calls.at(-1)?.[0];
  };
  try {
    expect(binding.ports["@openlup/platform/catalog:stock"]).toBe(stock.getAvailability);
    for (const remaining of [4, 0]) {
      injectedRows.set("P7-SECOND", stockRow("P7-SECOND", remaining));
      const availability = { sellableNow: remaining, status: remaining === 0 ? "out_of_stock" : "available", limitingSku: "P7-SECOND" };
      expect(await readMounted("/api/bff/admin/commerce/bundles/get", { code, currency: "XXX" })).toMatchObject({
        ok: true, data: { bundle: { code, status: "active", availability: { ...availability, components: [
          { sku: "P7-UNIT", quantity: 2, sellableNow: 12 }, { sku: "P7-SECOND", quantity: 1, sellableNow: remaining },
        ] } } },
      });
      expect(await readMounted("/api/bff/catalog/bundles", {})).toMatchObject({
        ok: true, data: { bundles: [{ code, price: { amountMinor: 3000, currency: "XXX" }, availability }] },
      });
    }
    expect(injectedStockReaderDouble.read).toHaveBeenCalledTimes(4);
    for (let call = 1; call <= 4; call++) expect(injectedStockReaderDouble.read).toHaveBeenNthCalledWith(call, {
      skus: ["P7-UNIT", "P7-SECOND"], horizonDays: 7, excludeOrderId: null,
    });
    expect(observe.warn).not.toHaveBeenCalled();
  } finally { await binding.close(); await readPool.end(); }
}, 30_000);

it("native-bundle-replay-contention-characterization", async () => {
  for (const code of ["P7-A", "P7-B", "P7-C", "P7-D"]) {
    await pool.query("SELECT public.admin_upsert_bundle_draft($1,$2,'Synthetic set','virtual')", [actor, code]);
    await compose(pool, code, 1, `initial-${code}`);
  }
  for (const rollbackFirst of [false, true]) {
    const first = rollbackFirst ? "P7-C" : "P7-A", second = rollbackFirst ? "P7-D" : "P7-B";
    const key = rollbackFirst ? "p7-rollback" : "p7-contention";
    const a = await pool.connect(), b = await pool.connect();
    let pending: Promise<{ result?: unknown; error?: unknown }> | undefined;
    try {
      await a.query("BEGIN"); await b.query("BEGIN");
      await a.query("SET LOCAL statement_timeout='8000ms'"); await b.query("SET LOCAL statement_timeout='8000ms'");
      const aPid = (await a.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const bPid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      expect(aPid).not.toBe(bPid);
      expect(await compose(a, first, 2, key)).toMatchObject({ idempotent: false });
      pending = compose(b, second, 3, key).then(result => ({ result }), error => ({ error }));
      let blocked = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const lock = (await pool.query("SELECT $1::int = ANY(pg_blocking_pids($2)) AS blocked", [aPid, bPid])).rows[0];
        if (lock.blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      // Disjoint entities isolate the global key index, rather than component uniqueness.
      expect(await readComposition(second)).toEqual([{ quantity: 1 }]);
      await a.query(rollbackFirst ? "ROLLBACK" : "COMMIT");
      const outcome = await pending;
      if (rollbackFirst) {
        expect(outcome).toMatchObject({ result: { idempotent: false, componentCount: 1 } });
        await b.query("COMMIT");
        expect(await readComposition(first)).toEqual([{ quantity: 1 }]);
        expect(await readComposition(second)).toEqual([{ quantity: 3 }]);
        expect(await events(key)).toEqual([{ bundle_code: second, action: "bundle_composition_set" }]);
      } else {
        expect(outcome).toMatchObject({ error: { code: "23505", constraint: "uq_catalog_bundle_write_events_key" } });
        await expect(b.query("SELECT 1")).rejects.toMatchObject({ code: "25P02" });
        await b.query("ROLLBACK");
        expect(await readComposition(first)).toEqual([{ quantity: 2 }]);
        expect(await readComposition(second)).toEqual([{ quantity: 1 }]);
        expect(await events(key)).toEqual([{ bundle_code: first, action: "bundle_composition_set" }]);
      }
    } finally {
      await a.query("ROLLBACK");
      if (pending) await pending;
      await b.query("ROLLBACK");
      a.release(); b.release();
    }
  }
  const before = await pool.query("SELECT to_jsonb(t) AS row FROM public.catalog_bundle_write_events t ORDER BY id");
  for (const [code, quantity] of [["P7-A", 9], ["P7-B", 8], ["ABSENT", 0]] as const)
    expect(await compose(pool, code, quantity, "p7-contention")).toEqual({ code, idempotent: true, dryRun: false });
  expect((await pool.query("SELECT public.admin_set_bundle_target_price($1,'ABSENT','one_time',0,'XXX','gross','commit','p7-contention') AS result", [actor])).rows[0].result).toEqual({ code: "ABSENT", idempotent: true, dryRun: false });
  expect((await pool.query("SELECT to_jsonb(t) AS row FROM public.catalog_bundle_write_events t ORDER BY id")).rows).toEqual(before.rows);
  expect(await readComposition("P7-A")).toEqual([{ quantity: 2 }]);
  expect(await readComposition("P7-B")).toEqual([{ quantity: 1 }]);
}, 30_000);

it("native consumer readback preserves quote authority, draft receipts and unsupported continuation", async () => {
  for (const unit of CATALOG_MIGRATIONS) {
    expect(readFileSync(unit.url)).toEqual(readFileSync(unit.catalogPath));
    expect(createHash("sha256").update(readFileSync(unit.url)).digest("hex")).toBe(unit.sha256);
    expect([manifest.baseline, ...manifest.forward][unit.position]).toEqual({ file: unit.catalogPath, sha256: unit.sha256 });
  }
  const transported: unknown[][] = [];
  const db = { query: (sql: string, values?: readonly unknown[]) => { if (sql.includes("catalog_draft_apply")) transported.push([...(values ?? [])]); return executor(pool).query(sql, values); } };
  const catalog = createPostgresCatalogSkuEnvelopeReadPort(db);
  const envelope = await catalog.getSkuEnvelope({ kind: "sku_code", skuCode: "P7-UNIT" });
  expect(envelope).toMatchObject({ sku: { code: "P7-UNIT", netContent: { unscaled: 100, scale: 0, unit: "GRAM" } }, documentRevision: { digest: "a".repeat(64) }, identifiers: [{ normalizedValue: "00000000000000" }] });
  const facts: CommerceQuoteCatalogReadPort = { async listQuoteCatalogItems() {
    const page = await catalog.listActiveSkuEnvelopes({ cursor: null, limit: 10, skuCodes: ["P7-UNIT"] });
    return page.items.map(item => ({ skuId: item.sku.id, skuCode: item.sku.code, variantId: item.sku.id, productSlug: item.product.slug, netWeightG: item.sku.netContent.unscaled,
      isPrimarySku: item.product.primarySkuId === item.sku.id, isAddon: item.sku.isAddon, sellability: item.sku.sellability, documentRevision: item.documentRevision }));
  } };
  const promos = createPostgresCommercePromoDataPort(db);
  const applyPromotions: typeof resolveAutomaticQuotePromotions = input => resolveAutomaticQuotePromotions({ ...input, promoDataPort: promos });
  const tax = { included: true as const, country: "ZZ", category: "standard", vatRateBps: 0, legalBasis: "Synthetic" };
  // Observe DB-defaulted price windows with the fixture's clock for quotes and offers.
  const quoteAt = (await pool.query("SELECT clock_timestamp() AS at")).rows[0].at.toISOString();
  const quote = createDbBackedCommerceQuotePort({ now: () => quoteAt, quoteCatalogReadPort: facts, isStrictD1Quote: true, commercePriceAuthorityPort: createPostgresCommercePriceAuthorityPort(db),
    taxProfile: tax, supportedTaxProfiles: [tax], regionCode: "ZZ", currency: "XXX", hasPromotionCodePort: false,
    resolveAutomaticQuotePromotions: applyPromotions, applyPromotionCodesV2, lineContext: () => ({}), quoteContext: request => () => ({ mode: request.mode, promoCodes: request.promoCodes }),
  });
  const requestFor = (_item: unknown, mode: "one_time" | "subscription"): CreateQuoteRequest => ({ mode, lines: [{ sku: "P7-UNIT", quantity: 2 }], promoCodes: [] });
  const offer = () => projectCommerceOfferPricing({ quoteCatalogReadPort: facts, quoteWithPromotions: quote, quoteWithoutPromotions: quote,
    isOfferProduct: item => item.isPrimarySku === true, requestFor, unitCount: 2, minimumProductPayableMinor: 1, scopeV1: "synthetic", scopeV2: "synthetic" });
  const auth = resolveAdminAuthBinding({ PLATFORM_BUNDLE: "node-postgres", PLATFORM_OPERATOR_ID: actor, PLATFORM_OPERATOR_TOKEN: token, DATABASE_URL: container!.connectionString });
  if (!auth.binding) throw new Error("native auth unavailable");
  // Phase A consumer does not select stock serving. The required injected port refuses every read.
  const stock = { getAvailability: async () => { throw new Error("native_stock_binding_pending"); } };
  const version = JSON.parse(readFileSync("packages/platform/package.json", "utf8")).version;
  const catalogue = { version: "complete-catalogue", migration: catalogueMigration };
  const binding = createM05CatalogBinding({ executor: db, data: { connectionString: container!.connectionString }, auth: auth.binding, stock,
    registry: createCatalogProductTypeRegistry([{ key: "synthetic:unit", version: 1, units: [{ code: "unit:piece", dimension: "count", integral: true }], netContentUnits: ["unit:piece"], dimensions: [], validateContent: () => [] }]),
    version, catalogue, quote: quote.createQuote, offer, applyPromotions,
  });
  try {
    const schema = await createSchemaProbe(db, async () => ({ database: "synthetic", version: catalogue.version })).observe(m05CatalogSchema(catalogue));
    expect(schema.objects.filter(item => item.present !== true)).toEqual([]);
    const request = requestFor(null, "one_time"), priced = await quote.createQuote(request);
    expect(priced.quote.totalGross).toEqual({ amountMinor: 2000, currency: "XXX" });
    const projection = await offer();
    expect(projection.products).toMatchObject([{ productSlug: "p7-unit", oneTime: { unitGross: { amountMinor: 1000, currency: "XXX" } }, subscriptionInitial: { unitGross: { amountMinor: 900 } } }]);
    // No acceptance token is minted; native acquisition acceptance is declared unsupported.
    expect(createRoutePromotionAcceptanceIssuer(null)(request, priced.quote)).toBeNull();
    expect(binding.unsupported).toContain("nativeAcquisitionAcceptance");
    const draftId = "c7000000-0000-4000-8000-000000000002";
    const command = { schemaVersion: 1, action: "create", draftId, commandKey: "p7-create", expectedRevision: 0,
      payload: { schemaVersion: 1, product: { id: envelope!.product.id, type: { key: "synthetic:unit", version: 1 }, dimensions: [] }, skus: [] } };
    const authorized = { headers: { authorization: `Bearer ${token}` } } as HttpRequest, denied = { headers: {} } as HttpRequest;
    expect(await binding.drafts.execute(command, denied)).toMatchObject({ outcome: "unauthorized" });
    const submitted = await binding.drafts.execute(command, authorized);
    expect(submitted).toMatchObject({ outcome: "committed", record: { revision: 1, status: "open", actorId: actor, fingerprint: createHash("sha256").update(canonicalCatalogDraftJson(command)).digest("hex") } });
    if (submitted.outcome !== "committed") throw new Error("draft not committed");
    expect(await binding.drafts.get({ draftId }, authorized)).toEqual({ outcome: "found", record: submitted.record });
    expect(await binding.drafts.execute(command, authorized)).toMatchObject({ outcome: "replayed", record: submitted.record });
    expect(transported).toEqual([[canonicalCatalogDraftJson(command), submitted.record.fingerprint, actor]]);
    expect((await pool.query("SELECT fingerprint,revision FROM public.catalog_draft_command_receipts WHERE draft_id=$1", [draftId])).rows).toEqual([{ fingerprint: submitted.record.fingerprint, revision: 1 }]);
    expect(binding.capabilities).toMatchObject({ publicationRead: false, publish: false, lifecycleWrite: false });
    expect(await binding.drafts.list({ limit: 1 }, authorized)).toMatchObject({ outcome: "listed", page: { items: [{ draftId, status: "open", revision: 1 }] } });
    expect(await binding.drafts.get({ draftId }, denied)).toMatchObject({ outcome: "unauthorized" });
    expect(await binding.catalog.getSkuEnvelope({ kind: "sku_code", skuCode: "P7-UNIT" })).toEqual(envelope);
  } finally { await binding.close(); }
}, 30_000);
