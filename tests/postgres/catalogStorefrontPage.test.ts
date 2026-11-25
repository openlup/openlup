import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  buildCatalogReleaseDraftV3, catalogDefinitionDigest, catalogInternalGtin, createCatalogProductTypeRegistry,
  createPostgresCatalogDraftStoreV4, createPostgresCatalogPublicationCommands, installCatalogDefinitions,
  projectPublishedCatalogOfferPage, readPostgresCatalogStorefrontPage,
  withCatalogPublicationRules, type CatalogDraftPayloadV3, type CatalogDraftPayloadV4, type CatalogHeadRef,
  type CatalogPublishCommand, type CatalogStorefrontPageInput,
} from "@openlup/platform/catalog";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog/contracts";
import { createPostgresRoleFreeTransactionLane, type PgQueryExecutor } from "@openlup/platform/data";
import { createPlatformPostgresMigrationRunner, qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "@openlup/platform/migrations";
import { createCatalogPriceSetupHandler, createPostgresCatalogPriceSetupStore } from "@openlup/platform/pricing";
import { hash, transaction } from "./catalogPublicationFixture.js";
import { composeCatalogueStorefront } from "../../examples/neutral-store/host/catalogue-storefront.js";
import { configurations } from "../../examples/neutral-store/owned/store.config.js";
import { readStarterProducts } from "../../examples/neutral-store/shared/catalogue-products.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined, admin: Pool, runtime: Pool, legacy: Pool;
let runtimeConnectionString: string;
const password = "synthetic-conformance", actor = randomUUID(), list = randomUUID();
const installation: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed",
  migrationLogin: "postgres", bootstrapLogin: "postgres", runtimeLogin: "storefront_runtime", restoreLogin: "storefront_restore" };
const input = { offerVersion: "classic", limit: 100, regionCode: "ZZ", currency: "XXX", channel: "D2C" };
const typeRef = { key: "test:article", version: 1 }, presentation = { title: "Published article" };
const netContent = { dimension: "mass", unit: "openlup:g", scale: 0, unscaled: "100" } as const;
const artifact = Buffer.from(`
  const wire = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : 1)));
  module.exports = {
    validateContent: () => [], validateProduct: () => [], identifyDocument: value => value,
    inspectDocument(text) { return { ...JSON.parse(text), canonicallyEncoded: wire(JSON.parse(text)) === text }; },
    matchesDocument: (value, text) => wire(value) === text,
    deriveSkuFacts: () => ({}), classifySkuChange: () => "compatible",
  };
`);
const fixtureMediaRef = "/media/collection.svg";
const fixtureMediaDigest = () => createHash("sha256").update(readFileSync(`examples/neutral-store/public${fixtureMediaRef}`)).digest("hex");
const registry = createCatalogProductTypeRegistry(withCatalogPublicationRules({ id: "test:rules", namespace: "test",
  version: 1, openlupRange: "1.x", capabilities: {}, taxClasses: [], types: [{
    ...typeRef, units: [{ code: "openlup:g", dimension: "mass", integral: false }], netContentUnits: ["openlup:g"],
    dimensions: [{ key: "finish", kind: "choice", values: ["matte", "gloss"] }],
    axes: [{ key: "finish", attributeKey: "finish" }],
    attributes: [{ key: "finish", scope: "variant", valueType: { kind: "enum", values: [{ id: "matte" }, { id: "gloss" }] },
      required: false, cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} }],
  }] }, () => artifact).types);
const definition = registry.resolve(typeRef)!;
const gtins = [catalogInternalGtin(301), catalogInternalGtin(302)];
const options = (finish: string) => ({ finish: { kind: "choice" as const, value: finish } });
const { release, activation } = buildCatalogReleaseDraftV3({ namespace: "test", type: typeRef, slug: "published-article",
  name: "Published article", presentation, skus: ["matte", "gloss"].map((finish, index) => ({
    code: `ARTICLE-${finish}`, title: `Article ${finish}`, minQuantity: 2, options: options(finish), attributes: { finish },
    primary: index === 0, netContent, grossMass: { ...netContent, unscaled: "120" }, logisticsRef: `test:logistics/${finish}`,
    identifiers: [{ scheme: "gs1:gtin", issuer: "test:internal", value: gtins[index]!, packagingLevel: "unit", isPrimary: true }],
    sell: { oneTime: true, subscription: true },
  })) });
const productId = release.payload.product.id, skuId = release.payload.skus[0]!.id;
const draftId = randomUUID();
let publishedHead: CatalogHeadRef, baseEntry: string;

async function saveAndPublish(draftId: string, payload: CatalogDraftPayloadV3 | CatalogDraftPayloadV4, draftRevision: number,
  expectedHead: CatalogHeadRef | null, changes: CatalogPublishCommand["changes"] = [], typeRegistry = registry) {
  const canonicalCommand = canonicalCatalogDraftJson({ schemaVersion: payload.schemaVersion, action: draftRevision === 1 ? "create" : "revise",
    draftId, commandKey: randomUUID(), expectedRevision: draftRevision - 1, payload });
  expect(await createPostgresCatalogDraftStoreV4(admin).apply({ canonicalCommand, fingerprint: hash(canonicalCommand), actorId: actor }))
    .toMatchObject({ record: { revision: draftRevision } });
  const api = createPostgresCatalogPublicationCommands({
    authorizeHuman: async userId => userId === actor
      ? { ok: true, userId, role: "admin", isMachineActor: false } : { ok: false },
    catalogPublicationOwner: { run: work => transaction(admin, work) }, registry: typeRegistry,
    verifyMedia: async (_db, claim) => claim.mediaRef === fixtureMediaRef && claim.revisionDigest === fixtureMediaDigest(),
  });
  const operator = (await api.authorize(actor))!;
  const candidate = await api.prepareCandidate({ draftId, draftRevision, expectedHead }, operator);
  if (!("candidateRef" in candidate) || !candidate.preparation?.postStateDigest) throw new Error(JSON.stringify(candidate));
  const key = { productId: payload.product.id, candidateRef: candidate.candidateRef, candidateDigest: candidate.candidateDigest };
  expect(await api.execute({ ...key, action: "approve", commandKey: randomUUID(), postStateDigest: candidate.preparation.postStateDigest }, operator))
    .toMatchObject({ outcome: "committed" });
  const result = await api.execute({ ...key, action: "publish", commandKey: randomUUID(), expectedHead, changes }, operator);
  if (result.outcome !== "committed" || !("head" in result.receipt)) throw new Error(JSON.stringify(result));
  return result.receipt.head;
}

async function setBasePrice(variantId: string, unitPriceMinor: number, expected = { entryId: null as string | null, unitPriceMinor: null as number | null }) {
  return transaction(admin, async db => {
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, role: "authenticated" })]);
    const handler = createCatalogPriceSetupHandler({ store: createPostgresCatalogPriceSetupStore(db), authorizeOperator: async () => ({ actorId: actor }) });
    const answer = await handler.apply({ schemaVersion: 1, commandKey: randomUUID(), variantId, priceListId: list,
      mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor, expected }, undefined);
    if (answer.outcome !== "committed") throw new Error(JSON.stringify(answer));
    return answer.receipt.current.entryId;
  });
}

beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-storefront-${process.pid}`, password });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Storefront proof needs PostgreSQL");
  admin = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(installation) });
  for (const role of [installation.runtimeLogin, installation.restoreLogin!])
    await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
  const runner = createPlatformPostgresMigrationRunner({ connectionString: container.connectionString }, { installation, poolFactory: () => admin });
  await runner.apply();
  expect((await runner.status()).pending).toEqual([]);
  const url = new URL(container.connectionString);
  url.username = installation.runtimeLogin;
  runtimeConnectionString = url.toString();
  runtime = new Pool({ connectionString: runtimeConnectionString });
  await admin.query("CREATE DATABASE storefront_legacy TEMPLATE postgres");
  url.pathname = "/storefront_legacy";
  legacy = new Pool({ connectionString: url.toString() });
  const legacyAdmin = new Pool({ connectionString: container.connectionStringFor("storefront_legacy") });
  try {
    await legacyAdmin.query("INSERT INTO public.catalog_products(slug,name,status) VALUES('legacy-item','Legacy item','active')");
    await legacyAdmin.query(`INSERT INTO public.catalog_skus(product_id,sku,title,status,sellable_standalone)
      SELECT id,'LEGACY-ITEM','Legacy item','active',true FROM public.catalog_products WHERE slug='legacy-item'`);
  } finally { await legacyAdmin.end(); }
  await admin.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'storefront-operator@example.invalid')", [actor]);
  await admin.query(`INSERT INTO public.platform_human_memberships
    (principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())`, [actor]);
  await admin.query(`INSERT INTO public.catalog_type_versions(type_key,version,definition,definition_digest,validator_ref)
    VALUES($1,1,'{}',$2,$3)`, [definition.key, catalogDefinitionDigest(definition), definition.validatorRef]);
  await admin.query(`INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ'),('settlement_currency','XXX')
    ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`);
  await admin.query("SELECT public.commerce_capture_offer_policy_v2_legacy_baseline()");
  await addPriceList(list);
  await configureActivationReadiness();
  await admin.query(`INSERT INTO public.subscription_price_policy_revisions
    (id,revision_no,price_list_id,region_code,currency,channel,effective_from,discount_bps,rounding_quantum_minor,rounding_rule,digest)
    SELECT id,1,$1,'ZZ','XXX','D2C',at,1000,10,'FLOOR_TO_QUANTUM',
      public.catalog_price_setup_policy_digest(id,1,$1,'ZZ','XXX','D2C',at,NULL,1000,10,'FLOOR_TO_QUANTUM')
    FROM (SELECT gen_random_uuid() AS id,date_trunc('milliseconds',statement_timestamp()-interval '1 hour') AS at) timing`, [list]);
  const released = await saveAndPublish(draftId, release.payload, 1, null);
  const { rows: [beforeActivation] } = await runtime.query(
    "SELECT public.catalog_offer_memberships_page($1,NULL,24,NULL) AS result", [input.offerVersion],
  );
  expect(beforeActivation?.result).toEqual({ kind: "refusal", reason: "unknown_offer" });
  expect(await read({ ...input, limit: 24 })).toMatchObject({
    outcome: "validation_issue", reason: "catalog_offer_memberships_page_input_invalid", issue: "offer_unpublished",
  });
  for (const sku of release.payload.skus) {
    const entry = await setBasePrice(sku.id, 1000);
    if (sku.id === skuId) baseEntry = entry;
  }
  publishedHead = await saveAndPublish(draftId, activation.payload, 2, released);
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, [admin, runtime, legacy]), postgresTeardownTimeoutMs);

async function configureActivationReadiness() {
  const { rows: [clock] } = await admin.query("SELECT now()-interval '1 hour' AS since");
  const common = {
    status: "active", trigger_type: "automatic", code: null, discount_type: "percentage", applies_to_kind: "order_total",
    valid_from: clock!.since.toISOString(), valid_to: null, redemption_limit_global: null,
    region_availability: [input.regionCode], benefit_lane: "product", benefit_value_minor: null, v2_mirror_of: null,
  };
  for (const promotion of [
    { ...common, id: "test:acquisition", promotion_engine_version: "promotion-engine.v2",
      discount_value: 50, stacking_rule: "exclusive", redemption_limit_per_customer: 1, benefit_kind: "target_percentage",
      benefit_value_bps: 5000, eligibility: { first_subscription_purchase: true },
      applies_to_payload: { cart_mode: "subscription", acquisitionTerms: {
        schemaVersion: "subscription-acquisition.v1", revision: "test:terms-1", delivery2DiscountBps: 3500,
      } } },
    { ...common, id: "test:bundle", promotion_engine_version: "promotion-engine.v1",
      discount_value: 5, stacking_rule: "stackable_with_any", redemption_limit_per_customer: null, benefit_kind: "percentage",
      benefit_value_bps: 500, eligibility: { min_cart_minor: 12000 }, applies_to_payload: { cart_mode: "one_time" } },
  ]) {
    const bytes = JSON.stringify(promotion);
    await admin.query(`INSERT INTO public.commerce_promotion_definitions(promotion_id,definition_fingerprint,definition,active)
      VALUES($1,$2,$3,true)`, [promotion.id, hash(bytes), bytes]);
  }
  await admin.query(`INSERT INTO public.platform_job_controls(job_name,active_driver,enabled,last_status,last_success_at,metadata)
    VALUES('platform-watchdog','worker',true,'success',statement_timestamp(),'{"promotionReady":true}'),
    ('promotion-claim-sweep','worker',true,'success',statement_timestamp(),'{}')
    ON CONFLICT(job_name) DO UPDATE SET enabled=excluded.enabled,last_status=excluded.last_status,
      last_success_at=excluded.last_success_at,metadata=excluded.metadata`);
}

async function addPriceList(id: string) {
  await admin.query(`INSERT INTO public.price_lists(id,name,region_code,currency,valid_from)
    VALUES($1,'Storefront proof','ZZ','XXX',statement_timestamp()-interval '1 hour')`, [id]);
}
const read = (request: CatalogStorefrontPageInput = input, pool = runtime) => readPostgresCatalogStorefrontPage({ run: work => transaction(pool, work) }, request);
const price = (amountMinor: number) => ({ amountMinor, currency: "XXX", amountBasis: "tax_inclusive" });
async function governed(answer = read()) {
  const result = await answer;
  if (!("protocol" in result) || result.protocol !== "governed") throw new Error(JSON.stringify(result));
  return result;
}

it("published_product_is_listed_with_price_and_options", async () => {
  const { products, nextCursor } = await governed();
  expect(nextCursor).toBeNull();
  expect(products).toHaveLength(1);
  const { rows: [sealed] } = await admin.query("SELECT canonical_state::jsonb AS manifest FROM public.catalog_publications WHERE id=$1",
    [publishedHead.publicationId]);
  expect(sealed!.manifest.schemaVersion).toBe(2);
  expect(sealed!.manifest.product).not.toHaveProperty("definitionDigest");
  expect(products[0]).toMatchObject({ productId, slug: "published-article", name: "Published article", typeRef,
    definitionDigest: null, presentation });
  expect(products[0]!.skus).toHaveLength(2);
  const { rows: [identifier] } = await admin.query("SELECT normalized_value FROM public.catalog_sku_identifiers WHERE catalog_sku_id=$1 AND is_primary", [skuId]);
  expect(gtins[0]).toMatch(/^\d{13}$/u);
  expect(identifier!.normalized_value).toBe(`0${gtins[0]}`);
  expect(products[0]!.skus.find(sku => sku.skuId === skuId)).toMatchObject({
    skuCode: "ARTICLE-matte", title: "Article matte", minQuantity: 2, options: options("matte"), attributes: { finish: "matte" },
    skuRevision: sealed!.manifest.skus.find((ref: { skuId: string }) => ref.skuId === skuId), netContent,
    primaryUnitIdentifier: { scheme: "gs1:gtin", issuer: "test:internal", value: gtins[0] },
    sell: { oneTime: true, subscription: true }, price: { oneTime: price(1000), subscription: price(900) },
  });
});

it("price_only_change_appears_on_next_read", async () => {
  const before = await governed();
  const updated = await setBasePrice(skuId, 1500, { entryId: baseEntry, unitPriceMinor: 1000 });
  try {
    const after = await governed();
    const select = (page: typeof before) => page.products[0]!.skus.find(sku => sku.skuId === skuId)!;
    expect(after.headDigest).toBe(before.headDigest);
    expect(select(after).skuRevision).toEqual(select(before).skuRevision);
    expect(select(after).price).toEqual({ oneTime: price(1500), subscription: price(1350) });
  } finally { baseEntry = await setBasePrice(skuId, 1000, { entryId: updated, unitPriceMinor: 1500 }); }
});

it("mode_without_price_is_null_not_refusal", async () => {
  const page = await governed(read({ ...input, channel: "WEB" }));
  expect(page.products[0]!.skus.find(sku => sku.skuId === skuId)).toMatchObject({
    sell: { oneTime: true, subscription: true }, price: { oneTime: price(1000), subscription: null },
  });
});

it("ambiguous_price_list_refuses_dependency_unavailable", async () => {
  const overlapping = randomUUID();
  await addPriceList(overlapping);
  try {
    expect(await read()).toEqual({ outcome: "dependency_unavailable", reason: "active_price_list_ambiguous",
      message: "End the overlapping price lists so exactly one is effective for the requested region and currency." });
  } finally { await admin.query("UPDATE public.price_lists SET valid_to=statement_timestamp() WHERE id=$1", [overlapping]); }
  expect((await governed()).products[0]!.skus.find(sku => sku.skuId === skuId)!.price.oneTime).toEqual(price(1000));
});

it("ignores an expired active-status price list with an infinite start", async () => {
  const expired = randomUUID();
  await admin.query(`INSERT INTO public.price_lists(id,name,region_code,currency,status,valid_from,valid_to)
    VALUES($1,'Expired storefront list','ZZ','XXX','active','-infinity',statement_timestamp()-interval '1 hour')`, [expired]);
  try {
    const page = await governed();
    expect(page.products[0]!.skus.find(sku => sku.skuId === skuId)!.price)
      .toEqual({ oneTime: price(1000), subscription: price(900) });
  } finally { await admin.query("DELETE FROM public.price_lists WHERE id=$1", [expired]); }
});

it("verifies SQL-sealed finite policy timestamps through the default runtime lane", async () => {
  const channel = "WEB_FINITE_POLICY";
  await admin.query(`INSERT INTO public.subscription_price_policy_revisions
    (id,revision_no,price_list_id,region_code,currency,channel,effective_from,effective_to,
      discount_bps,rounding_quantum_minor,rounding_rule,digest)
    SELECT id,1,$1,'ZZ','XXX',$2,starts,ends,1250,10,'FLOOR_TO_QUANTUM',
      public.catalog_price_setup_policy_digest(id,1,$1,'ZZ','XXX',$2,starts,ends,1250,10,'FLOOR_TO_QUANTUM')
    FROM (SELECT gen_random_uuid() AS id,
      date_trunc('second',statement_timestamp())-interval '1 hour'+interval '123 milliseconds' AS starts,
      date_trunc('second',statement_timestamp())+interval '1 hour'+interval '456 milliseconds' AS ends) timing`, [list, channel]);
  const lane = createPostgresRoleFreeTransactionLane<PgQueryExecutor>({ connectionString: runtimeConnectionString });
  try {
    const page = await governed(readPostgresCatalogStorefrontPage(lane, { ...input, channel }));
    expect(page.products[0]!.skus.find(sku => sku.skuId === skuId)!.price)
      .toEqual({ oneTime: price(1000), subscription: price(870) });
  } finally { await lane.close(); }
});

it("refuses a zero gross base for a subscription-only legacy price and recovers after repair", async () => {
  const offerVersion = "test:subscription-only";
  const { release, activation } = buildCatalogReleaseDraftV3({ namespace: "test", type: typeRef, slug: "subscription-article",
    name: "Subscription article", presentation: { title: "Subscription article" }, skus: [{
      code: "SUBSCRIPTION-ARTICLE", title: "Subscription article", options: options("matte"), attributes: { finish: "matte" },
      netContent, grossMass: { ...netContent, unscaled: "120" }, logisticsRef: "test:logistics/subscription-article",
      identifiers: [{ scheme: "gs1:gtin", issuer: "test:internal", value: catalogInternalGtin(304),
        packagingLevel: "unit", isPrimary: true }],
      sell: { oneTime: false, subscription: true }, offerVersions: [offerVersion],
    }] });
  const subscriptionDraft = randomUUID(), variantId = release.payload.skus[0]!.id;
  const released = await saveAndPublish(subscriptionDraft, release.payload, 1, null);
  const base = await setBasePrice(variantId, 1000);
  await saveAndPublish(subscriptionDraft, activation.payload, 2, released);

  const legacyEntry = randomUUID(), request = { ...input, offerVersion, channel: "WEB_SUBSCRIPTION_ONLY" };
  try {
    await transaction(admin, async db => {
      await db.query(`INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,min_qty,amount_kind,unit_price_minor,valid_from)
        VALUES($1,$2,$3,'subscription',1,'gross',850,statement_timestamp()-interval '1 hour')`, [legacyEntry, list, variantId]);
      await db.query("UPDATE public.price_entries SET unit_price_minor=0 WHERE id=$1", [base]);
    });
    expect(await read(request)).toEqual({ outcome: "dependency_unavailable", reason: "price_shape_invalid",
      message: "Set a positive gross one-time base price within the supported range. If the subscription amount is invalid, correct its effective price entry or policy." });
    await admin.query("UPDATE public.price_entries SET unit_price_minor=1000 WHERE id=$1", [base]);
    const page = await governed(read(request));
    expect(page.products[0]?.skus).toMatchObject([{ skuId: variantId, sell: { oneTime: false, subscription: true },
      price: { oneTime: null, subscription: price(850) } }]);
  } finally {
    await transaction(admin, async db => {
      await db.query("UPDATE public.price_entries SET unit_price_minor=1000 WHERE id=$1 AND unit_price_minor=0", [base]);
      await db.query("DELETE FROM public.price_entries WHERE id=$1", [legacyEntry]);
    });
  }
});

it("reports a projection deadlock as retryable and succeeds in a new transaction", async () => {
  const result = await readPostgresCatalogStorefrontPage({ run: work => transaction(runtime,
    client => work({ async query(sql, args) {
      if (sql.includes("FROM public.catalog_skus s JOIN public.catalog_products"))
        throw Object.assign(new Error("Synthetic projection deadlock"), { code: "40P01" });
      return client.query(sql, args);
    } })) }, input);
  expect(result).toEqual({ outcome: "conflict", reason: "catalog_publication_transaction_conflict", retryable: true,
    message: "Retry the page in a new transaction after the concurrent operation finishes." });
  expect((await governed()).products).toHaveLength(1);
});

it("pages by SKU and rejects out-of-domain input or a cursor for another offer", async () => {
  const first = await governed(read({ ...input, limit: 1 }));
  expect(first.products[0]!.skus).toHaveLength(1);
  expect(first.nextCursor).toEqual({ skuId: first.products[0]!.skus[0]!.skuId, headDigest: first.headDigest, offerVersion: input.offerVersion, mode: null });
  const second = await governed(read({ ...input, limit: 1, cursor: first.nextCursor! }));
  expect(second.products[0]!.skus).toHaveLength(1);
  expect(second.products[0]!.skus[0]!.skuId).not.toBe(first.nextCursor!.skuId);
  expect(second.nextCursor).toBeNull();
  for (const overrides of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "1" },
    { offerVersion: "unknown" }, { offerVersion: "bad\u0000" }, { offerVersion: "\uD800" }, { regionCode: "zz" },
    { currency: "XX" }, { channel: "invalid channel" }, { cursor: { ...first.nextCursor, offerVersion: "other" } },
    { cursor: { ...first.nextCursor, skuId: "bad" } }, { cursor: { ...first.nextCursor, mode: "one_time" } }]) {
    expect(await read({ ...input, ...overrides } as CatalogStorefrontPageInput)).toMatchObject({
      outcome: "validation_issue", reason: "catalog_offer_memberships_page_input_invalid",
    });
  }
});

it("runtime_login_reads_without_new_grants", async () => {
  const calls: string[] = [];
  const answer = readPostgresCatalogStorefrontPage({ run: work => transaction(runtime, async client => {
    const executor: PgQueryExecutor = { query: async (sql, values) => {
      calls.push(sql);
      if (calls.length === 2) {
        const { rows: [who] } = await client.query(`SELECT current_user,session_user,rolsuper,rolbypassrls,
          current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only
          FROM pg_roles WHERE rolname=current_user`);
        expect(who).toEqual({ current_user: installation.runtimeLogin, session_user: installation.runtimeLogin,
          rolsuper: false, rolbypassrls: false, isolation: "repeatable read", read_only: "on" });
        for (const name of ["catalog_products", "catalog_skus", "catalog_sku_identifiers",
          "price_lists", "price_entries", "subscription_price_policy_revisions"])
          expect((await client.query("SELECT has_table_privilege($1,'SELECT') AS allowed", [`public.${name}`])).rows).toEqual([{ allowed: true }]);
        expect((await client.query("SELECT has_function_privilege('public.catalog_offer_memberships_page(text,jsonb,integer,text)','EXECUTE') AS allowed"))
          .rows).toEqual([{ allowed: true }]);
      }
      return client.query(sql, values);
    } };
    return work(executor);
  }) }, input);
  expect((await governed(answer)).products).toHaveLength(1);
  expect(calls.filter(sql => sql.includes("catalog_offer_memberships_page"))).toHaveLength(1);
  expect(calls.filter(sql => sql.includes("catalog_skus"))).toHaveLength(1);
  expect(calls.filter(sql => /(?:clock|statement|transaction)_timestamp\(/u.test(sql))).toHaveLength(1);
});

it("legacy_store_returns_protocol_legacy_empty", async () => {
  expect(await read(input, legacy)).toEqual({ protocol: "legacy", products: [], nextCursor: null });
});


it("legacy_subscription_basis_and_policy_history_are_preserved", async () => {
  const legacyEntry = randomUUID();
  await admin.query(`INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,min_qty,amount_kind,unit_price_minor,valid_from)
    VALUES($1,$2,$3,'subscription',1,'net',850,statement_timestamp()-interval '1 hour')`, [legacyEntry, list, skuId]);
  const request = { ...input, channel: "WEB_HISTORY" };
  const prices = async () => (await governed(read(request))).products[0]!.skus.find(sku => sku.skuId === skuId)!.price;
  try {
    expect(await prices()).toEqual({ oneTime: price(1000), subscription: { ...price(850), amountBasis: "tax_exclusive" } });
    await admin.query(`INSERT INTO public.subscription_price_policy_revisions
      (id,revision_no,price_list_id,region_code,currency,channel,effective_from,discount_bps,rounding_quantum_minor,rounding_rule,digest)
      SELECT id,1,$1,'ZZ','XXX',$2,at,1000,10,'FLOOR_TO_QUANTUM',
        public.catalog_price_setup_policy_digest(id,1,$1,'ZZ','XXX',$2,at,NULL,1000,10,'FLOOR_TO_QUANTUM')
      FROM (SELECT gen_random_uuid() AS id,date_trunc('milliseconds',statement_timestamp()+interval '1 hour') AS at) timing`, [list, request.channel]);
    expect(await prices()).toEqual({ oneTime: price(1000), subscription: null });
  } finally { await admin.query("DELETE FROM public.price_entries WHERE id=$1", [legacyEntry]); }
});

it("invalid_amount_refuses_and_the_replacement_price_recovers", async () => {
  await admin.query("UPDATE public.price_entries SET unit_price_minor=0 WHERE id=$1", [baseEntry]);
  try {
    expect(await read()).toEqual({ outcome: "dependency_unavailable", reason: "price_shape_invalid",
      message: "Set a positive gross one-time base price within the supported range. If the subscription amount is invalid, correct its effective price entry or policy." });
  } finally { baseEntry = await setBasePrice(skuId, 1000, { entryId: baseEntry, unitPriceMinor: 0 }); }
  expect((await governed()).products[0]!.skus.find(sku => sku.skuId === skuId)!.price.oneTime).toEqual(price(1000));
});

it("an_infrastructure_refusal_keeps_its_cause_private", async () => {
  const cause = new Error("synthetic PostgreSQL connection failure");
  const result = await readPostgresCatalogStorefrontPage({ run: work => transaction(runtime,
    client => work({ async query(sql, args) {
      if (sql.includes("catalog_offer_memberships_page")) throw cause;
      return client.query(sql, args);
    } })) }, input);
  expect(result).toEqual({ outcome: "dependency_unavailable", reason: "publication_authority_unavailable",
    message: "Check the PostgreSQL connection and TLS settings, verify the runtime login and its installed grants, and finish applying the platform migrations. Then read again." });
  expect(Object.getOwnPropertyDescriptor(result, "cause")).toMatchObject({ value: cause, enumerable: false });
  expect((await governed()).products).toHaveLength(1);
});

it("projection_drift_refuses_until_a_compensation_is_published", async () => {
  await transaction(admin, async db => {
    await db.query("UPDATE public.catalog_products SET name='Unpublished name' WHERE id=$1", [productId]);
    await db.query("UPDATE public.catalog_skus SET title='Unpublished title' WHERE id=$1", [skuId]);
  });
  expect(await read()).toEqual({ outcome: "dependency_unavailable", reason: "catalog_publication_live_drift",
    message: "Prepare a compensation revision against the current head, approve it with a fresh key, and publish it." });
  const compensation = structuredClone(activation.payload);
  compensation.publication = { kind: "compensation", evidence: {}, operations: [
    { op: "set_product_presentation", productSlug: "published-article", presentation },
  ] };
  publishedHead = await saveAndPublish(draftId, compensation, 3, publishedHead);
  const page = await governed();
  expect(page.products[0]).toMatchObject({ name: "Published article", definitionDigest: null,
    skus: expect.arrayContaining([expect.objectContaining({ skuId, title: "Article matte" })]) });
});

it("governed_product_reports_its_sealed_definition_digest", async () => {
  const before = await governed(read({ ...input, limit: 1 }));
  const id = randomUUID(), variantId = randomUUID(), revisionId = randomUUID(), governedDraftId = randomUUID();
  const productSlug = "governed-article", skuCode = "GOVERNED-ARTICLE", offerVersion = "test:governed";
  const document = { schemaId: "test:product@1", documentRef: "test:product/governed-article",
    productSlug, revisionNo: 1, name: presentation.title };
  const canonicalText = canonicalCatalogDraftJson(document), digest = hash(canonicalText);
  const sourceRef = "test:catalogue-products";
  const facts = { skuCode, title: presentation.title, minQuantity: 1, isAddon: false, facts: {} };
  const identifier = { scheme: "gs1:gtin", issuer: "test:internal", value: catalogInternalGtin(303),
    packagingLevel: "unit" as const };
  const payload: CatalogDraftPayloadV4 = {
    schemaVersion: 4,
    product: { id, slug: productSlug, type: typeRef, dimensions: ["finish"], primarySkuId: variantId,
      documentRevision: { id: revisionId, productId: id, revisionNo: 1, schemaId: document.schemaId,
        documentRef: document.documentRef, sourceRef, digest },
      sharedContent: { schemaVersion: 1, catalogAction: "create", document, presentation,
        requestedModes: [], offerMemberships: [], publicationSkus: [facts] } },
    skus: [{ id: variantId, productId: id, code: skuCode, options: options("matte"), netContent,
      grossMass: { ...netContent, unscaled: "120" }, identifiers: [identifier] }],
    publication: { kind: "release", evidence: {}, operations: [
      { op: "create_product", productId: id, productSlug, name: document.name },
      { op: "register_document_revision", productSlug, revisionId, revisionNo: 1, documentRef: document.documentRef,
        sourceRef, canonicalText, digest, provenance: { source: "current_draft" } },
      { op: "move_document_pointer", productSlug, documentRevisionNo: 1 },
      { op: "create_sku", productSlug, skuId: variantId, documentRevisionNo: 1, ...facts },
      { op: "create_identifier", skuCode, ...identifier, quantity: 1, isPrimary: true, label: null, sourceRef: null },
      { op: "set_primary_sku", productSlug, skuCode },
      { op: "set_product_presentation", productSlug, presentation },
    ] },
  };
  const first = await saveAndPublish(governedDraftId, payload, 1, null);
  await setBasePrice(variantId, 1000);
  const membership = { skuCode, offerVersion, admitted: true };
  const logisticsRef = "test:logistics/governed";
  payload.product.sharedContent = { ...payload.product.sharedContent, catalogAction: "revise",
    requestedModes: [{ skuCode, modes: ["one_time"] }], offerMemberships: [membership] };
  payload.skus[0]!.logisticsRef = logisticsRef;
  payload.publication.operations = [
    { op: "set_product_lifecycle", productSlug, expectedState: "draft", state: "active", children: [] },
    { op: "set_sku_lifecycle", skuCode, expectedState: "draft", state: "active" },
    { op: "set_sku_metadata", skuCode, logisticsRef },
    { op: "set_eligibility", skuCode, sellableStandalone: true, sellableInSubscription: false },
    { op: "set_offer_membership", ...membership },
  ];
  const active = await saveAndPublish(governedDraftId, payload, 2, first, [{ variantId, expectedRevision: 1, state: "active" }]);
  const { rows: [sealed] } = await admin.query("SELECT canonical_state::jsonb AS manifest FROM public.catalog_publications WHERE id=$1",
    [active.publicationId]);
  expect(sealed!.manifest).toMatchObject({ schemaVersion: 3,
    product: { lifecycleState: "active", definitionDigest: catalogDefinitionDigest(definition) } });
  const page = await governed(read({ ...input, offerVersion }));
  expect(page.products).toHaveLength(1);
  expect(page.products[0]).toMatchObject({ productId: id, typeRef, definitionDigest: sealed!.manifest.product.definitionDigest,
    skus: [{ skuId: variantId, sell: { oneTime: true, subscription: false }, price: { oneTime: price(1000), subscription: null } }] });
  expect(await read({ ...input, limit: 1, cursor: before.nextCursor! })).toEqual({
    outcome: "conflict", reason: "catalog_publication_head_moved", retryable: true, message: "Read again from the first page.",
  });
  expect((await governed()).headDigest).toBe(page.headDigest);
});

it("installed_storefront_follows_the_twenty_fifth_sibling_and_projects_certified_attributes", async () => {
  const config = structuredClone(configurations.coffee!);
  config.market.currency = input.currency;
  const values = Array.from({ length: 25 }, (_, index) => `finish-${index + 1}`);
  const type = { key: typeRef.key, version: 2 }, offer = "test:occupied", slug = "occupied-article";
  const publicFinish = definition.attributes![0]!;
  const pack = withCatalogPublicationRules({ id: "test:storefront-proof", version: 1, namespace: "test", openlupRange: "1.x",
    capabilities: {}, taxClasses: [], types: [{
      ...definition, ...type, dimensions: [{ key: "finish", kind: "choice", values }],
      attributes: [
        { ...publicFinish, valueType: { kind: "enum", values: values.map(id => ({ id })) } },
        { ...publicFinish, key: "private_sample", scope: "product", public: false, valueType: { kind: "text", maxLength: 40 } },
      ],
    }],
  }, () => artifact);
  const installed = await transaction(admin, db => installCatalogDefinitions(db, pack));
  const typeRegistry = createCatalogProductTypeRegistry(pack.types), installedType = typeRegistry.resolve(type)!;
  const receipt = { type: installedType, digest: installed.types[0]!.definitionDigest };
  const guide = readFileSync("packages/core/docs/guide/how-to/build/customize-the-starter.md", "utf8");
  const example = /## Show published products in the starter[\s\S]*?```json\n([\s\S]*?)\n```/u.exec(guide);
  expect(example?.[1]).toBeDefined();
  const display = JSON.parse(example![1]!);
  const { release, activation } = buildCatalogReleaseDraftV3({
    namespace: "test", type, slug, name: "Occupied fixture", attributes: { private_sample: "fixture-only" },
    presentation: display,
    skus: values.map((value, index) => ({
      code: `OCCUPIED-${index + 1}`, title: value, minQuantity: 1, primary: index === 0, options: options(value),
      attributes: { finish: value }, netContent, grossMass: { ...netContent, unscaled: "120" },
      identifiers: [{ scheme: "gs1:gtin", issuer: "test:internal", value: catalogInternalGtin(400 + index), packagingLevel: "unit" }],
      sell: { oneTime: true, subscription: false }, offerVersions: [offer], logisticsRef: `test:logistics/${value}`,
    })),
  });
  const key = randomUUID(), head = await saveAndPublish(key, release.payload, 1, null, [], typeRegistry);
  activation.payload.publication.evidence.media = activation.payload.skus.map(sku => ({
    skuCode: sku.code!, mediaRef: fixtureMediaRef, assetRefs: [], revisionDigest: fixtureMediaDigest(),
  }));
  const ordered = release.payload.skus.map((sku, index) => ({ id: sku.id, skuCode: sku.code!, value: values[index]!, amount: 2300 + index }))
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
  for (const row of ordered) await setBasePrice(row.id, row.amount);
  const active = await saveAndPublish(key, activation.payload, 2, head, [], typeRegistry);

  const request = { ...input, offerVersion: offer, limit: 24 };
  const first = await governed(read(request));
  expect(first.products[0]!.skus.map(sku => sku.skuId)).toEqual(ordered.slice(0, 24).map(row => row.id));
  expect(first.nextCursor?.skuId).toBe(ordered[23]!.id);
  const next = await governed(read({ ...request, cursor: first.nextCursor }));
  const wanted = ordered[24]!;
  expect(next.nextCursor).toBeNull();
  expect(next.products[0]!.skus).toMatchObject([{ skuId: wanted.id, skuCode: wanted.skuCode, price: { oneTime: price(wanted.amount) } }]);
  const finalPage = projectPublishedCatalogOfferPage(next, [receipt]);
  expect(finalPage.products[0]).toMatchObject({ attributes: {}, skus: [{ attributes: { finish: wanted.value } }] });
  expect(readStarterProducts(finalPage, config).products[0]).toMatchObject({ sku: wanted.skuCode, unitPrice: { amountMinor: wanted.amount },
    name: { en: "Article with image", pl: "Published article" }, media: "/media/collection.svg" });
  const lane = createPostgresRoleFreeTransactionLane<PgQueryExecutor>({ connectionString: runtimeConnectionString }, { pool: runtime });
  let fault: "presentation" | "price" | undefined;
  const mounted = composeCatalogueStorefront(lane, async (db, query) => {
    const result = await readPostgresCatalogStorefrontPage(db, { ...query, offerVersion: offer });
    if (!fault || !query.cursor || !("protocol" in result) || result.protocol !== "governed") return result;
    const product = result.products[0]!, row = product.skus[0]!;
    return { ...result, products: [fault === "presentation" ? { ...product, presentation: null }
      : { ...product, skus: [{ ...row, price: { oneTime: null, subscription: null } }] }] };
  });
  const find = async () => {
    const listed = await mounted.resolveCatalogue(config);
    expect(listed.ok).toBe(true);
    return listed.ok ? listed.value.products.find(item => item.sku === wanted.skuCode) : undefined;
  };
  const finding = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const [kind, code] of [["presentation", "starter_catalogue_presentation_invalid"], ["price", "starter_catalogue_price_missing"]] as const) {
      fault = kind;
      expect(await find()).toBeUndefined();
      expect(JSON.parse(finding.mock.lastCall![0])).toMatchObject({ code, subject: wanted.skuCode,
        observed: expect.any(String), cause: expect.any(String), fix: expect.any(String), recheck: expect.any(String) });
      fault = undefined;
      expect(await find()).toMatchObject({ sku: wanted.skuCode, unitPrice: { amountMinor: wanted.amount } });
    }
  } finally { finding.mockRestore(); }

  const copyRevision = structuredClone(activation.payload);
  const updatedCopy = { ...display, shortName: { en: "Article with revised copy" } };
  copyRevision.product.sharedContent.presentation = updatedCopy;
  copyRevision.publication = { kind: "release", evidence: {}, operations: [
    { op: "set_product_presentation", productSlug: slug, presentation: updatedCopy },
  ] };
  const copied = await saveAndPublish(key, copyRevision, 3, active, [], typeRegistry);
  expect(copied.revision).toBe(3);
  expect(copied.documentDigest).toBe(active.documentDigest);
  expect(await find()).toMatchObject({ sku: wanted.skuCode, name: { en: "Article with revised copy" }, unitPrice: { amountMinor: wanted.amount } });
});
