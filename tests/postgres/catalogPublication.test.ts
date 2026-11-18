import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCatalogCandidateService, createPostgresCatalogPublication, createCatalogProductTypeRegistry, catalogDefinitionDigest, installCatalogDefinitions,
  type CatalogPublicationDependencies } from "@openlup/platform/catalog";
import { canonicalCatalogDraftJson, type CatalogDraftPayloadV3, type CatalogPublishCommand, type CatalogHeadRef } from "@openlup/platform/catalog/contracts";
import type { CatalogRetainedSourceBinding } from "@openlup/platform/catalog/contracts";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { setFixtureCatalogDocument } from "../helpers/storeJourney.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

const containers: PostgresContainer[] = [], pools: Pool[] = [];
let db: Pool;
let priceDb: Pool;
const priceList = randomUUID(), anchorSku = randomUUID();
const admin = randomUUID();
const definition = { key: "example:article", version: 1, units: [{ code: "openlup:g", dimension: "mass" as const, integral: false, factor: { canonicalUnit: "openlup:g" as const, unscaled: "1", scale: 0 } }],
  netContentUnits: ["openlup:g"], dimensions: [{ key: "pack_size", kind: "quantity" as const, dimension: "mass" as const, units: ["openlup:g"] }, { key: "axis_flag", kind: "boolean" as const }], axes: [{ key: "pack_size", attributeKey: "pack_size" }, { key: "axis_flag", attributeKey: "axis_flag" }], attributes: [{ key: "pack_size", scope: "variant" as const, valueType: { kind: "quantity" as const, dimension: "mass" as const, units: ["openlup:g"] }, required: false, cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} }, { key: "details", scope: "variant" as const,
    valueType: { kind: "list" as const, item: { kind: "text" as const, maxLength: 1900 }, min: 0, max: 300 }, required: false,
    cardinality: { min: 0, max: 300 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} },
    { key: "reference", scope: "variant" as const, valueType: { kind: "reference" as const, allowlist: ["example:asset"] }, required: false,
      cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} },
    { key: "product_flag", scope: "product" as const, valueType: { kind: "boolean" as const }, required: false, cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} },
    { key: "axis_flag", scope: "variant" as const, valueType: { kind: "boolean" as const }, required: false, cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} }],
  validatorRef: `sha256:${"a".repeat(64)}`, validateContent: () => [] };
const registry = createCatalogProductTypeRegistry([definition]);
let authority: ReturnType<typeof createPostgresCatalogPublication<null>>;
let actor: NonNullable<Awaited<ReturnType<typeof authority.authorize>>>;
let paged: { data: Awaited<ReturnType<typeof draft>>; head: CatalogHeadRef };
let foreignPublished: { data: Awaited<ReturnType<typeof draft>>; head: CatalogHeadRef };
function dependencies(afterQuery?: (sql: string, executor: PgQueryExecutor, rows: Record<string, unknown>[], values?: unknown[]) => void | Promise<void>): CatalogPublicationDependencies<null> {
  return { registry, transactions: { async run(work) { const client = await db.connect();
    try { await client.query("BEGIN"); await client.query(`SET LOCAL request.jwt.claims = '${JSON.stringify({ sub: admin, role: "authenticated" })}'`); const result = await work({ async query(sql, values) { const result = await client.query(sql, values); await afterQuery?.(sql, client, result.rows, values); return result; } }); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } } },
    authorizeHuman: async () => ({ ok: true, userId: admin, role: "admin", isMachineActor: false }),
    rules: { canonicalizeDocument: canonicalCatalogDraftJson, identifyDocument(document) {
      const { schemaVersion, id, productSlug, revisionNo } = document as { schemaVersion: number; id: string; productSlug: string; revisionNo: number };
      return { schemaId: `example:document.v${schemaVersion}`, documentRef: id, productSlug, revisionNo };
    }, deriveSkuFacts: (document) => ({ derived: (document as { derived: number }).derived }),
      validateProduct: () => [], classifySkuChange: (before, after, context) => {
        if (!context.beforeDocument) return "inconclusive";
        if (canonicalCatalogDraftJson(before.netContent) !== canonicalCatalogDraftJson(after.netContent)
          || canonicalCatalogDraftJson(before.options) !== canonicalCatalogDraftJson(after.options)
          || canonicalCatalogDraftJson(before.attributes) !== canonicalCatalogDraftJson(after.attributes))
          return Array.isArray(after.attributes.details) && after.attributes.details.includes("unknown") ? "inconclusive" : "material";
        return "compatible";
      } },
    presentationReadiness: async () => ({ ready: true, reasons: [] }),
    readiness: async () => ({ ready: true, reasons: [] }), verifyMedia: async () => false };
}
beforeAll(async () => {
  // Keep background maintenance out of the disposable fixtures' NOWAIT schedules.
  const command = ["postgres", "-c", "autovacuum=off"];
  const container = await runPostgresContainer({ name: `catalog-publication-${process.pid}`, password: "synthetic-catalog-publication", command });
  containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Publication witnesses require real PostgreSQL");
  db = new Pool({ connectionString: container.connectionString }); pools.push(db);
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  for (const unit of [manifest.baseline, ...manifest.forward]) {
    if (unit.file === "db/platform/migrations/20261123150000_catalog_publication.sql") break;
    await db.query(readFileSync(unit.file, "utf8"));
  }
  await db.query(readFileSync("db/platform/migrations/20261123150000_catalog_publication.sql", "utf8"));
  await installCatalogDefinitions(db, { id: "example:publication", namespace: "example", version: 1, openlupRange: "0.44.x", capabilities: { publish: false }, types: [definition], taxClasses: [] });
  await db.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'publication@example.invalid')", [admin]);
  await db.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())", [admin]);
  authority = createPostgresCatalogPublication(dependencies()); actor = (await authority.authorize(null))!;
  const data = await draft(); let receipt = await commit(data.publication);
  for (let revision = 1; revision <= 1; revision++) receipt = await commit(await incrementalSku(data, receipt.head, revision));
  paged = { data, head: receipt.head };
  const other = await draft(), otherReceipt = await commit(other.publication); foreignPublished = { data: other, head: otherReceipt.head };
  const priceContainer = await runPostgresContainer({ name: `catalog-publication-prices-${process.pid}`, password: "synthetic-catalog-publication", command });
  containers.push(priceContainer);
  if (!await waitForPostgresTcpReady(priceContainer.connectionString)) throw new Error("Price publication witnesses require real PostgreSQL");
  priceDb = new Pool({ connectionString: priceContainer.connectionString }); pools.push(priceDb);
  for (const unit of [manifest.baseline, ...manifest.forward]) await priceDb.query(readFileSync(unit.file, "utf8"));
  await installCatalogDefinitions(priceDb, { id: "example:publication", namespace: "example", version: 1, openlupRange: "0.44.x", capabilities: { publish: false }, types: [definition], taxClasses: [] });
  await priceDb.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'publication-prices@example.invalid')", [admin]);
  await priceDb.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())", [admin]);
  await seedRealReadiness();
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(containers, pools), postgresTeardownTimeoutMs);
let serial = 0;
function nextGtin() {
  const body = String(590123400000 + ++serial);
  const total = [...body].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 ? 3 : 1), 0);
  return `${body}${(10 - total % 10) % 10}`;
}
async function save(payload: CatalogDraftPayloadV3, draftId: string, expectedRevision = 0, head: CatalogHeadRef | null = null) {
  const command = { schemaVersion: 3, action: expectedRevision === 0 ? "create" : "revise", draftId, commandKey: `draft:${expectedRevision + 1}`, expectedRevision, payload }, text = canonicalCatalogDraftJson(command);
  const stored = (await db.query("SELECT public.catalog_draft_apply($1,$2,'operator:synthetic') AS result", [text, createHash("sha256").update(text).digest("hex")])).rows[0].result;
  expect(stored.outcome, JSON.stringify(stored)).toBe("committed");
  const candidateRef = `v1:${draftId}@${expectedRevision + 1}/${head ? `${head.publicationId}@${head.revision}` : "unpublished"}`;
  const candidateDigest = createHash("sha256").update('["catalog-candidate",1,').update(canonicalCatalogDraftJson(payload)).update(",")
    .update(canonicalCatalogDraftJson([{ ...payload.product.type, definitionDigest: catalogDefinitionDigest(definition) }])).update(",").update(canonicalCatalogDraftJson(head)).update("]").digest("hex");
  return { commandKey: `publish:${expectedRevision + 1}`, productId: payload.product.id, candidateRef, candidateDigest, expectedHead: head, changes: [] } satisfies CatalogPublishCommand;
}
function approvalCommand(publication: CatalogPublishCommand, commandKey = `approve:${publication.commandKey}`) {
  return { schemaVersion: 2 as const, action: "approve" as const, productId: publication.productId, commandKey,
    candidateRef: publication.candidateRef, candidateDigest: publication.candidateDigest, reason: "Verified exact candidate" };
}
async function approve(publication: CatalogPublishCommand, target = authority, capability = actor, commandKey = `approve:${publication.commandKey}`) {
  const decision = approvalCommand(publication, commandKey);
  const result = await target.decision(decision, capability); expect(result.outcome, JSON.stringify(result)).toBe("committed"); return decision;
}
async function commit(publication: CatalogPublishCommand, target = authority, capability = actor) {
  await approve(publication, target, capability);
  const result = await target.publish(publication, capability);
  expect(result.outcome, JSON.stringify(result)).toBe("committed");
  if (!("receipt" in result)) throw new Error(JSON.stringify(result));
  return result.receipt;
}
async function draft(requestedSlug?: string, requestedCode?: string) {
  const productId = randomUUID(), skuId = randomUUID(), draftId = randomUUID(), revisionId = randomUUID(), slug = requestedSlug ?? `article-${productId}`;
  const document = { schemaVersion: 1, id: "example:document", revisionNo: 1, productSlug: slug, name: "Synthetic article", derived: 12 }, canonicalText = canonicalCatalogDraftJson(document);
  const digest = createHash("sha256").update(canonicalText).digest("hex");
  const facts = { skuCode: requestedCode ?? `SKU-${skuId}`, title: "Synthetic article", minQuantity: 1, isAddon: false, facts: { derived: 12 } };
  const gtin = nextGtin();
  const payload: CatalogDraftPayloadV3 = { schemaVersion: 3, product: { id: productId, type: { key: definition.key, version: 1 }, slug,
    primarySkuId: skuId, dimensions: ["pack_size"], documentRevision: { id: revisionId, productId, revisionNo: 1, schemaId: "example:document.v1", documentRef: "example:document", sourceRef: "example:source", digest },
    sharedContent: { schemaVersion: 1, catalogAction: "create", document, presentation: { routePath: { en: `/${slug}` } }, publicationSkus: [facts],
      offerMemberships: [{ skuCode: facts.skuCode, offerVersion: "example:offer", admitted: false }], requestedModes: [{ skuCode: facts.skuCode, modes: [] }] } },
    skus: [{ id: skuId, productId, code: facts.skuCode, options: { pack_size: { kind: "quantity", value: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 } } }, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 },
      identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1 }] }],
    publication: { kind: "release", evidence: {}, operations: [
      { op: "create_product", productId, productSlug: slug, name: "Synthetic article" },
      { op: "register_document_revision", productSlug: slug, revisionId, revisionNo: 1, documentRef: "example:document", sourceRef: "example:source", canonicalText, digest, provenance: { source: "current_draft" } },
      { op: "move_document_pointer", productSlug: slug, documentRevisionNo: 1 },
      { op: "create_sku", skuId, productSlug: slug, documentRevisionNo: 1, ...facts },
      { op: "create_identifier", skuCode: facts.skuCode, scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null },
      { op: "set_primary_sku", productSlug: slug, skuCode: facts.skuCode },
      { op: "set_product_presentation", productSlug: slug, presentation: { routePath: { en: `/${slug}` } } },
      { op: "set_offer_membership", skuCode: facts.skuCode, offerVersion: "example:offer", admitted: false },
    ] } };
  const publication = await save(payload, draftId);
  return { payload, draftId, productId, skuId, publication };
}
it("catalog_publish_replays_original_receipt_after_new_head", async () => {
  const data = await draft();
  const first = await commit(data.publication), second = await commit(await revise(data, first.head));
  const reconnected = createPostgresCatalogPublication(dependencies()), reconnectedActor = (await reconnected.authorize(null))!;
  const before = await snapshot();
  expect(await reconnected.publish(data.publication, reconnectedActor)).toEqual({ outcome: "replayed", receipt: first });
  expect(await snapshot()).toEqual(before);
  expect(await reconnected.reads.current(data.productId)).toMatchObject({ outcome: "found", head: second.head });
});
async function revise(data: Awaited<ReturnType<typeof draft>>, head: CatalogHeadRef) {
  const payload = structuredClone(data.payload);
  payload.product.sharedContent.catalogAction = "revise";
  payload.product.sharedContent.presentation = { routePath: { en: `/revised-${data.productId}` } };
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
  return save(payload, data.draftId, 1, head);
}
async function incrementalSku(data: Awaited<ReturnType<typeof draft>>, head: CatalogHeadRef, revision: number) {
  const payload = structuredClone(data.payload), skuId = randomUUID(), skuCode = `SKU-${skuId}`, gtin = nextGtin();
  payload.product.sharedContent.catalogAction = "revise"; delete payload.product.primarySkuId;
  const quantity = { dimension: "mass" as const, unit: "openlup:g", unscaled: String(100 + revision), scale: 0 };
  payload.skus[0] = { ...payload.skus[0], id: skuId, code: skuCode, netContent: quantity, options: { pack_size: { kind: "quantity", value: quantity } }, identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1 }] };
  const facts = { ...payload.product.sharedContent.publicationSkus[0], skuCode };
  payload.product.sharedContent.publicationSkus = [facts]; payload.product.sharedContent.offerMemberships = []; payload.product.sharedContent.requestedModes = [];
  payload.publication.operations = [
    { op: "create_sku", skuId, productSlug: payload.product.slug!, documentRevisionNo: 1, ...facts },
    { op: "create_identifier", skuCode, scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null },
  ];
  return save(payload, data.draftId, revision, head);
}
async function snapshot(executor: PgQueryExecutor = db) {
  const tables = ["catalog_products", "catalog_skus", "catalog_sku_identifiers", "catalog_product_document_revisions", "catalog_attribute_projection",
    "catalog_draft_heads", "catalog_draft_revisions", "catalog_draft_command_receipts", "catalog_draft_sku_reservations",
    "catalog_publications", "catalog_publication_heads", "catalog_sku_revisions", "catalog_operator_receipts", "catalog_publication_decisions",
    "catalog_publication_pointer_capabilities", "outbox_events", "subscriptions", "subscription_lines", "commerce_orders", "commerce_order_items", "price_entries", "catalog_price_setup_receipts"];
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await executor.query(`SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') AS rows FROM (SELECT to_jsonb(t) AS value FROM public.${table} t) rows`)).rows[0].rows])));
}
it("catalog_readback_returns_exact_historical_head", async () => {
  const data = await draft(), first = await commit(data.publication), retained = await authority.readbackV2(first.head);
  await commit(await revise(data, first.head));
  expect(await authority.readbackV2(first.head)).toEqual(retained);
});
it("catalog_receipt_recovers_lost_publish_response", async () => {
  const data = await draft(), result = await commit(data.publication), before = await snapshot();
  const reconnected = createPostgresCatalogPublication(dependencies()), capability = (await reconnected.authorize(null))!;
  expect(await reconnected.receipt({ productId: data.productId, commandKey: data.publication.commandKey }, capability)).toEqual({ outcome: "found", receipt: result });
  expect(await reconnected.readPort(capability).receipt({ productId: data.productId, commandKey: data.publication.commandKey })).toMatchObject({ outcome: "found", receipt: { head: result.head } });
  expect(await snapshot()).toEqual(before);
});
it("catalog_publish_refuses_command_key_reuse", async () => {
  const data = await draft(); await commit(data.publication); const before = await snapshot();
  expect(await authority.publish({ ...data.publication, changes: [{ variantId: data.skuId, expectedRevision: 0, state: "active" }] }, actor)).toMatchObject({ outcome: "conflict", reason: "catalog_publication_command_key_reused" });
  expect(await snapshot()).toEqual(before);
});
it("catalog_publish_refuses_stale_head", async () => {
  const data = await draft(), first = await commit(data.publication), second = await revise(data, first.head); await approve(second);
  const before = await snapshot();
  expect(await authority.publish({ ...second, expectedHead: null }, actor)).toMatchObject({ outcome: "conflict", reason: "head_conflict" });
  expect(await snapshot()).toEqual(before);
});
it("catalog_publish_refuses_stale_variant_revision", async () => {
  const data = await draft(), first = await commit(data.publication), second = await revise(data, first.head); await approve(second);
  const before = await snapshot();
  expect(await authority.publish({ ...second, changes: [{ variantId: data.skuId, expectedRevision: 0, state: "active" }] }, actor)).toMatchObject({ outcome: "conflict", reason: "catalog_publication_variant_revision_conflict" });
  expect(await snapshot()).toEqual(before);
});
it("catalog_publish_does_not_delete_omitted_sku", async () => {
  const data = await draft(), first = await commit(data.publication), before = await authority.readbackV2(first.head);
  const payload = structuredClone(data.payload); payload.product.sharedContent.catalogAction = "revise";
  delete payload.product.primarySkuId;
  payload.skus = []; payload.product.sharedContent.publicationSkus = []; payload.product.sharedContent.requestedModes = [];
  payload.product.sharedContent.offerMemberships = []; payload.product.sharedContent.presentation = { routePath: { en: `/omitted-${data.productId}` } };
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
  const second = await commit(await save(payload, data.draftId, 1, first.head)), after = await authority.readbackV2(second.head);
  expect(after.outcome).toBe("page");
  if (after.outcome !== "page" || before.outcome !== "page") throw new Error("Expected immutable facts");
  expect(after.items).toEqual(before.items);
});
it("catalog_history_cursor_is_product_bound", async () => {
  const left = await draft(), first = await commit(left.publication), right = await draft(); await commit(right.publication);
  const forged = Buffer.from(canonicalCatalogDraftJson({ schemaVersion: 1, kind: "history", productId: left.productId, highWater: 1, before: first.head.revision })).toString("base64url");
  expect(await authority.reads.history(right.productId, forged)).toMatchObject({ outcome: "validation_issue" });
  expect(await authority.reads.history(left.productId, null)).toMatchObject({ outcome: "page", receipts: [{ head: first.head }], nextCursor: null });
});
it("catalog_public_read_never_exposes_draft", async () => {
  const data = await draft(), before = await snapshot();
  expect(await authority.reads.current(data.productId)).toEqual({ outcome: "unpublished" });
  expect(await snapshot()).toEqual(before);
});
it("resolves retained A for account, order and fulfilment through real source ownership after B and withdrawal", async () => {
  const data = await draft(), first = await commit(data.publication), page = await authority.readbackV2(first.head);
  if (page.outcome !== "page") throw new Error("Missing retained facts");
  const second = await commit(await revise(data, first.head));
  const payload = (await db.query("SELECT public.catalog_draft_record($1,2) AS record", [data.draftId])).rows[0].record.payload as CatalogDraftPayloadV3;
  payload.publication.operations = [{ op: "set_product_status", productSlug: payload.product.slug!, status: "archived" }];
  await commit(await save(payload, data.draftId, 2, second.head));
  const owner = randomUUID(), stranger = randomUUID();
  await db.query("CREATE TABLE public.publication_source_fixture(kind text,source_id uuid,line_id uuid,owner_id uuid,binding jsonb,PRIMARY KEY(kind,source_id,line_id))");
  try {
    const deps: CatalogPublicationDependencies<string> = { ...dependencies(),
      authorizeHuman: async () => ({ ok: true, userId: admin, role: "admin", isMachineActor: false }), acceptedSource: async (executor, caller, binding) => {
      expect((await executor.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
      expect((await executor.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
      const rows = (await executor.query("SELECT owner_id,binding FROM public.publication_source_fixture WHERE kind=$1 AND source_id=$2 AND line_id=$3", [binding.kind, binding.sourceId, binding.lineId])).rows;
      if (rows.length !== 1 || rows[0].owner_id !== caller) return "unauthorized";
      return rows[0].binding as CatalogRetainedSourceBinding | null;
    } };
    const retained = createPostgresCatalogPublication(deps), scope = retained.authorizeReadScope(owner), foreign = retained.authorizeReadScope(stranger);
    for (const kind of ["account", "order", "fulfilment"] as const) {
      const binding = { kind, sourceId: randomUUID(), lineId: randomUUID(), productId: data.productId, skuId: data.skuId,
        skuRevisionId: page.items[0].reference.revisionId, publicationId: first.head.publicationId, documentRevisionId: page.product.document!.id };
      await db.query("INSERT INTO public.publication_source_fixture VALUES($1,$2,$3,$4,$5::jsonb)", [kind, binding.sourceId, binding.lineId, owner, canonicalCatalogDraftJson(binding)]);
      expect(await retained.resolveRetained(binding, scope)).toEqual({ outcome: "found", head: first.head, product: page.product, reference: page.items[0].reference, sku: page.items[0].facts });
      expect(await retained.resolveRetained(binding, foreign)).toMatchObject({ outcome: "unauthorized" });
      expect(await retained.resolveRetained(binding, {} as typeof scope)).toMatchObject({ outcome: "unauthorized" });
      for (const changed of [{ lineId: randomUUID() }, { sourceId: randomUUID() }, { publicationId: second.head.publicationId }, { skuRevisionId: randomUUID() }, { skuId: randomUUID() }])
        expect(await retained.resolveRetained({ ...binding, ...changed }, scope)).toMatchObject({ outcome: "unauthorized" });
      await db.query("UPDATE public.publication_source_fixture SET binding=NULL WHERE kind=$1 AND source_id=$2 AND line_id=$3", [kind, binding.sourceId, binding.lineId]);
      expect(await retained.resolveRetained(binding, scope)).toEqual({ outcome: "unsupported", reason: "retained_revision_unavailable" });
      const unavailable = createPostgresCatalogPublication({ ...deps, acceptedSource: async () => { throw new Error("Synthetic private outage"); } });
      expect(await unavailable.resolveRetained(binding, unavailable.authorizeReadScope(owner))).toEqual({ outcome: "dependency_unavailable", reason: "publication_authority_unavailable" });
    }
  } finally { await db.query("DROP TABLE public.publication_source_fixture"); }
});
it("appends nonempty compensation without requiring observed drift, and refuses an unchanged release", async () => {
  const data = await draft(), first = await commit(data.publication), payload = structuredClone(data.payload);
  payload.product.sharedContent.catalogAction = "revise";
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
  const unchanged = await save(payload, data.draftId, 1, first.head); await approve(unchanged); const before = await snapshot();
  expect(await authority.publish(unchanged, actor)).toMatchObject({ outcome: "validation_issue", reason: "catalog_publication_v3_compile_change_noop" });
  expect(await snapshot()).toEqual(before);
  payload.publication.kind = "compensation";
  const next = await commit(await save(payload, data.draftId, 2, first.head));
  expect(next.head.revision).toBe(2); expect(next.publicationDigest).toBe(first.publicationDigest);
});
it.each(["INSERT INTO public.catalog_product_document_revisions", "INSERT INTO public.catalog_skus", "INSERT INTO public.catalog_publications", "INSERT INTO public.catalog_operator_receipts", "INSERT INTO public.outbox_events", "AS live_product"])("rolls back every earlier publication effect after %s", async point => {
  const data = await draft(); await approve(data.publication); const before = await snapshot(); let injected = false;
  const failing = createPostgresCatalogPublication(dependencies(sql => {
    if (!injected && sql.includes(point) && (point !== "AS live_product" || sql.includes("AS live_product") && written)) { injected = true; throw new Error("Synthetic synchronous failure"); }
    if (sql.includes("INSERT INTO public.catalog_publications")) written = true;
  }));
  let written = false;
  const capability = (await failing.authorize(null))!;
  expect(await failing.publish(data.publication, capability)).toMatchObject({ outcome: "dependency_unavailable" });
  expect(injected).toBe(true); expect(await snapshot()).toEqual(before);
});

it.each([
  "authenticates the live human membership before returning an original replay",
  "W01_V5-1369_predicate_precedence_boundary",
  "W01_V5-1370_predicate_precedence_boundary",
  "W01_V5-1371_predicate_precedence_boundary",
  "W01_V5-1372_predicate_precedence_boundary",
  "W01_V5-1373_predicate_precedence_boundary",
  "W01_V5-2044_predicate_precedence_boundary",
  "W01_V5-2045_predicate_precedence_boundary",
  "W01_V5-2046_predicate_precedence_boundary"
])("%s", async () => {
  const revocable = randomUUID();
  await db.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [revocable, `${revocable}@example.invalid`]);
  await db.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())", [revocable]);
  const deps = dependencies(); deps.authorizeHuman = async () => ({ ok: true, userId: revocable, role: "admin", isMachineActor: false });
  const revocableAuthority = createPostgresCatalogPublication(deps), capability = (await revocableAuthority.authorize(null))!;
  const data = await draft(); await commit(data.publication, revocableAuthority, capability);
  expect(await authority.publish(data.publication, Object.freeze({}) as typeof actor)).toMatchObject({ outcome: "unauthorized" });
  expect(await authority.publish(null as never, Object.freeze({}) as typeof actor)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_command_invalid" });
  expect(await authority.publish({ ...data.publication, unknown: true } as never, actor)).toMatchObject({ outcome: "validation_issue", reason: "catalog_publication_command_invalid" });
  await db.query("SELECT public.platform_revoke_human_membership($1,$2,'Synthetic offboarding')", [admin, revocable]);
  const before = await snapshot();
  expect(await revocableAuthority.publish(data.publication, capability)).toMatchObject({ outcome: "unauthorized" }); expect(await snapshot()).toEqual(before);
  for (const auth of [{ ok: true, userId: admin, role: "admin", isMachineActor: true }, { ok: true, userId: admin, role: "distributor", isMachineActor: false }]) {
    const deps = dependencies(); deps.authorizeHuman = async () => auth as Awaited<ReturnType<typeof deps.authorizeHuman>>;
    expect(await createPostgresCatalogPublication(deps).authorize(null)).toBeNull();
  }
});
it.each([
  "persists alternating exact-digest decisions and keeps successful publication replay after revoke",
  "W02_V5-1548_predicate_precedence_boundary",
  "W02_V5-1549_predicate_precedence_boundary",
  "W02_V5-1550_predicate_precedence_boundary",
  "W02_V5-1551_predicate_precedence_boundary",
  "W02_V5-1552_predicate_precedence_boundary",
  "W02_V5-1553_predicate_precedence_boundary",
  "W02_V5-1554_predicate_precedence_boundary",
  "W02_V5-1555_predicate_precedence_boundary",
  "W02_V5-1556_predicate_precedence_boundary",
  "W02_V5-1557_predicate_precedence_boundary",
  "W02_V5-1558_predicate_precedence_boundary",
  "W02_V5-1559_predicate_precedence_boundary",
  "W02_V5-1560_predicate_precedence_boundary",
  "W02_V5-1561_predicate_precedence_boundary",
  "W02_V5-1562_predicate_precedence_boundary",
  "W02_V5-1563_predicate_precedence_boundary",
  "W02_V5-1564_predicate_precedence_boundary",
  "W02_V5-1565_predicate_precedence_boundary",
  "W02_V5-1566_predicate_precedence_boundary",
  "W02_V5-1567_predicate_precedence_boundary",
  "W02_V5-2047_predicate_precedence_boundary",
  "W02_V5-2048_predicate_precedence_boundary",
  "W02_V5-2049_predicate_precedence_boundary",
  "W02_V5-2050_predicate_precedence_boundary",
  "W02_V5-2051_predicate_precedence_boundary",
  "W02_V5-2052_predicate_precedence_boundary",
  "W02_V5-2053_predicate_precedence_boundary",
  "W02_V5-2054_predicate_precedence_boundary",
  "W02_V5-2055_predicate_precedence_boundary",
  "W02_V5-2056_predicate_precedence_boundary",
  "W02_V5-2057_predicate_precedence_boundary"
])("%s", async () => {
  const data = await draft(), approved = await approve(data.publication);
  expect(await authority.decision({ ...approved, commandKey: "approve:duplicate" }, actor)).toMatchObject({ outcome: "conflict", reason: "catalog_publication_decision_balance_invalid" });
  const revoked = { ...approved, action: "revoke" as const, commandKey: "revoke:first" };
  const revokedResult = await authority.decision(revoked, actor);
  expect(revokedResult.outcome).toBe("committed");
  expect(await authority.publish(data.publication, actor)).toMatchObject({ outcome: "validation_issue", reason: "catalog_publication_approval_required" });
  expect(await authority.decision({ ...revoked, commandKey: "revoke:duplicate" }, actor)).toMatchObject({ outcome: "conflict" });
  expect(await authority.decision(approved, actor)).toMatchObject({ outcome: "replayed" });
  await approve(data.publication, authority, actor, "approve:again");
  const published = await authority.publish(data.publication, actor); expect(published.outcome).toBe("committed");
  expect(await authority.decision({ ...revoked, commandKey: "revoke:after-publish" }, actor)).toMatchObject({ outcome: "committed" });
  expect(await authority.decision(revoked, actor)).toMatchObject({ outcome: "replayed", receipt: "receipt" in revokedResult ? revokedResult.receipt : null });
  const before = await snapshot();
  expect(await authority.publish(data.publication, actor)).toMatchObject({ outcome: "replayed", receipt: "receipt" in published ? published.receipt : null });
  expect(await snapshot()).toEqual(before);
  expect(await authority.decision({ ...approved, candidateDigest: "b".repeat(64), commandKey: "approve:forged" }, actor)).toMatchObject({ outcome: "conflict", reason: "candidate_digest_mismatch" });
  expect(await authority.decision({ ...approved, action: "adopt_v1" } as never, actor)).toMatchObject({ outcome: "validation_issue", reason: "catalog_publication_command_invalid" });
  expect(await authority.publish({ ...data.publication, commandKey: "approve:again" }, actor)).toMatchObject({ outcome: "conflict", reason: "catalog_publication_command_key_reused" });
});
it("serializes concurrent first publication and decision writers without duplicate effects", async () => {
  const data = await draft(); await approve(data.publication);
  const results = await Promise.all([authority.publish(data.publication, actor), authority.publish(data.publication, actor)]);
  expect(results.map(result => result.outcome).sort()).toEqual(["committed", "replayed"]);
  const head = await authority.reads.current(data.productId); expect(head.outcome).toBe("found");
  expect((await db.query("SELECT count(*)::integer AS count FROM public.catalog_publications WHERE product_id=$1", [data.productId])).rows[0].count).toBe(1);
  expect((await db.query("SELECT count(*)::integer AS count FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='catalog.publication.committed'", [data.productId])).rows[0].count).toBe(1);
  const next = await draft();
  const decision = { schemaVersion: 2 as const, action: "approve" as const, productId: next.productId, candidateRef: next.publication.candidateRef, candidateDigest: next.publication.candidateDigest, reason: "Concurrent synthetic approval" };
  const decisions = await Promise.all([authority.decision({ ...decision, commandKey: "approve:a" }, actor), authority.decision({ ...decision, commandKey: "approve:b" }, actor)]);
  expect(decisions.map(result => result.outcome).sort()).toEqual(["committed", "conflict"]);
});
it.each([
  "denies pointer bypass and consumes exactly one transaction-local authorization",
  "W27_V5-1308_predicate_precedence_boundary",
  "W27_V5-1309_predicate_precedence_boundary",
  "W27_V5-1310_predicate_precedence_boundary",
  "W27_V5-1311_predicate_precedence_boundary",
  "W27_V5-1312_predicate_precedence_boundary",
  "W27_V5-1313_predicate_precedence_boundary",
  "W27_V5-1314_predicate_precedence_boundary",
  "W27_V5-1317_predicate_precedence_boundary",
  "W27_V5-1318_predicate_precedence_boundary",
  "W27_V5-1319_predicate_precedence_boundary",
  "W27_V5-1320_predicate_precedence_boundary",
  "W27_V5-1321_predicate_precedence_boundary",
  "W27_V5-1322_predicate_precedence_boundary",
  "W27_V5-1323_predicate_precedence_boundary",
  "W27_V5-2088_predicate_precedence_boundary",
  "W27_V5-2089_predicate_precedence_boundary"
])("%s", async () => {
  const data = await draft(), first = await commit(data.publication);
  const documentId = (await authority.readbackV2(first.head));
  if (documentId.outcome !== "page") throw new Error("Missing full read");
  const original = documentId.product.document!.id, next = randomUUID();
  await db.query(`INSERT INTO public.catalog_product_document_revisions(id,product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest)
    SELECT $1,product_id,2,schema_id,document_ref,'{"schemaVersion":1,"derived":13}'::jsonb,source_ref,provenance,$3 FROM public.catalog_product_document_revisions WHERE id=$2`,
  [next, original, createHash("sha256").update(canonicalCatalogDraftJson({ schemaVersion: 1, derived: 13 })).digest("hex")]);
  const before = await snapshot();
  await expect(db.query("UPDATE public.catalog_products SET current_document_revision_id=$2 WHERE id=$1", [data.productId, next])).rejects.toMatchObject({ code: "42501", message: "catalog_document_pointer_direct_write_denied" });
  expect(await snapshot()).toEqual(before);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO public.catalog_publication_pointer_capabilities VALUES(pg_current_xact_id(),$1,$2,$3)", [data.productId, next, "a".repeat(64)]);
    await client.query("UPDATE public.catalog_products SET current_document_revision_id=$2 WHERE id=$1", [data.productId, next]);
    expect((await client.query("SELECT count(*)::integer AS count FROM public.catalog_publication_pointer_capabilities WHERE transaction_id=pg_current_xact_id()")).rows[0].count).toBe(0);
    await expect(client.query("UPDATE public.catalog_products SET current_document_revision_id=$2 WHERE id=$1", [data.productId, original])).rejects.toMatchObject({ code: "42501" });
  } finally { await client.query("ROLLBACK"); client.release(); }
  expect(await snapshot()).toEqual(before);
  await setFixtureCatalogDocument(db, data.productId, next);
  expect((await db.query("SELECT current_document_revision_id FROM public.catalog_products WHERE id=$1", [data.productId])).rows[0].current_document_revision_id).toBe(next);
  await setFixtureCatalogDocument(db, data.productId, original);
  expect((await db.query("SELECT count(*)::integer AS count FROM public.catalog_publication_pointer_capabilities")).rows[0].count).toBe(0);
  const ambiguous = await db.connect();
  try {
    await ambiguous.query("BEGIN");
    for (const fingerprint of ["a".repeat(64), "b".repeat(64)])
      await ambiguous.query("INSERT INTO public.catalog_publication_pointer_capabilities VALUES(pg_current_xact_id(),$1,$2,$3)", [data.productId, next, fingerprint]);
    await expect(ambiguous.query("UPDATE public.catalog_products SET current_document_revision_id=$2 WHERE id=$1", [data.productId, next])).rejects.toMatchObject({ code: "42501" });
  } finally { await ambiguous.query("ROLLBACK"); ambiguous.release(); }
  await expect(db.query("INSERT INTO public.catalog_publication_pointer_capabilities VALUES(pg_current_xact_id(),$1,$2,$3)", [randomUUID(), next, "a".repeat(64)])).rejects.toMatchObject({ code: "23503" });
  await expect(db.query("INSERT INTO public.catalog_publication_pointer_capabilities VALUES(pg_current_xact_id(),$1,$2,$3)", [data.productId, next, "bad"])).rejects.toMatchObject({ code: "23514" });
});
it("refuses a globally colliding GTIN and leaves all publication effects unchanged", async () => {
  const left = await draft(); await commit(left.publication); const right = await draft();
  const payload = structuredClone(right.payload), value = left.payload.skus[0].identifiers![0].value.padStart(14, "0");
  payload.skus[0].identifiers![0].value = value; payload.skus[0].identifiers![0].issuer = "example:other";
  const operation = payload.publication.operations.find(operation => operation.op === "create_identifier")!;
  if (operation.op !== "create_identifier") throw new Error("Missing identifier"); operation.value = value; operation.issuer = "example:other";
  const command = await save(payload, right.draftId, 1); await approve(command); const before = await snapshot();
  expect(await authority.publish(command, actor)).toMatchObject({ outcome: "conflict", reason: "catalog_publication_identity_conflict" });
  expect(await snapshot()).toEqual(before);
});
it.each([
  "native publication tables default-deny browser roles and immutable records reject mutation",
  "W49_V5-1085_predicate_precedence_boundary",
  "W49_V5-1261_predicate_precedence_boundary",
  "W49_V5-1374_predicate_precedence_boundary",
  "W49_V5-1375_predicate_precedence_boundary"
])("%s", async () => {
  const data = await draft(); await commit(data.publication);
  for (const table of ["catalog_publications", "catalog_sku_revisions", "catalog_operator_receipts", "catalog_publication_decisions"])
    await expect(db.query(`UPDATE public.${table} SET ${table === "catalog_publications" || table === "catalog_publication_decisions" ? "id=id" : table === "catalog_sku_revisions" ? "id=id" : "command_key=command_key"}`)).rejects.toMatchObject({ code: "55000" });
  for (const signature of ["public.catalog_price_setup_prepare(text,text)", "public.catalog_price_setup_apply_prelocked(jsonb,boolean)",
    "public.catalog_price_setup_prelock(uuid,uuid,jsonb)", "public.catalog_price_setup_apply_in_transaction(uuid,uuid,jsonb)"])
    expect((await db.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS allowed", [signature])).rows).toEqual([{ allowed: false }]);
  const role = `publication_reader_${process.pid}`, client = await db.connect();
  try {
    await client.query(`CREATE ROLE ${role} NOLOGIN`); await client.query(`SET ROLE ${role}`);
    for (const table of ["catalog_publications", "catalog_sku_revisions", "catalog_operator_receipts", "catalog_publication_decisions", "catalog_publication_heads", "catalog_publication_pointer_capabilities"])
      await expect(client.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: "42501" });
    await expect(client.query("SELECT public.catalog_publication_sku_reasons($1,true)", [data.skuId])).rejects.toMatchObject({ code: "42501" });
    for (const [table, assignment] of [["catalog_products", "name=name"], ["catalog_skus", "title=title"],
      ["catalog_sku_identifiers", "quantity=quantity"], ["catalog_product_document_revisions", "digest=digest"]])
      await expect(client.query(`UPDATE public.${table} SET ${assignment} WHERE false`)).rejects.toMatchObject({ code: "42501" });
  } finally { await client.query("RESET ROLE"); await client.query(`DROP ROLE IF EXISTS ${role}`); client.release(); }
});
it.each([
  "refuses ordinary live drift and permits donor compensation to repair it",
  "W24_V5-1479_predicate_precedence_boundary",
  "W24_V5-1480_predicate_precedence_boundary",
  "W24_V5-1481_predicate_precedence_boundary",
  "W24_V5-1482_predicate_precedence_boundary",
  "W24_V5-1483_predicate_precedence_boundary",
  "W24_V5-1780_predicate_precedence_boundary",
  "W24_V5-1781_predicate_precedence_boundary",
  "W24_V5-1782_predicate_precedence_boundary",
  "W24_V5-1783_predicate_precedence_boundary",
  "W24_V5-1784_predicate_precedence_boundary",
  "W24_V5-1785_predicate_precedence_boundary",
  "W24_V5-1786_predicate_precedence_boundary",
  "W24_V5-1787_predicate_precedence_boundary",
  "W24_V5-1788_predicate_precedence_boundary",
  "W24_V5-2058_predicate_precedence_boundary",
  "W24_V5-2059_predicate_precedence_boundary",
  "W24_V5-2060_predicate_precedence_boundary",
  "W24_V5-2061_predicate_precedence_boundary",
  "W24_V5-2062_predicate_precedence_boundary",
  "W24_V5-2064_predicate_precedence_boundary",
  "W24_V5-2065_predicate_precedence_boundary",
  "W24_V5-2066_predicate_precedence_boundary",
  "W24_V5-2067_predicate_precedence_boundary",
  "W24_V5-2068_predicate_precedence_boundary",
  "W24_V5-2069_predicate_precedence_boundary",
  "W24_V5-2070_predicate_precedence_boundary",
  "W24_V5-2071_predicate_precedence_boundary",
  "W24_V5-2072_predicate_precedence_boundary"
])("%s", async () => {
  const data = await draft(), first = await commit(data.publication), command = await revise(data, first.head); await approve(command);
  await db.query("UPDATE public.catalog_products SET status='active' WHERE id=$1", [data.productId]); const before = await snapshot();
  expect(await authority.publish(command, actor)).toMatchObject({ outcome: "conflict", reason: "catalog_publication_live_drift" });
  expect(await snapshot()).toEqual(before);
  const payload = structuredClone(data.payload); payload.product.sharedContent.catalogAction = "revise"; payload.publication.kind = "compensation";
  payload.publication.operations = [{ op: "set_product_status", productSlug: payload.product.slug!, status: "archived" }];
  const compensation = await save(payload, data.draftId, 2, first.head);
  // Compensation skips the ordinary drift gate; its explicit operation still
  // has to restore the compiled complete projection before commit.
  const result = await commit(compensation);
  expect(result.head.revision).toBe(2); expect(await authority.reads.current(data.productId)).toMatchObject({ outcome: "found", head: result.head });
  const next = await incrementalSku(data, result.head, 3); await approve(next);
  const stable = await snapshot();
  expect(await authority.publish({ ...next, expectedHead: first.head }, actor)).toMatchObject({ outcome: "conflict", reason: "head_conflict" });
  const guard = await db.connect();
  try {
    await guard.query("BEGIN"); await guard.query("SELECT pg_advisory_xact_lock(hashtextextended('catalog-publication-global',0))");
    expect(await authority.publish(next, actor)).toMatchObject({ outcome: "conflict", reason: "catalog_publication_busy" });
  } finally { await guard.query("ROLLBACK"); guard.release(); }
  expect(await snapshot()).toEqual(stable);
  const legacy = randomUUID(); await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Synthetic legacy')", [legacy, `legacy-${legacy}`]);
  expect(await authority.reads.current(legacy)).toMatchObject({ outcome: "unsupported" });
  expect(await authority.reads.history(legacy, null)).toMatchObject({ outcome: "unsupported" });
});
it("separates the native price-only 64-character ceiling from dark structural readiness", async () => {
  const data = await draft(), payload = structuredClone(data.payload);
  payload.skus[0].logisticsRef = "example:logistics";
  payload.publication.operations.push({ op: "set_sku_metadata", skuCode: payload.skus[0].code!, logisticsRef: "example:logistics" });
  const command = await save(payload, data.draftId, 1); await approve(command);
  const before = await snapshot();
  let staged = false;
  const stagedAuthority = createPostgresCatalogPublication(dependencies(async (sql, executor) => {
    if (staged || !sql.startsWith("UPDATE public.catalog_skus SET publication_facts=$2::jsonb,attribute_values=")) return;
    staged = true;
    // A SQL identity is broader than hard authored preparation. Test the native
    // price-only guard independently, on otherwise complete real native rows.
    for (const [length, reasons] of [[64, []], [65, ["commerce_identity_unsupported"]]] as const) {
      await executor.query("UPDATE public.catalog_products SET slug=$2 WHERE id=$1", [data.productId, "a".repeat(length)]);
      expect((await executor.query("SELECT public.catalog_publication_sku_reasons($1,true) AS reasons", [data.skuId])).rows[0].reasons).toEqual(reasons);
      expect((await executor.query("SELECT public.catalog_publication_sku_reasons($1,false) AS reasons", [data.skuId])).rows[0].reasons).toEqual([]);
    }
  }));
  const capability = (await stagedAuthority.authorize(null))!;
  // Native rows remain dark here. The readback gate still refuses the SQL drift;
  // activation-specific publication proof needs the real LC3 readiness binding.
  expect(await stagedAuthority.publish(command, capability)).toMatchObject({ outcome: "validation_issue", reason: "catalog_publication_post_state_mismatch" });
  expect(staged).toBe(true); expect(await snapshot()).toEqual(before);
});
it.each([
  ["net", "fractional", "15", 1], ["net", "zero", "0", 0], ["net", "negative", "-1", 0], ["net", "out_of_range", "2147483648", 0],
] as const)("catalog_publication_refuses_%s_%s_mass", async (kind, _case, unscaled, scale) => {
  const data = await draft(), payload = structuredClone(data.payload);
  payload.skus[0][kind === "net" ? "netContent" : "grossMass"] = { dimension: "mass", unit: "openlup:g", unscaled, scale };
  // Native drafts retain opaque quantity input; publication must refuse even
  // when the input did not pass through the stricter TypeScript draft facade.
  const command = await save(payload, data.draftId, 1), before = await snapshot();
  expect(await authority.publish(command, actor)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_integral_grams_required" });
  expect(await snapshot()).toEqual(before);
});
describe("bounded publication pagination", () => {
  beforeAll(async () => {
    let receipt = { head: paged.head };
    for (let revision = 2; revision <= 100; revision++) receipt = await commit(await incrementalSku(paged.data, receipt.head, revision));
    paged.head = receipt.head;
  }, postgresSetupTimeoutMs);
it("paginates full facts and freezes history at a product-bound high water", async () => {
  const first = await authority.readbackV2(paged.head);
  expect(first.outcome).toBe("page"); if (first.outcome !== "page") throw new Error("Missing first page");
  expect(first.items).toHaveLength(100); expect(first.nextCursor).not.toBeNull();
  const last = await authority.readbackV2(paged.head, first.nextCursor);
  expect(last.outcome).toBe("page"); if (last.outcome !== "page") throw new Error("Missing second page");
  expect(last.items).toHaveLength(1); expect(last.nextCursor).toBeNull();
  expect(new Set([...first.items, ...last.items].map(item => item.reference.skuId)).size).toBe(101);
  const history = await authority.reads.history(paged.data.productId, null);
  expect(history.outcome).toBe("page"); if (history.outcome !== "page") throw new Error("Missing history");
  expect(history.receipts).toHaveLength(100); expect(history.nextCursor).not.toBeNull();
  const later = await commit(await incrementalSku(paged.data, paged.head, 101));
  const remainder = await authority.reads.history(paged.data.productId, history.nextCursor);
  expect(remainder.outcome).toBe("page"); if (remainder.outcome !== "page") throw new Error("Missing history remainder");
  expect(remainder.receipts).toHaveLength(1); expect(remainder.nextCursor).toBeNull();
  expect(history.receipts.every(receipt => receipt.head.revision < later.head.revision)).toBe(true);
  expect(await authority.readbackV2(paged.head)).toEqual(first);
});
});
// The native matrix is shared by conservative constraint/lifecycle aliases.
it.each([
  "W31_V5-0028_predicate_precedence_boundary",
  "W31_V5-0029_predicate_precedence_boundary",
  "W31_V5-0030_predicate_precedence_boundary",
  "W31_V5-0313_predicate_precedence_boundary",
  "W31_V5-0314_predicate_precedence_boundary",
  "W31_V5-0315_predicate_precedence_boundary",
  "W31_V5-0316_predicate_precedence_boundary",
  "W31_V5-0317_predicate_precedence_boundary",
  "W31_V5-0318_predicate_precedence_boundary",
  "W31_V5-0319_predicate_precedence_boundary",
  "W31_V5-0785_predicate_precedence_boundary",
  "W31_V5-0786_predicate_precedence_boundary",
  "W31_V5-0787_predicate_precedence_boundary",
  "W31_V5-0788_predicate_precedence_boundary",
  "W31_V5-0789_predicate_precedence_boundary",
  "W31_V5-0790_predicate_precedence_boundary",
  "W31_V5-0791_predicate_precedence_boundary",
  "W31_V5-0792_predicate_precedence_boundary",
  "W31_V5-0793_predicate_precedence_boundary",
  "W31_V5-0795_predicate_precedence_boundary",
  "W31_V5-0796_predicate_precedence_boundary",
  "W31_V5-0797_predicate_precedence_boundary",
  "W31_V5-0799_predicate_precedence_boundary",
  "W31_V5-0800_predicate_precedence_boundary",
  "W31_V5-0801_predicate_precedence_boundary",
  "W31_V5-0802_predicate_precedence_boundary",
  "W31_V5-0803_predicate_precedence_boundary",
  "W48_V5-0804_predicate_precedence_boundary",
  "W48_V5-0805_predicate_precedence_boundary",
  "W31_V5-0806_predicate_precedence_boundary",
  "W31_V5-0807_predicate_precedence_boundary",
  "W31_V5-0808_predicate_precedence_boundary",
  "W31_V5-0809_predicate_precedence_boundary",
  "W31_V5-0867_predicate_precedence_boundary",
  "W31_V5-0868_predicate_precedence_boundary",
  "W31_V5-0869_predicate_precedence_boundary",
  "W48_V5-0870_predicate_precedence_boundary",
  "W48_V5-0871_predicate_precedence_boundary",
  "W31_V5-0872_predicate_precedence_boundary",
  "W31_V5-0873_predicate_precedence_boundary",
  "W31_V5-0874_predicate_precedence_boundary",
  "W31_V5-0875_predicate_precedence_boundary",
  "W31_V5-0876_predicate_precedence_boundary",
  "W31_V5-0877_predicate_precedence_boundary",
  "W31_V5-0878_predicate_precedence_boundary",
  "W48_V5-0880_predicate_precedence_boundary",
  "W31_V5-0881_predicate_precedence_boundary",
  "W31_V5-1051_predicate_precedence_boundary",
  "W31_V5-1052_predicate_precedence_boundary",
  "W31_V5-1053_predicate_precedence_boundary",
  "W31_V5-1054_predicate_precedence_boundary",
  "W31_V5-1055_predicate_precedence_boundary",
  "W31_V5-1056_predicate_precedence_boundary",
  "W31_V5-1057_predicate_precedence_boundary",
  "W31_V5-1058_predicate_precedence_boundary",
  "W31_V5-1059_predicate_precedence_boundary",
  "W31_V5-1060_predicate_precedence_boundary",
  "W31_V5-1061_predicate_precedence_boundary",
  "W31_V5-1062_predicate_precedence_boundary",
  "W31_V5-1063_predicate_precedence_boundary",
  "W31_V5-1064_predicate_precedence_boundary",
  "W31_V5-1065_predicate_precedence_boundary",
  "W31_V5-1066_predicate_precedence_boundary",
  "W31_V5-1067_predicate_precedence_boundary",
  "W31_V5-1068_predicate_precedence_boundary",
  "W31_V5-1069_predicate_precedence_boundary",
  "W31_V5-1206_predicate_precedence_boundary",
  "W31_V5-1207_predicate_precedence_boundary",
  "W31_V5-1208_predicate_precedence_boundary",
  "W31_V5-1209_predicate_precedence_boundary",
  "W31_V5-1210_predicate_precedence_boundary",
  "W31_V5-1211_predicate_precedence_boundary",
  "W31_V5-1212_predicate_precedence_boundary",
  "W31_V5-1213_predicate_precedence_boundary",
  "W31_V5-1214_predicate_precedence_boundary",
  "W31_V5-1215_predicate_precedence_boundary",
  "W31_V5-1216_predicate_precedence_boundary",
  "W31_V5-1217_predicate_precedence_boundary",
  "W31_V5-1218_predicate_precedence_boundary",
  "W31_V5-1219_predicate_precedence_boundary",
  "W31_V5-1220_predicate_precedence_boundary",
  "W31_V5-1221_predicate_precedence_boundary",
  "W31_V5-1222_predicate_precedence_boundary",
  "W31_V5-1223_predicate_precedence_boundary",
  "W31_V5-1224_predicate_precedence_boundary",
  "W31_V5-1225_predicate_precedence_boundary",
  "W31_V5-1226_predicate_precedence_boundary",
  "W31_V5-1228_predicate_precedence_boundary",
  "W31_V5-1230_predicate_precedence_boundary",
  "W31_V5-1258_predicate_precedence_boundary",
  "W31_V5-1259_predicate_precedence_boundary",
  "W31_V5-1260_predicate_precedence_boundary",
  "W30_V5-1315_predicate_precedence_boundary",
  "W30_V5-1316_predicate_precedence_boundary",
  "W37_V5-1376_predicate_precedence_boundary",
  "W37_V5-1377_predicate_precedence_boundary",
  "W37_V5-1378_predicate_precedence_boundary",
  "W37_V5-1379_predicate_precedence_boundary",
  "W37_V5-1380_predicate_precedence_boundary",
  "W37_V5-1381_predicate_precedence_boundary",
  "W37_V5-1382_predicate_precedence_boundary",
  "W37_V5-1383_predicate_precedence_boundary",
  "W37_V5-1384_predicate_precedence_boundary",
  "W37_V5-1385_predicate_precedence_boundary",
  "W37_V5-1386_predicate_precedence_boundary",
  "W37_V5-1387_predicate_precedence_boundary",
  "W37_V5-1388_predicate_precedence_boundary",
  "W37_V5-1389_predicate_precedence_boundary",
  "W37_V5-1390_predicate_precedence_boundary",
  "W37_V5-1391_predicate_precedence_boundary",
  "W37_V5-1392_predicate_precedence_boundary",
  "W37_V5-1393_predicate_precedence_boundary",
  "W37_V5-1394_predicate_precedence_boundary",
  "W37_V5-1395_predicate_precedence_boundary",
  "W37_V5-1396_predicate_precedence_boundary",
  "W37_V5-1397_predicate_precedence_boundary",
  "W37_V5-1398_predicate_precedence_boundary",
  "W37_V5-1399_predicate_precedence_boundary",
  "W37_V5-1400_predicate_precedence_boundary",
  "W37_V5-1401_predicate_precedence_boundary",
  "W37_V5-1402_predicate_precedence_boundary",
  "W37_V5-1403_predicate_precedence_boundary",
  "W37_V5-1404_predicate_precedence_boundary",
  "W10_V5-1406_predicate_precedence_boundary",
  "W10_V5-1407_predicate_precedence_boundary",
  "W10_V5-1409_predicate_precedence_boundary",
  "W10_V5-1410_predicate_precedence_boundary",
  "W10_V5-1411_predicate_precedence_boundary",
  "W10_V5-1412_predicate_precedence_boundary",
  "W10_V5-1413_predicate_precedence_boundary",
  "W10_V5-1415_predicate_precedence_boundary",
  "W10_V5-1416_predicate_precedence_boundary",
  "W10_V5-1417_predicate_precedence_boundary",
  "W10_V5-1418_predicate_precedence_boundary",
  "W10_V5-1419_predicate_precedence_boundary",
  "W10_V5-1420_predicate_precedence_boundary",
  "W30_V5-1421_predicate_precedence_boundary",
  "W30_V5-1422_predicate_precedence_boundary",
  "W30_V5-1423_predicate_precedence_boundary",
  "W30_V5-1424_predicate_precedence_boundary",
  "W30_V5-1425_predicate_precedence_boundary",
  "W30_V5-1426_predicate_precedence_boundary",
  "W30_V5-1427_predicate_precedence_boundary",
  "W30_V5-1428_predicate_precedence_boundary",
  "W30_V5-1429_predicate_precedence_boundary",
  "W30_V5-1430_predicate_precedence_boundary",
  "W30_V5-1431_predicate_precedence_boundary",
  "W30_V5-1432_predicate_precedence_boundary",
  "W30_V5-1433_predicate_precedence_boundary",
  "W30_V5-1434_predicate_precedence_boundary",
  "W30_V5-1436_predicate_precedence_boundary",
  "W30_V5-1437_predicate_precedence_boundary",
  "W30_V5-1438_predicate_precedence_boundary",
  "W30_V5-1439_predicate_precedence_boundary",
  "W30_V5-1440_predicate_precedence_boundary",
  "W30_V5-1441_predicate_precedence_boundary",
  "W30_V5-1442_predicate_precedence_boundary",
  "W30_V5-1443_predicate_precedence_boundary",
  "W30_V5-1444_predicate_precedence_boundary",
  "W30_V5-1445_predicate_precedence_boundary",
  "W30_V5-1446_predicate_precedence_boundary",
  "W30_V5-1447_predicate_precedence_boundary",
  "W30_V5-1448_predicate_precedence_boundary",
  "W30_V5-1449_predicate_precedence_boundary",
  "W30_V5-1450_predicate_precedence_boundary",
  "W08_V5-1451_predicate_precedence_boundary",
  "W08_V5-1452_predicate_precedence_boundary",
  "W08_V5-1453_predicate_precedence_boundary",
  "W10_V5-1710_predicate_precedence_boundary",
  "W10_V5-1713_predicate_precedence_boundary",
  "W30_V5-1716_predicate_precedence_boundary",
  "W31_V5-2074_predicate_precedence_boundary",
  "W31_V5-2075_predicate_precedence_boundary",
  "W31_V5-2091_predicate_precedence_boundary",
  "W31_V5-2092_predicate_precedence_boundary",
  "W31_V5-2093_predicate_precedence_boundary",
  "W31_V5-2094_predicate_precedence_boundary",
  "W31_V5-2095_predicate_precedence_boundary",
  "W31_V5-2096_predicate_precedence_boundary",
  "W31_V5-2097_predicate_precedence_boundary",
  "W31_V5-2098_predicate_precedence_boundary",
  "W31_V5-2099_predicate_precedence_boundary",
  "W31_V5-2100_predicate_precedence_boundary",
  "W31_V5-2127_predicate_precedence_boundary",
  "W31_V5-2128_predicate_precedence_boundary",
  "W31_V5-2129_predicate_precedence_boundary",
  "W31_V5-2130_predicate_precedence_boundary"
])("%s", async () => {
  const client = await db.connect(); await client.query("BEGIN");
  try {
    const records = new Map<string, Record<string, unknown>>();
    const subjects: Record<string, [string, string]> = {
      catalog_publications: ["product_id=$1 AND revision=1", paged.data.productId], catalog_sku_revisions: ["sku_id=$1 AND revision=1", paged.data.skuId],
      catalog_publication_heads: ["product_id=$1", paged.data.productId], catalog_operator_receipts: ["scope_id=$1 AND kind='approve' AND command_key='approve:publish:1'", paged.data.productId],
      catalog_publication_decisions: ["product_id=$1 AND command_key='approve:publish:1'", paged.data.productId], catalog_products: ["id=$1", paged.data.productId],
      catalog_skus: ["id=$1", paged.data.skuId], catalog_sku_identifiers: ["catalog_sku_id=$1", paged.data.skuId],
      catalog_product_document_revisions: ["product_id=$1 AND revision_no=1", paged.data.productId], catalog_draft_heads: ["draft_id=$1", paged.data.draftId],
      catalog_draft_revisions: ["draft_id=$1 AND revision=1", paged.data.draftId], catalog_draft_command_receipts: ["draft_id=$1 AND command_key='draft:1'", paged.data.draftId],
      catalog_draft_sku_reservations: ["sku_id=$1", paged.data.skuId],
    };
    for (const table of ["catalog_publications", "catalog_sku_revisions", "catalog_publication_heads", "catalog_operator_receipts", "catalog_publication_decisions",
      "catalog_products", "catalog_skus", "catalog_sku_identifiers", "catalog_product_document_revisions", "catalog_draft_heads", "catalog_draft_revisions", "catalog_draft_command_receipts", "catalog_draft_sku_reservations"]) {
      const [condition, value] = subjects[table];
      const rows = (await client.query(`SELECT to_jsonb(t) AS row FROM public.${table} t WHERE ${condition} LIMIT 1`, [value])).rows;
      expect(rows).toHaveLength(1); records.set(table, rows[0].row);
      await client.query("SAVEPOINT duplicate_record");
      await expect(client.query(`INSERT INTO public.${table} SELECT * FROM jsonb_populate_record(NULL::public.${table},$1::jsonb)`, [JSON.stringify(rows[0].row)])).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT duplicate_record");
    }
    const cases: [string, Record<string, unknown>, string][] = [
      ["catalog_publications", { revision: 0 }, "23514"], ["catalog_publications", { candidate_digest: "bad" }, "23514"],
      ["catalog_publications", { canonical_state: "{}", digest: createHash("sha256").update("{}").digest("hex") }, "23514"],
      ["catalog_publications", { actor_id: null }, "23502"],
      ["catalog_sku_revisions", { revision: 0 }, "23514"], ["catalog_sku_revisions", { digest: "bad" }, "23514"],
      ["catalog_sku_revisions", { full_facts: "{}", digest: createHash("sha256").update("{}").digest("hex") }, "23514"],
      ["catalog_publication_heads", { revision: 0 }, "23514"], ["catalog_publication_heads", { product_id: null }, "23502"],
      ["catalog_operator_receipts", { kind: "" }, "23514"], ["catalog_operator_receipts", { command_key: "" }, "23514"],
      ["catalog_operator_receipts", { fingerprint: "A".repeat(64) }, "23514"], ["catalog_operator_receipts", { result: [] }, "23514"],
      ["catalog_operator_receipts", { result: null }, "23502"],
      ["catalog_publication_decisions", { action: "unknown" }, "23514"], ["catalog_publication_decisions", { candidate_reference_digest: "bad" }, "23514"],
      ["catalog_publication_decisions", { reason: " " }, "23514"],
      ["catalog_products", { slug: null }, "23502"], ["catalog_products", { name: " " }, "23514"], ["catalog_products", { status: "unknown" }, "23514"],
      ["catalog_skus", { sku: null }, "23502"], ["catalog_skus", { title: null }, "23502"], ["catalog_skus", { min_order_qty: 0 }, "23514"],
      ["catalog_skus", { status: "unknown" }, "23514"],
      ["catalog_sku_identifiers", { quantity: 0 }, "23514"], ["catalog_sku_identifiers", { issuer: " " }, "23514"],
      ["catalog_sku_identifiers", { identifier_kind: "unknown" }, "23514"], ["catalog_sku_identifiers", { pack_kind: "collective", quantity: 1 }, "23514"],
      ["catalog_sku_identifiers", { is_primary: true, pack_kind: "collective", quantity: 2 }, "23514"],
      ["catalog_product_document_revisions", { revision_no: 0 }, "23514"], ["catalog_product_document_revisions", { schema_id: " " }, "23514"],
      ["catalog_product_document_revisions", { digest: "bad" }, "23514"], ["catalog_product_document_revisions", { canonical_text: "{}" }, "23514"],
      ["catalog_draft_heads", { revision: 0 }, "23514"], ["catalog_draft_heads", { status: "unknown" }, "23514"],
      ["catalog_draft_revisions", { fingerprint: "bad" }, "23514"], ["catalog_draft_revisions", { actor_id: " " }, "23514"],
      ["catalog_draft_revisions", { payload: null }, "23502"], ["catalog_draft_command_receipts", { fingerprint: "bad" }, "23514"],
      ["catalog_draft_sku_reservations", { code: " " }, "23514"],
    ];
    for (const [table, patch, code] of cases) {
      await client.query("SAVEPOINT invalid_record");
      await expect(client.query(`INSERT INTO public.${table} SELECT * FROM jsonb_populate_record(NULL::public.${table},$1::jsonb)`, [JSON.stringify({ ...records.get(table), ...patch })])).rejects.toMatchObject({ code });
      await client.query("ROLLBACK TO SAVEPOINT invalid_record");
    }
    const receipt = records.get("catalog_operator_receipts")!;
    await client.query("SAVEPOINT foreign_receipt");
    await expect(client.query(`INSERT INTO public.catalog_operator_receipts SELECT * FROM jsonb_populate_record(NULL::public.catalog_operator_receipts,$1::jsonb)`,
      [JSON.stringify({ ...receipt, command_key: "foreign:actor", actor_id: randomUUID() })])).rejects.toMatchObject({ code: "23503" });
    await client.query("ROLLBACK TO SAVEPOINT foreign_receipt");
    const identifier = records.get("catalog_sku_identifiers")!;
    await client.query("SAVEPOINT global_gtin");
    await expect(client.query(`INSERT INTO public.catalog_sku_identifiers SELECT * FROM jsonb_populate_record(NULL::public.catalog_sku_identifiers,$1::jsonb)`,
      [JSON.stringify({ ...identifier, id: randomUUID(), issuer: "other:issuer", normalized_value: String(BigInt(identifier.normalized_value as string)), is_primary: false })]))
      .rejects.toMatchObject({ code: "23505", constraint: "catalog_sku_identifiers_global_gtin_key" });
    await client.query("ROLLBACK TO SAVEPOINT global_gtin");
    const freshProduct = randomUUID();
    await client.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Constraint parent')", [freshProduct, `constraint-${freshProduct}`]);
    const previous = (await client.query("SELECT id,revision FROM public.catalog_publications WHERE product_id=$1 ORDER BY revision DESC LIMIT 1",
      [records.get("catalog_publications")!.product_id])).rows[0];
    const revision = previous.revision + 1;
    const publicationKey = { previous_id: previous.id, command_key: `constraint:${randomUUID()}` };
    const foreignCases: [string, Record<string, unknown>][] = [
      ["catalog_products", { id: randomUUID(), slug: `foreign-${randomUUID()}`, primary_sku_id: null, current_document_revision_id: null, type_key: "example:absent", type_version: 1 }],
      ["catalog_skus", { id: randomUUID(), sku: `FOREIGN-${randomUUID()}`, product_id: randomUUID() }],
      ["catalog_product_document_revisions", { id: randomUUID(), product_id: randomUUID() }],
      ["catalog_publications", { ...publicationKey, id: randomUUID(), revision, candidate_ref: `v1:${randomUUID()}@1/unpublished`, draft_id: randomUUID() }],
      ["catalog_publications", { ...publicationKey, id: randomUUID(), revision, candidate_ref: `v1:${randomUUID()}@1/unpublished`, previous_id: foreignPublished.head.publicationId }],
      ["catalog_publications", { ...publicationKey, id: randomUUID(), revision, candidate_ref: `v1:${randomUUID()}@1/unpublished`, document_revision_id: foreignPublished.data.payload.product.documentRevision!.id }],
      ["catalog_sku_revisions", { id: randomUUID(), revision: 2, publication_id: randomUUID() }],
      ["catalog_sku_revisions", { id: randomUUID(), revision: 2, publication_id: foreignPublished.head.publicationId }],
      ["catalog_publication_heads", { product_id: freshProduct }],
      ["catalog_draft_command_receipts", { draft_id: randomUUID() }],
    ];
    for (const [table, patch] of foreignCases) {
      await client.query("SAVEPOINT foreign_record");
      await expect(client.query(`INSERT INTO public.${table} SELECT * FROM jsonb_populate_record(NULL::public.${table},$1::jsonb)`, [JSON.stringify({ ...records.get(table), ...patch })])).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO SAVEPOINT foreign_record");
    }
    for (const table of ["catalog_publications", "catalog_sku_revisions", "catalog_operator_receipts", "catalog_publication_decisions", "catalog_product_document_revisions", "catalog_draft_revisions"]) {
      await client.query("SAVEPOINT immutable_record");
      await expect(client.query(`DELETE FROM public.${table}`)).rejects.toMatchObject({ code: "55000" });
      await client.query("ROLLBACK TO SAVEPOINT immutable_record");
    }
  } finally { await client.query("ROLLBACK"); client.release(); }
});
it("publishes cumulative attributes above the incoming one-MiB draft ceiling", async () => {
  const data = await draft(); data.payload.skus[0].attributes = { details: Array.from({ length: 300 }, () => "é".repeat(900)) };
  const first = await commit(await save(data.payload, data.draftId, 1));
  const second = await commit(await incrementalSku(data, first.head, 2));
  const page = await authority.readbackV2(second.head);
  expect(page.outcome).toBe("page"); if (page.outcome !== "page") throw new Error("Missing cumulative facts");
  expect(page.items).toHaveLength(2); expect(Buffer.byteLength(JSON.stringify(page))).toBeGreaterThan(1_048_576);
  expect((await db.query("SELECT count(*)::integer AS count FROM public.catalog_attribute_projection WHERE sku_id IN (SELECT id FROM public.catalog_skus WHERE product_id=$1)", [data.productId])).rows[0].count).toBe(600);
  expect(await authority.readbackV2(first.head)).toMatchObject({ outcome: "page", items: [{ facts: { attributes: data.payload.skus[0].attributes } }] });
});

it("retains omitted physical source across compatible document caches and exact document tuple reuse", async () => {
  const data = await draft(), first = await commit(data.publication), before = await authority.readbackV2(first.head);
  if (before.outcome !== "page") throw new Error("Missing first facts");
  const payload = structuredClone(data.payload), doc = { ...payload.product.sharedContent.document as Record<string, unknown>, revisionNo: 2, derived: 13 };
  const canonicalText = canonicalCatalogDraftJson(doc), digest = createHash("sha256").update(canonicalText).digest("hex"), revisionId = randomUUID();
  payload.publication.kind = "compensation"; payload.product.sharedContent.catalogAction = "revise";
  payload.product.sharedContent.document = doc; payload.product.documentRevision = { ...payload.product.documentRevision!, id: revisionId, revisionNo: 2, digest };
  payload.skus = []; delete payload.product.primarySkuId;
  payload.product.sharedContent.publicationSkus = []; payload.product.sharedContent.offerMemberships = []; payload.product.sharedContent.requestedModes = [];
  payload.publication.operations = [
    { op: "register_document_revision", productSlug: payload.product.slug!, revisionId, revisionNo: 2, documentRef: "example:document", sourceRef: "example:source", canonicalText, digest, provenance: { source: "current_draft" } },
    { op: "move_document_pointer", productSlug: payload.product.slug!, documentRevisionNo: 2 },
    { op: "set_derived_sku_facts", skuCode: data.payload.skus[0].code!, documentRevisionNo: 2, netContent: before.items[0].facts.netContent, facts: { derived: 13 } },
  ];
  const command = await save(payload, data.draftId, 1, first.head), second = await commit(command), page = await authority.readbackV2(second.head);
  if (page.outcome !== "page") throw new Error("Missing cache facts");
  expect(page.items[0].facts.facts).toEqual({ derived: 13 }); expect(page.items[0].facts.source).toEqual(before.items[0].facts.source);
  expect(page.items[0].reference.revision).toBe(2); expect(page.items[0].reference.revisionId).not.toBe(before.items[0].reference.revisionId);
  const candidateRef = `v1:${data.draftId}@2/${second.head.publicationId}@${second.head.revision}`;
  const candidateDigest = createHash("sha256").update('["catalog-candidate",1,').update(canonicalCatalogDraftJson(payload)).update(",")
    .update(canonicalCatalogDraftJson([{ ...payload.product.type, definitionDigest: catalogDefinitionDigest(definition) }])).update(",").update(canonicalCatalogDraftJson(second.head)).update("]").digest("hex");
  const repeated = await commit({ ...command, commandKey: "exact-document-reuse", candidateRef, candidateDigest, expectedHead: second.head });
  expect(repeated.publicationDigest).toBe(second.publicationDigest);
  expect((await db.query("SELECT count(*)::integer AS count FROM public.catalog_product_document_revisions WHERE product_id=$1", [data.productId])).rows[0].count).toBe(2);
  expect((await db.query("SELECT count(*)::integer AS count FROM public.catalog_sku_revisions WHERE sku_id=$1", [data.skuId])).rows[0].count).toBe(2);
  payload.publication.kind = "release"; payload.product.sharedContent.presentation = { routePath: { en: `/cache-${data.productId}` } };
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
  const final = await commit(await save(payload, data.draftId, 2, repeated.head)), retained = await authority.readbackV2(final.head);
  expect(retained).toMatchObject({ outcome: "page", items: page.items });
  await expect(db.query("INSERT INTO public.catalog_attribute_projection(sku_id,publication_revision,attribute_key,definition_version,value_ordinal,value_kind,text_value) VALUES($1,1,'details',1,0,'text','failed later projection')", [randomUUID()])).rejects.toMatchObject({ code: "23503" });
  expect(await authority.readbackV2(final.head)).toEqual(retained);
  expect(await authority.receipt({ productId: data.productId, commandKey: "publish:3" }, actor)).toMatchObject({ outcome: "found", receipt: final });
});

it("catalogue writes preserve an existing agreement, order, clocks and frozen money byte for byte", async () => {
  const data = await draft(), first = await commit(data.publication), customer = randomUUID(), subscription = randomUUID(), order = randomUUID();
  await db.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [customer, `${customer}@example.invalid`]);
  await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,clock_timestamp()+interval '28 days')", [subscription, customer]);
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,3,0,617,'XXX')", [subscription, data.skuId]);
  await db.query("WITH new_order AS (INSERT INTO public.commerce_orders(id,status,currency_code,total_amount_minor) VALUES($1,'paid','XXX',1851) RETURNING id) INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) SELECT id,$2,1,3,617,1851 FROM new_order", [order, data.skuId]);
  const before = await snapshot();
  await commit(await revise(data, first.head));
  const after = await snapshot();
  for (const table of ["subscriptions", "subscription_lines", "commerce_orders", "commerce_order_items", "price_entries"])
    expect(after[table]).toEqual(before[table]);
  expect(after.subscriptions).not.toEqual([]); expect(after.subscription_lines).not.toEqual([]); expect(after.commerce_order_items).not.toEqual([]);
});

// Transport/schema census aliases exercise real reads with corrupt driver responses.
it.each([
  "W38_V5-0253_predicate_precedence_boundary",
  "W38_V5-0254_predicate_precedence_boundary",
  "W38_V5-0255_predicate_precedence_boundary",
  "W38_V5-0256_predicate_precedence_boundary",
  "W38_V5-0257_predicate_precedence_boundary",
  "W38_V5-0258_predicate_precedence_boundary",
  "W38_V5-0259_predicate_precedence_boundary",
  "W38_V5-0260_predicate_precedence_boundary",
  "W38_V5-0261_predicate_precedence_boundary",
  "W38_V5-0262_predicate_precedence_boundary",
  "W38_V5-0263_predicate_precedence_boundary",
  "W38_V5-0264_predicate_precedence_boundary",
  "W38_V5-0265_predicate_precedence_boundary",
  "W38_V5-0266_predicate_precedence_boundary",
  "W38_V5-0267_predicate_precedence_boundary",
  "W38_V5-0268_predicate_precedence_boundary",
  "W38_V5-0269_predicate_precedence_boundary",
  "W38_V5-0270_predicate_precedence_boundary",
  "W38_V5-0271_predicate_precedence_boundary",
  "W38_V5-0272_predicate_precedence_boundary",
  "W38_V5-0273_predicate_precedence_boundary",
  "W38_V5-0274_predicate_precedence_boundary",
  "W38_V5-0275_predicate_precedence_boundary",
  "W38_V5-0276_predicate_precedence_boundary",
  "W38_V5-0277_predicate_precedence_boundary",
  "W38_V5-0278_predicate_precedence_boundary",
  "W38_V5-0279_predicate_precedence_boundary",
  "W38_V5-0280_predicate_precedence_boundary",
  "W38_V5-0281_predicate_precedence_boundary",
  "W38_V5-0282_predicate_precedence_boundary",
  "W38_V5-0283_predicate_precedence_boundary",
  "W38_V5-0284_predicate_precedence_boundary",
  "W38_V5-0285_predicate_precedence_boundary",
  "W38_V5-0286_predicate_precedence_boundary",
  "W38_V5-0287_predicate_precedence_boundary",
  "W38_V5-0288_predicate_precedence_boundary",
  "W38_V5-0289_predicate_precedence_boundary",
  "W38_V5-0290_predicate_precedence_boundary",
  "W38_V5-0291_predicate_precedence_boundary",
  "W38_V5-0292_predicate_precedence_boundary",
  "W38_V5-0293_predicate_precedence_boundary",
  "W38_V5-0294_predicate_precedence_boundary",
  "W38_V5-0295_predicate_precedence_boundary",
  "W38_V5-0296_predicate_precedence_boundary",
  "W38_V5-0297_predicate_precedence_boundary",
  "W38_V5-0298_predicate_precedence_boundary",
  "W38_V5-0299_predicate_precedence_boundary",
  "W38_V5-0300_predicate_precedence_boundary",
  "W38_V5-0301_predicate_precedence_boundary",
  "W38_V5-0302_predicate_precedence_boundary",
  "W38_V5-0303_predicate_precedence_boundary",
  "W38_V5-0304_predicate_precedence_boundary",
  "W38_V5-0305_predicate_precedence_boundary",
  "W38_V5-0731_predicate_precedence_boundary",
  "W38_V5-0732_predicate_precedence_boundary",
  "W38_V5-0733_predicate_precedence_boundary",
  "W38_V5-0737_predicate_precedence_boundary",
  "W38_V5-0738_predicate_precedence_boundary",
  "W38_V5-0739_predicate_precedence_boundary",
  "W38_V5-0740_predicate_precedence_boundary",
  "W38_V5-0741_predicate_precedence_boundary",
  "W38_V5-0742_predicate_precedence_boundary",
  "W38_V5-0743_predicate_precedence_boundary",
  "W38_V5-0744_predicate_precedence_boundary",
  "W38_V5-0745_predicate_precedence_boundary",
  "W38_V5-0746_predicate_precedence_boundary",
  "W38_V5-0747_predicate_precedence_boundary",
  "W38_V5-0748_predicate_precedence_boundary",
  "W38_V5-0749_predicate_precedence_boundary",
  "W38_V5-0750_predicate_precedence_boundary",
  "W38_V5-0751_predicate_precedence_boundary",
  "W38_V5-0752_predicate_precedence_boundary",
  "W38_V5-0753_predicate_precedence_boundary",
  "W38_V5-0754_predicate_precedence_boundary",
  "W38_V5-0755_predicate_precedence_boundary",
  "W38_V5-0756_predicate_precedence_boundary",
  "W38_V5-0759_predicate_precedence_boundary",
  "W38_V5-0760_predicate_precedence_boundary",
  "W38_V5-0761_predicate_precedence_boundary",
  "W38_V5-0762_predicate_precedence_boundary",
  "W38_V5-0763_predicate_precedence_boundary",
  "W38_V5-0764_predicate_precedence_boundary",
  "W38_V5-0765_predicate_precedence_boundary",
  "W38_V5-0766_predicate_precedence_boundary",
  "W38_V5-0767_predicate_precedence_boundary",
  "W38_V5-0768_predicate_precedence_boundary",
  "W38_V5-0769_predicate_precedence_boundary",
  "W38_V5-0770_predicate_precedence_boundary",
  "W38_V5-0771_predicate_precedence_boundary",
  "W38_V5-0772_predicate_precedence_boundary",
  "W38_V5-0773_predicate_precedence_boundary",
  "W38_V5-0774_predicate_precedence_boundary",
  "W38_V5-0775_predicate_precedence_boundary",
  "W38_V5-0776_predicate_precedence_boundary",
  "W38_V5-0777_predicate_precedence_boundary"
])("%s", async () => {
  const faults: { match: string; mutate: (rows: Record<string, unknown>[]) => void }[] = [];
  const manifestQuery = "SELECT p.product_id,p.revision,p.canonical_state";
  faults.push({ match: manifestQuery, mutate: rows => { rows.length = 0; } }, { match: manifestQuery, mutate: rows => { rows.push(rows[0]); } });
  for (const changed of [{ canonical_state: "{}" }, { digest: "a".repeat(64) }, { product_id: randomUUID() }, { document_id: randomUUID() },
    { document_digest: "a".repeat(64) }, { canonical_text: "{}" }, { revision: 0 }])
    faults.push({ match: manifestQuery, mutate: rows => Object.assign(rows[0], changed) });
  for (const match of ["SELECT id,sku_id,revision,digest,octet_length", "SELECT id,full_facts"]) {
    faults.push({ match, mutate: rows => { rows.pop(); } }, { match, mutate: rows => { rows.push(rows[0]); } });
  }
  for (const changed of [{ bytes: 0 }, { bytes: 2_097_153 }, { sku_id: randomUUID() }, { digest: "b".repeat(64) }, { revision: 0 }])
    faults.push({ match: "SELECT id,sku_id,revision,digest,octet_length", mutate: rows => Object.assign(rows[0], changed) });
  for (const full_facts of ["{}", "null", "{", "[]"])
    faults.push({ match: "SELECT id,full_facts", mutate: rows => { rows[0].full_facts = full_facts; } });
  for (const fault of faults) {
    let injected = false;
    const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => { if (sql.startsWith(fault.match)) { fault.mutate(rows); injected = true; } }));
    const response = await target.readbackV2(paged.head);
    expect(response.outcome, JSON.stringify(fault)).not.toBe("page"); expect(injected).toBe(true);
    expect(JSON.stringify(response)).not.toContain("Synthetic private");
  }
  for (const changed of [{ schemaVersion: 9 }, { actorId: randomUUID() }, { fingerprint: "a".repeat(64) }, { productId: randomUUID() },
    { commandKey: "forged" }, { publicationDigest: "a".repeat(64) }, { committedAt: "invalid" },
    { previousHead: { publicationId: randomUUID(), revision: 1, documentDigest: "b".repeat(64) } }]) {
    const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
      if (sql.includes("FROM public.catalog_operator_receipts WHERE") && sql.startsWith("SELECT kind,") && rows[0]) Object.assign(rows[0].result as object, changed);
    }));
    const capability = (await target.authorize(null))!;
    expect((await target.receipt({ productId: paged.data.productId, commandKey: "publish:1" }, capability)).outcome).not.toBe("found");
    expect((await target.publish(paged.data.publication, capability)).outcome).not.toBe("replayed");
  }
  const unavailable = createPostgresCatalogPublication(dependencies(() => { throw new Error("Synthetic private dependency"); }));
  expect(await unavailable.readbackV2(paged.head)).toEqual({ outcome: "dependency_unavailable", reason: "publication_authority_unavailable" });
});

// Dark inputs may be staged; activation still requires exact immutable media evidence.
it.each([
  "W18_V5-0166_predicate_precedence_boundary",
  "W18_V5-0167_predicate_precedence_boundary",
  "W18_V5-0168_predicate_precedence_boundary",
  "W18_V5-0169_predicate_precedence_boundary",
  "W18_V5-0170_predicate_precedence_boundary",
  "W18_V5-0171_predicate_precedence_boundary",
  "W18_V5-0172_predicate_precedence_boundary",
  "W18_V5-0173_predicate_precedence_boundary",
  "W18_V5-0174_predicate_precedence_boundary",
  "W18_V5-0175_predicate_precedence_boundary",
  "W18_V5-0176_predicate_precedence_boundary",
  "W18_V5-0177_predicate_precedence_boundary",
  "W18_V5-0178_predicate_precedence_boundary",
  "W18_V5-0179_predicate_precedence_boundary",
  "W18_V5-1857_predicate_precedence_boundary",
  "W18_V5-1858_predicate_precedence_boundary",
  "W18_V5-1859_predicate_precedence_boundary",
  "W18_V5-1860_predicate_precedence_boundary",
  "W18_V5-2009_predicate_precedence_boundary",
  "W18_V5-2010_predicate_precedence_boundary",
  "W18_V5-2011_predicate_precedence_boundary",
  "W18_V5-2012_predicate_precedence_boundary",
  "W36_V5-0449_predicate_precedence_boundary",
  "W36_V5-0450_predicate_precedence_boundary",
  "W36_V5-0451_predicate_precedence_boundary",
  "W36_V5-0454_predicate_precedence_boundary",
  "W36_V5-0455_predicate_precedence_boundary",
  "W36_V5-0485_predicate_precedence_boundary",
  "W36_V5-0486_predicate_precedence_boundary",
  "W36_V5-0490_predicate_precedence_boundary",
  "W36_V5-0491_predicate_precedence_boundary",
  "W36_V5-0493_predicate_precedence_boundary",
  "W36_V5-0494_predicate_precedence_boundary",
  "W36_V5-0495_predicate_precedence_boundary",
  "W36_V5-0498_predicate_precedence_boundary",
  "W36_V5-0499_predicate_precedence_boundary",
  "W36_V5-0519_predicate_precedence_boundary",
  "W36_V5-0520_predicate_precedence_boundary",
  "W36_V5-0521_predicate_precedence_boundary",
  "W36_V5-0522_predicate_precedence_boundary",
  "W36_V5-0523_predicate_precedence_boundary",
  "W36_V5-0524_predicate_precedence_boundary",
  "W36_V5-0525_predicate_precedence_boundary",
  "W36_V5-0526_predicate_precedence_boundary",
  "W36_V5-0527_predicate_precedence_boundary",
  "W36_V5-0528_predicate_precedence_boundary",
  "W36_V5-0529_predicate_precedence_boundary",
  "W36_V5-0530_predicate_precedence_boundary"
])("%s", async () => {
  const data = await draft(), payload = structuredClone(data.payload), sku = payload.skus[0];
  const first = await commit(data.publication);
  payload.product.sharedContent.catalogAction = "revise";
  payload.publication.operations = payload.publication.operations.filter(operation => operation.op === "set_product_presentation" || operation.op === "set_offer_membership");
  const skuCode = sku.code!, proof = { skuCode, mediaRef: "example:media", assetRefs: ["panel"], revisionDigest: "a".repeat(64) };
  sku.assetRefs = ["panel"]; sku.grossMass = { dimension: "mass", unit: "openlup:g", unscaled: "200", scale: 0 }; sku.logisticsRef = "example:logistics";
  payload.product.sharedContent.presentation.mediaRef = "example:media";
  const presentation = payload.publication.operations.find(op => op.op === "set_product_presentation")!;
  if (presentation.op === "set_product_presentation") presentation.presentation = payload.product.sharedContent.presentation;
  payload.publication.operations.push({ op: "set_sku_metadata", skuCode, logisticsRef: "example:logistics" });
  payload.product.sharedContent.requestedModes = [{ skuCode, modes: ["one_time"] }];
  payload.product.sharedContent.offerMemberships[0].admitted = true;
  const membership = payload.publication.operations.find(op => op.op === "set_offer_membership")!;
  if (membership.op === "set_offer_membership") membership.admitted = true;
  payload.publication.operations.push({ op: "set_eligibility", skuCode, sellableStandalone: true, sellableInSubscription: false }, { op: "set_sku_status", skuCode, status: "active" });
  // No effects can precede these refusals, even when the host cannot prove media.
  for (const [index, claim] of [undefined, { ...proof, assetRefs: ["other"] }, { ...proof, mediaRef: "example:other" }, proof].entries()) {
    if (claim) payload.publication.evidence.media = [claim]; else delete payload.publication.evidence.media;
    const command = await save(payload, data.draftId, index + 1, first.head);
    let checked = false;
    const target = createPostgresCatalogPublication({ ...dependencies(), verifyMedia: async (_executor, supplied) => { checked = true; expect(supplied).toEqual(proof); return false; } });
    const capability = (await target.authorize(null))!;
    const invalidClaim = index === 1 || index === 2;
    if (!invalidClaim) await approve(command, target, capability);
    const before = await snapshot();
    const result = invalidClaim ? await target.decision(approvalCommand(command), capability) : await target.publish(command, capability);
    expect(result).toEqual({ outcome: "validation_issue", reason: invalidClaim ? "catalog_publication_media_evidence_mismatch" : "catalog_publication_media_readiness_unproven" });
    expect(checked).toBe(index === 3); expect(await snapshot()).toEqual(before);
  }
  // Dark media does not imply activation or invoke a proof/readiness network check.
  payload.publication.evidence.media = [proof]; payload.product.sharedContent.requestedModes = [{ skuCode, modes: [] }];
  payload.publication.operations = payload.publication.operations.filter(op => op.op !== "set_eligibility" && op.op !== "set_sku_status");
  const target = createPostgresCatalogPublication({ ...dependencies(), verifyMedia: async () => { throw new Error("Dark media must not need activation proof"); }, globalReadiness: async () => ({ ready: false, reasons: ["unrelated_global_red"] }) });
  const capability = (await target.authorize(null))!, command = await save(payload, data.draftId, 5, first.head);
  await commit(command, target, capability);
});


// Real intrinsic SQL probes and installed readiness refusal are independent of LC3.
it.each([
  "W20_V5-1690_predicate_precedence_boundary",
  "W20_V5-1691_predicate_precedence_boundary",
  "W20_V5-1692_predicate_precedence_boundary",
  "W20_V5-1693_predicate_precedence_boundary",
  "W20_V5-1694_predicate_precedence_boundary",
  "W20_V5-1695_predicate_precedence_boundary",
  "W20_V5-1696_predicate_precedence_boundary",
  "W21_V5-1705_predicate_precedence_boundary",
  "W19_V5-2147_predicate_precedence_boundary",
  "W19_V5-2148_predicate_precedence_boundary",
  "W19_V5-2149_predicate_precedence_boundary",
  "W19_V5-2150_predicate_precedence_boundary",
  "W19_V5-2151_predicate_precedence_boundary",
  "W19_V5-2152_predicate_precedence_boundary",
  "W19_V5-2153_predicate_precedence_boundary",
  "W19_V5-2154_predicate_precedence_boundary",
  "W20_V5-2155_predicate_precedence_boundary",
  "W20_V5-2157_predicate_precedence_boundary",
  "W20_V5-2158_predicate_precedence_boundary",
  "W20_V5-2159_predicate_precedence_boundary",
  "W20_V5-2160_predicate_precedence_boundary",
  "W20_V5-2161_predicate_precedence_boundary",
  "W20_V5-2162_predicate_precedence_boundary",
  "W20_V5-2163_predicate_precedence_boundary",
  "W19_V5-2171_predicate_precedence_boundary",
  "W19_V5-2172_predicate_precedence_boundary"
])("%s", async () => {
  const client = await db.connect(), product = randomUUID(), sku = randomUUID();
  try {
    await client.query("BEGIN");
    expect((await client.query("SELECT public.catalog_publication_sku_reasons($1,true) AS reasons", [sku])).rows[0].reasons).toEqual(["sku_not_materialized"]);
    await client.query("INSERT INTO public.catalog_products(id,slug,name,status) VALUES($1,$2,'Incomplete native product','draft')", [product, `incomplete-${product}`]);
    await client.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$2,$3,'Incomplete native SKU')", [sku, product, `SKU-${sku}`]);
    expect((await client.query("SELECT public.catalog_publication_sku_reasons($1,false) AS reasons", [sku])).rows[0].reasons).toEqual(["document_revision_missing", "primary_sku_missing"]);
    await client.query("UPDATE public.catalog_products SET primary_sku_id=$2 WHERE id=$1", [product, sku]);
    expect((await client.query("SELECT public.catalog_publication_sku_reasons($1,false) AS reasons", [sku])).rows[0].reasons).toEqual(["document_revision_missing"]);
    expect((await client.query("SELECT public.catalog_publication_sku_reasons($1,true) AS reasons", [sku])).rows[0].reasons).toEqual(["document_revision_missing", "unit_gtin_missing", "logistics_reference_missing"]);
    await client.query("UPDATE public.catalog_skus SET status='archived' WHERE id=$1", [sku]);
    expect((await client.query("SELECT public.catalog_publication_sku_reasons($1,true) AS reasons", [sku])).rows[0].reasons).toEqual(["document_revision_missing", "primary_sku_missing", "sku_archived", "unit_gtin_missing", "logistics_reference_missing"]);
  } finally { await client.query("ROLLBACK"); client.release(); }
  const data = await draft(); await approve(data.publication); const before = await snapshot();
  for (const result of [{ ready: false, reasons: ["installed_document_invalid"] }, { ready: false, reasons: ["installed_derived_facts_mismatch"] },
    { ready: false, reasons: ["installed_presentation_missing"] }, { ready: true, reasons: ["contradictory_readiness"] },
    { ready: true, reasons: ["duplicate", "duplicate"] }, { ready: true, reasons: ["private error detail"] }]) {
    const target = createPostgresCatalogPublication({ ...dependencies(), readiness: async () => result });
    const capability = (await target.authorize(null))!;
    expect((await target.publish(data.publication, capability)).outcome).not.toBe("committed"); expect(await snapshot()).toEqual(before);
  }
  const target = createPostgresCatalogPublication({ ...dependencies(), readiness: async (_executor, _state, requirePrice) => { expect(requirePrice).toBe(false); return { ready: true, reasons: [] }; },
    globalReadiness: async () => { throw new Error("No eligibility-on operation must skip global readiness"); }, verifyMedia: async () => { throw new Error("No media must skip media verification"); } });
  const capability = (await target.authorize(null))!;
  expect(await target.publish(data.publication, capability)).toMatchObject({ outcome: "committed" });
});

it("refuses a real concurrent draft advance after candidate resolution and before draft admission", async () => {
  const data = await draft(); await approve(data.publication);
  let signal!: () => void, release!: () => void;
  const observed = new Promise<void>(resolve => { signal = resolve; }), proceed = new Promise<void>(resolve => { release = resolve; });
  let intercepted = false;
  const target = createPostgresCatalogPublication(dependencies(async sql => {
    if (!intercepted && sql.includes("AS live_product")) { intercepted = true; signal(); await proceed; }
  }));
  const capability = (await target.authorize(null))!, pending = target.publish(data.publication, capability);
  let stable;
  try { await observed; await save(data.payload, data.draftId, 1); stable = await snapshot(); }
  finally { release(); }
  expect(await pending).toEqual({ outcome: "conflict", reason: "catalog_publication_draft_advanced" });
  expect(await snapshot()).toEqual(stable);
});
it.each(["material", "inconclusive"] as const)("refuses %s same-SKU physical changes without changing existing obligations", async kind => {
  const data = await draft(), first = await commit(data.publication), payload = structuredClone(data.payload);
  payload.product.sharedContent.catalogAction = "revise"; payload.skus[0].attributes = { details: [kind === "inconclusive" ? "unknown" : "changed physical specification"] };
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: { label: "Revision" } }];
  payload.product.sharedContent.presentation = { label: "Revision" };
  const command = await save(payload, data.draftId, 1, first.head); await approve(command); const before = await snapshot();
  expect(await authority.publish(command, actor)).toEqual({ outcome: "validation_issue", reason: "sku_identity_change_requires_new_sku" });
  expect(await snapshot()).toEqual(before);
});

it.each(["foreign child before contexts", "reserved child prelocks before catalogue effects"])("price boundary: %s", async mode => {
  const data = await draft(), payload = structuredClone(data.payload);
  payload.skus[0].priceOperations = [{ schemaVersion: 1, commandKey: "price:boundary", variantId: data.skuId,
    priceListId: randomUUID(), mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 100, expected: { entryId: null, unitPriceMinor: null } }];
  const command = await save(payload, data.draftId, 1);
  if (mode === "foreign child before contexts") await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status) VALUES($1,$2,$3,'Misbound legacy row','draft')", [data.skuId, foreignPublished.data.productId, payload.skus[0].code]);
  await approve(command); const before = await snapshot(); let prelocked = false;
  const target = createPostgresCatalogPublication({ ...dependencies(), prices: {
    prelock: async (executor, _actor, productId, commands) => {
      prelocked = true; expect(productId).toBe(data.productId); expect(commands).toEqual(payload.skus[0].priceOperations);
      expect((await executor.query("SELECT id FROM public.catalog_products WHERE id=$1", [productId])).rows).toEqual([]);
      expect((await executor.query("SELECT id FROM public.catalog_skus WHERE id=$1", [data.skuId])).rows).toEqual([]);
      throw new Error("Stop after observing the real pre-effect boundary; no price writer is simulated");
    }, applyInTransaction: async () => { throw new Error("This boundary witness must never apply a price"); },
  } });
  const capability = (await target.authorize(null))!, result = await target.publish(command, capability);
  expect(result).toEqual(mode === "foreign child before contexts" ? { outcome: "validation_issue", reason: "catalog_price_parent_mismatch" }
    : { outcome: "dependency_unavailable", reason: "publication_authority_unavailable" });
  expect(prelocked).toBe(mode !== "foreign child before contexts"); expect(await snapshot()).toEqual(before);
});

it("rejects a decision replay body whose candidate or reason does not match its original fingerprint", async () => {
  const data = await draft(), command = await approve(data.publication), before = await snapshot();
  for (const changed of [{ candidateRef: `v1:${randomUUID()}@1/unpublished` }, { candidateDigest: "b".repeat(64) }, { reason: "Altered acknowledgement" }]) {
    const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
      if (sql.includes("FROM public.catalog_operator_receipts WHERE") && sql.startsWith("SELECT kind,")) rows[0].result = { ...rows[0].result as object, ...changed };
    }));
    const capability = (await target.authorize(null))!;
    expect(await target.decision(command, capability)).toEqual({ outcome: "dependency_unavailable", reason: "catalog_publication_receipt_invalid" });
    expect(await snapshot()).toEqual(before);
  }
});


// These fixtures use LC3/LC3P's real native inputs. The zero-cohort baseline is
// the audited, never-populated installation invariant, not fabricated readiness.
async function seedRealReadiness() {
  await priceDb.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ'),('settlement_currency','XXX') ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text");
  await priceDb.query("INSERT INTO public.catalog_products(id,slug,name,status) VALUES($1,'publication-price-anchor','Synthetic price anchor','active')", [anchorSku]);
  await priceDb.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,sellable_standalone,sellable_in_subscription) VALUES($1,$1,'PUBLICATION-PRICE-ANCHOR','Synthetic price anchor','active',true,true)", [anchorSku]);
  await priceDb.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Synthetic publication context','ZZ','XXX',statement_timestamp()-interval '1 hour')", [priceList]);
  await priceDb.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'one_time',1000,statement_timestamp()-interval '1 hour')", [priceList,anchorSku]);
  await priceDb.query(`INSERT INTO public.subscription_price_policy_revisions(id,revision_no,price_list_id,region_code,currency,channel,effective_from,discount_bps,rounding_quantum_minor,rounding_rule,digest)
    SELECT id,1,$1,'ZZ','XXX','D2C',at,1000,10,'FLOOR_TO_QUANTUM',public.catalog_price_setup_policy_digest(id,1,$1,'ZZ','XXX','D2C',at,NULL,1000,10,'FLOOR_TO_QUANTUM')
    FROM (SELECT gen_random_uuid() AS id,date_trunc('milliseconds',statement_timestamp()-interval '1 hour') AS at) v`, [priceList]);
  await priceDb.query("SELECT public.commerce_capture_offer_policy_v2_legacy_baseline()");
  const at = (await priceDb.query("SELECT to_char((statement_timestamp()-interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at")).rows[0].at;
  const acquisition = { id: "example:publication-acquisition", status: "active", trigger_type: "automatic", code: null, discount_type: "percentage", discount_value: 50,
    applies_to_kind: "order_total", applies_to_payload: { cart_mode: "subscription", acquisitionTerms: { schemaVersion: "subscription-acquisition.v1", revision: "example:publication-terms", delivery2DiscountBps: 3500 } },
    stacking_rule: "exclusive", eligibility: { first_subscription_purchase: true }, valid_from: at, valid_to: null, redemption_limit_global: null,
    redemption_limit_per_customer: 1, region_availability: ["ZZ"], promotion_engine_version: "promotion-engine.v2", benefit_lane: "product", benefit_kind: "target_percentage",
    benefit_value_bps: 5000, benefit_value_minor: null, v2_mirror_of: null };
  for (const value of [acquisition, { ...acquisition, id: "example:publication-bundle", promotion_engine_version: "promotion-engine.v1", discount_value: 5,
    applies_to_payload: { cart_mode: "one_time" }, stacking_rule: "stackable_with_any", eligibility: { min_cart_minor: 12000 },
    benefit_kind: "percentage", benefit_value_bps: 500, redemption_limit_per_customer: null }]) {
    const text = JSON.stringify(value);
    await priceDb.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition_fingerprint,definition,active) VALUES($1,$2,$3,true)", [value.id,createHash('sha256').update(text).digest('hex'),text]);
  }
  await priceDb.query(`INSERT INTO public.platform_job_controls(job_name,active_driver,enabled,last_status,last_success_at,metadata)
    VALUES('platform-watchdog','worker',true,'success',statement_timestamp(),'{"promotionReady":true}'),('promotion-claim-sweep','worker',true,'success',statement_timestamp(),'{}')
    ON CONFLICT(job_name) DO UPDATE SET enabled=true,last_status='success',last_success_at=statement_timestamp(),metadata=excluded.metadata`);
  expect((await priceDb.query("SELECT public.commerce_offer_policy_v2_readiness() AS result")).rows[0].result).toMatchObject({ ready: true, reasons: [], evidence: { legacyFrozenCount: 0, legacyFrozenBaselineMatches: true, priceMismatchCount: 0 } });
}
async function inPriceDatabase(work: () => Promise<void>) {
  const previous = db; db = priceDb;
  try { await work(); } finally { db = previous; }
}
function realPriceAuthority(connection?: import("pg").PoolClient, afterQuery?: Parameters<typeof dependencies>[0], verifyMedia?: CatalogPublicationDependencies<null>["verifyMedia"]) {
  const deps = dependencies(afterQuery);
  if (connection) deps.transactions = { async run(work) {
    await connection.query("SAVEPOINT publication_test");
    try { const result = await work({ async query(sql, values) {
      const result = await connection.query(sql, values); await afterQuery?.(sql, connection, result.rows, values); return result;
    } }); await connection.query("RELEASE SAVEPOINT publication_test"); return result; }
    catch(error) { await connection.query("ROLLBACK TO SAVEPOINT publication_test"); throw error; }
  } };
  return createPostgresCatalogPublication({ ...deps, ...(verifyMedia ? { verifyMedia } : {}),
    readiness: async (executor,state,requirePrice) => {
      const reasons: string[] = [];
      for (const sku of state.skus) {
        const priced = requirePrice && (sku.sellableStandalone || sku.sellableInSubscription);
        const value = (await executor.query("SELECT public.catalog_publication_sku_reasons($1,$2) AS reasons",[sku.id,priced])).rows[0]!.reasons;
        if (!Array.isArray(value)) throw new Error("Native readiness contract missing");
        reasons.push(...value as string[]);
        if (priced) {
          const preview = (await executor.query("SELECT public.catalog_price_setup_preview($1,$2,NULL) AS result",[sku.id,priceList])).rows[0]!.result as { outcome: string; currentCount: number; subscription: { kind: string; derivedUnitPriceMinor?: number }; readiness: { ready: boolean; reasons: string[] } };
          if (preview.outcome !== "preview" || preview.currentCount !== 1 || preview.subscription.kind === "unresolved"
            || preview.subscription.kind === "derived" && !(preview.subscription.derivedUnitPriceMinor! > 0)) reasons.push("price_readiness_missing");
        }
      }
      return { ready: reasons.length === 0, reasons: [...new Set(reasons)] };
    },
    globalReadiness: async executor => {
      const { ready, reasons } = (await executor.query("SELECT public.commerce_offer_policy_v2_readiness() AS result")).rows[0]!.result as { ready: boolean; reasons: string[] };
      return { ready, reasons };
    },
  });
}
async function priceDraft(active = true, slug?: string) {
  const data = await draft(slug), payload = structuredClone(data.payload), skuCode = payload.skus[0].code!;
  payload.skus[0].grossMass = { dimension: "mass", unit: "openlup:g", unscaled: "200", scale: 0 };
  payload.skus[0].logisticsRef = "example:logistics";
  payload.publication.operations.push({op:"set_sku_metadata",skuCode,logisticsRef:"example:logistics"});
  payload.skus[0].priceOperations = [{schemaVersion:1,commandKey:`price:${data.skuId}`,variantId:data.skuId,priceListId:priceList,mode:"one_time",minQty:1,amountKind:"gross",unitPriceMinor:1000,expected:{entryId:null,unitPriceMinor:null}}];
  let head: CatalogHeadRef | null = null;
  if (active) {
    head = (await commit(data.publication)).head;
    payload.product.sharedContent.catalogAction = "revise";
    payload.publication.operations = payload.publication.operations.filter(operation => operation.op === "set_product_presentation"
      || operation.op === "set_offer_membership" || operation.op === "set_sku_metadata");
    payload.product.sharedContent.requestedModes = [{skuCode,modes:["one_time"]}];
    payload.product.sharedContent.offerMemberships[0].admitted = true;
    const membership = payload.publication.operations.find(op=>op.op==="set_offer_membership")!; if(membership.op==="set_offer_membership") membership.admitted=true;
    payload.publication.operations.push({op:"set_eligibility",skuCode,sellableStandalone:true,sellableInSubscription:false},{op:"set_sku_status",skuCode,status:"active"});
  }
  return { ...data, payload, publication: await save(payload, data.draftId, 1, head) };
}
const invalidReadiness = { outcome: "dependency_unavailable", reason: "catalog_publication_readiness_invalid" };
const affirmative = { ready: true, reasons: [] };
const red = { ready: false, reasons: ["installed_business_block"] };
it.each([
  ["actor", true, "committed"],
  ["actor", false, "unauthorized"],
  ["actor", "false", "unauthorized"],
  ["structural", affirmative, "committed"],
  ["structural", red, "catalog_publication_v3_structural_readiness_failed"],
  ["structural", { ready: true, reasons: [], extra: true }, invalidReadiness.reason],
  ["structural", { ready: true, reasons: red.reasons }, invalidReadiness.reason],
  ["structural", { ready: false, reasons: [] }, invalidReadiness.reason],
  ["structural", { ready: false, reasons: ["duplicate", "duplicate"] }, invalidReadiness.reason],
  ["structural", null, invalidReadiness.reason],
  ["native", [], "committed"],
  ["native", red.reasons, "catalog_publication_v3_structural_readiness_failed"],
  ["native", { reasons: [] }, invalidReadiness.reason],
  ["native", ["private error detail"], invalidReadiness.reason],
  ["price", affirmative, "committed"],
  ["price", red, "catalog_publication_v3_activation_readiness_failed"],
  ["price", { ready: "true", reasons: [] }, invalidReadiness.reason],
  ["global", affirmative, "committed"],
  ["global", red, "catalog_publication_v3_activation_readiness_failed"],
  ["global", { ...affirmative, malformed: true }, invalidReadiness.reason],
  ["global", new Error("unavailable"), "publication_authority_unavailable"],
  ["media", true, "committed"],
  ["media", false, "catalog_publication_media_readiness_unproven"],
  ["media", "false", invalidReadiness.reason],
  ["media", null, invalidReadiness.reason],
])("publication requires a truthful %s verdict for %j", async (phase, input, expected) => inPriceDatabase(async () => {
  const active = phase === "price" || phase === "global" || phase === "media";
  const data = active ? await priceDraft() : await draft();
  const payload = data.payload;
  let command = data.publication;
  if (phase === "media") {
    const sku = payload.skus[0]!;
    const mediaRef = "example:reviewed-media", assetRefs = ["panel"];
    sku.assetRefs = assetRefs;
    payload.product.sharedContent.presentation.mediaRef = mediaRef;
    const presentation = payload.publication.operations.find(op => op.op === "set_product_presentation")!;
    if (presentation.op === "set_product_presentation") presentation.presentation = payload.product.sharedContent.presentation;
    payload.publication.evidence.media = [{ skuCode: sku.code!, mediaRef, assetRefs, revisionDigest: "a".repeat(64) }];
    command = await save(payload, data.draftId, 2, data.publication.expectedHead);
  }
  await approve(command);
  const before = await snapshot();
  const deps = dependencies((sql, _executor, rows) => {
    if (phase === "native" && sql.startsWith("SELECT public.catalog_publication_sku_reasons")) rows[0]!.reasons = input;
  });
  if (phase === "actor") deps.authorizeHuman = async () => ({
    ok: input as true, role: "admin", isMachineActor: false, userId: admin,
  });
  deps.readiness = async (_executor, _state, price) => phase === (price ? "price" : "structural")
    ? input as typeof affirmative : affirmative;
  deps.globalReadiness = async () => {
    if (input instanceof Error) throw input;
    return phase === "global" ? input as typeof affirmative : affirmative;
  };
  deps.verifyMedia = async () => input as boolean;
  const target = createPostgresCatalogPublication(deps);
  const capability = await target.authorize(null);
  if (expected === "unauthorized") {
    expect(capability).toBeNull();
  } else {
    const result = await target.publish(command, capability!);
    if (expected === "committed") {
      expect(result).toMatchObject({ outcome: "committed" });
      return;
    }
    if (expected === invalidReadiness.reason) expect(result).toEqual(invalidReadiness);
    else expect(result).toEqual({ outcome: expected === "publication_authority_unavailable" ? "dependency_unavailable" : "validation_issue", reason: expected });
  }
  expect(await snapshot()).toEqual(before);
}));

async function priceInputMatrix(group: "context"|"global") {
  const target = realPriceAuthority(), capability = (await target.authorize(null))!;
  const data = await priceDraft(); await approve(data.publication,target,capability);
  const cases: Array<[string,string]> = [["settlement_context_unverified","DELETE FROM public.commerce_settings WHERE key='settlement_region'"],
    ["settlement_context_unverified","DELETE FROM public.commerce_settings WHERE key='settlement_currency'"],
    ["settlement_context_unverified","UPDATE public.commerce_settings SET value_text='invalid' WHERE key='settlement_region'"],
    ["settlement_context_unverified","UPDATE public.commerce_settings SET value_text='invalid' WHERE key='settlement_currency'"]];
  if(group==="global") cases.push(["native_cohort_unverified","DELETE FROM public.commerce_offer_policy_rollout_baselines"],
    ["native_promotion_domain_unverified","UPDATE public.commerce_promotion_definitions SET definition=definition-'discount_value'"],
    ["catalog_publication_v3_activation_readiness_failed","UPDATE public.platform_job_controls SET last_status='failed' WHERE job_name='platform-watchdog'"],
    ["catalog_publication_v3_activation_readiness_failed","UPDATE public.platform_job_controls SET last_status='failed' WHERE job_name='promotion-claim-sweep'"],
    ["catalog_publication_v3_activation_readiness_failed","UPDATE public.subscription_price_policy_revisions SET effective_to=statement_timestamp()-interval '1 second'"]);
  if(group==="global") cases.push(["native_order_policy_pair_unverified","G019"],["native_order_admission_unverified","G031"]);
  for(const [reason,mutation] of cases) {
    const connection=await db.connect();
    try {
      await connection.query("BEGIN"); await connection.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:admin})]);
      if(mutation==="G019"||mutation==="G031") {
        const metadata=mutation==="G019"?{quoteSnapshot:{quote:{context:{pricingPolicy:{offerPolicyVersion:"commerce.offer-policy.v1",promotionEngineVersion:"promotion-engine.v2"}}}}}:{};
        const order=(await connection.query("INSERT INTO public.commerce_orders(status,currency_code,total_amount_minor,metadata) VALUES('pending_payment','XXX',100,$1) RETURNING id",[metadata])).rows[0].id;
        await connection.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,100,100)",[order]);
        await connection.query(`CREATE FUNCTION pg_temp.expose_publication_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE public.commerce_orders SET status='paid' WHERE id='${order}'::uuid; RETURN NEW; END $$`);
        await connection.query("CREATE TRIGGER expose_publication_order AFTER INSERT ON public.price_entries FOR EACH ROW EXECUTE FUNCTION pg_temp.expose_publication_order()");
      } else await connection.query(mutation);
      const before=await snapshot(connection);
      const failing=realPriceAuthority(connection), actor=(await failing.authorize(null))!;
      expect(await failing.publish(data.publication,actor)).toMatchObject({reason}); expect(await snapshot(connection)).toEqual(before);
    } finally {await connection.query("ROLLBACK");connection.release();}
  }
  const result=await publishApproved(data.publication,target,capability);
  expect(result.head.revision).toBe(2);
  expect((await db.query("SELECT public.commerce_offer_policy_v2_readiness() AS value")).rows[0].value).toMatchObject({ready:true,reasons:[]});
}
async function priceActivationMatrix() {
  const data=await priceDraft(), target=realPriceAuthority(), capability=(await target.authorize(null))!;
  const missing=structuredClone(data.payload); delete missing.skus[0].priceOperations;
  const absent=await save(missing,data.draftId,2,data.publication.expectedHead); await approve(absent,target,capability); const before=await snapshot();
  expect((await target.publish(absent,capability)).outcome).not.toBe("committed");expect(await snapshot()).toEqual(before);
  const command=await save(data.payload,data.draftId,3,data.publication.expectedHead); await approve(command,target,capability);
  // A real global red verdict refuses after the child write, and rolls it back.
  // An unavailable settlement context also refuses; neither is a ready stand-in.
  for(const context of ["global red","unknown context"]) {
    try {
      if(context==="global red") await db.query("UPDATE public.platform_job_controls SET last_status='failed' WHERE job_name='platform-watchdog'");
      else await db.query("DELETE FROM public.commerce_settings WHERE key='settlement_currency'");
      const before=await snapshot();
      expect((await target.publish(command,capability)).outcome).toBe(context==="global red"?"validation_issue":"dependency_unavailable");expect(await snapshot()).toEqual(before);
    } finally {
      await db.query("UPDATE public.platform_job_controls SET last_status='success',last_success_at=statement_timestamp() WHERE job_name='platform-watchdog'");
      await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_currency','XXX') ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text");
    }
  }
  const receipt=await publishApproved(command,target,capability);
  const stable=await snapshot();
  expect(await target.publish(command,capability)).toEqual({outcome:"replayed",receipt});expect(await snapshot()).toEqual(stable);
  expect((await db.query("SELECT public.commerce_offer_policy_v2_readiness() AS value")).rows[0].value).toMatchObject({ready:true,reasons:[]});
}

it.each(["W36_V5-0452_predicate_precedence_boundary",
  "W36_V5-0453_predicate_precedence_boundary",
  "W36_V5-0492_predicate_precedence_boundary",
  "W36_V5-0496_predicate_precedence_boundary",
  "W36_V5-0497_predicate_precedence_boundary"]) ("%s", async () => inPriceDatabase(async () => { await priceActivationMatrix(); }));

it.each(["W23_V5-1195_predicate_precedence_boundary",
  "W23_V5-1196_predicate_precedence_boundary",
  "W23_V5-1197_predicate_precedence_boundary",
  "W23_V5-1198_predicate_precedence_boundary",
  "W23_V5-1199_predicate_precedence_boundary",
  "W23_V5-1200_predicate_precedence_boundary",
  "W23_V5-1201_predicate_precedence_boundary",
  "W23_V5-1202_predicate_precedence_boundary",
  "W23_V5-1203_predicate_precedence_boundary",
  "W23_V5-1204_predicate_precedence_boundary"]) ("%s", async () => inPriceDatabase(async () => { await priceInputMatrix("context"); }));

it.each(["W20_V5-1701_predicate_precedence_boundary",
  "W20_V5-1702_predicate_precedence_boundary",
  "W20_V5-1703_predicate_precedence_boundary",
  "W20_V5-2164_predicate_precedence_boundary",
  "W20_V5-2165_predicate_precedence_boundary",
  "W20_V5-2166_predicate_precedence_boundary",
  "W20_V5-2167_predicate_precedence_boundary",
  "W20_V5-2169_predicate_precedence_boundary"]) ("%s", async () => inPriceDatabase(async () => { await priceActivationMatrix(); }));

it.each(["W22_V5-2173_predicate_precedence_boundary",
  "W22_V5-2174_predicate_precedence_boundary",
  "W22_V5-2175_predicate_precedence_boundary",
  "W22_V5-2176_predicate_precedence_boundary",
  "W22_V5-2177_predicate_precedence_boundary",
  "W22_V5-2178_predicate_precedence_boundary",
  "W22_V5-2179_predicate_precedence_boundary",
  "W22_V5-2180_predicate_precedence_boundary",
  "W22_V5-2181_predicate_precedence_boundary",
  "W22_V5-2182_predicate_precedence_boundary",
  "W22_V5-2183_predicate_precedence_boundary",
  "W22_V5-2184_predicate_precedence_boundary",
  "W22_V5-2185_predicate_precedence_boundary",
  "W22_V5-2186_predicate_precedence_boundary",
  "W22_V5-2187_predicate_precedence_boundary",
  "W22_V5-2188_predicate_precedence_boundary",
  "W22_V5-2189_predicate_precedence_boundary",
  "W22_V5-2190_predicate_precedence_boundary",
  "W22_V5-2191_predicate_precedence_boundary",
  "W22_V5-2192_predicate_precedence_boundary",
  "W22_V5-2193_predicate_precedence_boundary",
  "W22_V5-2194_predicate_precedence_boundary",
  "W22_V5-2195_predicate_precedence_boundary",
  "W22_V5-2196_predicate_precedence_boundary",
  "W22_V5-2197_predicate_precedence_boundary",
  "W22_V5-2198_predicate_precedence_boundary",
  "W22_V5-2199_predicate_precedence_boundary",
  "W22_V5-2200_predicate_precedence_boundary",
  "W22_V5-2201_predicate_precedence_boundary",
  "W22_V5-2202_predicate_precedence_boundary",
  "W22_V5-2203_predicate_precedence_boundary",
  "W22_V5-2204_predicate_precedence_boundary",
  "W22_V5-2205_predicate_precedence_boundary",
  "W22_V5-2206_predicate_precedence_boundary",
  "W22_V5-2207_predicate_precedence_boundary",
  "W22_V5-2208_predicate_precedence_boundary",
  "W22_V5-2209_predicate_precedence_boundary",
  "W22_V5-2210_predicate_precedence_boundary",
  "W22_V5-2211_predicate_precedence_boundary",
  "W22_V5-2212_predicate_precedence_boundary",
  "W22_V5-2213_predicate_precedence_boundary",
  "W22_V5-2214_predicate_precedence_boundary",
  "W22_V5-2215_predicate_precedence_boundary",
  "W22_V5-2216_predicate_precedence_boundary",
  "W22_V5-2217_predicate_precedence_boundary",
  "W22_V5-2218_predicate_precedence_boundary",
  "W22_V5-2219_predicate_precedence_boundary",
  "W22_V5-2220_predicate_precedence_boundary",
  "W22_V5-2221_predicate_precedence_boundary",
  "W22_V5-2222_predicate_precedence_boundary",
  "W22_V5-2223_predicate_precedence_boundary",
  "W22_V5-2224_predicate_precedence_boundary",
  "W22_V5-2225_predicate_precedence_boundary",
  "W22_V5-2226_predicate_precedence_boundary",
  "W22_V5-2227_predicate_precedence_boundary",
  "W22_V5-2228_predicate_precedence_boundary",
  "W22_V5-2233_predicate_precedence_boundary",
  "W22_V5-2234_predicate_precedence_boundary",
  "W22_V5-2235_predicate_precedence_boundary",
  "W22_V5-2236_predicate_precedence_boundary",
  "W22_V5-2237_predicate_precedence_boundary",
  "W22_V5-2238_predicate_precedence_boundary",
  "W22_V5-2239_predicate_precedence_boundary",
  "W22_V5-2240_predicate_precedence_boundary",
  "W22_V5-2241_predicate_precedence_boundary",
  "W22_V5-2242_predicate_precedence_boundary",
  "W22_V5-2243_predicate_precedence_boundary"]) ("%s", async () => inPriceDatabase(async () => { await priceInputMatrix("global"); }));

it("catalog_publish_rolls_back_price_and_document_failure", async()=>inPriceDatabase(async()=>{
  const data=await priceDraft(false), target=realPriceAuthority(), capability=(await target.authorize(null))!; await approve(data.publication,target,capability);
  const before=await snapshot(); let written=false;
  const failing=realPriceAuthority(undefined,async(sql,executor)=>{
    if(sql.startsWith("SELECT public.catalog_price_setup_apply_in_transaction")) {
      written=true;expect((await executor.query("SELECT count(*)::integer AS n FROM public.catalog_price_setup_receipts WHERE idempotency_key=$1",[data.payload.skus[0].priceOperations![0].commandKey])).rows[0]!.n).toBe(1);
      expect((await executor.query("SELECT id FROM public.catalog_product_document_revisions WHERE product_id=$1",[data.productId])).rows).toHaveLength(1);
      throw new Error("Failure after real document and child price/receipt effects");
    }
  }), actor=(await failing.authorize(null))!;
  expect((await failing.publish(data.publication,actor)).outcome).toBe("dependency_unavailable");expect(written).toBe(true);expect(await snapshot()).toEqual(before);
}));
it("W45_V5-2156_predicate_precedence_boundary",async()=>inPriceDatabase(async()=>{
  const data=await priceDraft(true,"a".repeat(28)+randomUUID()), target=realPriceAuthority(),capability=(await target.authorize(null))!;
  await approve(data.publication,target,capability); const before=await snapshot();let observed=false;
  const failing=realPriceAuthority(undefined,async(sql,executor)=>{
    if(sql.startsWith("SELECT public.catalog_price_setup_apply_in_transaction")) {
      expect((await executor.query("SELECT public.commerce_offer_policy_v2_readiness() AS value")).rows[0]!.value).toMatchObject({ready:true,reasons:[]});
      expect((await executor.query("SELECT public.catalog_publication_sku_reasons($1,true) AS reasons",[data.skuId])).rows[0]!.reasons).toEqual([]);
      await executor.query("UPDATE public.catalog_products SET slug=$2 WHERE id=$1",[data.productId,"a".repeat(65)]);
      expect((await executor.query("SELECT public.catalog_publication_sku_reasons($1,true) AS reasons",[data.skuId])).rows[0]!.reasons).toEqual(["commerce_identity_unsupported"]);observed=true;
    }
  }), actor=(await failing.authorize(null))!;
  expect(await failing.publish(data.publication,actor)).toMatchObject({reason:"catalog_publication_v3_activation_readiness_failed"});expect(observed).toBe(true);expect(await snapshot()).toEqual(before);
  await publishApproved(data.publication,target,capability);
}));

async function publishApproved(command: CatalogPublishCommand, target: ReturnType<typeof realPriceAuthority>, actor: NonNullable<Awaited<ReturnType<typeof target.authorize>>>) {
  const result=await target.publish(command,actor);expect(result.outcome,JSON.stringify(result)).toBe("committed");
  if(result.outcome!=="committed") throw new Error("Expected real publication");return result.receipt;
}
it.each(["publication first", "standalone first"] as const)(
  "catalog_price_publication_and_standalone_complete_without_deadlock: %s", async order => inPriceDatabase(async () => {
    const data = await priceDraft(false), initial = realPriceAuthority(), actor = (await initial.authorize(null))!;
    const first = await commit(data.publication, initial, actor), baseOperation = data.payload.skus[0].priceOperations![0];
    const [before] = (await db.query("SELECT id,unit_price_minor FROM public.price_entries WHERE variant_id=$1 AND active", [data.skuId])).rows;
    const base = { entryId: before.id as string, unitPriceMinor: before.unit_price_minor as number };
    const standaloneKey = `standalone:${data.skuId}`, parentKey = `publication:${data.skuId}`;
    const makeParent = async ({ entryId, unitPriceMinor }: typeof base, amount: number) => {
      const payload = structuredClone(data.payload);
      payload.skus[0].priceOperations = [{ ...baseOperation, commandKey: parentKey, unitPriceMinor: amount, expected: { entryId, unitPriceMinor } }];
      payload.product.sharedContent.catalogAction = "revise";
      payload.product.sharedContent.presentation = { routePath: { en: `/raced-${data.productId}` } };
      payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
      const command = await save(payload, data.draftId, 2, first.head);
      await approve(command, initial, actor);
      return command;
    };
    const standalone = await db.connect();
    let releaseParent = () => {}, receiveParent!: (value: typeof base) => void, parentPid!: (pid: number) => void;
    const heldParent = new Promise<void>(resolve => { releaseParent = resolve; });
    const parentPrice = new Promise<typeof base>(resolve => { receiveParent = resolve; });
    const publisherPid = new Promise<number>(resolve => { parentPid = resolve; });
    let parent: ReturnType<typeof initial.publish> | undefined;
    const publication = realPriceAuthority(undefined, async (sql, executor, rows) => {
      if (sql.startsWith("SET TRANSACTION"))
        parentPid((await executor.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid as number);
      if (order === "publication first" && sql.startsWith("SELECT public.catalog_price_setup_apply_in_transaction")) {
        const result = rows[0]!.result as { results: { receipt: { current: typeof base } }[] };
        receiveParent(result.results[0].receipt.current);
        await heldParent;
      }
    });
    const publisher = (await publication.authorize(null))!;
    const observe = async (waiting: number, holding: number) => {
      await expect.poll(async () => (await db.query("SELECT wait_event, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1", [waiting])).rows[0])
        .toEqual({ wait_event: "advisory", blockers: [holding] });
    };
    const apply = async ({ entryId, unitPriceMinor }: typeof base, amount: number) => {
      const command = { ...baseOperation, commandKey: standaloneKey, unitPriceMinor: amount, expected: { entryId, unitPriceMinor } };
      const bytes = canonicalCatalogDraftJson(command);
      return (await standalone.query("SELECT public.catalog_price_setup_apply($1,$2) AS value", [bytes, createHash("sha256").update(bytes).digest("hex")])).rows[0].value;
    };
    try {
      await standalone.query("BEGIN");
      await standalone.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: admin })]);
      const standbyPid = (await standalone.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      if (order === "publication first") {
        const command = await makeParent(base, 1200);
        parent = publication.publish(command, publisher);
        const progressed = await Promise.race([parentPrice, parent.then(result => { throw new Error(JSON.stringify(result)); })]);
        const child = apply(progressed, 1300);
        try { await observe(standbyPid, await publisherPid); } finally { releaseParent(); }
        expect(await parent).toMatchObject({ outcome: "committed" });
        expect(await child).toMatchObject({ outcome: "committed", receipt: { current: { unitPriceMinor: 1300 } } });
        await standalone.query("COMMIT");
      } else {
        const child = await apply(base, 1200);
        expect(child).toMatchObject({ outcome: "committed" });
        const command = await makeParent(child.receipt.current, 1300);
        parent = publication.publish(command, publisher);
        try { await observe(await publisherPid, standbyPid); } finally { await standalone.query("COMMIT"); }
        expect(await parent).toMatchObject({ outcome: "committed" });
      }
      expect((await db.query("SELECT unit_price_minor FROM public.price_entries WHERE variant_id=$1 AND active", [data.skuId])).rows)
        .toEqual([{ unit_price_minor: 1300 }]);
      expect((await db.query("SELECT idempotency_key FROM public.catalog_price_setup_receipts WHERE idempotency_key=ANY($1::text[]) ORDER BY idempotency_key",
        [[standaloneKey, parentKey]])).rows).toEqual([{ idempotency_key: parentKey }, { idempotency_key: standaloneKey }]);
    } finally {
      releaseParent();
      await standalone.query("ROLLBACK");
      standalone.release();
      await parent;
    }
  }));

it("catalog_publication_parent_replay_never_reruns_prices",async()=>inPriceDatabase(async()=>{
  let priceCalls=0;
  const data=await priceDraft(), target=realPriceAuthority(undefined,async sql=>{if(sql.startsWith("SELECT public.catalog_price_setup_apply_in_transaction"))priceCalls++;}), actor=(await target.authorize(null))!;
  const receipt=await commit(data.publication,target,actor), previous=(await db.query("SELECT id,unit_price_minor FROM public.price_entries WHERE variant_id=$1 AND active",[data.skuId])).rows[0];
  const command={...data.payload.skus[0].priceOperations![0],commandKey:`later:${data.skuId}`,unitPriceMinor:1500,expected:{entryId:previous.id,unitPriceMinor:previous.unit_price_minor}};
  const connection=await db.connect();
  try {
    await connection.query("BEGIN");await connection.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:admin})]);
    const bytes=canonicalCatalogDraftJson(command);
    expect((await connection.query("SELECT public.catalog_price_setup_apply($1,$2) AS result",[bytes,createHash('sha256').update(bytes).digest('hex')])).rows[0].result.outcome).toBe("committed");await connection.query("COMMIT");
  }finally{await connection.query("ROLLBACK");connection.release();}
  const before=await snapshot(), calls=priceCalls;
  expect(await target.publish(data.publication,actor)).toEqual({outcome:"replayed",receipt});expect(priceCalls).toBe(calls);expect(await snapshot()).toEqual(before);
  expect((await db.query("SELECT unit_price_minor FROM public.price_entries WHERE variant_id=$1 AND active",[data.skuId])).rows).toEqual([{unit_price_minor:1500}]);
}));


it("cycle1 draft physical combinations are unique independent of status", async () => {
  const data = await draft(), first = await commit(data.publication), payload = structuredClone(data.payload), sku = structuredClone(payload.skus[0]);
  sku.id = randomUUID(); sku.code = `SKU-${sku.id}`;
  const gtin = nextGtin(); sku.identifiers = [{ scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1 }];
  payload.skus = [sku]; delete payload.product.primarySkuId; payload.product.sharedContent.catalogAction = "revise";
  const facts = { ...payload.product.sharedContent.publicationSkus[0], skuCode: sku.code };
  payload.product.sharedContent.publicationSkus = [facts]; payload.product.sharedContent.requestedModes = []; payload.product.sharedContent.offerMemberships = [];
  payload.publication.operations = [{ op: "create_sku", productSlug: payload.product.slug!, documentRevisionNo: 1, skuId: sku.id, ...facts },
    { op: "create_identifier", skuCode: sku.code!, scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null }];
  const command = await save(payload, data.draftId, 1, first.head); await approve(command); const before = await snapshot();
  expect(await authority.publish(command, actor)).toEqual({ outcome: "validation_issue", reason: "duplicate_combination" });
  expect(await snapshot()).toEqual(before);
});
it("cycle1 expected head precedes live drift", async () => {
  const data = await draft(), first = await commit(data.publication), command = await revise(data, first.head);
  await approve(command);
  await db.query("UPDATE public.catalog_products SET name='Live drift' WHERE id=$1", [data.productId]);
  const before = await snapshot();
  expect(await authority.publish({ ...command, expectedHead: null }, actor)).toEqual({ outcome: "conflict", reason: "head_conflict" });
  expect(await snapshot()).toEqual(before);
});
it("cycle1 scaled gross mass round trips exactly", async () => {
  const data = await draft(), payload = structuredClone(data.payload);
  payload.skus[0].grossMass = { dimension: "mass", unit: "openlup:g", unscaled: "1005", scale: 1 };
  const receipt = await commit(await save(payload, data.draftId, 1));
  expect(await authority.readbackV2(receipt.head)).toMatchObject({ outcome: "page", items: [{ facts: { grossMass: payload.skus[0].grossMass } }] });
  expect((await db.query("SELECT gross_mass_unscaled::text AS unscaled,gross_mass_scale AS scale FROM public.catalog_skus WHERE id=$1", [data.skuId])).rows).toEqual([{ unscaled: "1005", scale: 1 }]);
});
it.each([["cycle1 retained omitted activation source advanced refuses", "advanced"], ["cycle1 retained omitted activation source abandoned refuses", "abandoned"],
  ["W15_V5-1958_predicate_precedence_boundary", "advanced"], ["W15_V5-1959_predicate_precedence_boundary", "advanced"]] as const)("%s", async (_name, mode) => inPriceDatabase(async () => {
  const target = realPriceAuthority(), capability = (await target.authorize(null))!, data = await priceDraft();
  const first = await commit(data.publication, target, capability), payload = structuredClone(data.payload);
  payload.product.sharedContent.catalogAction = "revise"; delete payload.product.primarySkuId; payload.skus = [];
  payload.product.sharedContent.publicationSkus = []; payload.product.sharedContent.requestedModes = []; payload.product.sharedContent.offerMemberships = [];
  const document = { ...payload.product.sharedContent.document, revisionNo: 2 }, canonicalText = canonicalCatalogDraftJson(document);
  const digest = createHash("sha256").update(canonicalText).digest("hex"), revisionId = randomUUID();
  payload.product.sharedContent.document = document;
  payload.product.documentRevision = { ...payload.product.documentRevision!, id: revisionId, revisionNo: 2, digest };
  payload.publication.operations = [
    { op: "register_document_revision", productSlug: payload.product.slug!, revisionId, revisionNo: 2, documentRef: "example:document", sourceRef: "example:source", canonicalText, digest, provenance: { source: "current_draft" } },
    { op: "move_document_pointer", productSlug: payload.product.slug!, documentRevisionNo: 2 },
  ];
  const command = await save(payload, data.draftId, 2, first.head);
  await approve(command, target, capability);
  if (mode === "abandoned") {
    const text = canonicalCatalogDraftJson({ schemaVersion: 3, action: "abandon", draftId: data.draftId, commandKey: "close-source", expectedRevision: 3 });
    expect((await db.query("SELECT public.catalog_draft_apply($1,$2,'operator:synthetic') AS value", [text,createHash("sha256").update(text).digest("hex")])).rows[0].value.outcome).toBe("committed");
  }
  const before = await snapshot();
  expect(await target.publish(command, capability)).toEqual({ outcome: "conflict", reason: "catalog_publication_draft_advanced" });
  expect(await snapshot()).toEqual(before);
}));
async function withdrawalUnderRed() { await inPriceDatabase(async () => {
  const data = await priceDraft(false), payload = structuredClone(data.payload), second = structuredClone(payload.skus[0]);
  second.id = randomUUID(); second.code = `SKU-${second.id}`;
  second.netContent = { dimension: "mass", unit: "openlup:g", unscaled: "101", scale: 0 };
  second.options = { pack_size: { kind: "quantity", value: second.netContent } };
  const gtin = nextGtin(); second.identifiers = [{ scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1 }];
  second.priceOperations = [{ ...second.priceOperations![0], variantId: second.id, commandKey: `price:${second.id}` }];
  payload.skus.push(second);
  const facts = { ...payload.product.sharedContent.publicationSkus[0], skuCode: second.code };
  payload.product.sharedContent.publicationSkus.push(facts);
  payload.product.sharedContent.requestedModes.push({ skuCode: second.code!, modes: [] });
  payload.product.sharedContent.offerMemberships[0].admitted = true;
  const firstMembership = payload.publication.operations.find(operation => operation.op === "set_offer_membership")!;
  if (firstMembership.op === "set_offer_membership") firstMembership.admitted = true;
  payload.product.sharedContent.offerMemberships.push({ skuCode: second.code!, offerVersion: "example:offer", admitted: true });
  payload.publication.operations.push({ op: "create_sku", skuId: second.id, productSlug: payload.product.slug!, documentRevisionNo: 1, ...facts },
    { op: "create_identifier", skuCode: second.code!, scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null },
    { op: "set_offer_membership", skuCode: second.code!, offerVersion: "example:offer", admitted: true },
    { op: "set_sku_metadata", skuCode: second.code!, logisticsRef: "example:logistics" });
  const initial = await save(payload, data.draftId, 2), target = realPriceAuthority(), capability = (await target.authorize(null))!;
  const structural = await commit(initial, target, capability);
  const activation = structuredClone(payload);
  activation.product.sharedContent.catalogAction = "revise";
  activation.product.sharedContent.requestedModes = activation.skus.map(sku => ({ skuCode: sku.code!, modes: ["one_time"] }));
  activation.publication.operations = activation.skus.flatMap(sku => [
    { op: "set_eligibility", skuCode: sku.code!, sellableStandalone: true, sellableInSubscription: false },
    { op: "set_sku_status", skuCode: sku.code!, status: "active" },
  ]);
  activation.skus.forEach(sku => { delete sku.priceOperations; });
  const first = await commit(await save(activation, data.draftId, 3, structural.head), target, capability);
  const withdrawal = structuredClone(activation);
  withdrawal.product.sharedContent.catalogAction = "revise";
  withdrawal.skus = [withdrawal.skus[0]]; delete withdrawal.skus[0].priceOperations;
  withdrawal.product.sharedContent.publicationSkus = [withdrawal.product.sharedContent.publicationSkus[0]];
  withdrawal.product.sharedContent.offerMemberships = [withdrawal.product.sharedContent.offerMemberships[0]];
  withdrawal.product.sharedContent.requestedModes = [{ skuCode: withdrawal.skus[0].code!, modes: [] }];
  withdrawal.publication.operations = [{ op: "set_eligibility", skuCode: withdrawal.skus[0].code!, sellableStandalone: false, sellableInSubscription: false }];
  const command = await save(withdrawal, data.draftId, 4, first.head), connection = await db.connect();
  try {
    await connection.query("BEGIN"); await connection.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: admin })]);
    await connection.query("UPDATE public.price_entries SET valid_to=statement_timestamp()-interval '1 microsecond' WHERE variant_id=$1 AND valid_to IS NULL", [second.id]);
    await connection.query("UPDATE public.platform_job_controls SET last_status='failed' WHERE job_name='platform-watchdog'");
    expect((await connection.query("SELECT public.commerce_offer_policy_v2_readiness() AS value")).rows[0].value.ready).toBe(false);
    expect((await connection.query("SELECT public.catalog_price_setup_preview($1,$2,NULL) AS value", [second.id, priceList])).rows[0].value.currentCount).toBe(0);
    const readinessReads: string[] = [];
    const scoped = realPriceAuthority(connection, sql => { if (sql.startsWith("SELECT public.catalog_publication_sku_reasons")) readinessReads.push(sql); }), actor = (await scoped.authorize(null))!;
    const receipt = await commit(command, scoped, actor);
    expect(readinessReads).toEqual([]);
    expect(receipt.head.revision).toBe(first.head.revision + 1);
    expect((await connection.query("SELECT id,sellable_standalone FROM public.catalog_skus WHERE product_id=$1 ORDER BY id", [data.productId])).rows).toEqual([
      { id: data.skuId, sellable_standalone: false }, { id: second.id, sellable_standalone: true },
    ].sort((a,b) => a.id.localeCompare(b.id)));
  } finally { await connection.query("ROLLBACK"); connection.release(); }
}); }
it("cycle1 withdrawal under real red readiness ignores an untouched expired sibling", withdrawalUnderRed);

it.each(["draft", "active", "archived"] as const)("cycle1 native physical combination collision refuses %s", async status => {
  const data = await draft(); await commit(data.publication);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await expect(client.query(`INSERT INTO public.catalog_skus SELECT (jsonb_populate_record(NULL::public.catalog_skus,
      to_jsonb(s)||jsonb_build_object('id',$2::text,'sku',$3::text,'status',$4::text))).* FROM public.catalog_skus s WHERE id=$1::uuid`,
      [data.skuId,randomUUID(),`SKU-${randomUUID()}`,status])).rejects.toMatchObject({ code: "23505", constraint: "catalog_skus_publication_combination_key" });
  } finally { await client.query("ROLLBACK"); client.release(); }
});

it("cycle1 affected source requires authored gross mass before simultaneous withdrawal", async () => inPriceDatabase(async () => {
  const data = await priceDraft(), target = realPriceAuthority(), capability = (await target.authorize(null))!;
  const first = await commit(data.publication, target, capability), payload = structuredClone(data.payload);
  payload.product.sharedContent.catalogAction = "revise"; delete payload.skus[0].grossMass; delete payload.skus[0].priceOperations;
  payload.product.sharedContent.requestedModes = [{ skuCode: payload.skus[0].code!, modes: [] }];
  const document = { ...payload.product.sharedContent.document, revisionNo: 2 }, canonicalText = canonicalCatalogDraftJson(document);
  const digest = createHash("sha256").update(canonicalText).digest("hex"), revisionId = randomUUID();
  payload.product.sharedContent.document = document; payload.product.documentRevision = { ...payload.product.documentRevision!, id: revisionId, revisionNo: 2, digest };
  payload.publication.operations = [
    { op: "register_document_revision", productSlug: payload.product.slug!, revisionId, revisionNo: 2, documentRef: "example:document", sourceRef: "example:source", canonicalText, digest, provenance: { source: "current_draft" } },
    { op: "move_document_pointer", productSlug: payload.product.slug!, documentRevisionNo: 2 },
    { op: "set_eligibility", skuCode: payload.skus[0].code!, sellableStandalone: false, sellableInSubscription: false },
  ];
  const command = await save(payload, data.draftId, 2, first.head); await approve(command, target, capability); const before = await snapshot();
  expect(await target.publish(command, capability)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_gross_mass_required" });
  expect(await snapshot()).toEqual(before);
}));

it("cycle1 native reader grammar keeps revision key and cursor boundaries", async () => {
  const productId = randomUUID(), publicationId = randomUUID(), documentDigest = "a".repeat(64);
  for (const revision of [1, 2_147_483_647])
    expect(await authority.readbackV2({ publicationId, revision, documentDigest })).toEqual({ outcome: "unsupported", reason: "catalog_publication_absent" });
  for (const revision of [0, -1, 1.5, 2_147_483_648])
    expect(await authority.readbackV2({ publicationId, revision, documentDigest })).toEqual({ outcome: "validation_issue", reason: "catalog_publication_query_invalid" });
  for (const commandKey of ["x", " ", " x", "x ", "é".repeat(100)]) expect(await authority.receipt({ productId, commandKey }, actor)).toEqual({ outcome: "absent" });
  for (const commandKey of ["", "é".repeat(100) + "x"])
    expect(await authority.receipt({ productId, commandKey }, actor)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_query_invalid" });
  for (const [highWater, before, valid] of [[1, 0, true], [2_147_483_647, 2_147_483_647, true], [0, 0, false],
    [2_147_483_648, 0, false], [1, -1, false], [2_147_483_647, 2_147_483_648, false], [1, 2, false]] as const) {
    const cursor = Buffer.from(canonicalCatalogDraftJson({ schemaVersion: 1, kind: "history", productId, highWater, before })).toString("base64url");
    expect(await authority.reads.history(productId, cursor)).toMatchObject(valid ? { outcome: "page", receipts: [], nextCursor: null }
      : { outcome: "validation_issue", reason: "candidate_invalid" });
  }
});
it("cycle1 native command grammar keeps candidate reason and change boundaries", async () => {
  const data = await draft(), before = await snapshot();
  const decision = { schemaVersion: 2 as const, action: "approve" as const, productId: data.productId, commandKey: "decision:bounds",
    candidateRef: "?", candidateDigest: data.publication.candidateDigest, reason: "x" };
  for (const length of [0, 1, 200, 201]) {
    const candidateRef = "?".repeat(length), reason = "catalog_publication_command_invalid";
    expect(await authority.publish({ ...data.publication, candidateRef }, actor)).toEqual({ outcome: "validation_issue", reason });
    expect(await authority.decision({ ...decision, candidateRef }, actor)).toEqual({ outcome: "validation_issue", reason });
  }
  for (const candidateRef of [`v1:${"-".repeat(36)}@1/unpublished`, `v1:${data.draftId}@2147483648/unpublished`]) {
    expect(await authority.publish({ ...data.publication, candidateRef }, actor)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_command_invalid" });
    expect(await authority.decision({ ...decision, candidateRef }, actor)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_command_invalid" });
  }
  for (const length of [0, 1, 1000, 1001])
    expect(await authority.decision({ ...decision, productId: randomUUID(), candidateRef: data.publication.candidateRef, reason: "x".repeat(length) }, actor)).toEqual({ outcome: "validation_issue",
      reason: length >= 1 && length <= 1000 ? "candidate_invalid" : "catalog_publication_command_invalid" });
  for (const expectedRevision of [-1, 0, 2_147_483_646, 2_147_483_647])
    expect(await authority.publish({ ...data.publication, changes: [{ variantId: data.skuId, expectedRevision, state: "active" }] }, actor))
      .toEqual({ outcome: "validation_issue", reason: expectedRevision >= 0 && expectedRevision <= 2_147_483_646 ? "catalog_publication_approval_required" : "catalog_publication_command_invalid" });
  for (const count of [10_000, 10_001])
    expect(await authority.publish({ ...data.publication, changes: Array.from({ length: count }, () => ({ variantId: data.skuId, expectedRevision: 0, state: "active" as const })) }, actor))
      .toEqual({ outcome: "validation_issue", reason: count === 10_000 ? "catalog_publication_approval_required" : "catalog_publication_command_invalid" });
  expect(await snapshot()).toEqual(before);
});

it("cycle1 native receipt observation accepts a one-character SKU and rejects empty transport facts", async () => {
  const data = await draft(undefined, "X"), receipt = await commit(data.publication), before = await snapshot();
  expect(receipt.changes[0].sku).toBe("X");
  expect(await authority.receipt({ productId: data.productId, commandKey: data.publication.commandKey }, actor)).toEqual({ outcome: "found", receipt });
  const damaged = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
    if (sql.includes("FROM public.catalog_operator_receipts WHERE") && sql.startsWith("SELECT kind,")) for (const row of rows) {
      const result = row.result as typeof receipt;
      row.result = { ...result, changes: result.changes.map(change => ({ ...change, sku: "" })) };
    }
  }));
  const capability = (await damaged.authorize(null))!;
  expect(await damaged.receipt({ productId: data.productId, commandKey: data.publication.commandKey }, capability))
    .toEqual({ outcome: "dependency_unavailable", reason: "publication_authority_unavailable" });
  expect(await snapshot()).toEqual(before);
});

it("cycle1 native publication rolls back primitive null and code-less adapter errors", async () => {
  const data = await draft(); await approve(data.publication); const before = await snapshot();
  const codeLess = new Proxy({}, { has: () => false, get: () => { throw new Error("Unrequested synthetic error field"); } });
  for (const error of [null, undefined, false, 17, "Synthetic adapter outage", {}, new Error("Synthetic adapter outage"), codeLess]) {
    const target = createPostgresCatalogPublication({ ...dependencies(), readiness: async () => { throw error; } });
    const capability = (await target.authorize(null))!;
    await expect(target.publish(data.publication, capability)).resolves.toEqual({ outcome: "dependency_unavailable", reason: "publication_authority_unavailable" });
    expect(await snapshot()).toEqual(before);
  }
});

it.each(["candidate", "live"] as const)("cycle1 native expected head independently binds the %s head", async mismatch => {
  const data = await draft(), first = await commit(data.publication), second = await commit(await revise(data, first.head));
  const payload = structuredClone(data.payload); payload.product.sharedContent.catalogAction = "revise";
  payload.product.sharedContent.presentation = { routePath: { en: `/third-${data.productId}` } };
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
  const command = await save(payload, data.draftId, 2, first.head); await approve(command); const before = await snapshot();
  expect(await authority.publish({ ...command, expectedHead: mismatch === "candidate" ? second.head : first.head }, actor))
    .toEqual({ outcome: "conflict", reason: "head_conflict" });
  expect(await snapshot()).toEqual(before);
});
it("cycle1 native actor membership response refuses extra rows", async () => {
  const data = await draft(); await approve(data.publication); const before = await snapshot(); let injected = false;
  const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
    if (sql.includes("platform_human_membership_is_administrator")) { rows.push({ ...rows[0] }); injected = true; }
  }));
  const capability = (await target.authorize(null))!;
  expect(await target.publish(data.publication, capability)).toEqual({ outcome: "unauthorized", reason: "publisher_not_authorized" });
  expect(injected).toBe(true); expect(await snapshot()).toEqual(before);
});
it("cycle1 native current load rejects corrupt manifest transport fields", async () => {
  const data = await draft(); await commit(data.publication); const before = await snapshot();
  const faults: ((rows: Record<string, unknown>[]) => void)[] = [
    rows => { rows.push(structuredClone(rows[0])); },
    rows => { (rows[0].publication as Record<string, unknown>).product_id = randomUUID(); },
    rows => { (rows[0].publication as Record<string, unknown>).digest = "c".repeat(64); },
    rows => { const publication = rows[0].publication as Record<string, unknown>, manifest = JSON.parse(publication.canonical_state as string); manifest.product.id = randomUUID(); publication.canonical_state = canonicalCatalogDraftJson(manifest); publication.digest = createHash("sha256").update(publication.canonical_state as string).digest("hex"); },
    rows => { const documents = rows[0].documents as Record<string, unknown>[]; documents[0].source_ref = "example:foreign"; },
    rows => { const documents = rows[0].documents as Record<string, unknown>[]; documents[0].canonical_text = "{}"; },
    rows => { const publication = rows[0].publication as Record<string, unknown>; publication.canonical_state = ` ${publication.canonical_state as string} `; },
  ];
  for (const fault of faults) {
    let injected = false;
    const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
      if (sql.startsWith("SELECT (SELECT to_jsonb(h)")) { fault(rows); injected = true; }
    }));
    expect(await target.reads.current(data.productId)).toEqual({ outcome: "dependency_unavailable", reason: "publication_authority_unavailable" });
    expect(injected).toBe(true);
  }
  expect(await snapshot()).toEqual(before);
});
it("cycle1 native historical load never fabricates absent lineage", async () => {
  const data = await draft(), receipt = await commit(data.publication), before = await snapshot(); let injected = false;
  const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
    if (sql.startsWith("SELECT (SELECT to_jsonb(h)")) { rows[0].publication = null; rows[0].live_product = null; injected = true; }
  }));
  expect(await target.reads.readback(receipt.head)).toEqual({ outcome: "unsupported", reason: "publication_not_supported" });
  expect(injected).toBe(true); expect(await snapshot()).toEqual(before);
});

it("cycle1 native publish names incomplete document and SKU transport refusals", async () => {
  const data = await draft(), first = await commit(data.publication), command = await revise(data, first.head); await approve(command); const before = await snapshot();
  const faults: [string, (row: Record<string, unknown>) => void][] = [
    ["catalog_publication_document_invalid", row => { row.documents = []; }],
    ["catalog_publication_document_invalid", row => { (row.documents as Record<string, unknown>[])[0].source_ref = "example:foreign"; }],
    ["catalog_publication_document_invalid", row => { (row.documents as Record<string, unknown>[])[0].canonical_text = "{}"; }],
    ["catalog_publication_sku_revision_invalid", row => { row.revisions = []; }],
    ["catalog_publication_sku_revision_invalid", row => { (row.revisions as Record<string, unknown>[])[0].id = randomUUID(); }],
    ["catalog_publication_sku_revision_invalid", row => { (row.revisions as Record<string, unknown>[])[0].full_facts = 0; }],
    ["catalog_publication_sku_revision_invalid", row => { const revision = (row.revisions as Record<string, unknown>[])[0], facts = JSON.parse(revision.full_facts as string); facts.title = "Changed transport title"; revision.full_facts = canonicalCatalogDraftJson(facts); }],
    ["catalog_publication_sku_revision_invalid", row => { (row.revisions as Record<string, unknown>[])[0].digest = "c".repeat(64); }],
    ["catalog_publication_sku_revision_invalid", row => { const revision = (row.revisions as Record<string, unknown>[])[0]; revision.full_facts = ` ${revision.full_facts as string} `; }],
    ["catalog_publication_sku_revision_invalid", row => { (row.revisions as Record<string, unknown>[])[0].sku_id = randomUUID(); }],
    ["catalog_publication_sku_revision_invalid", row => { (row.revisions as Record<string, unknown>[])[0].revision = 2; }],
  ];
  for (const [reason, fault] of faults) {
    let injected = false;
    const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
      if (sql.startsWith("SELECT (SELECT to_jsonb(h)")) { fault(rows[0]); injected = true; }
    }));
    const capability = (await target.authorize(null))!;
    expect(await target.publish(command, capability)).toEqual({ outcome: "dependency_unavailable", reason });
    expect(injected).toBe(true); expect(await snapshot()).toEqual(before);
  }
});

it("cycle1 native legacy readback retains A exactly after B changes live projections", async () => {
  const data = await draft(), first = await commit(data.publication), retained = await authority.reads.readback(first.head);
  expect(retained).toMatchObject({ outcome: "found", head: first.head });
  const second = await commit(await revise(data, first.head));
  expect(await authority.reads.readback(first.head)).toEqual(retained);
  expect(await authority.reads.current(data.productId)).toMatchObject({ outcome: "found", head: second.head });
});
it("cycle1 native current read refuses every mismatched live projection field", async () => {
  const data = await draft(); await commit(data.publication); const before = await snapshot();
  const faults: ((row: Record<string, unknown>) => void)[] = [row => { row.live_product = null; },
    row => { (row.live_skus as unknown[]).pop(); }, row => { (row.live_skus as unknown[]).push(structuredClone((row.live_skus as unknown[])[0])); }];
  for (const [field, value] of Object.entries({ publication_facts: {}, slug: "other", name: "Other", status: "archived", primary_sku_id: randomUUID(), current_document_revision_id: randomUUID() }))
    faults.push(row => { (row.live_product as Record<string, unknown>)[field] = value; });
  for (const [field, value] of Object.entries({ id: randomUUID(), publication_facts: {}, sku: "OTHER", title: "Other", status: "archived",
    sellable_standalone: true, sellable_in_subscription: true, min_order_qty: 2, is_addon: true }))
    faults.push(row => { (row.live_skus as Record<string, unknown>[])[0][field] = value; });
  for (const fault of faults) {
    let injected = false;
    const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
      if (sql.startsWith("SELECT (SELECT to_jsonb(h)")) { fault(rows[0]); injected = true; }
    }));
    expect(await target.reads.current(data.productId)).toEqual({ outcome: "conflict", reason: "head_conflict" });
    expect(injected).toBe(true);
  }
  expect(await snapshot()).toEqual(before);
});
it("cycle1 native loaded SKU identity matches the manifest despite a correlated transport digest", async () => {
  const data = await draft(); await commit(data.publication); const before = await snapshot();
  for (const field of ["id", "productId"]) {
    let injected = false;
    const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
      if (!sql.startsWith("SELECT (SELECT to_jsonb(h)")) return;
      const row = rows[0], revision = (row.revisions as Record<string, unknown>[])[0], facts = JSON.parse(revision.full_facts as string);
      facts[field] = randomUUID(); revision.full_facts = canonicalCatalogDraftJson(facts);
      revision.digest = createHash("sha256").update(revision.full_facts as string).digest("hex");
      const publication = row.publication as Record<string, unknown>, manifest = JSON.parse(publication.canonical_state as string);
      manifest.skus.find((reference: { revisionId: string }) => reference.revisionId === revision.id).digest = revision.digest;
      publication.canonical_state = canonicalCatalogDraftJson(manifest); publication.digest = createHash("sha256").update(publication.canonical_state as string).digest("hex");
      injected = true;
    }));
    expect(await target.reads.current(data.productId)).toEqual({ outcome: "dependency_unavailable", reason: "publication_authority_unavailable" });
    expect(injected).toBe(true);
  }
  expect(await snapshot()).toEqual(before);
});


it("catalog_publication_preserves_integer_grams_at_native_boundaries", async () => {
  const data = await draft(), payload = structuredClone(data.payload);
  payload.skus[0].netContent = { dimension: "mass", unit: "openlup:g", unscaled: "2147483647", scale: 0 };
  payload.skus[0].grossMass = { dimension: "mass", unit: "openlup:g", unscaled: "9999999999999999999999999999999999999999", scale: 0 };
  const receipt = await commit(await save(payload, data.draftId, 1));
  expect((await db.query("SELECT net_weight_g,net_content_unscaled::text AS net,gross_mass_unscaled::text AS gross FROM public.catalog_skus WHERE id=$1", [data.skuId])).rows)
    .toEqual([{ net_weight_g: 2147483647, net: "2147483647", gross: "9999999999999999999999999999999999999999" }]);
  expect(await authority.readbackV2(receipt.head)).toMatchObject({ outcome: "page", items: [{ facts: { netContent: payload.skus[0].netContent, grossMass: payload.skus[0].grossMass } }] });
});


// Opaque presentation checks and localized uniqueness belong to the installed adapter.
it.each([
  "W09_V5-1717_predicate_precedence_boundary",
  "W09_V5-1718_predicate_precedence_boundary",
  "W09_V5-1719_predicate_precedence_boundary",
  "W09_V5-1720_predicate_precedence_boundary",
  "W09_V5-1721_predicate_precedence_boundary",
  "W09_V5-1722_predicate_precedence_boundary",
  "W09_V5-1723_predicate_precedence_boundary",
  "W09_V5-1724_predicate_precedence_boundary",
  "W09_V5-1725_predicate_precedence_boundary",
  "W09_V5-1726_predicate_precedence_boundary",
  "W09_V5-1727_predicate_precedence_boundary",
  "W09_V5-1729_predicate_precedence_boundary",
  "W09_V5-1730_predicate_precedence_boundary",
  "W09_V5-1731_predicate_precedence_boundary",
  "W09_V5-1732_predicate_precedence_boundary",
  "W09_V5-1733_predicate_precedence_boundary",
  "W09_V5-1734_predicate_precedence_boundary",
  "W09_V5-1735_predicate_precedence_boundary",
  "W09_V5-1736_predicate_precedence_boundary"
])("%s", async () => {
  const data = await draft(), payload = structuredClone(data.payload);
  const route = (foreignPublished.data.payload.product.sharedContent.presentation.routePath as { en: string }).en;
  payload.product.sharedContent.presentation = { routePath: { en: route } };
  const presentation = payload.publication.operations.find(op => op.op === "set_product_presentation")!;
  if (presentation.op === "set_product_presentation") presentation.presentation = payload.product.sharedContent.presentation;
  const command = await save(payload, data.draftId, 1); await approve(command); const before = await snapshot();
  let observed = false;
  const target = createPostgresCatalogPublication({ ...dependencies(), readiness: async (executor, state, requirePrice) => {
    expect(requirePrice).toBe(false); observed = true;
    const rows = (await executor.query("SELECT id FROM public.catalog_products WHERE id<>$1 AND publication_facts->'presentation'->'routePath'->>'en'=$2", [state.product.id, route])).rows;
    return { ready: rows.length === 0, reasons: rows.length ? ["localized_route_duplicate"] : [] };
  } });
  const capability = (await target.authorize(null))!;
  expect(await target.publish(command, capability)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_v3_structural_readiness_failed" });
  expect(observed).toBe(true); expect(await snapshot()).toEqual(before);
});


it("cycle1 active product requires an active eligible primary", async () => {
  const data = await draft(), payload = structuredClone(data.payload);
  payload.publication.operations.push({ op: "set_product_status", productSlug: payload.product.slug!, status: "active" });
  const command = await save(payload, data.draftId, 1); await approve(command); const before = await snapshot();
  expect(await authority.publish(command, actor)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_v3_active_primary_required" });
  expect(await snapshot()).toEqual(before);
});


it.each(["W21_V5-1706_predicate_precedence_boundary",
  "W21_V5-1707_predicate_precedence_boundary"]) ("%s", withdrawalUnderRed);

it("cycle1 native projection failures distinguish live drift from an executor outage", async () => {
  const data = await draft(), first = await commit(data.publication), command = await revise(data, first.head); await approve(command);
  const failed = createPostgresCatalogPublication(dependencies(sql => { if (sql.startsWith("SELECT p.publication_facts=")) throw new Error("Synthetic projection executor outage"); }));
  expect(await failed.reads.current(data.productId)).toEqual({ outcome: "dependency_unavailable", reason: "publication_authority_unavailable" });
  const original = (await db.query("SELECT net_weight_g FROM public.catalog_skus WHERE id=$1", [data.skuId])).rows[0].net_weight_g;
  try {
    await db.query("UPDATE public.catalog_skus SET net_weight_g=net_weight_g+1 WHERE id=$1", [data.skuId]); const before = await snapshot();
    expect(await authority.reads.current(data.productId)).toEqual({ outcome: "conflict", reason: "head_conflict" });
    expect(await authority.publish(command, actor)).toEqual({ outcome: "conflict", reason: "catalog_publication_live_drift" });
    expect(await snapshot()).toEqual(before);
  } finally { await db.query("UPDATE public.catalog_skus SET net_weight_g=$2 WHERE id=$1", [data.skuId, original]); }
});
it("cycle1 native publication replay refuses another real human and malformed receipt columns", async () => {
  const data = await draft(); await commit(data.publication);
  const other = randomUUID(); await db.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [other, `${other}@example.invalid`]);
  await db.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())", [other]);
  const otherAuthority = createPostgresCatalogPublication({ ...dependencies(), authorizeHuman: async () => ({ ok: true, userId: other, role: "admin", isMachineActor: false }) });
  const otherActor = (await otherAuthority.authorize(null))!; const before = await snapshot();
  expect(await otherAuthority.publish(data.publication, otherActor)).toEqual({ outcome: "conflict", reason: "catalog_publication_command_key_reused" });
  for (const mode of ["extra row", "kind", "fingerprint"]) {
    const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
      if (!sql.includes("FROM public.catalog_operator_receipts WHERE") || !sql.startsWith("SELECT kind,")) return;
      if (mode === "extra row") rows.push(structuredClone(rows[0]));
      if (mode === "kind") rows[0].kind = "approve";
      if (mode === "fingerprint") rows[0].fingerprint = "c".repeat(64);
    }));
    const capability = (await target.authorize(null))!;
    expect(await target.publish(data.publication, capability)).toEqual(mode === "fingerprint"
      ? { outcome: "conflict", reason: "catalog_publication_command_key_reused" }
      : { outcome: "dependency_unavailable", reason: "catalog_publication_receipt_invalid" });
  }
  expect(await snapshot()).toEqual(before);
});
it("cycle1 native decision replay binds every receipt identity field", async () => {
  const data = await draft(), decision = await approve(data.publication), before = await snapshot();
  for (const changed of [{ productId: randomUUID() }, { commandKey: "other:decision" }, { fingerprint: "c".repeat(64) },
    { actorId: randomUUID() }, { action: "revoke" }, { candidateRef: "other" }, { candidateDigest: "c".repeat(64) }, { reason: "Other reason" }]) {
    const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
      if (sql.includes("FROM public.catalog_operator_receipts WHERE") && sql.startsWith("SELECT kind,") && rows[0]) Object.assign(rows[0].result as object, changed);
    }));
    const capability = (await target.authorize(null))!;
    expect(await target.decision(decision, capability)).toEqual({ outcome: "dependency_unavailable", reason: "catalog_publication_receipt_invalid" });
    expect(await snapshot()).toEqual(before);
  }
});

it("cycle1 native receipt recovery never substitutes a later real publication body", async () => {
  const data = await draft(), first = await commit(data.publication), second = await commit(await revise(data, first.head)), before = await snapshot();
  const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
    if (sql.includes("FROM public.catalog_operator_receipts WHERE") && sql.startsWith("SELECT kind,") && rows[0]?.command_key === first.commandKey)
      rows[0].result = { ...second, commandKey: first.commandKey, fingerprint: first.fingerprint };
  }));
  const capability = (await target.authorize(null))!;
  expect(await target.receipt({ productId: data.productId, commandKey: first.commandKey }, capability))
    .toEqual({ outcome: "dependency_unavailable", reason: "catalog_publication_receipt_invalid" });
  expect(await target.publish(data.publication, capability)).toEqual({ outcome: "dependency_unavailable", reason: "catalog_publication_receipt_invalid" });
  expect(await snapshot()).toEqual(before);
});

it("cycle1 native B receipt metadata stays bound to its real publication and predecessor A", async () => {
  const data = await draft(), first = await commit(data.publication), command = await revise(data, first.head), second = await commit(command), before = await snapshot();
  for (const field of ["missing", "extra", "revision", "document_digest", "digest", "committed_at", "previous_id", "previous_revision", "previous_document_digest"]) {
    let injected = false;
    const target = createPostgresCatalogPublication(dependencies(async (sql, executor, rows) => {
      if (!sql.startsWith("SELECT p.revision,p.digest,d.digest AS document_digest")) return;
      if (field === "missing") rows.length = 0;
      else if (field === "extra") rows.push(structuredClone(rows[0]));
      else if (field === "committed_at") rows[0].committed_at = (await executor.query("SELECT to_char(($1::timestamptz+interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value", [rows[0].committed_at])).rows[0].value;
      else if (field === "revision" || field === "previous_revision") rows[0][field] = Number(rows[0][field]) + 1;
      else rows[0][field] = field === "previous_id" ? randomUUID() : "c".repeat(64);
      injected = true;
    }));
    const capability = (await target.authorize(null))!;
    expect(await target.receipt({ productId: data.productId, commandKey: second.commandKey }, capability))
      .toEqual({ outcome: "dependency_unavailable", reason: "catalog_publication_receipt_invalid" });
    expect(injected).toBe(true); expect(await snapshot()).toEqual(before);
  }
  const scoped = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
    if (sql.includes("FROM public.catalog_operator_receipts WHERE") && sql.startsWith("SELECT kind,")) rows[0].scope_id = randomUUID();
  }));
  expect(await scoped.receipt({ productId: data.productId, commandKey: second.commandKey }, (await scoped.authorize(null))!))
    .toEqual({ outcome: "dependency_unavailable", reason: "catalog_publication_receipt_invalid" });
  expect(await snapshot()).toEqual(before);
});

it("cycle1 native candidate binds product version and referenced publication head", async () => {
  const data = await draft(), other = await draft(), first = await commit(data.publication), next = await revise(data, first.head), before = await snapshot();
  const command = { schemaVersion: 2 as const, action: "approve" as const, productId: data.productId, commandKey: "candidate:binding",
    candidateRef: next.candidateRef, candidateDigest: next.candidateDigest, reason: "Verify candidate identity" };
  expect(await authority.decision({ ...command, candidateRef: other.publication.candidateRef, candidateDigest: other.publication.candidateDigest }, actor)).toEqual({ outcome: "validation_issue", reason: "candidate_invalid" });
  expect(await authority.decision({ ...command, candidateRef: next.candidateRef.replace(`/${first.head.publicationId}@${first.head.revision}`, `/${first.head.publicationId}@${first.head.revision + 1}`) }, actor))
    .toEqual({ outcome: "conflict", reason: "head_conflict" });
  for (const count of [0, 2]) {
    const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
      if (sql.startsWith("SELECT p.id,p.revision,d.digest FROM public.catalog_publications")) {
        if (count === 0) rows.length = 0; else rows.push(structuredClone(rows[0]));
      }
    }));
    expect(await target.decision(command, (await target.authorize(null))!)).toEqual({ outcome: "conflict", reason: "head_conflict" });
  }
  for (const version of [1, 2]) {
    const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
      if (sql.startsWith("SELECT public.catalog_draft_record")) {
        const record = rows[0].record as { payload: Record<string, unknown> };
        delete record.payload.publication; record.payload.schemaVersion = version;
      }
    }));
    expect(await target.decision(command, (await target.authorize(null))!)).toEqual({ outcome: "validation_issue", reason: "candidate_invalid" });
  }
  expect(await snapshot()).toEqual(before);
});

it("cycle1 native candidate refuses missing validator and changed installed definition evidence", async () => {
  const data = await draft(), before = await snapshot();
  const command = { schemaVersion: 2 as const, action: "approve" as const, productId: data.productId, commandKey: "candidate:definition",
    candidateRef: data.publication.candidateRef, candidateDigest: data.publication.candidateDigest, reason: "Verify installed definition" };
  const absent = createPostgresCatalogPublication({ ...dependencies(), registry: createCatalogProductTypeRegistry([]) });
  expect(await absent.decision(command, (await absent.authorize(null))!)).toEqual({ outcome: "validation_issue", reason: "catalog_definition_drift" });
  for (const mode of ["missing", "extra", "changed"] as const) {
    const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
      if (sql.startsWith("SELECT definition_digest FROM public.catalog_type_versions")) {
        if (mode === "missing") rows.length = 0;
        else if (mode === "extra") rows.push(structuredClone(rows[0]));
        else rows[0].definition_digest = "c".repeat(64);
      }
    }));
    expect(await target.decision(command, (await target.authorize(null))!)).toEqual({ outcome: "validation_issue", reason: "catalog_definition_drift" });
  }
  const withoutValidator = { ...definition, validatorRef: undefined };
  const target = createPostgresCatalogPublication({ ...dependencies(), registry: createCatalogProductTypeRegistry([withoutValidator]) });
  expect(await target.decision(command, (await target.authorize(null))!)).toEqual({ outcome: "validation_issue", reason: "catalog_definition_drift" });
  expect(await snapshot()).toEqual(before);
});

it("cycle1 native publication locks and verifies its installed active tax class", async () => {
  const taxDefinition = { ...definition, key: "example:taxed-article", taxClass: "example:publication-tax" };
  await installCatalogDefinitions(db, { id: "example:publication-tax", namespace: "example", version: 1, openlupRange: "^1.0.0", capabilities: { publish: false }, types: [taxDefinition], taxClasses: [{ key: taxDefinition.taxClass }] });
  const data = await draft(), payload = structuredClone(data.payload); payload.product.type.key = taxDefinition.key;
  const command = await save(payload, data.draftId, 1);
  command.candidateDigest = createHash("sha256").update('["catalog-candidate",1,').update(canonicalCatalogDraftJson(payload)).update(",")
    .update(canonicalCatalogDraftJson([{ ...payload.product.type, definitionDigest: catalogDefinitionDigest(taxDefinition) }])).update(",null]").digest("hex");
  const target = createPostgresCatalogPublication({ ...dependencies(), registry: createCatalogProductTypeRegistry([taxDefinition]) }), capability = (await target.authorize(null))!;
  await approve(command, target, capability);
  const before = await snapshot();
  for (const count of [0, 2]) {
    const damaged = createPostgresCatalogPublication({ ...dependencies((sql, _executor, rows) => {
      if (sql.startsWith("SELECT key FROM public.catalog_tax_classes")) { if (count === 0) rows.length = 0; else rows.push(structuredClone(rows[0])); }
    }), registry: createCatalogProductTypeRegistry([taxDefinition]) });
    const identity = (await damaged.authorize(null))!;
    expect(await damaged.publish(command, identity)).toEqual({ outcome: "validation_issue", reason: "catalog_tax_class_unavailable" });
    expect(await snapshot()).toEqual(before);
  }
  await db.query("UPDATE public.catalog_tax_classes SET status='retired' WHERE key=$1", [taxDefinition.taxClass]);
  try { expect(await target.publish(command, capability)).toEqual({ outcome: "validation_issue", reason: "catalog_tax_class_unavailable" }); }
  finally { await db.query("UPDATE public.catalog_tax_classes SET status='active' WHERE key=$1", [taxDefinition.taxClass]); }
  expect(await snapshot()).toEqual(before);
  expect(await target.publish(command, capability)).toMatchObject({ outcome: "committed", receipt: { productId: data.productId } });
});

it("cycle1 native draft admission binds every claim identity and the open current head", async () => {
  const data = await draft(), missing = structuredClone(data.payload);
  missing.publication.evidence.drafts = [{ draftId: randomUUID(), revision: 2, commandKey: "missing:claim", fingerprint: "c".repeat(64) }];
  const command = await save(missing, data.draftId, 1); const before = await snapshot();
  expect(await authority.decision(approvalCommand(command), actor)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_source_mismatch" });
  expect(await snapshot()).toEqual(before);
  const closed = await draft(), abandon = canonicalCatalogDraftJson({ schemaVersion: 3, action: "abandon", draftId: closed.draftId, commandKey: "close:current", expectedRevision: 1 });
  expect((await db.query("SELECT public.catalog_draft_apply($1,$2,'operator:synthetic') AS result", [abandon, createHash("sha256").update(abandon).digest("hex")])).rows[0].result.outcome).toBe("committed");
  const abandoned = { ...closed.publication, candidateRef: `v1:${closed.draftId}@2/unpublished` };
  const closedBefore = await snapshot();
  expect(await authority.decision(approvalCommand(abandoned), actor)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_source_mismatch" });
  expect(await snapshot()).toEqual(closedBefore);
});

it("cycle1 native retained source claims bind product command and fingerprint", async () => {
  const data = await draft(), first = await commit(data.publication), command = await revise(data, first.head); await approve(command);
  const before = await snapshot();
  for (const changed of [{ commandKey: "other:source" }, { fingerprint: "c".repeat(64) }]) {
    const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
      if (sql.startsWith("SELECT public.catalog_draft_record") && (rows[0]?.record as { revision?: number } | undefined)?.revision === 1)
        Object.assign(rows[0].record as object, changed);
    }));
    expect(await target.publish(command, (await target.authorize(null))!)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_source_mismatch" });
    expect(await snapshot()).toEqual(before);
  }
  const foreign = await draft(), record = (await db.query("SELECT public.catalog_draft_record($1,1) AS record", [foreign.draftId])).rows[0].record;
  const local = await draft(), payload = structuredClone(local.payload);
  payload.publication.evidence.drafts = [{ draftId: record.draftId, revision: record.revision, commandKey: record.commandKey, fingerprint: record.fingerprint }];
  const foreignClaim = await save(payload, local.draftId, 1); const claimedBefore = await snapshot();
  expect(await authority.decision(approvalCommand(foreignClaim), actor)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_source_mismatch" });
  expect(await snapshot()).toEqual(claimedBefore);
});

it.each(["eligibility", "membership"] as const)("cycle1 native omitted %s withdrawal preserves its source refusal before activation admission", async mode => inPriceDatabase(async () => {
  const target = realPriceAuthority(), capability = (await target.authorize(null))!, data = await priceDraft(), first = await commit(data.publication, target, capability);
  const payload = structuredClone(data.payload); payload.product.sharedContent.catalogAction = "revise"; payload.skus = []; delete payload.product.primarySkuId;
  payload.product.sharedContent.publicationSkus = []; payload.product.sharedContent.requestedModes = []; payload.product.sharedContent.offerMemberships = [];
  payload.publication.operations = mode === "eligibility" ? [{ op: "set_eligibility", skuCode: data.payload.skus[0].code!, sellableStandalone: false, sellableInSubscription: false }]
    : [{ op: "set_offer_membership", skuCode: data.payload.skus[0].code!, offerVersion: "example:offer", admitted: false }];
  const command = await save(payload, data.draftId, 2, first.head); const before = await snapshot();
  expect(await target.decision(approvalCommand(command), capability)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_operation_source_missing" });
  expect(await snapshot()).toEqual(before);
}));

it.each(["draft eligible", "active ineligible"] as const)("cycle1 native document move excludes an omitted %s SKU from activation source admission", async mode => inPriceDatabase(async () => {
  const reads: unknown[][] = [], target = realPriceAuthority(undefined, (sql, _executor, _rows, values) => { if (sql.startsWith("SELECT public.catalog_publication_sku_reasons")) reads.push(values!); }), capability = (await target.authorize(null))!, data = await priceDraft(), initial = structuredClone(data.payload);
  if (mode === "draft eligible") initial.publication.operations = initial.publication.operations.filter(operation => operation.op !== "set_sku_status");
  let head = (await commit(await save(initial, data.draftId, 2, data.publication.expectedHead), target, capability)).head, revision = 3;
  if (mode === "active ineligible") {
    const withdrawal = structuredClone(initial); delete withdrawal.skus[0].priceOperations; withdrawal.product.sharedContent.catalogAction = "revise";
    withdrawal.product.sharedContent.requestedModes = [{ skuCode: withdrawal.skus[0].code!, modes: [] }];
    withdrawal.publication.operations = [{ op: "set_eligibility", skuCode: withdrawal.skus[0].code!, sellableStandalone: false, sellableInSubscription: false }];
    head = (await commit(await save(withdrawal, data.draftId, revision++, head), target, capability)).head;
  }
  const payload = structuredClone(initial); payload.product.sharedContent.catalogAction = "revise"; payload.skus = []; delete payload.product.primarySkuId;
  payload.product.sharedContent.publicationSkus = []; payload.product.sharedContent.requestedModes = []; payload.product.sharedContent.offerMemberships = [];
  const document = { ...payload.product.sharedContent.document, revisionNo: 2 }, canonicalText = canonicalCatalogDraftJson(document), digest = createHash("sha256").update(canonicalText).digest("hex"), revisionId = randomUUID();
  payload.product.sharedContent.document = document; payload.product.documentRevision = { ...payload.product.documentRevision!, id: revisionId, revisionNo: 2, digest };
  payload.publication.operations = [
    { op: "register_document_revision", productSlug: payload.product.slug!, revisionId, revisionNo: 2, documentRef: "example:document", sourceRef: "example:source", canonicalText, digest, provenance: { source: "current_draft" } },
    { op: "move_document_pointer", productSlug: payload.product.slug!, documentRevisionNo: 2 },
  ];
  reads.length = 0;
  expect((await commit(await save(payload, data.draftId, revision, head), target, capability)).head.revision).toBe(head.revision + 1);
  expect(reads).toEqual([[data.skuId, false], [data.skuId, false]]);
}));

it.each(["membership", "product activation"] as const)("cycle1 native omitted active eligible source must be current for %s", async mode => inPriceDatabase(async () => {
  const target = realPriceAuthority(), capability = (await target.authorize(null))!, data = await priceDraft(), first = await commit(data.publication, target, capability);
  const payload = structuredClone(data.payload); payload.product.sharedContent.catalogAction = "revise"; payload.skus = []; delete payload.product.primarySkuId;
  payload.product.sharedContent.publicationSkus = []; payload.product.sharedContent.requestedModes = []; payload.product.sharedContent.offerMemberships = [];
  payload.publication.operations = mode === "membership" ? [{ op: "set_offer_membership", skuCode: data.payload.skus[0].code!, offerVersion: "example:offer", admitted: true }]
    : [{ op: "set_product_status", productSlug: payload.product.slug!, status: "active" }];
  const command = await save(payload, data.draftId, 2, first.head);
  if (mode === "product activation") await approve(command, target, capability);
  const before = await snapshot();
  const result = mode === "membership" ? await target.decision(approvalCommand(command), capability) : await target.publish(command, capability);
  expect(result).toEqual(mode === "membership" ? { outcome: "validation_issue", reason: "catalog_publication_operation_source_missing" }
    : { outcome: "conflict", reason: "catalog_publication_draft_advanced" });
  expect(await snapshot()).toEqual(before);
}));

it("cycle1 native presentation alone does not reactivate an omitted eligible SKU", async () => inPriceDatabase(async () => {
  const target = realPriceAuthority(), capability = (await target.authorize(null))!, data = await priceDraft(), first = await commit(data.publication, target, capability);
  const payload = structuredClone(data.payload); payload.product.sharedContent.catalogAction = "revise"; payload.skus = []; delete payload.product.primarySkuId;
  payload.product.sharedContent.publicationSkus = []; payload.product.sharedContent.requestedModes = []; payload.product.sharedContent.offerMemberships = [];
  payload.product.sharedContent.presentation = { routePath: { en: "/changed-presentation" } };
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
  expect((await commit(await save(payload, data.draftId, 2, first.head), target, capability)).head.revision).toBe(first.head.revision + 1);
}));

it.each(["document", "product", "archive"] as const)("cycle1 native omitted activation admission keeps %s scope refusal precedence", async mode => inPriceDatabase(async () => {
  const target = realPriceAuthority(), capability = (await target.authorize(null))!, data = await priceDraft(), first = await commit(data.publication, target, capability);
  const payload = structuredClone(data.payload); payload.product.sharedContent.catalogAction = "revise"; payload.skus = []; delete payload.product.primarySkuId;
  payload.product.sharedContent.publicationSkus = []; payload.product.sharedContent.requestedModes = []; payload.product.sharedContent.offerMemberships = [];
  payload.publication.operations = mode === "document" ? [{ op: "move_document_pointer", productSlug: "other-product", documentRevisionNo: 1 }]
    : [{ op: "set_product_status", productSlug: mode === "product" ? "other-product" : payload.product.slug!, status: mode === "archive" ? "archived" : "active" }];
  const command = await save(payload, data.draftId, 2, first.head);
  if (mode === "archive") {
    const receipt = await commit(command, target, capability);
    expect(await target.readbackV2(receipt.head)).toMatchObject({ outcome: "page", product: { status: "archived" },
      items: [{ facts: { status: "active", sellableStandalone: true } }] });
  } else {
    const before = await snapshot();
    expect(await target.decision(approvalCommand(command), capability)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_scope_expansion" });
    expect(await snapshot()).toEqual(before);
  }
}));

it("cycle1 native incremental dark SKU runs structural readiness for its affected set", async () => inPriceDatabase(async () => {
  const reads: unknown[][] = [], target = realPriceAuthority(undefined, (sql, _executor, _rows, values) => { if (sql.startsWith("SELECT public.catalog_publication_sku_reasons")) reads.push(values!); });
  const capability = (await target.authorize(null))!, data = await draft(), first = await commit(data.publication, target, capability);
  reads.length = 0;
  const command = await incrementalSku(data, first.head, 1);
  const skuId = (await db.query("SELECT public.catalog_draft_record($1,2) AS record", [data.draftId])).rows[0].record.payload.skus[0].id;
  const receipt = await commit(command, target, capability);
  expect(reads).toEqual([[skuId, false], [skuId, false]]);
  expect((await target.readbackV2(receipt.head))).toMatchObject({ outcome: "page", items: expect.any(Array) });
  const payload = (await db.query("SELECT public.catalog_draft_record($1,2) AS record", [data.draftId])).rows[0].record.payload as CatalogDraftPayloadV3;
  const skuCode = payload.skus[0].code!;
  payload.product.sharedContent.offerMemberships = [{ skuCode, offerVersion: "example:offer", admitted: true }];
  payload.publication.operations = [{ op: "set_offer_membership", skuCode, offerVersion: "example:offer", admitted: true }];
  reads.length = 0;
  await commit(await save(payload, data.draftId, 2, receipt.head), target, capability);
  expect(reads).toEqual([[skuId, false], [skuId, false]]);
}));

it("cycle1 native new SKU activation checks only its affected structural and price set", async () => inPriceDatabase(async () => {
  const target = realPriceAuthority(), capability = (await target.authorize(null))!, data = await priceDraft(), first = await commit(data.publication, target, capability);
  const payload = structuredClone(data.payload), sku = structuredClone(payload.skus[0]), gtin = nextGtin();
  sku.id = randomUUID(); sku.code = `SKU-${sku.id}`; sku.netContent = { dimension: "mass", unit: "openlup:g", unscaled: "101", scale: 0 };
  sku.options = { pack_size: { kind: "quantity", value: sku.netContent } }; sku.identifiers = [{ scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1 }];
  sku.priceOperations = [{ ...sku.priceOperations![0], variantId: sku.id, commandKey: `price:${sku.id}` }];
  payload.skus = [sku]; delete payload.product.primarySkuId; payload.product.sharedContent.catalogAction = "revise";
  const facts = { ...payload.product.sharedContent.publicationSkus[0], skuCode: sku.code };
  payload.product.sharedContent.publicationSkus = [facts]; payload.product.sharedContent.offerMemberships = [{ skuCode: sku.code!, offerVersion: "example:offer", admitted: true }];
  payload.product.sharedContent.requestedModes = [{ skuCode: sku.code!, modes: ["one_time"] }];
  payload.publication.operations = [
    { op: "create_sku", skuId: sku.id, productSlug: payload.product.slug!, documentRevisionNo: 1, ...facts },
    { op: "create_identifier", skuCode: sku.code!, scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null },
    { op: "set_offer_membership", skuCode: sku.code!, offerVersion: "example:offer", admitted: true },
    { op: "set_sku_metadata", skuCode: sku.code!, logisticsRef: "example:logistics" },
    { op: "set_eligibility", skuCode: sku.code!, sellableStandalone: true, sellableInSubscription: false },
    { op: "set_sku_status", skuCode: sku.code!, status: "active" },
  ];
  const sameIssuance = await save(payload, data.draftId, 2, first.head);
  await approve(sameIssuance, target, capability);
  const unchanged = await snapshot();
  expect(await target.publish(sameIssuance, capability)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_operation_source_mismatch" });
  expect(await snapshot()).toEqual(unchanged);
  const enabling = payload.publication.operations.filter(operation => operation.op === "set_sku_status" || operation.op === "set_eligibility");
  payload.publication.operations = payload.publication.operations.filter(operation => operation.op !== "set_sku_status" && operation.op !== "set_eligibility");
  const staged = await commit(await save(payload, data.draftId, 3, first.head), target, capability);
  expect(await target.readbackV2(staged.head)).toMatchObject({ outcome: "page", items: expect.arrayContaining([{ reference: expect.objectContaining({ skuId: sku.id, revision: 1 }),
    facts: expect.objectContaining({ status: "draft", sellableStandalone: false }) }]) });
  expect((await db.query("SELECT unit_price_minor FROM public.price_entries WHERE variant_id=$1 AND active", [sku.id])).rows)
    .toEqual([{ unit_price_minor: 1000 }]);
  delete sku.priceOperations;
  payload.publication.operations = enabling;
  const command: CatalogPublishCommand = { ...await save(payload, data.draftId, 4, staged.head), changes: [{ variantId: sku.id, expectedRevision: 1, state: "active" }] };
  const connection = await db.connect();
  try {
    await connection.query("BEGIN"); await connection.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: admin })]);
    expect((await connection.query("SELECT public.commerce_offer_policy_v2_readiness() AS value")).rows[0].value).toMatchObject({ ready: true, reasons: [] });
    const reads: unknown[][] = [], scoped = realPriceAuthority(connection, (sql, _executor, _rows, values) => { if (sql.startsWith("SELECT public.catalog_publication_sku_reasons")) reads.push(values!); }), identity = (await scoped.authorize(null))!;
    await approve(command, scoped, identity); const before = await snapshot(connection);
    for (const changes of [[{ variantId: randomUUID(), expectedRevision: 0, state: "active" as const }], [{ variantId: sku.id, expectedRevision: 1, state: "withdrawn" as const }]]) {
      expect(await scoped.publish({ ...command, changes }, identity)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_variant_state_mismatch" });
      expect(await snapshot(connection)).toEqual(before);
    }
    expect(await scoped.publish(command, identity)).toMatchObject({ outcome: "committed", receipt: { head: { revision: staged.head.revision + 1 } } });
    expect(reads).toEqual([[sku.id, true], [sku.id, true]]);
  } finally { await connection.query("ROLLBACK"); connection.release(); }
}));

it("cycle1 native archiving an ineligible product skips activation readiness", async () => inPriceDatabase(async () => {
  const reads: string[] = [], target = realPriceAuthority(undefined, sql => { if (sql.startsWith("SELECT public.catalog_publication_sku_reasons")) reads.push(sql); });
  const capability = (await target.authorize(null))!, data = await draft(), first = await commit(data.publication, target, capability);
  const payload = structuredClone(data.payload); payload.product.sharedContent.catalogAction = "revise";
  payload.product.sharedContent.publicationSkus = []; payload.product.sharedContent.requestedModes = [];
  payload.publication.operations = [{ op: "set_offer_membership", skuCode: data.payload.skus[0].code!, offerVersion: "example:offer", admitted: false },
    { op: "set_product_status", productSlug: payload.product.slug!, status: "archived" }];
  reads.length = 0;
  expect((await commit(await save(payload, data.draftId, 1, first.head), target, capability)).head.revision).toBe(2);
  expect(reads).toEqual([]);
}));

it("cycle1 native eligibility alone requires prices without a structural operation", async () => inPriceDatabase(async () => {
  const reads: unknown[][] = [], target = realPriceAuthority(undefined, (sql, _executor, _rows, values) => { if (sql.startsWith("SELECT public.catalog_publication_sku_reasons")) reads.push(values!); });
  const capability = (await target.authorize(null))!, data = await priceDraft(), initial = structuredClone(data.payload);
  initial.product.sharedContent.requestedModes = [{ skuCode: initial.skus[0].code!, modes: [] }];
  initial.publication.operations = initial.publication.operations.filter(operation => operation.op !== "set_eligibility" && operation.op !== "set_sku_status");
  const first = await commit(await save(initial, data.draftId, 2, data.publication.expectedHead), target, capability), payload = structuredClone(initial);
  payload.product.sharedContent.catalogAction = "revise"; delete payload.skus[0].priceOperations;
  payload.product.sharedContent.requestedModes = [{ skuCode: payload.skus[0].code!, modes: ["one_time"] }];
  payload.publication.operations = [{ op: "set_eligibility", skuCode: payload.skus[0].code!, sellableStandalone: true, sellableInSubscription: false }];
  reads.length = 0;
  await commit(await save(payload, data.draftId, 3, first.head), target, capability);
  expect(reads).toEqual([[data.skuId, true], [data.skuId, true]]);
}));

it("cycle1 native membership admission rechecks the eligible SKU price without enabling eligibility", async () => inPriceDatabase(async () => {
  const reads: unknown[][] = [], target = realPriceAuthority(undefined, (sql, _executor, _rows, values) => { if (sql.startsWith("SELECT public.catalog_publication_sku_reasons")) reads.push(values!); });
  const capability = (await target.authorize(null))!, data = await priceDraft(), first = await commit(data.publication, target, capability), payload = structuredClone(data.payload);
  payload.product.sharedContent.catalogAction = "revise"; delete payload.skus[0].priceOperations;
  payload.product.sharedContent.offerMemberships = [{ skuCode: payload.skus[0].code!, offerVersion: "example:second-offer", admitted: true }];
  payload.publication.operations = [{ op: "set_offer_membership", skuCode: payload.skus[0].code!, offerVersion: "example:second-offer", admitted: true }];
  reads.length = 0;
  await commit(await save(payload, data.draftId, 2, first.head), target, capability);
  expect(reads).toEqual([[data.skuId, false], [data.skuId, false], [data.skuId, true], [data.skuId, true]]);
}));

it("cycle1 native readiness shape refusals precede business red and keep inclusive bounds", async () => {
  const data = await draft(); await approve(data.publication); const before = await snapshot();
  const invalid: unknown[] = [{ ready: "true", reasons: [] }, { reasons: [] }, { ready: false, reasons: "a" }, { ready: false, reasons: [] },
    { ready: false, reasons: Array.from({ length: 101 }, (_, index) => `r${index}`) }, { ready: false, reasons: ["a", "a"] },
    { ready: false, reasons: [false] }, { ready: false, reasons: ["private detail"] }, { ready: false, reasons: ["a".repeat(161)] }];
  for (const result of invalid) {
    const target = createPostgresCatalogPublication({ ...dependencies(), readiness: async () => result as { ready: boolean; reasons: string[] } });
    expect(await target.publish(data.publication, (await target.authorize(null))!)).toEqual({ outcome: "dependency_unavailable", reason: "catalog_publication_readiness_invalid" });
    expect(await snapshot()).toEqual(before);
  }
  for (const reasons of [["a"], ["a".repeat(160)], Array.from({ length: 100 }, (_, index) => `r${index}`)]) {
    const target = createPostgresCatalogPublication({ ...dependencies(), readiness: async () => ({ ready: false, reasons }) });
    expect(await target.publish(data.publication, (await target.authorize(null))!)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_v3_structural_readiness_failed" });
    expect(await snapshot()).toEqual(before);
  }
  expect(await authority.publish(data.publication, actor)).toMatchObject({ outcome: "committed" });
});

it("cycle1 native structural readiness refuses missing duplicate and red SQL responses", async () => {
  const data = await draft(); await approve(data.publication); const before = await snapshot();
  for (const mode of ["missing", "duplicate", "red"] as const) {
    const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
      if (!sql.startsWith("SELECT public.catalog_publication_sku_reasons")) return;
      if (mode === "missing") rows.length = 0;
      else if (mode === "duplicate") rows.push(structuredClone(rows[0]));
      else rows[0].reasons = ["document_revision_missing"];
    }));
    expect(await target.publish(data.publication, (await target.authorize(null))!)).toEqual(mode === "red"
      ? { outcome: "validation_issue", reason: "catalog_publication_v3_structural_readiness_failed" }
      : { outcome: "dependency_unavailable", reason: "catalog_publication_readiness_invalid" });
    expect(await snapshot()).toEqual(before);
  }
});

it("cycle1 native candidate validation refuses invalid fields and unrelated missing facts", async () => {
  const data = await draft(), first = await commit(data.publication);
  for (const field of ["attribute", "slug"] as const) {
    const payload = structuredClone(data.payload); payload.product.sharedContent.catalogAction = "revise";
    if (field === "attribute") payload.skus[0].attributes = { not_installed: "value" }; else delete payload.product.slug;
    payload.publication.operations = [{ op: "set_product_presentation", productSlug: data.payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
    const command = await save(payload, data.draftId, field === "attribute" ? 1 : 2, first.head);
    if (field === "attribute") await approve(command);
    const before = await snapshot();
    const result = field === "attribute" ? await authority.publish(command, actor) : await authority.decision(approvalCommand(command), actor);
    expect(result).toEqual({ outcome: "validation_issue", reason: field === "attribute" ? "candidate_invalid" : "catalog_publication_scope_expansion" });
    expect(await snapshot()).toEqual(before);
  }
  const initial = await draft(), payload = structuredClone(initial.payload); delete payload.product.primarySkuId;
  const command = await save(payload, initial.draftId, 1); const before = await snapshot();
  expect(await authority.decision(approvalCommand(command), actor)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_v3_compile_primary_foreign" });
  expect(await snapshot()).toEqual(before);
});

it("native publication refuses a bare move to an intermediate immutable revision", async () => {
  const data = await draft(); let head = (await commit(data.publication)).head;
  let second: CatalogDraftPayloadV3 | undefined;
  for (const revisionNo of [2, 3]) {
    const payload = structuredClone(data.payload); payload.product.sharedContent.catalogAction = "revise";
    const document = { ...payload.product.sharedContent.document, revisionNo }, canonicalText = canonicalCatalogDraftJson(document), digest = createHash("sha256").update(canonicalText).digest("hex"), revisionId = randomUUID();
    payload.product.sharedContent.document = document; payload.product.documentRevision = { ...payload.product.documentRevision!, id: revisionId, revisionNo, digest };
    payload.publication.operations = [
      { op: "register_document_revision", productSlug: payload.product.slug!, revisionId, revisionNo, documentRef: "example:document", sourceRef: "example:source", canonicalText, digest, provenance: { source: "current_draft" } },
      { op: "move_document_pointer", productSlug: payload.product.slug!, documentRevisionNo: revisionNo },
    ];
    head = (await commit(await save(payload, data.draftId, revisionNo - 1, head))).head;
    if (revisionNo === 2) second = structuredClone(payload);
  }
  const payload = second!; payload.publication.operations = [{ op: "move_document_pointer", productSlug: payload.product.slug!, documentRevisionNo: 2 }];
  const command = await save(payload, data.draftId, 3, head); await approve(command);
  const stable = await snapshot();
  expect(await authority.publish(command, actor)).toEqual({ outcome: "conflict", reason: "catalog_publication_v3_document_reference_stale" });
  expect(await snapshot()).toEqual(stable);
});

it("cycle1 native explicit inactive media refuses an advanced recorded SKU source", async () => {
  const data = await draft(), initial = structuredClone(data.payload);
  initial.skus[0].assetRefs = ["example:original-asset"]; initial.product.sharedContent.presentation = { mediaRef: "example:original-media" };
  const presentation = initial.publication.operations.find(operation => operation.op === "set_product_presentation")!;
  if (presentation.op === "set_product_presentation") presentation.presentation = initial.product.sharedContent.presentation;
  const first = await commit(await save(initial, data.draftId, 1));
  await incrementalSku({ ...data, payload: initial }, first.head, 2);
  const next = (await db.query("SELECT public.catalog_draft_record($1,3) AS record", [data.draftId])).rows[0].record.payload as CatalogDraftPayloadV3;
  next.skus.push(structuredClone(initial.skus[0])); next.product.sharedContent.publicationSkus.push(structuredClone(initial.product.sharedContent.publicationSkus[0]));
  next.product.sharedContent.presentation = { mediaRef: "example:later-media" };
  next.publication.operations.push({ op: "set_product_presentation", productSlug: next.product.slug!, presentation: next.product.sharedContent.presentation });
  const second = await commit(await save(next, data.draftId, 3, first.head));
  const retained = await authority.readbackV2(second.head);
  if (!("items" in retained)) throw new Error(JSON.stringify(retained));
  expect(new Set(retained.items.map(item => item.facts.source.revision)).size).toBe(2);
  const payload = structuredClone(next); payload.skus = []; delete payload.product.primarySkuId;
  payload.product.sharedContent.publicationSkus = []; payload.product.sharedContent.presentation = { mediaRef: "example:current-presentation" };
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
  payload.publication.evidence.media = [{ skuCode: initial.skus[0].code!, mediaRef: "example:original-media", assetRefs: ["example:original-asset"], revisionDigest: first.publicationDigest }];
  const command = await save(payload, data.draftId, 4, second.head); const before = await snapshot();
  expect(await authority.decision(approvalCommand(command), actor)).toEqual({ outcome: "conflict", reason: "catalog_publication_draft_advanced" });
  expect(await snapshot()).toEqual(before);
});

it.each(["command", "fingerprint"] as const)("cycle1 native explicit current draft claim rejects an altered %s", async field => {
  const data = await draft(), payload = structuredClone(data.payload);
  payload.publication.evidence.drafts = [{ draftId: data.draftId, revision: 2, commandKey: field === "command" ? "other:command" : "draft:2", fingerprint: "c".repeat(64) }];
  const command = await save(payload, data.draftId, 1); const before = await snapshot();
  expect(await authority.decision(approvalCommand(command), actor)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_source_mismatch" });
  expect(await snapshot()).toEqual(before);
});

it("cycle1 native unknown media SKU retains the named evidence refusal", async () => {
  const data = await draft(), payload = structuredClone(data.payload);
  payload.publication.evidence.media = [{ skuCode: "MISSING", mediaRef: "example:missing", assetRefs: [], revisionDigest: "a".repeat(64) }];
  const command = await save(payload, data.draftId, 1); const before = await snapshot();
  expect(await authority.decision(approvalCommand(command), actor)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_media_evidence_mismatch" });
  expect(await snapshot()).toEqual(before);
});

it.each(["omitted retained SKU", "included SKU with old proof", "included SKU with fresh proof"] as const)(
  "publication media evidence binds to the current authored SKU: %s", async mode => inPriceDatabase(async () => {
    const data = await priceDraft(), payload = structuredClone(data.payload);
    const current = data.publication.expectedHead!;
    const sku = payload.skus[0], skuCode = sku.code!, mediaRef = "example:reviewed-media", assetRefs = ["panel"];
    const freshDigest = createHash("sha256").update(canonicalCatalogDraftJson({ skuCode, mediaRef, assetRefs })).digest("hex");
    const oldDigest = current.documentDigest;
    sku.assetRefs = assetRefs;
    payload.product.sharedContent.presentation = { mediaRef };
    const presentation = { op: "set_product_presentation" as const, productSlug: payload.product.slug!, presentation: { mediaRef } };
    payload.publication.operations = payload.publication.operations.map(op => op.op === "set_product_presentation" ? presentation : op);
    if (mode === "omitted retained SKU") {
      payload.skus = [];
      delete payload.product.primarySkuId;
      Object.assign(payload.product.sharedContent, { publicationSkus: [], requestedModes: [], offerMemberships: [] });
      payload.publication.operations = [presentation];
    }
    payload.publication.evidence.media = [{ skuCode, mediaRef, assetRefs, revisionDigest: mode === "included SKU with fresh proof" ? freshDigest : oldDigest }];
    const command = await save(payload, data.draftId, 2, current);
    const verified: string[] = [], fallback: unknown[] = [];
    const target = realPriceAuthority(undefined, (sql, _db, _rows, values) => {
      if (sql.includes("SELECT DISTINCT ON (sku.sku)")) fallback.push(values);
    }, async (_db, proof) => {
      verified.push(proof.revisionDigest);
      return proof.revisionDigest === freshDigest;
    });
    const capability = (await target.authorize(null))!;
    if (mode === "omitted retained SKU") {
      expect(await target.decision(approvalCommand(command), capability)).toEqual({ outcome: "conflict", reason: "catalog_publication_draft_advanced" });
      expect(fallback).toEqual([]);
      expect(verified).toEqual([]);
      return;
    }
    await approve(command, target, capability);
    const before = await snapshot(), result = await target.publish(command, capability);
    expect(fallback).toEqual([]);
    if (mode === "included SKU with old proof") {
      expect(result).toEqual({ outcome: "validation_issue", reason: "catalog_publication_media_readiness_unproven" });
      expect(verified).toEqual([oldDigest]);
      expect(await snapshot()).toEqual(before);
    } else {
      expect(result).toMatchObject({ outcome: "committed", receipt: { changes: [{ sku: skuCode, state: "active" }] } });
      expect(verified).toEqual([freshDigest]);
    }
  }));

it.each(["reference", "assets"] as const)("cycle1 native activation binds verified media to the applied %s", async field => inPriceDatabase(async () => {
  const initialTarget = realPriceAuthority(), initialActor = (await initialTarget.authorize(null))!, data = await priceDraft(false), initial = structuredClone(data.payload), skuCode = initial.skus[0].code!;
  initial.skus[0].assetRefs = ["panel"]; initial.product.sharedContent.presentation = { mediaRef: "example:before" };
  initial.product.sharedContent.offerMemberships[0].admitted = true;
  for (const operation of initial.publication.operations) {
    if (operation.op === "set_product_presentation") operation.presentation = initial.product.sharedContent.presentation;
    if (operation.op === "set_offer_membership") operation.admitted = true;
  }
  const first = await commit(await save(initial, data.draftId, 2), initialTarget, initialActor), payload = structuredClone(initial);
  payload.product.sharedContent.catalogAction = "revise"; delete payload.skus[0].priceOperations;
  payload.product.sharedContent.requestedModes = [{ skuCode, modes: ["one_time"] }];
  if (field === "reference") payload.product.sharedContent.presentation = { mediaRef: "example:after" }; else delete payload.skus[0].assetRefs;
  payload.publication.operations = [{ op: "set_eligibility", skuCode, sellableStandalone: true, sellableInSubscription: false }];
  const proof = { skuCode, mediaRef: String(payload.product.sharedContent.presentation.mediaRef), assetRefs: payload.skus[0].assetRefs ?? [], revisionDigest: first.publicationDigest };
  payload.publication.evidence.media = [proof];
  const target = realPriceAuthority(undefined, undefined, async (_executor, supplied) => canonicalCatalogDraftJson(supplied) === canonicalCatalogDraftJson(proof));
  const capability = (await target.authorize(null))!, command = await save(payload, data.draftId, 3, first.head); await approve(command, target, capability); const before = await snapshot();
  expect(await target.publish(command, capability)).toEqual({ outcome: "validation_issue", reason: field === "reference" ? "catalog_publication_presentation_effect_missing" : "catalog_publication_media_readiness_unproven" });
  expect(await snapshot()).toEqual(before);
}));

it.each([2_147_483_646, 2_147_483_647])("cycle1 native publication revision boundary from %i", async revision => {
  const data = await draft(), first = await commit(data.publication), publicationId = randomUUID();
  // Each value fits the integer domain, but neither can skip its predecessor.
  const insert = db.query(`INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id,committed_at,command_key)
    SELECT $1,product_id,$2,id,draft_id,draft_revision,$3,candidate_digest,document_revision_id,canonical_state,digest,actor_id,clock_timestamp(),$3
    FROM public.catalog_publications WHERE id=$4`, [publicationId, revision, `fixture:revision:${publicationId}`, first.head.publicationId]);
  await expect(insert).rejects.toMatchObject({ code: "23514", message: "catalog_publication_lineage_invalid" });
  expect(await authority.reads.current(data.productId)).toMatchObject({ outcome: "found", head: first.head });
});

it.each(["direct media", "resumed activation", "resumed media"] as const)("cycle1 native media cannot borrow an unmaterialized SKU from a retained product draft: %s", async mode => {
  const data = await draft(), initial = structuredClone(data.payload), pending = structuredClone(initial.skus[0]), gtin = nextGtin();
  pending.id = randomUUID(); pending.code = `PENDING-${pending.id}`;
  pending.netContent = { dimension: "mass", unit: "openlup:g", unscaled: "101", scale: 0 };
  pending.options = { pack_size: { kind: "quantity", value: pending.netContent } };
  pending.identifiers = [{ scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1 }]; pending.assetRefs = ["pending-asset"];
  initial.product.sharedContent.presentation = { mediaRef: "example:pending-media" };
  const presentation = initial.publication.operations.find(operation => operation.op === "set_product_presentation")!;
  if (presentation.op === "set_product_presentation") presentation.presentation = initial.product.sharedContent.presentation;
  const first = await commit(await save(initial, data.draftId, 1));
  const incomplete = structuredClone(initial);
  incomplete.skus.push(pending);
  incomplete.product.sharedContent.publicationSkus.push({ ...initial.product.sharedContent.publicationSkus[0], skuCode: pending.code });
  incomplete.product.sharedContent.catalogAction = "revise";
  incomplete.publication.operations = [{ op: "set_product_presentation", productSlug: incomplete.product.slug!, presentation: incomplete.product.sharedContent.presentation }];
  await save(incomplete, data.draftId, 2, first.head);
  expect((await db.query("SELECT id FROM public.catalog_skus WHERE id=$1", [pending.id])).rows).toEqual([]);
  const payload = structuredClone(initial); payload.product.sharedContent.catalogAction = "revise"; payload.skus = []; delete payload.product.primarySkuId;
  payload.product.sharedContent.publicationSkus = []; payload.product.sharedContent.requestedModes = []; payload.product.sharedContent.offerMemberships = [];
  payload.product.sharedContent.presentation = { mediaRef: "example:changed-presentation" };
  if (mode !== "direct media") {
    payload.skus = [structuredClone(initial.skus[0])];
    payload.product.sharedContent.publicationSkus = [structuredClone(initial.product.sharedContent.publicationSkus[0])];
  }
  payload.publication.operations = mode === "resumed activation"
    ? [{ op: "set_eligibility", skuCode: pending.code, sellableStandalone: true, sellableInSubscription: false }]
    : [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
  if (mode !== "resumed activation") payload.publication.evidence.media = [{ skuCode: pending.code, mediaRef: "example:pending-media", assetRefs: ["pending-asset"], revisionDigest: first.publicationDigest }];
  const command = mode === "direct media" ? await save(payload, data.draftId, 3, first.head) : await saveResumed(payload, data.draftId, 3, first.head);
  const before = await snapshot();
  expect(await authority.decision(approvalCommand(command), actor)).toEqual({ outcome: "validation_issue",
    reason: mode === "resumed activation" ? "catalog_publication_operation_source_missing" : "catalog_publication_media_evidence_mismatch" });
  expect(await snapshot()).toEqual(before);
});

async function saveResumed(payload: CatalogDraftPayloadV3, draftId: string, expectedRevision: number, head: CatalogHeadRef | null, wrongCommand = false) {
  const revision = expectedRevision + 3, commandKey = `resume:${revision}`;
  const resume = { schemaVersion: 3, action: "resume", draftId, commandKey, expectedRevision: revision - 1 };
  const fingerprint = createHash("sha256").update(canonicalCatalogDraftJson(resume)).digest("hex");
  payload.publication.evidence.drafts = [{ draftId, revision, commandKey: wrongCommand ? "other:command" : commandKey, fingerprint }];
  const saved = await save(payload, draftId, expectedRevision, head);
  for (const command of [{ schemaVersion: 3, action: "abandon", draftId, commandKey: `abandon:${revision}`, expectedRevision: revision - 2 }, resume]) {
    const text = canonicalCatalogDraftJson(command);
    const result = (await db.query("SELECT public.catalog_draft_apply($1,$2,'operator:synthetic') AS result", [text, createHash("sha256").update(text).digest("hex")])).rows[0].result;
    expect(result.outcome, JSON.stringify(result)).toBe("committed");
    expect(result.record.payload).toEqual(payload);
    if (command.action === "resume") expect(result.record).toMatchObject({ revision, status: "open", commandKey, fingerprint });
  }
  return { ...saved, commandKey: `publish:resumed:${revision}`, candidateRef: `v1:${draftId}@${revision}/${head ? `${head.publicationId}@${head.revision}` : "unpublished"}` };
}
it.each([false, true])("cycle1 native resumed claim independently binds its current command: altered=%s", async wrongCommand => {
  const data = await draft(), payload = structuredClone(data.payload), command = await saveResumed(payload, data.draftId, 1, null, wrongCommand);
  if (wrongCommand) {
    const before = await snapshot();
    expect(await authority.decision(approvalCommand(command), actor)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_source_mismatch" });
    expect(await snapshot()).toEqual(before);
  } else expect(await commit(command)).toMatchObject({ changes: [{ draftRef: { draftId: data.draftId, revision: 4 } }] });
});

it("cycle1 native price writes require their SKU in the compiled materialized roster", async () => inPriceDatabase(async () => {
  const target = realPriceAuthority(), capability = (await target.authorize(null))!, data = await priceDraft(false), first = await commit(data.publication, target, capability);
  const payload = structuredClone(data.payload), pending = structuredClone(payload.skus[0]), gtin = nextGtin();
  delete payload.skus[0].priceOperations;
  pending.id = randomUUID(); pending.code = `PENDING-${pending.id}`;
  pending.netContent = { dimension: "mass", unit: "openlup:g", unscaled: "101", scale: 0 }; pending.options = { pack_size: { kind: "quantity", value: pending.netContent } };
  pending.identifiers = [{ scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1 }];
  pending.priceOperations = [{ ...pending.priceOperations![0], variantId: pending.id, commandKey: `price:${pending.id}` }];
  payload.skus.push(pending); payload.product.sharedContent.publicationSkus.push({ ...payload.product.sharedContent.publicationSkus[0], skuCode: pending.code });
  payload.product.sharedContent.catalogAction = "revise"; payload.product.sharedContent.presentation = { routePath: { en: "/pending-price-roster" } };
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
  const command = await save(payload, data.draftId, 2, first.head); await approve(command, target, capability); const before = await snapshot();
  expect(await target.publish(command, capability)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_sku_effect_missing" });
  expect(await snapshot()).toEqual(before);
}));

it("cycle1 native receipts distinguish product-only changes and SKU withdrawals", async () => {
  const data = await draft(), first = await commit(data.publication);
  expect(first.changes).toMatchObject([{ variantId: data.skuId, variantRevision: 1, state: "draft" }]);
  const second = await commit(await revise(data, first.head)); expect(second.changes).toEqual([]);
  const currentPayload = (await db.query("SELECT public.catalog_draft_record($1,2) AS record", [data.draftId])).rows[0].record.payload as CatalogDraftPayloadV3;
  const third = await commit(await incrementalSku({ ...data, payload: currentPayload }, second.head, 2));
  const payload = (await db.query("SELECT public.catalog_draft_record($1,3) AS record", [data.draftId])).rows[0].record.payload as CatalogDraftPayloadV3;
  const sku = payload.skus[0];
  expect(third.changes).toMatchObject([{ variantId: sku.id, variantRevision: 1, state: "draft" }]);
  payload.publication.operations = [{ op: "set_sku_status", skuCode: sku.code!, status: "archived" }];
  const fourth = await commit(await save(payload, data.draftId, 3, third.head));
  expect(fourth.changes).toMatchObject([{ variantId: sku.id, variantRevision: 2, state: "withdrawn" }]);
  const current = await authority.reads.current(data.productId);
  expect(current).toMatchObject({ outcome: "found", head: fourth.head, observations: expect.arrayContaining([
    expect.objectContaining({ variantId: data.skuId, variantRevision: 1, state: "draft" }),
    expect.objectContaining({ variantId: sku.id, variantRevision: 2, state: "withdrawn" }),
  ]) });
  expect(await authority.receipt({ productId: data.productId, commandKey: fourth.commandKey }, actor)).toEqual({ outcome: "found", receipt: fourth });
});

it("cycle1 native repeated pointer operation consumes no unused capability", async () => {
  const data = await draft(), payload = structuredClone(data.payload);
  payload.publication.operations.push({ op: "move_document_pointer", productSlug: payload.product.slug!, documentRevisionNo: 1 });
  const receipt = await commit(await save(payload, data.draftId, 1));
  expect((await db.query("SELECT id FROM public.catalog_product_document_revisions WHERE product_id=$1", [data.productId])).rows).toHaveLength(1);
  expect((await db.query("SELECT * FROM public.catalog_publication_pointer_capabilities WHERE product_id=$1", [data.productId])).rows).toEqual([]);
  expect(await authority.readbackV2(receipt.head)).toMatchObject({ outcome: "page" });
});

it("cycle1 native projection detects an unexpected SKU before persisting the head", async () => {
  const data = await draft(); await approve(data.publication); const before = await snapshot(); let injected = false;
  const target = createPostgresCatalogPublication(dependencies(async (sql, executor) => {
    if (!sql.startsWith("SELECT to_char(clock_timestamp()")) return;
    await executor.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status) VALUES($1,$2,$3,'Unexpected native SKU','draft')", [randomUUID(), data.productId, `UNEXPECTED-${randomUUID()}`]);
    injected = true;
  }));
  expect(await target.publish(data.publication, (await target.authorize(null))!)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_post_state_mismatch" });
  expect(injected).toBe(true); expect(await snapshot()).toEqual(before);
});

it.each(["facts", "logistics", "membership", "status", "eligibility", "untouched", "mixed"] as const)("cycle1 native compensation reapplies only its explicit %s effect", async mode => inPriceDatabase(async () => {
  const initialTarget = realPriceAuthority(), initialActor = (await initialTarget.authorize(null))!, data = await priceDraft(), first = await commit(data.publication, initialTarget, initialActor);
  const payload = structuredClone(data.payload), skuCode = payload.skus[0].code!;
  delete payload.skus[0].priceOperations; payload.product.sharedContent.catalogAction = "revise"; payload.publication.kind = "compensation";
  payload.publication.operations = mode === "logistics" ? [{ op: "set_sku_metadata", skuCode, logisticsRef: "example:logistics" }]
    : mode === "membership" ? [{ op: "set_offer_membership", skuCode, offerVersion: "example:offer", admitted: true }]
    : mode === "status" ? [{ op: "set_eligibility", skuCode, sellableStandalone: true, sellableInSubscription: false }, { op: "set_sku_status", skuCode, status: "active" }]
    : mode === "eligibility" ? [{ op: "set_eligibility", skuCode, sellableStandalone: true, sellableInSubscription: false }]
    : mode === "untouched" ? [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }]
    : [{ op: "set_derived_sku_facts", skuCode, documentRevisionNo: 1, netContent: payload.skus[0].netContent!, facts: { derived: 12 } }];
  const command = await save(payload, data.draftId, 2, first.head), connection = await db.connect();
  try {
    await connection.query("BEGIN"); await connection.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: admin })]);
    const path = mode === "logistics" ? ["logisticsRef"] : mode === "membership" ? ["memberships"] : mode === "status" ? ["status"] : mode === "eligibility" ? ["sellableStandalone"] : ["facts", "derived"];
    const value = mode === "logistics" ? "example:wrong" : mode === "membership" ? [{ offerVersion: "example:offer", admitted: false }] : mode === "status" ? "archived" : mode === "eligibility" ? false : 13;
    await connection.query("UPDATE public.catalog_skus SET publication_facts=jsonb_set(publication_facts,$2::text[],$3::jsonb) WHERE id=$1", [data.skuId, path, canonicalCatalogDraftJson(value)]);
    if (mode === "mixed") await connection.query("UPDATE public.catalog_skus SET publication_facts=jsonb_set(publication_facts,'{logisticsRef}','\"example:wrong\"'::jsonb) WHERE id=$1", [data.skuId]);
    const target = realPriceAuthority(connection), capability = (await target.authorize(null))!; await approve(command, target, capability);
    const before = await snapshot(connection), result = await target.publish(command, capability);
    if (mode === "untouched" || mode === "mixed") {
      expect(result).toEqual({ outcome: "validation_issue", reason: "catalog_publication_post_state_mismatch" });
      expect(await snapshot(connection)).toEqual(before);
    } else {
      expect(result).toMatchObject({ outcome: "committed", receipt: { head: { revision: first.head.revision + 1 }, changes: [] } });
      expect((await connection.query("SELECT publication_facts FROM public.catalog_skus WHERE id=$1", [data.skuId])).rows[0].publication_facts)
        .toMatchObject({ facts: { derived: 12 }, logisticsRef: "example:logistics", memberships: [{ offerVersion: "example:offer", admitted: true }], status: "active", sellableStandalone: true });
    }
  } finally { await connection.query("ROLLBACK"); connection.release(); }
}));

it.each(["presentation", "untouched status", "untouched presentation", "untouched attributes", "untouched axes"] as const)("cycle1 native compensation preserves unaddressed product %s drift", async mode => {
  const data = await draft(), first = await commit(data.publication), payload = structuredClone(data.payload);
  payload.product.sharedContent.catalogAction = "revise"; payload.publication.kind = "compensation";
  payload.publication.operations = mode === "untouched presentation" ? [{ op: "set_primary_sku", productSlug: payload.product.slug!, skuCode: payload.skus[0].code! }]
    : [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
  const command = await save(payload, data.draftId, 1, first.head); await approve(command);
  const connection = await db.connect();
  try {
    await connection.query("BEGIN"); await connection.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: admin })]);
    if (mode === "untouched attributes") await connection.query("UPDATE public.catalog_products SET attribute_values='{\"unexpected\":true}' WHERE id=$1", [data.productId]);
    else if (mode === "untouched axes") await connection.query("UPDATE public.catalog_products SET variant_axes=ARRAY['unexpected'] WHERE id=$1", [data.productId]);
    else await connection.query("UPDATE public.catalog_products SET publication_facts=jsonb_set(publication_facts,$2::text[],$3::jsonb) WHERE id=$1", [data.productId,
      mode === "untouched status" ? ["status"] : ["presentation"], canonicalCatalogDraftJson(mode === "untouched status" ? "archived" : { wrong: true })]);
    const target = realPriceAuthority(connection), capability = (await target.authorize(null))!, before = await snapshot(connection);
    const result = await target.publish(command, capability);
    if (mode === "presentation") expect(result).toMatchObject({ outcome: "committed" });
    else { expect(result).toEqual({ outcome: "validation_issue", reason: "catalog_publication_post_state_mismatch" }); expect(await snapshot(connection)).toEqual(before); }
  } finally { await connection.query("ROLLBACK"); connection.release(); }
});

it.each(["old transaction", "current foreign"] as const)("cycle1 native pointer cleanup never consumes another capability: %s", async mode => inPriceDatabase(async () => {
  const target = realPriceAuthority(), capability = (await target.authorize(null))!, other = await priceDraft(false);
  await commit(other.publication, target, capability);
  const data = await priceDraft(false); await approve(data.publication, target, capability);
  const documentId = other.payload.product.documentRevision!.id, sentinel = "c".repeat(64), connection = await db.connect();
  let oldTransaction: string | undefined;
  try {
    if (mode === "old transaction") oldTransaction = (await db.query("INSERT INTO public.catalog_publication_pointer_capabilities VALUES(pg_current_xact_id(),$1,$2,$3) RETURNING transaction_id::text", [other.productId, documentId, sentinel])).rows[0].transaction_id;
    await connection.query("BEGIN"); await connection.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: admin })]);
    if (mode === "current foreign") await connection.query("INSERT INTO public.catalog_publication_pointer_capabilities VALUES(pg_current_xact_id(),$1,$2,$3)", [other.productId, documentId, sentinel]);
    const local = realPriceAuthority(connection), localActor = (await local.authorize(null))!, before = await snapshot(connection), result = await local.publish(data.publication, localActor);
    if (mode === "current foreign") { expect(result).toEqual({ outcome: "validation_issue", reason: "catalog_publication_pointer_capability_unconsumed" }); expect(await snapshot(connection)).toEqual(before); }
    else { expect(result).toMatchObject({ outcome: "committed" }); expect((await connection.query("SELECT * FROM public.catalog_publication_pointer_capabilities WHERE transaction_id=$1::xid8 AND command_fingerprint=$2", [oldTransaction, sentinel])).rows).toHaveLength(1); }
  } finally {
    await connection.query("ROLLBACK"); connection.release();
    if (oldTransaction) await db.query("DELETE FROM public.catalog_publication_pointer_capabilities WHERE transaction_id=$1::xid8 AND product_id=$2 AND revision_id=$3 AND command_fingerprint=$4", [oldTransaction, other.productId, documentId, sentinel]);
  }
}));

it.each(["other transaction", "other document"] as const)("cycle1 native pointer cleanup binds the matching scope: %s", async mode => inPriceDatabase(async () => {
  const initial = realPriceAuthority(), initialActor = (await initial.authorize(null))!, data = await priceDraft(), first = await commit(data.publication, initial, initialActor);
  const oldDocument = data.payload.product.documentRevision!.id, payload = structuredClone(data.payload);
  const content = { ...payload.product.sharedContent.document, revisionNo: 2 }, canonicalText = canonicalCatalogDraftJson(content), digest = createHash("sha256").update(canonicalText).digest("hex");
  const document = { ...payload.product.documentRevision!, id: randomUUID(), revisionNo: 2, digest };
  payload.product.documentRevision = document; payload.product.sharedContent.document = content; payload.product.sharedContent.catalogAction = "revise"; delete payload.skus[0].priceOperations;
  payload.publication.operations = [
    { op: "register_document_revision", productSlug: payload.product.slug!, revisionId: document.id, revisionNo: 2,
      documentRef: document.documentRef, sourceRef: document.sourceRef, canonicalText, digest, provenance: { source: "current_draft" } },
    { op: "move_document_pointer", productSlug: payload.product.slug!, documentRevisionNo: 2 },
  ];
  const command = await save(payload, data.draftId, 2, first.head); await approve(command, initial, initialActor);
  const fingerprint = createHash("sha256").update(canonicalCatalogDraftJson([command, admin])).digest("hex"), oldTransaction = (await db.query("SELECT xmin::text AS transaction FROM public.catalog_publications WHERE id=$1", [first.head.publicationId])).rows[0].transaction;
  const connection = await db.connect(); let injected = false;
  try {
    await connection.query("BEGIN"); await connection.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: admin })]);
    const target = realPriceAuthority(connection, async (sql, executor) => {
      if (!sql.startsWith("INSERT INTO public.catalog_product_document_revisions")) return;
      injected = true;
      await executor.query("INSERT INTO public.catalog_publication_pointer_capabilities VALUES(coalesce($1::xid8,pg_current_xact_id()),$2,$3,$4)",
        [mode === "other transaction" ? oldTransaction : null, data.productId, mode === "other document" ? oldDocument : document.id, fingerprint]);
    }), capability = (await target.authorize(null))!, before = await snapshot(connection), result = await target.publish(command, capability);
    expect(injected, JSON.stringify(result)).toBe(true);
    if (mode === "other document") { expect(result).toEqual({ outcome: "validation_issue", reason: "catalog_publication_pointer_capability_unconsumed" }); expect(await snapshot(connection)).toEqual(before); }
    else { expect(result).toMatchObject({ outcome: "committed", receipt: { fingerprint } }); expect((await connection.query("SELECT * FROM public.catalog_publication_pointer_capabilities WHERE transaction_id=$1::xid8 AND product_id=$2 AND revision_id=$3 AND command_fingerprint=$4", [oldTransaction, data.productId, document.id, fingerprint])).rows).toHaveLength(1); }
  } finally { await connection.query("ROLLBACK"); connection.release(); }
}));

it.each(["facts", "title", "net content", "gross mass", "attributes", "assets", "clean"] as const)("cycle1 compensation changes metadata without refreshing %s", async mode => inPriceDatabase(async () => {
  const initial = realPriceAuthority(), initialActor = (await initial.authorize(null))!, data = await priceDraft(), first = await commit(data.publication, initial, initialActor);
  const payload = structuredClone(data.payload); payload.product.sharedContent.catalogAction = "revise"; payload.publication.kind = "compensation";
  delete payload.skus[0].priceOperations; payload.skus[0].logisticsRef = "example:changed-logistics";
  payload.publication.operations = [{ op: "set_sku_metadata", skuCode: payload.skus[0].code!, logisticsRef: payload.skus[0].logisticsRef }];
  const command = await save(payload, data.draftId, 2, first.head); await approve(command, initial, initialActor);
  const connection = await db.connect();
  try {
    await connection.query("BEGIN"); await connection.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: admin })]);
    if (mode === "facts" || mode === "title") await connection.query("UPDATE public.catalog_skus SET publication_facts=jsonb_set(publication_facts,$2::text[],$3::jsonb) WHERE id=$1", [data.skuId, mode === "facts" ? ["facts", "derived"] : ["title"], canonicalCatalogDraftJson(mode === "facts" ? 13 : "Unaddressed cache drift")]);
    if (mode === "net content") await connection.query("UPDATE public.catalog_skus SET net_content_unscaled=101 WHERE id=$1", [data.skuId]);
    if (mode === "gross mass") await connection.query("UPDATE public.catalog_skus SET gross_mass_unscaled=201 WHERE id=$1", [data.skuId]);
    if (mode === "attributes") await connection.query("UPDATE public.catalog_skus SET attribute_values='{\"details\":[\"Unaddressed\"]}'::jsonb WHERE id=$1", [data.skuId]);
    if (mode === "assets") await connection.query("UPDATE public.catalog_skus SET asset_ref='asset:unaddressed' WHERE id=$1", [data.skuId]);
    const target = realPriceAuthority(connection), capability = (await target.authorize(null))!, before = await snapshot(connection), result = await target.publish(command, capability);
    if (mode !== "clean") { expect(result).toEqual({ outcome: "validation_issue", reason: "catalog_publication_post_state_mismatch" }); expect(await snapshot(connection)).toEqual(before); }
    else { expect(result).toMatchObject({ outcome: "committed", receipt: { changes: [{ variantId: data.skuId, variantRevision: first.changes[0].variantRevision + 1 }] } }); expect((await connection.query("SELECT publication_facts->>'logisticsRef' AS ref FROM public.catalog_skus WHERE id=$1", [data.skuId])).rows).toEqual([{ ref: "example:changed-logistics" }]); }
  } finally { await connection.query("ROLLBACK"); connection.release(); }
}));

it("cycle1 complete facts persist compatible attributes gross mass and assets", async () => {
  const deps = dependencies(), target = createPostgresCatalogPublication({ ...deps, rules: { ...deps.rules, classifySkuChange: () => "compatible" },
    readiness: async (executor, state, requirePrice) => {
      const reasons: string[] = [];
      for (const sku of state.skus) reasons.push(...(await executor.query("SELECT public.catalog_publication_sku_reasons($1,$2) AS reasons", [sku.id, requirePrice])).rows[0].reasons as string[]);
      return { ready: reasons.length === 0, reasons };
    } }), capability = (await target.authorize(null))!, data = await draft(), payload = structuredClone(data.payload);
  payload.product.dimensions.push("axis_flag"); payload.skus[0].options.axis_flag = { kind: "boolean", value: true };
  payload.product.attributes = { product_flag: false }; payload.skus[0].attributes = { details: ["Before"], axis_flag: true }; payload.skus[0].grossMass = { dimension: "mass", unit: "openlup:g", unscaled: "200", scale: 0 };
  const first = await commit(await save(payload, data.draftId, 1), target, capability);
  payload.product.sharedContent.catalogAction = "revise"; payload.product.dimensions.reverse(); payload.product.attributes = { product_flag: true }; payload.skus[0].attributes = { details: ["After"], axis_flag: true };
  payload.skus[0].grossMass = { dimension: "mass", unit: "openlup:g", unscaled: "201", scale: 0 }; payload.skus[0].assetRefs = ["asset:compatible"];
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
  const second = await commit(await save(payload, data.draftId, 2, first.head), target, capability);
  expect(await target.readbackV2(second.head)).toMatchObject({ outcome: "page", product: { axes: ["axis_flag", "pack_size"], attributes: { product_flag: true } }, items: [{ facts: { attributes: { details: ["After"] }, grossMass: { unscaled: "201" }, assetRefs: ["asset:compatible"] } }] });
  expect((await db.query("SELECT p.variant_axes AS axes,p.attribute_values AS product_attributes,s.attribute_values AS sku_attributes,s.gross_mass_unscaled::text,s.asset_ref FROM public.catalog_products p JOIN public.catalog_skus s ON s.product_id=p.id WHERE p.id=$1", [data.productId])).rows)
    .toEqual([{ axes: ["axis_flag", "pack_size"], product_attributes: { product_flag: true }, sku_attributes: { details: ["After"], axis_flag: true }, gross_mass_unscaled: "201", asset_ref: "asset:compatible" }]);
});

it.each(["opaque", "numeric"] as const)("cycle1 native identifiers preserve non-GTIN %s values and a nonfirst primary", async kind => {
  const data = await draft(), payload = structuredClone(data.payload), second = structuredClone(payload.skus[0]);
  second.id = randomUUID(); second.code = `SKU-${second.id}`; second.netContent = { ...second.netContent!, unscaled: "101" };
  second.options = { pack_size: { kind: "quantity", value: second.netContent } };
  const gtin = nextGtin(); second.identifiers = [{ scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1 }];
  payload.skus.push(second);
  const facts = { skuCode: second.code!, title: "Second synthetic article", minQuantity: 1, isAddon: false, facts: { derived: 12 } };
  payload.product.sharedContent.publicationSkus.push(facts); payload.product.sharedContent.requestedModes.push({ skuCode: second.code!, modes: [] });
  const primary = payload.skus.reduce((left, right) => left.id > right.id ? left : right), value = kind === "opaque" ? `opaque:${randomUUID()}` : primary.identifiers![0].value;
  primary.identifiers!.push({ scheme: "example:opaque", issuer: "example:issuer", value, packagingLevel: "unit", quantity: 1 });
  payload.product.primarySkuId = primary.id;
  payload.publication.operations = payload.publication.operations.filter(operation => operation.op !== "set_primary_sku");
  payload.publication.operations.push({ op: "create_sku", productSlug: payload.product.slug!, documentRevisionNo: 1, skuId: second.id, ...facts },
    { op: "create_identifier", skuCode: second.code!, scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null },
    { op: "create_identifier", skuCode: primary.code!, scheme: "example:opaque", issuer: "example:issuer", value, packagingLevel: "unit", quantity: 1, isPrimary: false, label: "Synthetic opaque identifier", sourceRef: null },
    { op: "set_primary_sku", productSlug: payload.product.slug!, skuCode: primary.code! });
  const receipt = await commit(await save(payload, data.draftId, 1));
  expect((await db.query("SELECT primary_sku_id FROM public.catalog_products WHERE id=$1", [data.productId])).rows).toEqual([{ primary_sku_id: primary.id }]);
  expect((await db.query("SELECT catalog_sku_id,identifier_kind,normalized_value,scheme FROM public.catalog_sku_identifiers WHERE scheme='example:opaque' AND catalog_sku_id=ANY($1::uuid[])", [payload.skus.map(sku => sku.id)])).rows)
    .toEqual([{ catalog_sku_id: primary.id, identifier_kind: "other", normalized_value: value, scheme: "example:opaque" }]);
  expect(await authority.readbackV2(receipt.head)).toMatchObject({ outcome: "page", product: { primarySkuId: primary.id } });
});

it.each([
  ["before compilation", "exact tuple"],
  ["before compilation", "wrong provenance"],
  ["after compilation snapshot", "exact tuple"],
  ["after compilation snapshot", "wrong provenance"],
] as const)("document registration checks the saved tuple %s: %s", async (phase, tuple) => {
  const data = await draft(), first = await commit(data.publication), payload = structuredClone(data.payload), content = { ...payload.product.sharedContent.document, revisionNo: 2 };
  const canonicalText = canonicalCatalogDraftJson(content), digest = createHash("sha256").update(canonicalText).digest("hex"), document = { ...payload.product.documentRevision!, id: randomUUID(), revisionNo: 2, digest };
  payload.product.sharedContent.catalogAction = "revise"; payload.product.sharedContent.document = content; payload.product.documentRevision = document;
  payload.publication.operations = [{ op: "register_document_revision", productSlug: payload.product.slug!, revisionId: document.id, revisionNo: 2, documentRef: document.documentRef, sourceRef: document.sourceRef, canonicalText, digest, provenance: { source: "current_draft" } }, { op: "move_document_pointer", productSlug: payload.product.slug!, documentRevisionNo: 2 }];
  const command = await save(payload, data.draftId, 1, first.head), record = (await db.query("SELECT public.catalog_draft_record($1,2) AS value", [data.draftId])).rows[0].value;
  const provenance = { draftId: record.draftId, draftRevision: record.revision, draftCommandKey: record.commandKey, draftFingerprint: record.fingerprint };
  const insert = async () => {
    const storedProvenance = tuple === "exact tuple" ? provenance : { ...provenance, draftCommandKey: "wrong" };
    await db.query(`INSERT INTO public.catalog_product_document_revisions
      (id,product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest,canonical_text)
      VALUES($1,$2,2,$3,$4,$5::text::jsonb,$6,$7::jsonb,$8,$5)`, [document.id, data.productId, document.schemaId,
      document.documentRef, canonicalText, document.sourceRef, canonicalCatalogDraftJson(storedProvenance), digest]);
    return snapshot();
  };
  await approve(command);
  let stable = phase === "before compilation" ? await insert() : undefined;
  let snapshots = 0;
  const target = createPostgresCatalogPublication(dependencies(async (sql, _executor, rows) => {
    if (phase !== "after compilation snapshot") return;
    if (sql.includes("pg_try_advisory_xact_lock")) stable = await insert();
    if (sql.includes("AS live_product") && ++snapshots === 2) {
      // Hold the earlier snapshot's document roster while the other
      // transaction's insert is already visible to the final SQL admission.
      rows[0].documents = (rows[0].documents as { id: string }[]).filter(row => row.id !== document.id);
    }
  }));
  const capability = (await target.authorize(null))!;
  const result = await target.publish(command, capability);
  expect(stable).toBeDefined();
  if (tuple === "exact tuple") {
    expect(result).toMatchObject({ outcome: "committed", receipt: { head: { documentDigest: digest } } });
    expect((await db.query("SELECT id FROM public.catalog_product_document_revisions WHERE product_id=$1 AND revision_no=2", [data.productId])).rows)
      .toEqual([{ id: document.id }]);
  } else {
    expect(result).toEqual({ outcome: phase === "before compilation" ? "validation_issue" : "conflict",
      reason: "catalog_publication_v3_compile_document_conflict" });
    expect(await snapshot()).toEqual(stable);
  }
});


it.each([
  ["media", ["a", "z"]],
  ["media", ["\uE000", "\u{10000}"]],
  ["membership", ["a", "z"]],
  ["membership", ["\uE000", "\u{10000}"]],
] as const)("publication matches database collation for %s references %j", async (field, [lower, higher]) => {
  const data = await draft(), payload = structuredClone(data.payload);
  const content = payload.product.sharedContent, skuCode = payload.skus[0].code!;
  if (field === "media") {
    const mediaRef = "example:collation", assetRefs = [lower, higher].sort();
    content.presentation = { mediaRef };
    payload.skus[0].assetRefs = assetRefs;
    const op = payload.publication.operations.find(op => op.op === "set_product_presentation")!;
    if (op.op === "set_product_presentation") op.presentation = content.presentation;
    payload.publication.evidence.media = [{ skuCode, mediaRef, assetRefs, revisionDigest: "a".repeat(64) }];
    const command = await save(payload, data.draftId, 1);
    if (assetRefs[0] === lower) {
      await commit(command);
    } else {
      const stable = await snapshot();
      expect(await authority.decision(approvalCommand(command), actor)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_media_evidence_mismatch" });
      expect(await snapshot()).toEqual(stable);
    }
    return;
  }
  content.offerMemberships = [{ skuCode, offerVersion: higher, admitted: false }];
  const op = payload.publication.operations.find(op => op.op === "set_offer_membership")!;
  if (op.op === "set_offer_membership") op.offerVersion = higher;
  const first = await commit(await save(payload, data.draftId, 1));
  content.catalogAction = "revise";
  content.offerMemberships[0].offerVersion = lower;
  const membership = { op: "set_offer_membership" as const, ...content.offerMemberships[0] };
  payload.publication.operations = [membership];
  const second = await commit(await save(payload, data.draftId, 2, first.head));
  content.presentation = { routePath: { en: "/ordering" } };
  payload.publication.operations.push({ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: content.presentation });
  const final = await commit(await save(payload, data.draftId, 3, second.head));
  const before = await authority.readbackV2(second.head), after = await authority.readbackV2(final.head);
  expect(before).toMatchObject({ outcome: "page", items: [{ facts: { memberships: [
    { offerVersion: lower, admitted: false }, { offerVersion: higher, admitted: false },
  ] } }] });
  expect(after.outcome === "page" && after.items).toEqual(before.outcome === "page" && before.items);
});

it.each([
  ["candidate", "missing"],
  ["candidate", "duplicate"],
  ["candidate", "conflicting"],
  ["candidate", "wrong key"],
  ["balance", "missing"],
  ["balance", "duplicate"],
  ["clock", "duplicate"],
  ["remaining", "duplicate"],
  ["pointer", "duplicate"],
  ["product projection", "duplicate"],
  ["SKU projection", "duplicate"],
  ["history", "duplicate"],
  ["facts", "duplicate"],
  ["facts", "wrong key"],
  ["legacy readback", "duplicate"],
  ["recovery", "duplicate"],
  ["retained", "duplicate"],
  ["retained", "missing companion"],
  ["retained", "wrong key"],
  ["price", "missing outcome"],
  ["price", "healthy"],
] as const)("publication validates the %s singleton boundary: %s", async (boundary, variation) => inPriceDatabase(async () => {
  const existing = boundary === "facts" || boundary === "legacy readback" || boundary === "recovery" || boundary === "retained" || boundary === "history";
  const data = boundary === "price" ? await priceDraft(false) : await draft();
  const first = existing ? await commit(data.publication) : null;
  const full = existing ? await authority.readbackV2(first!.head) : null;
  const predicates = {
    candidate: /^SELECT public.catalog_draft_record/u, balance: /^SELECT coalesce\(sum/u, clock: /^SELECT to_char\(clock_timestamp/u,
    remaining: /^SELECT count.*AS remaining FROM public.catalog_publication_pointer_capabilities/u,
    pointer: /^SELECT current_document_revision_id FROM public.catalog_products/u,
    "product projection": /^SELECT p.publication_facts=/u, "SKU projection": /^SELECT s.publication_facts=/u,
    history: /^SELECT EXISTS\(SELECT 1 FROM public.catalog_products/u, facts: /^SELECT p.product_id,p.revision,p.canonical_state/u,
    "legacy readback": /^SELECT product_id FROM public.catalog_publications/u, recovery: /FROM public.catalog_operator_receipts WHERE kind='publish'/u,
    retained: /^SELECT p.revision,p.canonical_state,p.digest AS manifest_digest/u, price: /^SELECT public.catalog_price_setup_apply_in_transaction/u,
  };
  ["price", "unexpected previous entry"],
  let hits = 0;
  const target = createPostgresCatalogPublication({ ...dependencies((sql, _executor, rows) => {
    if (!predicates[boundary].test(sql)) return;
    hits++;
    expect(rows).toHaveLength(1);
    if (variation === "missing") rows.splice(0);
    else if (variation === "duplicate") rows.push({ ...rows[0] });
    else if (variation === "conflicting") rows.push({ record: null });
    else if (variation === "wrong key") {
      if (boundary === "candidate") (rows[0]!.record as Record<string, unknown>).draftId = randomUUID();
      else rows[0]!.publication_id = randomUUID();
    } else if (variation === "missing companion") rows[0]!.full_facts = null;
    else if (variation === "missing outcome") delete (rows[0]!.result as Record<string, unknown>).outcome;
  }), acceptedSource: async (_executor, _context, binding) => binding });
  const capability = (await target.authorize(null))!;
  if (!existing) await approve(data.publication);
  const stable = await snapshot();
  const run = async () => {
    if (boundary === "history") return target.reads.history(data.productId, null);
    if (boundary === "facts") return target.readbackV2(first!.head);
    if (boundary === "legacy readback") return target.reads.readback(first!.head);
    if (boundary === "recovery") return target.receipt({ productId: data.productId, commandKey: data.publication.commandKey }, capability);
    if (boundary === "retained") {
      if (full?.outcome !== "page") throw new Error("Missing retained fixture");
      const results = await Promise.all((["account", "order", "fulfilment"] as const).map(kind =>
        target.resolveRetained({ kind, sourceId: randomUUID(), lineId: randomUUID(), productId: data.productId,
        skuId: data.skuId, skuRevisionId: full.items[0].reference.revisionId, publicationId: first!.head.publicationId,
        documentRevisionId: full.product.document!.id }, target.authorizeReadScope(null))));
    else if (variation === "unexpected previous entry") {
      const result = rows[0]!.result as { results: { receipt: { current: { entryId: string } } & Record<string, unknown> }[] };
      const { receipt } = result.results[0];
      receipt.previous = { ...receipt.current, entryId: randomUUID() };
    }
      expect(results.every(answer => canonicalCatalogDraftJson(answer) === canonicalCatalogDraftJson(results[0]))).toBe(true);
      return results[0];
    }
    return target.publish(data.publication, capability);
  };
  const result = await run();
  expect(hits).toBeGreaterThan(0);
  if (variation === "healthy") expect(result).toMatchObject({ outcome: "committed" });
  else {
    const reason = boundary === "price" ? "invalid_store_response"
      : boundary === "legacy readback" || boundary === "history" ? "publication_authority_unavailable"
      : boundary === "recovery" ? "catalog_publication_receipt_invalid" : "catalog_publication_read_invalid";
    expect(result).toEqual({ outcome: "dependency_unavailable", reason });
    expect(await snapshot()).toEqual(stable);
  }
}));

it.each([
  ["sealed name", "committed"],
  ["missing name", "catalog_publication_product_name_source_mismatch"],
  ["different name", "catalog_publication_product_name_source_mismatch"],
  ["clear on create", "catalog_publication_v3_structural_readiness_failed"],
  ["clear on revision", "committed"],
  ["repeat allowed membership", "committed"],
  ["repeat frozen membership", "catalog_publication_membership_change_not_allowed"],
  ["compensate frozen membership", "catalog_publication_membership_change_not_allowed"],
] as const)("publication enforces the authored capability for %s", async (mode, expected) => {
  const data = await draft(), payload = structuredClone(data.payload), content = payload.product.sharedContent;
  const existing = mode === "clear on revision" || mode.endsWith("membership");
  const first = existing ? await commit(data.publication) : null;
  if (mode.endsWith("name") && mode !== "sealed name") {
    const document = content.document!;
    if (mode === "missing name") delete document.name;
    else document.name = "Other authored name";
    const canonicalText = canonicalCatalogDraftJson(document), digest = createHash("sha256").update(canonicalText).digest("hex");
    payload.product.documentRevision!.digest = digest;
    const op = payload.publication.operations.find(op => op.op === "register_document_revision")!;
    Object.assign(op, { canonicalText, digest });
  }
  if (first) content.catalogAction = "revise";
  if (mode === "clear on create" || mode === "clear on revision") {
    const clear = { op: "set_product_presentation" as const, productSlug: payload.product.slug!, presentation: null };
    if (first) payload.publication.operations = [clear];
    else payload.publication.operations.splice(payload.publication.operations.findIndex(op => op.op === clear.op), 1, clear);
  }
  if (mode.endsWith("membership")) {
    content.presentation = { headline: "Changed catalogue presentation" };
    payload.publication.operations = [
      { op: "set_offer_membership", ...content.offerMemberships[0] },
      { op: "set_product_presentation", productSlug: payload.product.slug!, presentation: content.presentation },
    ];
    if (mode.startsWith("compensate")) payload.publication.kind = "compensation";
  }
  const command = await save(payload, data.draftId, 1, first?.head ?? null);
  const deps = dependencies();
  const checks: string[] = [];
  const target = createPostgresCatalogPublication({ ...deps, rules: { ...deps.rules,
    ...(mode.endsWith("membership") ? { validateMembershipChange(sku: { memberships: readonly { offerVersion: string; admitted: boolean }[] }, change: { offerVersion: string; admitted: boolean }) {
      checks.push(change.offerVersion);
      expect(sku.memberships).toContainEqual({ offerVersion: change.offerVersion, admitted: change.admitted });
      return mode === "repeat allowed membership";
    } } : {}),
  } });
  const capability = (await target.authorize(null))!;
  const invalidName = mode === "missing name" || mode === "different name";
  if (!invalidName) await approve(command);
  const stable = await snapshot();
  const result = invalidName ? await target.decision(approvalCommand(command), capability) : await target.publish(command, capability);
  if (expected === "committed") {
    expect(result).toMatchObject({ outcome: "committed" });
    if (result.outcome !== "committed" || !("head" in result.receipt)) throw new Error("Missing publication receipt");
    expect(await target.readbackV2(result.receipt.head)).toMatchObject({ outcome: "page", product: {
      name: "Synthetic article", presentation: mode === "clear on revision" ? null : content.presentation,
    } });
  } else {
    expect(result).toEqual({ outcome: "validation_issue", reason: expected });
    expect(await snapshot()).toEqual(stable);
  }
  expect(checks).toEqual(mode.endsWith("membership") ? ["example:offer"] : []);
});

it.each([
  ["create", "en", false],
  ["create", "en", true],
  ["revise", "pl", true],
  ["compensation", "en", true],
  ["preview", "pl", false],
] as const)("route ownership is checked before later publication work for %s/%s: child price %s", async (kind, locale, price) => inPriceDatabase(async () => {
  const other = await draft(), otherPayload = structuredClone(other.payload), path = `/occupied-${other.productId}`;
  otherPayload.product.sharedContent.presentation = { routePath: { [locale]: path } };
  const presentation = otherPayload.publication.operations.find(op => op.op === "set_product_presentation")!;
  if (presentation.op === "set_product_presentation") presentation.presentation = otherPayload.product.sharedContent.presentation;
  await commit(await save(otherPayload, other.draftId, 1));
  const data = await priceDraft(false), payload = structuredClone(data.payload);
  const existing = kind === "revise" || kind === "compensation", initial = existing ? await commit(data.publication) : null;
  const content = payload.product.sharedContent;
  content.presentation = { routePath: { [locale]: path } };
  if (existing) {
    content.catalogAction = "revise";
    payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: content.presentation }];
  } else {
    const op = payload.publication.operations.find(op => op.op === "set_product_presentation")!;
    if (op.op === "set_product_presentation") op.presentation = content.presentation;
  }
  if (kind === "compensation") payload.publication.kind = "compensation";
  if (price) {
    const operation = payload.skus[0].priceOperations![0];
    operation.commandKey = `stale:${data.skuId}`;
    operation.expected = { entryId: randomUUID(), unitPriceMinor: 1000 };
  } else delete payload.skus[0].priceOperations;
  const command = await save(payload, data.draftId, 2, initial?.head ?? null);
  const check = async (executor: PgQueryExecutor, productId: string) => {
    const rows = (await executor.query(`SELECT EXISTS(SELECT 1 FROM public.catalog_products WHERE id<>$1
      AND publication_facts #>> ARRAY['presentation','routePath',$2::text]=$3) AS conflict`, [productId, locale, path])).rows;
    const ready = !rows[0]!.conflict;
    return { ready, reasons: ready ? [] : ["duplicate_route"] };
  };
  const deps = dependencies();
  if (kind === "preview") {
    const service = createCatalogCandidateService({ registry, publicationRules: deps.rules,
      readDraft: async (draftId, revision) => (await db.query("SELECT public.catalog_draft_record($1,$2) AS record", [draftId, revision ?? 3])).rows[0].record,
      installedDefinitionDigest: async () => catalogDefinitionDigest(definition), resolveHead: async () => null,
      currentHead: async () => ({ outcome: "unpublished" }),
      presentationReadiness: productId => check(db, productId),
    });
    const query = { draftId: data.draftId, draftRevision: 3, expectedHead: null };
    const first = await service.prepareCandidate(query);
    expect(first.preparation?.structural).toMatchObject({ outcome: "blocked-input", issues: [{ code: "duplicate_route" }] });
    expect(await service.validate(first.candidateRef)).toEqual(first);
    expect(await service.compareCandidate({ ...first, expectedHead: null })).toEqual(first);
    return;
  }
  let childApply = 0, checks = 0;
  const target = createPostgresCatalogPublication({ ...dependencies(sql => {
    if (sql.startsWith("SELECT public.catalog_price_setup_apply_in_transaction")) childApply++;
  }), presentationReadiness: async (executor, productId) => { checks++; return check(executor, productId); } });
  const capability = (await target.authorize(null))!;
  await approve(command);
  const stable = await snapshot();
  expect(await target.publish(command, capability)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_v3_structural_readiness_failed" });
  expect(checks).toBe(1);
  expect(childApply).toBe(0);
  expect(await snapshot()).toEqual(stable);
}));

it.each(["archive eligible product", "leave last membership", "live eligible", "live ineligible"] as const)(
  "publication calculates affected obligations from the owning state: %s", async mode => inPriceDatabase(async () => {
    const liveMismatch = mode.startsWith("live");
    const data = await priceDraft(mode !== "live eligible"), initial = realPriceAuthority();
    const initialActor = (await initial.authorize(null))!, first = await commit(data.publication, initial, initialActor);
    const payload = structuredClone(data.payload), content = payload.product.sharedContent, skuCode = payload.skus[0].code!;
    content.catalogAction = "revise";
    delete payload.skus[0].priceOperations;
    if (mode === "archive eligible product") payload.publication.operations = [
      { op: "set_product_status", productSlug: payload.product.slug!, status: "archived" },
    ];
    if (mode === "leave last membership") {
      content.offerMemberships[0].admitted = false;
      payload.publication.operations = [{ op: "set_offer_membership", ...content.offerMemberships[0] }];
    }
    if (liveMismatch) {
      payload.publication.kind = "compensation"; payload.skus = []; delete payload.product.primarySkuId;
      Object.assign(content, { publicationSkus: [], offerMemberships: [], requestedModes: [] });
      const document = { ...content.document, revisionNo: 2 };
      const canonicalText = canonicalCatalogDraftJson(document), digest = createHash("sha256").update(canonicalText).digest("hex"), revisionId = randomUUID();
      const reference = payload.product.documentRevision!;
      content.document = document;
      payload.product.documentRevision = { ...reference, id: revisionId, revisionNo: 2, digest };
      payload.publication.operations = [
        { op: "register_document_revision", productSlug: payload.product.slug!, revisionId, revisionNo: 2, documentRef: reference.documentRef,
          sourceRef: reference.sourceRef, canonicalText, digest, provenance: { source: "current_draft" } },
        { op: "move_document_pointer", productSlug: payload.product.slug!, documentRevisionNo: 2 },
      ];
    }
    const command = await save(payload, data.draftId, 2, first.head);
    await approve(command);
    const connection = await db.connect(), phases: boolean[] = [];
    try {
      await connection.query("BEGIN");
      await connection.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: admin })]);
      if (liveMismatch) await connection.query("UPDATE public.catalog_skus SET status='active',sellable_standalone=$2 WHERE id=$1", [data.skuId, mode === "live eligible"]);
      const target = realPriceAuthority(connection, (sql, _client, _rows, values) => {
        if (sql.startsWith("SELECT public.catalog_publication_sku_reasons")) phases.push(Boolean(values?.[1]));
      });
      const capability = (await target.authorize(null))!, stable = await snapshot(connection);
      const result = await target.publish(command, capability);
      if (liveMismatch) {
        expect(result).toEqual(mode === "live eligible" ? { outcome: "conflict", reason: "catalog_publication_draft_advanced" }
          : { outcome: "validation_issue", reason: "catalog_publication_post_state_mismatch" });
        expect(await snapshot(connection)).toEqual(stable);
        if (mode === "live eligible") expect(phases).toEqual([]);
      } else {
        expect(result.outcome).toBe("committed");
        const rows = (await connection.query(`SELECT p.status AS product_status,s.sellable_standalone,s.publication_facts->'memberships' AS memberships
          FROM public.catalog_products p JOIN public.catalog_skus s ON s.product_id=p.id WHERE s.sku=$1`, [skuCode])).rows;
        expect(rows).toEqual([{ product_status: mode === "archive eligible product" ? "archived" : "draft", sellable_standalone: true,
          memberships: [{ offerVersion: "example:offer", admitted: mode !== "leave last membership" }] }]);
        expect(phases).toEqual([]);
      }
    } finally { await connection.query("ROLLBACK"); connection.release(); }
  }));

it.each([
  ["publish", "  padded  ", true],
  ["publish", " ", true],
  ["publish", "é".repeat(99) + "x", true],
  ["publish", "é".repeat(100), true],
  ["publish", "é".repeat(100) + "x", false],
  ["publish", "", false],
  ["approve", null, true],
  ["approve", "  readable reason  ", true],
  ["revoke", "\t", true],
  ["revoke", "  ", false],
  ["revoke", "é".repeat(500), true],
  ["revoke", "é".repeat(500) + "x", false],
  ["anchor UUID", "------------------------------------", false],
  ["anchor revision", "40000000-0000-4000-8000-000000000001", false],
] as const)("publication uses field-specific UTF-8 wire bounds for %s (%j)", async (kind, value, valid) => {
  const data = await draft(), command = data.publication;
  if (kind === "publish") {
    await approve(command);
    const submitted = { ...command, commandKey: value! }, stable = await snapshot();
    const result = await authority.publish(submitted, actor);
    if (valid) {
      expect(result).toMatchObject({ outcome: "committed", receipt: { commandKey: value } });
      if (result.outcome !== "committed") throw new Error("Missing publication receipt");
      expect(await authority.publish(submitted, actor)).toEqual({ outcome: "replayed", receipt: result.receipt });
      expect(await authority.receipt({ productId: data.productId, commandKey: value! }, actor)).toEqual({ outcome: "found", receipt: result.receipt });
    } else {
      expect(result).toEqual({ outcome: "validation_issue", reason: "catalog_publication_command_invalid" });
      expect(await snapshot()).toEqual(stable);
    }
    return;
  }
  if (kind.startsWith("anchor")) {
    let reached = false;
    const target = createPostgresCatalogPublication(dependencies(sql => {
      if (sql.includes("JOIN public.catalog_product_document_revisions")) reached = true;
    }));
    const capability = (await target.authorize(null))!;
    const candidateRef = `v1:${data.draftId}@1/${value}@${kind.endsWith("UUID") ? 1 : 2_147_483_648}`;
    expect(await target.publish({ ...command, candidateRef }, capability)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_command_invalid" });
    expect(reached).toBe(false);
    return;
  }
  if (kind === "revoke") await approve(command);
  const submitted = { schemaVersion: 2 as const, action: kind as "approve" | "revoke", productId: data.productId, commandKey: "decision:wire",
    candidateRef: command.candidateRef, candidateDigest: command.candidateDigest, reason: value };
  const stable = await snapshot(), result = await authority.decision(submitted, actor);
  if (valid) {
    expect(result).toMatchObject({ outcome: "committed", receipt: { reason: value } });
    if (result.outcome !== "committed") throw new Error("Missing decision receipt");
    expect(await authority.decision(submitted, actor)).toEqual({ outcome: "replayed", receipt: result.receipt });
  } else {
    expect(result).toEqual({ outcome: "validation_issue", reason: "catalog_publication_command_invalid" });
    expect(await snapshot()).toEqual(stable);
  }
});

async function nativePublicationSqlRow(): Promise<Record<string, unknown>> {
  const data = foreignPublished.data, payload = structuredClone(data.payload);
  payload.product.sharedContent.catalogAction = "revise"; payload.publication.kind = "compensation"; payload.skus = []; delete payload.product.primarySkuId;
  payload.product.sharedContent.publicationSkus = []; payload.product.sharedContent.requestedModes = []; payload.product.sharedContent.offerMemberships = [];
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
  const revision = (await db.query("SELECT revision FROM public.catalog_draft_heads WHERE draft_id=$1", [data.draftId])).rows[0].revision;
  const command = await save(payload, data.draftId, revision, foreignPublished.head); await approve(command);
  const row = (await db.query("SELECT to_jsonb(p) AS value FROM public.catalog_publications p WHERE id=$1", [foreignPublished.head.publicationId])).rows[0].value as Record<string, unknown>;
  return { ...row, id: randomUUID(), revision: 2, previous_id: row.id, draft_revision: revision + 1, candidate_ref: command.candidateRef,
    candidate_digest: command.candidateDigest, command_key: `fixture:publication:${randomUUID()}`, committed_at: (await db.query("SELECT clock_timestamp()::text AS value")).rows[0].value };
}

it.each(["zero revision", "max revision", "zero draft revision", "max absent draft revision", "short candidate digest", "nonhex candidate digest", "manifest bound", "manifest overflow", "manifest digest", "manifest object", "manifest schema", "manifest product", "manifest roster"] as const)("cycle1 native publication SQL admission: %s", async mode => {
  const row: Record<string, unknown> = await nativePublicationSqlRow();
  let rejection: Record<string, string> | null = null;
  if (mode === "zero revision") { row.revision = 0; rejection = { code: "23514", constraint: "catalog_publications_revision_check" }; }
  if (mode === "max revision") { row.revision = 2_147_483_647; rejection = { code: "23514", message: "catalog_publication_lineage_invalid" }; }
  if (mode === "zero draft revision") { row.draft_revision = 0; rejection = { code: "23514", constraint: "catalog_publications_draft_revision_check" }; }
  if (mode === "max absent draft revision") { row.draft_revision = 2_147_483_647; rejection = { code: "23503" }; }
  if (mode === "short candidate digest" || mode === "nonhex candidate digest") { row.candidate_digest = (mode === "short candidate digest" ? "a".repeat(63) : "g".repeat(64)); rejection = { code: "23514", constraint: "catalog_publications_candidate_digest_check" }; }
  const state = JSON.parse(row.canonical_state as string);
  if (mode === "manifest bound" || mode === "manifest overflow") {
    state.product.content.document.zzPadding = "";
    const bytes = 16_777_216 + (mode === "manifest overflow" ? 1 : 0);
    state.product.content.document.zzPadding = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(state)));
    row.canonical_state = JSON.stringify(state); expect(Buffer.byteLength(row.canonical_state as string)).toBe(bytes);
    if (mode === "manifest overflow") rejection = { code: "23514", constraint: "catalog_publications_canonical_state_check" };
  }
  if (mode === "manifest object") { row.canonical_state = "[]"; rejection = { code: "23514", message: "catalog_publication_state_invalid" }; }
  if (mode === "manifest schema") { state.schemaVersion = 1; row.canonical_state = JSON.stringify(state); rejection = { code: "23514", message: "catalog_publication_state_invalid" }; }
  if (mode === "manifest product") { state.product.id = randomUUID(); row.canonical_state = JSON.stringify(state); rejection = { code: "23514", message: "catalog_publication_state_invalid" }; }
  if (mode === "manifest roster") { state.skus = {}; row.canonical_state = JSON.stringify(state); rejection = { code: "23514", message: "catalog_publication_state_invalid" }; }
  row.digest = createHash("sha256").update(row.canonical_state as string).digest("hex");
  if (mode === "manifest digest") { row.digest = `${(row.digest as string)[0] === "a" ? "b" : "a"}${(row.digest as string).slice(1)}`; rejection = { code: "23514", message: "catalog_publication_digest_mismatch" }; }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const insert = client.query("INSERT INTO public.catalog_publications SELECT (jsonb_populate_record(NULL::public.catalog_publications,$1::jsonb)).*", [JSON.stringify(row)]);
    if (rejection) await expect(insert).rejects.toMatchObject(rejection); else expect((await insert).rowCount).toBe(1);
  } finally { await client.query("ROLLBACK"); client.release(); }
});

it.each(["canonical mismatch", "digest mismatch", "nonobject", "legacy null"] as const)("cycle1 native document SQL admission: %s", async mode => {
  const client = await db.connect(), value = { schemaVersion: 1, derived: 12, zzFixture: randomUUID() };
  const canonical = mode === "nonobject" ? "13" : canonicalCatalogDraftJson(value), payload = mode === "canonical mismatch" ? canonicalCatalogDraftJson({ ...value, derived: 13 }) : canonical;
  const digest = createHash("sha256").update(canonical).digest("hex"), wrongDigest = `${digest[0] === "a" ? "b" : "a"}${digest.slice(1)}`;
  try {
    await client.query("BEGIN");
    const insert = client.query(`INSERT INTO public.catalog_product_document_revisions(id,product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest,canonical_text)
      SELECT $1,product_id,revision_no+1,schema_id,document_ref,$2::jsonb,source_ref,provenance,$3,$4 FROM public.catalog_product_document_revisions WHERE id=$5`,
    [randomUUID(), payload, mode === "digest mismatch" ? wrongDigest : digest, mode === "legacy null" ? null : canonical, foreignPublished.data.payload.product.documentRevision!.id]);
    if (mode === "legacy null") expect((await insert).rowCount).toBe(1);
    else await expect(insert).rejects.toMatchObject(mode === "canonical mismatch" ? { code: "23514", constraint: "catalog_document_canonical_text_check" } : { code: "23514", message: mode === "digest mismatch" ? "catalog_publication_digest_mismatch" : "catalog_publication_state_invalid" });
  } finally { await client.query("ROLLBACK"); client.release(); }
});

it.each(["zero", "maximum", "foreign publication"] as const)("cycle1 native head SQL admission: %s", async mode => {
  const row = await nativePublicationSqlRow(), client = await db.connect();
  try {
    await client.query("BEGIN");
    if (mode === "maximum") {
      row.revision = 2_147_483_647;
      await expect(client.query("UPDATE public.catalog_publication_heads SET publication_id=$2,revision=2147483647 WHERE product_id=$1",
        [row.product_id, row.id])).rejects.toMatchObject({ code: "23503" });
    } else await expect(client.query("UPDATE public.catalog_publication_heads SET publication_id=$2,revision=$3 WHERE product_id=$1", [row.product_id, mode === "foreign publication" ? paged.head.publicationId : foreignPublished.head.publicationId, mode === "zero" ? 0 : paged.head.revision]))
      .rejects.toMatchObject(mode === "zero" ? { code: "23514", constraint: "catalog_publication_heads_revision_check" } : { code: "23503" });
  } finally { await client.query("ROLLBACK"); client.release(); }
});

it.each(["zero revision", "max revision", "facts bound", "facts overflow", "facts digest", "facts object", "facts SKU", "facts product", "foreign SKU", "foreign publication"] as const)("cycle1 native SKU revision SQL admission: %s", async mode => {
  const row = (await db.query("SELECT to_jsonb(r) AS value FROM public.catalog_sku_revisions r WHERE publication_id=$1 LIMIT 1", [foreignPublished.head.publicationId])).rows[0].value as Record<string, unknown>;
  row.id = randomUUID(); row.revision = 2;
  let rejection: Record<string, string> | null = null;
  if (mode === "zero revision") { row.revision = 0; rejection = { code: "23514", constraint: "catalog_sku_revisions_revision_check" }; }
  if (mode === "max revision") row.revision = 2_147_483_647;
  const facts = JSON.parse(row.full_facts as string);
  if (mode === "facts bound" || mode === "facts overflow") {
    facts.facts.zzPadding = ""; const bytes = 2_097_152 + (mode === "facts overflow" ? 1 : 0);
    facts.facts.zzPadding = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(facts)));
    row.full_facts = JSON.stringify(facts); expect(Buffer.byteLength(row.full_facts as string)).toBe(bytes);
    if (mode === "facts overflow") rejection = { code: "23514", constraint: "catalog_sku_revisions_full_facts_check" };
  }
  if (mode === "facts object") { row.full_facts = "[]"; rejection = { code: "23514", message: "catalog_publication_state_invalid" }; }
  if (mode === "facts SKU") { facts.id = randomUUID(); row.full_facts = JSON.stringify(facts); rejection = { code: "23514", message: "catalog_publication_sku_revision_invalid" }; }
  if (mode === "facts product") { facts.productId = randomUUID(); row.full_facts = JSON.stringify(facts); rejection = { code: "23514", message: "catalog_publication_sku_revision_invalid" }; }
  if (mode === "foreign SKU") { row.sku_id = paged.data.skuId; facts.id = row.sku_id; row.full_facts = JSON.stringify(facts); rejection = { code: "23503" }; }
  if (mode === "foreign publication") { row.publication_id = paged.head.publicationId; rejection = { code: "23503" }; }
  row.digest = createHash("sha256").update(row.full_facts as string).digest("hex");
  if (mode === "facts digest") { row.digest = `${(row.digest as string)[0] === "a" ? "b" : "a"}${(row.digest as string).slice(1)}`; rejection = { code: "23514", message: "catalog_publication_digest_mismatch" }; }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const insert = client.query("INSERT INTO public.catalog_sku_revisions SELECT (jsonb_populate_record(NULL::public.catalog_sku_revisions,$1::jsonb)).*", [JSON.stringify(row)]);
    if (rejection) await expect(insert).rejects.toMatchObject(rejection); else expect((await insert).rowCount).toBe(1);
  } finally { await client.query("ROLLBACK"); client.release(); }
});

it.each(["one kind", "max kind", "empty kind", "padded kind", "long kind", "one key", "max key", "empty key", "padded key", "long key", "short fingerprint", "nonhex fingerprint", "empty object", "primitive result", "result bound", "result overflow"] as const)("cycle1 native receipt SQL admission: %s", async mode => {
  const row = (await db.query("SELECT to_jsonb(r) AS value FROM public.catalog_operator_receipts r WHERE kind='publish' AND publication_id=$1", [foreignPublished.head.publicationId])).rows[0].value as Record<string, unknown>;
  row.command_key = `constraint:${randomUUID()}`;
  let rejection: Record<string, string> | null = null;
  if (mode.endsWith("kind")) {
    row.kind = mode === "one kind" ? "x" : mode === "max kind" ? "x".repeat(80) : mode === "empty kind" ? "" : mode === "padded kind" ? " publish " : "x".repeat(81);
    if (["empty kind", "padded kind", "long kind"].includes(mode)) rejection = { code: "23514", constraint: "catalog_operator_receipts_kind_check" };
  }
  if (mode.endsWith("key")) {
    row.command_key = mode === "one key" ? "x" : mode === "max key" ? "é".repeat(100) : mode === "empty key" ? "" : mode === "padded key" ? " key " : "é".repeat(100) + "x";
    if (["empty key", "long key"].includes(mode)) rejection = { code: "23514", constraint: "catalog_operator_receipts_command_key_check" };
  }
  if (mode === "short fingerprint" || mode === "nonhex fingerprint") { row.fingerprint = mode === "short fingerprint" ? "a".repeat(63) : "g".repeat(64); rejection = { code: "23514", constraint: "catalog_operator_receipts_fingerprint_check" }; }
  if (mode === "empty object") row.result = "{}";
  if (mode === "primitive result") { row.result = "false"; rejection = { code: "23514", constraint: "catalog_operator_receipts_result_check" }; }
  if (mode === "result bound" || mode === "result overflow") {
    const receipt = { items: Array.from({ length: 100 }, () => false), zzPadding: "" };
    const bytes = 8_388_608 + (mode === "result overflow" ? 1 : 0);
    const missing = bytes - Buffer.byteLength(JSON.stringify({ outcome: "committed", receipt }));
    receipt.zzPadding = "é".repeat(Math.floor(missing / 2)) + "x".repeat(missing % 2);
    row.result = JSON.stringify(receipt);
    expect(Buffer.byteLength(JSON.stringify({ outcome: "committed", receipt }))).toBe(bytes);
    expect((await db.query("SELECT octet_length($1::jsonb::text) AS bytes", [row.result])).rows[0].bytes).toBeGreaterThan(8_388_608);
    if (mode === "result overflow") rejection = { code: "23514", constraint: "catalog_operator_receipts_result_check" };
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const insert = client.query("INSERT INTO public.catalog_operator_receipts SELECT (jsonb_populate_record(NULL::public.catalog_operator_receipts,$1::jsonb)).*", [JSON.stringify(row)]);
    if (rejection) await expect(insert).rejects.toMatchObject(rejection); else expect((await insert).rowCount).toBe(1);
  } finally { await client.query("ROLLBACK"); client.release(); }
});

it.each(["one reason", "max reason", "null reason", "tab reason", "blank reason", "long reason", "padded long reason", "action", "short candidate digest", "nonhex candidate digest", "short reference digest", "nonhex reference digest", "short fingerprint", "nonhex fingerprint"] as const)("cycle1 native decision SQL admission: %s", async mode => {
  const decision = (await db.query("SELECT to_jsonb(d) AS value FROM public.catalog_publication_decisions d WHERE product_id=$1 LIMIT 1", [foreignPublished.data.productId])).rows[0].value as Record<string, unknown>;
  const receipt = (await db.query("SELECT to_jsonb(r) AS value FROM public.catalog_operator_receipts r WHERE kind=$3 AND scope_id=$1 AND command_key=$2", [decision.product_id, decision.command_key, decision.action])).rows[0].value as Record<string, unknown>;
  decision.id = randomUUID(); decision.command_key = `constraint:${randomUUID()}`; receipt.command_key = decision.command_key;
  let constraint = "catalog_publication_decisions_reason_check";
  if (mode === "one reason") decision.reason = "x";
  if (mode === "max reason") decision.reason = "é".repeat(500);
  if (mode === "null reason") decision.reason = null;
  if (mode === "tab reason") decision.reason = "\t";
  if (mode === "blank reason") decision.reason = " ";
  if (mode === "long reason") decision.reason = "é".repeat(500) + "x";
  if (mode === "padded long reason") decision.reason = ` ${"x".repeat(1000)}`;
  if (mode === "action") { decision.action = "deny"; constraint = "catalog_publication_decisions_action_check"; }
  for (const [label, field] of [["candidate digest", "candidate_digest"], ["reference digest", "candidate_reference_digest"], ["fingerprint", "fingerprint"]]) {
    if (mode.endsWith(label)) { decision[field] = mode.startsWith("short") ? "a".repeat(63) : "g".repeat(64); constraint = `catalog_publication_decisions_${field}_check`; }
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO public.catalog_operator_receipts SELECT (jsonb_populate_record(NULL::public.catalog_operator_receipts,$1::jsonb)).*", [JSON.stringify(receipt)]);
    const insert = client.query("INSERT INTO public.catalog_publication_decisions SELECT (jsonb_populate_record(NULL::public.catalog_publication_decisions,$1::jsonb)).*", [JSON.stringify(decision)]);
    if (["one reason", "max reason", "null reason", "tab reason"].includes(mode)) expect((await insert).rowCount).toBe(1); else await expect(insert).rejects.toMatchObject({ code: "23514", constraint });
  } finally { await client.query("ROLLBACK"); client.release(); }
});

it.each(["short", "nonhex", "valid"] as const)("cycle1 native pointer SQL fingerprint: %s", async mode => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const fingerprint = mode === "short" ? "a".repeat(63) : mode === "nonhex" ? "g".repeat(64) : "a".repeat(64);
    const insert = client.query("INSERT INTO public.catalog_publication_pointer_capabilities VALUES(pg_current_xact_id(),$1,$2,$3)", [foreignPublished.data.productId, foreignPublished.data.payload.product.documentRevision!.id, fingerprint]);
    if (mode === "valid") expect((await insert).rowCount).toBe(1); else await expect(insert).rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_pointer_capabilit_command_fingerprint_check" });
  } finally { await client.query("ROLLBACK"); client.release(); }
});

it.each(["catalog_publications", "catalog_sku_revisions", "catalog_operator_receipts", "catalog_publication_decisions"] as const)("cycle1 native immutable SQL refusal names %s", async table => {
  await expect(db.query(`UPDATE public.${table} SET ${table === "catalog_operator_receipts" ? "command_key=command_key" : "id=id"}`))
    .rejects.toMatchObject({ code: "55000", message: "catalog_publication_record_immutable" });
});


it.each((["anon", "authenticated", "service_role"] as const).flatMap(role => (["present", "absent"] as const).map(mode => ({ role, mode }))))("cycle1 native optional role SQL admission: $role $mode", async ({ role, mode }) => {
  const statement = readFileSync("db/platform/migrations/20261123150000_catalog_publication.sql", "utf8").split("\n")
    .find(line => line.startsWith("DO $$") && line.includes(`FROM ${role};`));
  expect(statement).toBeDefined();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const exists = (await client.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS value", [role])).rows[0].value;
    if (mode === "present") {
      if (!exists) await client.query(`CREATE ROLE ${role}`);
      await client.query(`GRANT SELECT ON public.catalog_publications TO ${role}`);
    } else if (exists) await client.query(`ALTER ROLE ${role} RENAME TO publication_absent_${role}_${process.pid}`);
    await client.query(statement!);
    if (mode === "present") expect((await client.query("SELECT has_table_privilege($1,'public.catalog_publications','SELECT') AS allowed", [role])).rows[0].allowed).toBe(false);
  } finally { await client.query("ROLLBACK"); client.release(); }
});

it("cycle1 native readiness requires the primary unit identifier", async () => {
  const client = await db.connect();
  const skuId = foreignPublished.data.payload.skus[0].id;
  try {
    await client.query("BEGIN");
    await client.query("UPDATE public.catalog_skus SET publication_facts=jsonb_set(publication_facts,'{logisticsRef}','\"native-logistics\"') WHERE id=$1", [skuId]);
    const reasons = async () => (await client.query("SELECT public.catalog_publication_sku_reasons($1,true) AS reasons", [skuId])).rows[0].reasons;
    expect(await reasons()).toEqual([]);
    await client.query("UPDATE public.catalog_sku_identifiers SET is_primary=false WHERE catalog_sku_id=$1", [skuId]);
    expect(await reasons()).toEqual(["unit_gtin_missing"]);
    await client.query("UPDATE public.catalog_sku_identifiers SET is_primary=true WHERE catalog_sku_id=$1 AND identifier_kind='gtin' AND pack_kind='unit'", [skuId]);
    expect(await reasons()).toEqual([]);
  } finally { await client.query("ROLLBACK"); client.release(); }
});

it("cycle1 native readiness requires the current document pointer", async () => {
  const client = await db.connect(), productId = randomUUID(), skuId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO public.catalog_products(id,slug,name,status) VALUES($1,$2,'Unpointed native document','draft')", [productId, `unpointed-${productId}`]);
    await client.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$2,$3,'Unpointed native SKU')", [skuId, productId, `SKU-${skuId}`]);
    await client.query("UPDATE public.catalog_products SET primary_sku_id=$2 WHERE id=$1", [productId, skuId]);
    await client.query("INSERT INTO public.catalog_product_document_revisions(product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest) VALUES($1,1,'legacy:document','unpointed','{}','native-fixture','{}',$2)", [productId, "a".repeat(64)]);
    expect((await client.query("SELECT public.catalog_publication_sku_reasons($1,false) AS reasons", [skuId])).rows[0].reasons).toEqual(["document_revision_missing"]);
  } finally { await client.query("ROLLBACK"); client.release(); }
});

it("cycle1 native readiness precedence keeps identity before archived status", async () => {
  const client = await db.connect(), skuId = foreignPublished.data.payload.skus[0].id;
  try {
    await client.query("BEGIN");
    await client.query("UPDATE public.catalog_products SET slug=$2 WHERE id=$1", [foreignPublished.data.productId, "p".repeat(65)]);
    await client.query("UPDATE public.catalog_skus SET status='archived',publication_facts=jsonb_set(publication_facts,'{logisticsRef}','\"native-logistics\"') WHERE id=$1", [skuId]);
    expect((await client.query("SELECT public.catalog_publication_sku_reasons($1,true) AS reasons", [skuId])).rows[0].reasons).toEqual(["primary_sku_missing", "commerce_identity_unsupported", "sku_archived"]);
  } finally { await client.query("ROLLBACK"); client.release(); }
});

it("refuses malformed legacy publication lookup before querying a head", async () => {
  const invalidHead = { ...foreignPublished.head, revision: 0 };
  let queried = false;
  const target = createPostgresCatalogPublication(dependencies(sql => { if (!sql.startsWith("SET TRANSACTION")) queried = true; }));
  expect(await target.reads.readback(invalidHead)).toEqual({ outcome: "validation_issue", reason: "candidate_invalid" });
  expect(queried).toBe(false);
});

it("refuses a well-formed legacy head with no retained publication", async () => {
  const missingHead = { ...foreignPublished.head, publicationId: randomUUID() };
  expect(await authority.reads.readback(missingHead)).toEqual({ outcome: "unsupported", reason: "publication_not_supported" });
});

it("refuses a publication history receipt bound to a different product", async () => {
  const rows = (await db.query(`SELECT p.revision,p.id,r.result::jsonb AS result,r.kind,r.scope_id,r.command_key,r.fingerprint,r.actor_id,r.publication_id
    FROM public.catalog_publications p JOIN public.catalog_operator_receipts r ON r.publication_id=p.id
    WHERE p.id=$1 AND r.kind='publish'`, [foreignPublished.head.publicationId])).rows;
  expect(rows).toHaveLength(1);
  const target = createPostgresCatalogPublication(dependencies((sql, _executor, returned) => {
    if (sql.startsWith("SELECT p.revision,p.id,r.result")) returned.splice(0, returned.length, ...rows);
  }));
  expect(await target.reads.history(paged.data.productId, null))
    .toEqual({ outcome: "dependency_unavailable", reason: "publication_authority_unavailable" });
});

it("returns absence when publication recovery finds an approval under the same scope and key", async () => {
  const scope = { productId: foreignPublished.data.productId, commandKey: `approve:${foreignPublished.data.publication.commandKey}` };
  expect((await db.query("SELECT kind FROM public.catalog_operator_receipts WHERE scope_id=$1 AND command_key=$2", [scope.productId, scope.commandKey])).rows)
    .toEqual([{ kind: "approve" }]);
  expect(await authority.receipt(scope, actor)).toEqual({ outcome: "absent" });
  expect(await authority.readPort(actor).receipt(scope)).toEqual({ outcome: "absent" });
});

it.each(["legacy GTIN first", "row locker first", "publisher first with colliding GTIN", "publisher first with distinct identifier", "publisher first with colliding SKU"] as const)(
  "publication serializes with independent native catalogue writers: %s", async mode => {
    const data = await draft();
    const existing = mode === "row locker first" ? await commit(data.publication) : null;
    const command = existing ? await revise(data, existing.head) : data.publication;
    await approve(command);
    const competing = await db.connect();
    const gtin = data.payload.skus[0].identifiers![0].value;
    const otherSku = foreignPublished.data.skuId;
    const table = mode.endsWith("SKU") ? "catalog_skus" : "catalog_sku_identifiers";
    const writeIdentifier = (kind: "gtin" | "other") => competing.query(`INSERT INTO public.catalog_sku_identifiers
      (catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity) VALUES($1,$2,$3,$4,'unit',1)`,
    [otherSku, `legacy:${randomUUID()}`, kind, kind === "gtin" ? gtin : randomUUID()]);
    const writeLegacySku = () => competing.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,status,min_order_qty,is_addon,
      sellable_standalone,sellable_in_subscription,net_weight_g,combination_digest)
      SELECT $1,product_id,$2,title,'draft',min_order_qty,is_addon,false,false,net_weight_g,combination_digest
      FROM public.catalog_skus WHERE id=$3`, [randomUUID(), `SKU-${randomUUID()}`, data.skuId]);
    let guarded: boolean | undefined;
    let done = false;
    const target = createPostgresCatalogPublication(dependencies(async sql => {
      if (!mode.startsWith("publisher first") || !sql.startsWith("SELECT count(*)::integer AS remaining")) return;
      await competing.query("SAVEPOINT lock_probe");
      try {
        await competing.query(`LOCK TABLE public.${table} IN ROW EXCLUSIVE MODE NOWAIT`);
        guarded = false;
        if (mode.endsWith("distinct identifier")) await writeIdentifier("other");
      } catch (error) {
        expect(error).toMatchObject({ code: "55P03" });
        guarded = true;
        await competing.query("ROLLBACK TO SAVEPOINT lock_probe");
      }
      await competing.query("RELEASE SAVEPOINT lock_probe");
    }));
    const capability = (await target.authorize(null))!;
    try {
      await competing.query("BEGIN");
      if (mode === "legacy GTIN first") await writeIdentifier("gtin");
      if (mode === "row locker first") await competing.query("SELECT id FROM public.catalog_products WHERE id=$1 FOR NO KEY UPDATE", [data.productId]);
      const result = target.publish(command, capability).then(value => { done = true; return value; });
      if (mode === "row locker first") {
        const wait = async () => (await db.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM public.catalog_products WHERE id=%') AS value`)).rows[0].value;
        await expect.poll(async () => done || await wait()).toBe(true);
        if (!done) await competing.query("ROLLBACK");
      }
      if (mode.endsWith(" first")) {
        expect(await result).toEqual({ outcome: "conflict", reason: "catalog_publication_busy" });
        return;
      }
      expect(await result).toMatchObject({ outcome: "committed" });
      expect(guarded).toBe(true);
      if (mode.endsWith("distinct identifier")) expect((await writeIdentifier("other")).rowCount).toBe(1);
      else await expect(mode.endsWith("SKU") ? writeLegacySku() : writeIdentifier("gtin")).rejects.toMatchObject({ code: "23505" });
    } finally {
      await competing.query("ROLLBACK");
      competing.release();
    }
  });

it("publication binds an omitted SKU to its newest authored issuance without rewriting SKU facts", async () => inPriceDatabase(async () => {
  const target = realPriceAuthority(), capability = (await target.authorize(null))!;
  const data = await priceDraft(), first = await commit(data.publication, target, capability);
  const payload = structuredClone(data.payload);
  delete payload.skus[0].priceOperations;
  payload.product.sharedContent.presentation = { headline: "New catalogue presentation" };
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
  const second = await commit(await save(payload, data.draftId, 2, first.head), target, capability);
  const before = await target.readbackV2(first.head), after = await target.readbackV2(second.head);
  if (before.outcome !== "page" || after.outcome !== "page") throw new Error("Expected retained catalogue facts");
  expect(after.items[0].reference).toEqual(before.items[0].reference);
  payload.skus = [];
  delete payload.product.primarySkuId;
  Object.assign(payload.product.sharedContent, { publicationSkus: [], requestedModes: [], offerMemberships: [] });
  const authored = { ...payload.product.sharedContent.document, revisionNo: 2 };
  const canonicalText = canonicalCatalogDraftJson(authored), digest = createHash("sha256").update(canonicalText).digest("hex"), revisionId = randomUUID();
  const document = { ...payload.product.documentRevision!, id: revisionId, revisionNo: 2, digest };
  payload.product.sharedContent.document = authored;
  payload.product.documentRevision = document;
  payload.publication.operations = [
    { op: "register_document_revision", productSlug: payload.product.slug!, revisionId, revisionNo: 2,
      documentRef: document.documentRef, sourceRef: document.sourceRef, canonicalText, digest, provenance: { source: "current_draft" } },
    { op: "move_document_pointer", productSlug: payload.product.slug!, documentRevisionNo: 2 },
  ];
  const command = await save(payload, data.draftId, 3, second.head);
  await approve(command, target, capability);
  let selected: unknown;
  const reader = realPriceAuthority(undefined, (sql, _executor, rows) => {
    if (sql.includes("SELECT DISTINCT ON (sku.sku)")) selected = rows.map(row => [row.draft_id, row.revision]);
  });
  const identity = (await reader.authorize(null))!;
  expect(await reader.publish(command, identity)).toEqual({ outcome: "conflict", reason: "catalog_publication_draft_advanced" });
  expect(selected).toEqual([[data.draftId, 3]]);
}));

it.each([["changed materialized quantity", "catalog_publication_derived_source_mismatch"],
  ["unchanged materialized quantity", "head_conflict"]] as const)("publication checks %s before resolving the expected head", async (mode, reason) => {
  const data = await draft(), first = await commit(data.publication), payload = structuredClone(data.payload);
  payload.product.sharedContent.catalogAction = "revise";
  payload.publication.kind = "compensation";
  const sku = payload.skus[0];
  payload.publication.operations = [{ op: "set_derived_sku_facts", skuCode: sku.code!, documentRevisionNo: 1, netContent: sku.netContent!, facts: { derived: 12 } }];
  const command = await save(payload, data.draftId, 1, first.head);
  await approve(command);
  const changed = mode.startsWith("changed");
  if (changed) await db.query("UPDATE public.catalog_skus SET net_weight_g=101 WHERE id=$1", [data.skuId]);
  try {
    const before = await snapshot();
    expect(await authority.publish({ ...command, expectedHead: null }, actor)).toEqual({
      outcome: changed ? "validation_issue" : "conflict", reason,
    });
    expect(await snapshot()).toEqual(before);
  } finally {
    if (changed) await db.query("UPDATE public.catalog_skus SET net_weight_g=100 WHERE id=$1", [data.skuId]);
  }
});

it.each(["fresh decision", "publish", "wrong receipt fingerprint", "wrong head owner", "closed claimed revision",
  "replay without live definition", "crossed retained claims", "unused off-head declaration"] as const)(
  "publication binds immutable draft evidence before live effects: %s", async mode => {
    const data = await draft();
    if (mode === "unused off-head declaration") {
      const first = await commit(data.publication), payload = structuredClone(data.payload);
      const content = payload.product.sharedContent;
      content.catalogAction = "revise";
      content.presentation = { label: "Revise presentation" };
      payload.product.documentRevision = { ...payload.product.documentRevision!, id: randomUUID(), revisionNo: 2 };
      payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: content.presentation }];
      const command = await saveResumed(payload, data.draftId, 1, first.head);
      const stable = await snapshot();
      expect(await authority.decision(approvalCommand(command), actor)).toEqual({ outcome: "conflict", reason: "catalog_publication_v3_document_reference_stale" });
      expect(await snapshot()).toEqual(stable);
      return;
    }
    if (mode === "crossed retained claims") {
      const first = await commit(data.publication), command = await revise(data, first.head);
      const page = await authority.readbackV2(first.head);
      if (page.outcome !== "page") throw new Error(JSON.stringify(page));
      const item = page.items[0];
      const confused = { ...item.facts, source: { ...item.facts.source, fingerprint: "a".repeat(64) } };
      const full = canonicalCatalogDraftJson(confused), digest = createHash("sha256").update(full).digest("hex");
      const manifest = canonicalCatalogDraftJson({ schemaVersion: 2, product: page.product, skus: [{ ...item.reference, digest }] });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("ALTER TABLE public.catalog_sku_revisions DISABLE TRIGGER catalog_sku_revisions_immutable");
        await client.query("UPDATE public.catalog_sku_revisions SET full_facts=$2,digest=$3 WHERE id=$1", [item.reference.revisionId, full, digest]);
        await client.query("ALTER TABLE public.catalog_publications DISABLE TRIGGER catalog_publications_immutable");
        await client.query("UPDATE public.catalog_publications SET canonical_state=$2,digest=$3 WHERE id=$1",
          [first.head.publicationId, manifest, createHash("sha256").update(manifest).digest("hex")]);
        const target = createPostgresCatalogPublication({ ...dependencies(), transactions: {
          run: work => work({ query: (sql, values) => sql.startsWith("SET TRANSACTION") ? Promise.resolve({ rows: [] }) : client.query(sql, values) }),
        } });
        const capability = (await target.authorize(null))!;
        expect(await target.decision(approvalCommand(command), capability)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_source_mismatch" });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      return;
    }
    const command = data.publication;
    const decision = mode === "fresh decision"
      ? { schemaVersion: 2 as const, action: "approve" as const, productId: data.productId, commandKey: "approve:evidence",
        candidateRef: command.candidateRef, candidateDigest: command.candidateDigest, reason: null }
      : await approve(command);
    if (mode === "replay without live definition") {
      const target = createPostgresCatalogPublication({ ...dependencies(), registry: createCatalogProductTypeRegistry([]) });
      const capability = (await target.authorize(null))!;
      expect(await target.decision(decision, capability)).toMatchObject({ outcome: "replayed", receipt: decision });
      return;
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      if (mode === "wrong head owner") {
        await client.query("UPDATE public.catalog_draft_heads SET product_id=$2 WHERE draft_id=$1", [data.draftId, randomUUID()]);
      } else if (mode === "closed claimed revision") {
        await client.query("ALTER TABLE public.catalog_draft_revisions DISABLE TRIGGER catalog_draft_revisions_immutable");
        await client.query("UPDATE public.catalog_draft_revisions SET status='abandoned' WHERE draft_id=$1 AND revision=1", [data.draftId]);
      } else {
        await client.query("ALTER TABLE public.catalog_draft_command_receipts DISABLE TRIGGER catalog_draft_receipts_immutable");
        if (mode === "wrong receipt fingerprint")
          await client.query("UPDATE public.catalog_draft_command_receipts SET fingerprint=$2 WHERE draft_id=$1 AND revision=1", [data.draftId, "c".repeat(64)]);
        else await client.query("DELETE FROM public.catalog_draft_command_receipts WHERE draft_id=$1 AND revision=1", [data.draftId]);
      }
      const target = createPostgresCatalogPublication({ ...dependencies(), transactions: {
        run: work => work({ query: (sql, values) => sql.startsWith("SET TRANSACTION") ? Promise.resolve({ rows: [] }) : client.query(sql, values) }),
      } });
      const capability = (await target.authorize(null))!;
      const result = mode === "fresh decision" ? await target.decision(decision, capability) : await target.publish(command, capability);
      expect(result).toEqual(mode === "wrong head owner"
        ? { outcome: "conflict", reason: "catalog_publication_draft_advanced" }
        : { outcome: "validation_issue", reason: "catalog_publication_source_mismatch" });
      expect((await client.query("SELECT id FROM public.catalog_publications WHERE product_id=$1", [data.productId])).rows).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

it.each(["stale head", "future SKU revision", "duplicate code outside page", "wrong observation status", "duplicate observation"] as const)(
  "publication retained reads distinguish an internally consistent but false state: %s", async mode => {
    const data = await draft(), first = await commit(data.publication);
    const payload = structuredClone(data.payload);
    payload.product.sharedContent.catalogAction = "revise";
    payload.publication.kind = "compensation";
    payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
    const second = await commit(mode === "stale head" ? await save(payload, data.draftId, 1, first.head) : await incrementalSku(data, first.head, 1));
    const page = await authority.readbackV2(second.head);
    if (page.outcome !== "page") throw new Error(JSON.stringify(page));
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const stored = async (publicationId: string) => JSON.parse((await client.query(
        "SELECT canonical_state FROM public.catalog_publications WHERE id=$1", [publicationId])).rows[0].canonical_state);
      const writeState = async (publicationId: string, state: unknown) => {
        const canonical = canonicalCatalogDraftJson(state);
        await client.query("ALTER TABLE public.catalog_publications DISABLE TRIGGER catalog_publications_immutable");
        await client.query("UPDATE public.catalog_publications SET canonical_state=$2,digest=$3 WHERE id=$1",
          [publicationId, canonical, createHash("sha256").update(canonical).digest("hex")]);
      };
      let bound = page.items[0];
      if (mode === "stale head") {
        await client.query("UPDATE public.catalog_publication_heads SET publication_id=$2,revision=$3 WHERE product_id=$1",
          [data.productId, first.head.publicationId, first.head.revision]);
      } else if (mode === "future SKU revision") {
        const older = await stored(first.head.publicationId), newer = await stored(second.head.publicationId);
        bound = page.items.find(item => item.facts.id !== data.skuId)!;
        await writeState(first.head.publicationId, { ...older, skus: newer.skus });
      } else if (mode === "duplicate code outside page") {
        const [outside, inside] = page.items;
        bound = inside;
        const full = canonicalCatalogDraftJson({ ...outside.facts, code: inside.facts.code });
        const digest = createHash("sha256").update(full).digest("hex");
        await client.query("ALTER TABLE public.catalog_sku_revisions DISABLE TRIGGER catalog_sku_revisions_immutable");
        const row = (await client.query("SELECT to_jsonb(r) AS value FROM public.catalog_sku_revisions r WHERE id=$1",
          [outside.reference.revisionId])).rows[0].value;
        await client.query("UPDATE public.catalog_sku_revisions SET full_facts=$2,digest=$3 WHERE id=$1",
          [outside.reference.revisionId, full, digest]);
        if ("sku_code" in row) await client.query("UPDATE public.catalog_sku_revisions SET sku_code=$2 WHERE id=$1",
          [outside.reference.revisionId, inside.facts.code]);
        const state = await stored(second.head.publicationId);
        state.skus[0].digest = digest;
        await writeState(second.head.publicationId, state);
      } else {
        const receipt = { ...first, changes: mode === "wrong observation status" ? [{ ...first.changes[0], state: "active" }]
          : [...first.changes, first.changes[0]] };
        await client.query("ALTER TABLE public.catalog_operator_receipts DISABLE TRIGGER catalog_operator_receipts_immutable");
        await client.query("UPDATE public.catalog_operator_receipts SET result=$2 WHERE publication_id=$1",
          [first.head.publicationId, canonicalCatalogDraftJson(receipt)]);
      }
      const target = createPostgresCatalogPublication({ ...dependencies(), acceptedSource: async (_db, _context, binding) => binding,
        transactions: { run: work => work({ query: (sql, values) => sql.startsWith("SET TRANSACTION") ? Promise.resolve({ rows: [] }) : client.query(sql, values) }) },
      });
      const legacy = { outcome: "dependency_unavailable", reason: "publication_authority_unavailable" };
      if (mode === "stale head") {
        expect(await target.reads.current(data.productId)).toEqual(legacy);
      } else if (mode === "future SKU revision" || mode === "duplicate code outside page") {
        const head = mode === "future SKU revision" ? first.head : second.head;
        const cursor = mode === "future SKU revision" ? null : Buffer.from(canonicalCatalogDraftJson({ schemaVersion: 1, kind: "facts",
          productId: data.productId, highWater: head.revision, before: 1 })).toString("base64url");
        const refusal = { outcome: "dependency_unavailable", reason: "catalog_publication_sku_revision_invalid" };
        expect(await target.readbackV2(head, cursor)).toEqual(refusal);
        expect(await target.reads.readback(head)).toEqual(legacy);
        const binding = { kind: "account", sourceId: randomUUID(), lineId: randomUUID(), productId: data.productId, skuId: bound.facts.id,
          skuRevisionId: bound.reference.revisionId, publicationId: head.publicationId, documentRevisionId: page.product.document!.id } as const;
        expect(await target.resolveRetained(binding, target.authorizeReadScope(null))).toEqual(refusal);
      } else {
        const capability = (await target.authorize(null))!;
        const refusal = { outcome: "dependency_unavailable", reason: "catalog_publication_receipt_invalid" };
        expect(await target.receipt({ productId: data.productId, commandKey: first.commandKey }, capability)).toEqual(refusal);
        expect(await target.publish(data.publication, capability)).toEqual(refusal);
        expect(await target.reads.history(data.productId, null)).toEqual(legacy);
      }
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

it.each(["missing draft", "draft executor outage", "missing definition", "actual projection drift"] as const)(
  "publication distinguishes absence, unavailable evidence and live drift: %s", async mode => {
    const data = await draft();
    if (mode === "missing draft" || mode === "draft executor outage") {
      const target = createPostgresCatalogPublication(dependencies(sql => {
        if (mode === "draft executor outage" && sql.startsWith("SELECT public.catalog_draft_record")) throw new Error("Fixture executor unavailable");
      }));
      const command = { ...data.publication, candidateRef: `v1:${randomUUID()}@1/unpublished` };
      const capability = (await target.authorize(null))!;
      expect(await target.publish(command, capability)).toEqual(mode === "missing draft"
        ? { outcome: "validation_issue", reason: "candidate_invalid" }
        : { outcome: "dependency_unavailable", reason: "publication_authority_unavailable" });
      return;
    }
    const published = await commit(data.publication);
    await expect(authority.reads.current(data.productId)).resolves.toMatchObject({ outcome: "found", head: published.head });
    const name = (await db.query("SELECT name FROM public.catalog_products WHERE id=$1", [data.productId])).rows[0].name;
    const target = mode === "missing definition" ? createPostgresCatalogPublication({ ...dependencies(), registry: createCatalogProductTypeRegistry([]) }) : authority;
    if (mode === "actual projection drift") await db.query("UPDATE public.catalog_products SET name='Changed live name' WHERE id=$1", [data.productId]);
    try {
      expect(await target.reads.current(data.productId)).toEqual(mode === "missing definition"
        ? { outcome: "dependency_unavailable", reason: "publication_authority_unavailable" }
        : { outcome: "conflict", reason: "head_conflict" });
    } finally {
      if (mode === "actual projection drift") await db.query("UPDATE public.catalog_products SET name=$2 WHERE id=$1", [data.productId, name]);
    }
  });

it.each([
  [false, "catalog_publication_v3_structural_readiness_failed"],
  [true, "catalog_publication_v3_active_primary_required"],
] as const)("publication checks structural readiness before active primary: ready=%s", async (ready, reason) => {
  const data = await draft(), payload = structuredClone(data.payload);
  payload.publication.operations.push({ op: "set_product_status", productSlug: payload.product.slug!, status: "active" });
  const command = await save(payload, data.draftId, 1);
  const target = createPostgresCatalogPublication({ ...dependencies(),
    readiness: async () => ({ ready, reasons: ready ? [] : ["fixture_structural_block"] }),
  });
  const capability = (await target.authorize(null))!;
  await approve(command, target, capability);
  const before = await snapshot();
  expect(await target.publish(command, capability)).toEqual({ outcome: "validation_issue", reason });
  expect(await snapshot()).toEqual(before);
});

it.each(["product", "SKU"] as const)("publication stores only effects reached in the %s creation prefix", async mode => {
  const data = await draft(), payload = structuredClone(data.payload);
  const sku = payload.skus[0];
  sku.logisticsRef = "example:dispatch";
  payload.publication.operations.push({ op: "set_sku_metadata", skuCode: sku.code!, logisticsRef: sku.logisticsRef });
  const command = await save(payload, data.draftId, 1);
  const table = mode === "product" ? "catalog_products" : "catalog_skus";
  const identity = mode === "product" ? data.productId : data.skuId;
  let prefix: unknown;
  const target = createPostgresCatalogPublication(dependencies(async (sql, executor) => {
    if (sql.startsWith(`INSERT INTO public.${table}(`)) {
      prefix = (await executor.query(`SELECT publication_facts FROM public.${table} WHERE id=$1`, [identity])).rows[0].publication_facts;
    }
  }));
  const capability = (await target.authorize(null))!;
  const receipt = await commit(command, target, capability);
  expect(prefix).toMatchObject(mode === "product"
    ? { status: "draft", document: null, primarySkuId: null, presentation: null }
    : { status: "draft", sellableStandalone: false, sellableInSubscription: false, identifiers: [], memberships: [], logisticsRef: null });
  expect(await authority.readbackV2(receipt.head)).toMatchObject({ outcome: "page",
    product: { document: { id: payload.product.documentRevision!.id }, primarySkuId: data.skuId },
    items: [{ facts: { logisticsRef: sku.logisticsRef, identifiers: [{ scheme: "gs1:gtin" }] } }] });
});

it.each([
  "first missing", "middle missing", "last missing", "duplicate", "wrong kind", "wrong actor", "wrong scope",
  "decision missing", "healthy",
] as const)("publication receipt reads verify the authoritative companion: %s", async mode => {
  const data = await draft();
  const decision = await approve(data.publication);
  const result = await authority.publish(data.publication, actor);
  if (result.outcome !== "committed") throw new Error(JSON.stringify(result));
  const first = result.receipt;
  const second = await commit(await incrementalSku(data, first.head, 1));
  const third = await commit(await incrementalSku(data, second.head, 2));
  const expected = mode === "first missing" ? third : mode === "middle missing" ? second : first;
  const scope = { productId: data.productId, commandKey: expected.commandKey };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Model an independently imported ledger with a missing or inconsistent companion.
    if (mode === "decision missing") {
      await client.query("ALTER TABLE public.catalog_publication_decisions DISABLE TRIGGER catalog_publication_decisions_immutable");
      await client.query("DELETE FROM public.catalog_publication_decisions WHERE product_id=$1 AND command_key=$2", [data.productId, decision.commandKey]);
    } else if (mode !== "healthy") {
      await client.query("ALTER TABLE public.catalog_operator_receipts DISABLE TRIGGER catalog_operator_receipts_immutable");
      if (mode.endsWith("missing")) {
        await client.query("DELETE FROM public.catalog_operator_receipts WHERE publication_id=$1", [expected.head.publicationId]);
      } else if (mode === "duplicate") {
        await client.query(`INSERT INTO public.catalog_operator_receipts(kind,scope_id,command_key,fingerprint,actor_id,publication_id,result)
          SELECT kind,scope_id,command_key||':duplicate',fingerprint,actor_id,publication_id,
            jsonb_set(result::jsonb,'{commandKey}',to_jsonb(command_key||':duplicate'))::text
          FROM public.catalog_operator_receipts WHERE publication_id=$1`, [expected.head.publicationId]);
      } else if (mode === "wrong kind") {
        await client.query("UPDATE public.catalog_operator_receipts SET kind='approve' WHERE publication_id=$1", [expected.head.publicationId]);
      } else if (mode === "wrong scope") {
        await client.query(`UPDATE public.catalog_operator_receipts SET scope_id=$2,
          result=jsonb_set(result::jsonb,'{productId}',to_jsonb($2::uuid))::text WHERE publication_id=$1`,
        [expected.head.publicationId, randomUUID()]);
      } else {
        const secondActor = randomUUID();
        await client.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [secondActor, `${secondActor}@example.invalid`]);
        await client.query(`UPDATE public.catalog_operator_receipts SET actor_id=$2,
          result=jsonb_set(result::jsonb,'{actorId}',to_jsonb($2::uuid))::text WHERE publication_id=$1`,
        [expected.head.publicationId, secondActor]);
      }
    }
    const target = createPostgresCatalogPublication({ ...dependencies(), transactions: {
      run: work => work({ query: (sql, values) => sql.startsWith("SET TRANSACTION") ? Promise.resolve({ rows: [] }) : client.query(sql, values) }),
    } });
    const capability = (await target.authorize(null))!;
    const refusal = { outcome: "dependency_unavailable", reason: "catalog_publication_receipt_invalid" };
    if (mode === "decision missing") {
      expect(await target.decision(decision, capability)).toEqual(refusal);
      return;
    }
    const history = await target.reads.history(data.productId, null);
    if (mode === "healthy") {
      expect(history).toMatchObject({ outcome: "page", nextCursor: null, receipts: [{ head: third.head }, { head: second.head }, { head: first.head }] });
      expect(await target.receipt(scope, capability)).toEqual({ outcome: "found", receipt: expected });
      expect(await target.receipt({ ...scope, commandKey: "never submitted" }, capability)).toEqual({ outcome: "absent" });
    } else {
      expect(history).toEqual({ outcome: "dependency_unavailable", reason: "publication_authority_unavailable" });
      expect(await target.receipt(scope, capability)).toEqual(refusal);
      if (expected === first) expect(await target.publish(data.publication, capability)).toEqual(refusal);
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

it("refuses a full-fact head with the correct revision and a different document digest", async () => {
  const wrongDigest = (foreignPublished.head.documentDigest.startsWith("a") ? "b" : "a") + foreignPublished.head.documentDigest.slice(1);
  expect(await authority.readbackV2({ ...foreignPublished.head, documentDigest: wrongDigest }))
    .toEqual({ outcome: "conflict", reason: "head_conflict" });
});

it("refuses noncanonical full-fact manifest bytes with an unchanged semantic digest", async () => {
  const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
    if (sql.startsWith("SELECT p.product_id,p.revision,p.canonical_state")) rows[0].canonical_state = ` ${rows[0].canonical_state as string}`;
  }));
  expect(await target.readbackV2(foreignPublished.head)).toEqual({ outcome: "dependency_unavailable", reason: "catalog_publication_manifest_invalid" });
});

it("refuses a same-product full-fact cursor from an earlier publication revision", async () => {
  const cursor = Buffer.from(canonicalCatalogDraftJson({ schemaVersion: 1, kind: "facts", productId: paged.data.productId,
    highWater: paged.head.revision - 1, before: 1 })).toString("base64url");
  expect(await authority.readbackV2(paged.head, cursor)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_cursor_invalid" });
});

it("refuses noncanonical retained SKU bytes with an unchanged semantic digest", async () => {
  const target = createPostgresCatalogPublication(dependencies((sql, _executor, rows) => {
    if (sql.startsWith("SELECT id,full_facts FROM public.catalog_sku_revisions")) rows[0].full_facts = ` ${rows[0].full_facts as string}`;
  }));
  expect(await target.readbackV2(foreignPublished.head)).toEqual({ outcome: "dependency_unavailable", reason: "catalog_publication_sku_revision_invalid" });
});

it("rolls back when an identifier differs from the compiled post-state", async () => {
  const data = await draft(); await approve(data.publication);
  const before = await snapshot();
  const target = createPostgresCatalogPublication(dependencies(async (sql, executor) => {
    if (sql.startsWith("SELECT to_char(clock_timestamp()"))
      await executor.query("UPDATE public.catalog_sku_identifiers SET display_label='Different identifier label' WHERE catalog_sku_id=$1", [data.skuId]);
  }));
  expect(await target.publish(data.publication, (await target.authorize(null))!))
    .toEqual({ outcome: "validation_issue", reason: "catalog_publication_post_state_mismatch" });
  expect(await snapshot()).toEqual(before);
});

it("rolls back when a resolved attribute reference becomes unavailable at projection", async () => {
  const data = await draft();
  data.payload.skus[0].attributes = { reference: { namespace: "example:asset", id: "projection-asset" } };
  const command = await save(data.payload, data.draftId, 1);
  let projecting = false;
  const target = createPostgresCatalogPublication({
    ...dependencies(sql => { if (sql.startsWith("DELETE FROM public.catalog_attribute_projection")) projecting = true; }),
    attributeReferences: { resolve: async references => references.map(reference => ({
      ...reference, status: projecting ? "unavailable" as const : "resolved" as const,
    })) },
  });
  const capability = (await target.authorize(null))!;
  await approve(command, target, capability);
  const before = await snapshot();
  expect(await target.publish(command, capability)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_attribute_projection_invalid" });
  expect(projecting).toBe(true);
  expect(await snapshot()).toEqual(before);
});

it.each([["revision", "release"], ["compensation", "compensation"]] as const)(
  "W09 rejects a cross-product route collision on a presentation-only %s", async (_path, kind) => {
    const data = await draft(), initial = await commit(data.publication), payload = structuredClone(data.payload);
    const route = (foreignPublished.data.payload.product.sharedContent.presentation.routePath as { en: string }).en;
    payload.product.sharedContent.catalogAction = "revise";
    payload.publication.kind = kind;
    payload.product.sharedContent.presentation = { routePath: { en: route } };
    payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: payload.product.sharedContent.presentation }];
    const command = await save(payload, data.draftId, 1, initial.head);
    await approve(command);
    const before = await snapshot();
    const target = createPostgresCatalogPublication({ ...dependencies(), readiness: async (executor, state, requirePrice) => {
      expect(requirePrice).toBe(false);
      expect(state.skus).toEqual([]);
      const { rows } = await executor.query("SELECT id FROM public.catalog_products WHERE id<>$1 AND publication_facts->'presentation'->'routePath'->>'en'=$2", [state.product.id, route]);
      expect(rows).toEqual([{ id: foreignPublished.data.productId }]);
      return { ready: false, reasons: ["localized_route_duplicate"] };
    } });
    expect(await target.publish(command, (await target.authorize(null))!)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_v3_structural_readiness_failed" });
    expect(await snapshot()).toEqual(before);
  });

describe("LC2 forward compatibility with legacy catalogue rows", () => {
  let legacy: Pool;
  const publicationPath = "db/platform/migrations/20261123150000_catalog_publication.sql";
  beforeAll(async () => {
    const container = await runPostgresContainer({ name: `catalog-publication-legacy-${process.pid}`, password: "synthetic-catalog-publication" });
    containers.push(container);
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Legacy catalogue witnesses require real PostgreSQL");
    legacy = new Pool({ connectionString: container.connectionString });
    pools.push(legacy);
    const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
    for (const unit of [manifest.baseline, ...manifest.forward]) {
      if (unit.file === publicationPath) break;
      await legacy.query(readFileSync(unit.file, "utf8"));
    }
  }, postgresSetupTimeoutMs);

  it.each(["duplicate GTIN under different issuers", "duplicate draft combination", "opaque legacy GTIN"] as const)("installs over %s", async kind => {
    const client = await legacy.connect();
    const productId = randomUUID(), firstSku = randomUUID(), secondSku = randomUUID();
    const combination = Buffer.alloc(32, 1);
    const gtin = nextGtin();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Legacy product')", [productId, `legacy-${productId}`]);
      await client.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,status,combination_digest)
        VALUES($1,$3,$1::uuid::text,'First legacy SKU','draft',$4),($2,$3,$2::uuid::text,'Second legacy SKU','draft',$4)`,
      [firstSku, secondSku, productId, kind === "duplicate draft combination" ? combination : null]);
      if (kind === "duplicate GTIN under different issuers") {
        await client.query(`INSERT INTO public.catalog_sku_identifiers(catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity)
          VALUES ($1,'legacy:first','gtin',$3,'unit',1),($2,'legacy:second','gtin',$3,'unit',1)`, [firstSku, secondSku, gtin]);
      } else if (kind === "opaque legacy GTIN") {
        await client.query(`INSERT INTO public.catalog_sku_identifiers(catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity)
          VALUES ($1,'legacy:first','gtin','opaque','unit',1)`, [firstSku]);
      }
      await client.query(readFileSync(publicationPath, "utf8"));
      const skus = await client.query("SELECT publication_facts,combination_digest FROM public.catalog_skus WHERE product_id=$1", [productId]);
      expect(skus.rows).toEqual(Array.from({ length: 2 }, () => ({ publication_facts: null, combination_digest: kind === "duplicate draft combination" ? combination : null })));
      const identifiers = await client.query("SELECT issuer,scheme,normalized_value FROM public.catalog_sku_identifiers ORDER BY issuer");
      expect(identifiers.rows).toEqual(kind === "duplicate draft combination" ? [] : kind === "opaque legacy GTIN"
        ? [{ issuer: "legacy:first", scheme: null, normalized_value: "opaque" }]
        : [{ issuer: "legacy:first", scheme: null, normalized_value: gtin }, { issuer: "legacy:second", scheme: null, normalized_value: gtin }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

it("publication refuses a GTIN held by a different legacy issuer", async () => {
  const data = await draft(), identifier = data.payload.skus[0]!.identifiers![0]!;
  const legacy = randomUUID();
  await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Legacy product')", [legacy, `legacy-${legacy}`]);
  await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$2,'Legacy SKU')", [legacy, `legacy-${legacy}`]);
  await db.query(`INSERT INTO public.catalog_sku_identifiers(catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity)
    VALUES ($1,'legacy:issuer','gtin',$2,'unit',1)`, [legacy, identifier.value]);
  await approve(data.publication);
  const before = await snapshot();
  expect(await authority.publish(data.publication, actor)).toEqual({ outcome: "conflict", reason: "catalog_publication_identity_conflict" });
  expect(await snapshot()).toEqual(before);
});

it.each(["changed", "unchanged", "repeated", "unconsumed", "other tuple", "missing update"] as const)(
  "the document pointer fence alone consumes a changed pointer capability: %s", async mode => {
    const data = await draft(), payload = structuredClone(data.payload);
    const pointer = { op: "move_document_pointer" as const, productSlug: payload.product.slug!, documentRevisionNo: 1 };
    let command = data.publication;
    if (mode === "unchanged") {
      const first = await commit(command);
      payload.product.sharedContent.catalogAction = "revise";
      payload.publication.kind = "compensation";
      payload.publication.operations = [pointer];
      command = await save(payload, data.draftId, 1, first.head);
    } else if (mode === "repeated") {
      payload.publication.operations.push(pointer);
      command = await save(payload, data.draftId, 1);
    }
    const refusals = ["unconsumed", "other tuple", "missing update"];
    let capabilityArgs: unknown[] | undefined, inserts = 0, projected = false;
    const target = createPostgresCatalogPublication(dependencies(async (sql, executor, rows, values) => {
      if (sql.startsWith("INSERT INTO public.catalog_publication_pointer_capabilities")) { capabilityArgs = values; inserts++; }
      if (sql.startsWith("UPDATE public.catalog_products SET current_document_revision_id")) {
        if (mode === "unconsumed" || mode === "other tuple") await executor.query(
          "INSERT INTO public.catalog_publication_pointer_capabilities VALUES(pg_current_xact_id(),$1,$2,$3)",
          mode === "unconsumed" ? capabilityArgs : [foreignPublished.data.productId, foreignPublished.data.payload.product.documentRevision!.id, "f".repeat(64)]);
        if (mode === "missing update") rows.length = 0;
      }
      if (sql.startsWith("UPDATE public.catalog_products SET publication_facts=jsonb_set(publication_facts,'{document}'")) projected = true;
    }));
    const capability = (await target.authorize(null))!;
    await approve(command, target, capability);
    const before = await snapshot(), result = await target.publish(command, capability);
    expect(inserts).toBe(mode === "unchanged" ? 0 : 1);
    if (refusals.includes(mode)) {
      expect(result).toEqual({ outcome: "validation_issue", reason: "catalog_publication_pointer_capability_unconsumed" });
      expect(projected).toBe(false);
      expect(await snapshot()).toEqual(before);
    } else {
      expect(result).toMatchObject({ outcome: "committed" });
      expect((await db.query("SELECT * FROM public.catalog_publication_pointer_capabilities WHERE product_id=$1", [data.productId])).rows).toEqual([]);
    }
  });

it.each(["product active", "product archived", "SKU active", "SKU archived", "eligibility on", "eligibility off", "repeated cache", "rollback"] as const)(
  "ordered publication touches only the timestamps owned by its effects: %s", async mode => inPriceDatabase(async () => {
    const active = mode === "product active" || mode === "SKU active" || mode === "eligibility on";
    const initial = realPriceAuthority(), initialActor = (await initial.authorize(null))!;
    const data = active ? await priceDraft() : await draft();
    let head = (await commit(data.publication, initial, initialActor)).head;
    let revision = active ? 2 : 1;
    let payload = structuredClone(data.payload);
    if (mode === "SKU archived") {
      head = (await commit(await incrementalSku(data, head, revision++), initial, initialActor)).head;
      payload = (await db.query("SELECT public.catalog_draft_record($1,$2) AS record", [data.draftId, revision])).rows[0].record.payload;
    }
    payload.product.sharedContent.catalogAction = "revise";
    payload.publication.kind = "compensation";
    const sku = payload.skus[0], skuCode = sku.code!;
    delete sku.priceOperations;
    const productStatus = mode === "product active" || mode === "product archived";
    const eligibility = { op: "set_eligibility" as const, skuCode, sellableStandalone: active, sellableInSubscription: false };
    const cache = { op: "set_derived_sku_facts" as const, skuCode, documentRevisionNo: 1, netContent: sku.netContent!, facts: { derived: 12 } };
    payload.publication.operations = productStatus
      ? [{ op: "set_product_status", productSlug: payload.product.slug!, status: mode === "product active" ? "active" : "archived" }]
      : mode === "SKU active" ? [{ op: "set_sku_status", skuCode, status: "active" }, eligibility]
      : mode === "SKU archived" ? [{ op: "set_sku_status", skuCode, status: "archived" }]
      : mode === "repeated cache" || mode === "rollback" ? [cache, cache] : [eligibility];
    await db.query("UPDATE public.catalog_products SET updated_at=statement_timestamp()-interval '1 day' WHERE id=$1", [data.productId]);
    await db.query("UPDATE public.catalog_skus SET updated_at=statement_timestamp()-interval '1 day' WHERE id=$1", [sku.id]);
    const timestamps = async (executor: PgQueryExecutor) => (await executor.query(`SELECT
      (SELECT updated_at=transaction_timestamp() FROM public.catalog_products WHERE id=$1) AS product,
      (SELECT updated_at=transaction_timestamp() FROM public.catalog_skus WHERE id=$2) AS sku`, [data.productId, sku.id])).rows[0];
    const seen: unknown[] = [];
    const target = realPriceAuthority(undefined, async (sql, executor) => {
      if (/^UPDATE public.catalog_(?:products SET status|skus SET (?:status|sellable_standalone)|skus SET\s+publication_facts=jsonb_set\(publication_facts,'\{facts\}')/u.test(sql)) seen.push(await timestamps(executor));
      if (mode === "rollback" && sql.startsWith("INSERT INTO public.catalog_publications")) throw new Error("Synthetic publication failure after touches");
    });
    const capability = (await target.authorize(null))!, command = await save(payload, data.draftId, revision, head);
    await approve(command, target, capability);
    const before = await snapshot(), result = await target.publish(command, capability);
    expect(seen).toEqual(Array.from({ length: mode === "repeated cache" || mode === "SKU active" || mode === "rollback" ? 2 : 1 },
      () => ({ product: productStatus, sku: !productStatus })));
    if (mode === "rollback") {
      expect(result).toMatchObject({ outcome: "dependency_unavailable" });
      expect(await snapshot()).toEqual(before);
    } else expect(result).toMatchObject({ outcome: "committed" });
  }));
