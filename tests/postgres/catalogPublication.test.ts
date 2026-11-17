import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresCatalogPublication, createCatalogProductTypeRegistry, catalogDefinitionDigest, installCatalogDefinitions,
  type CatalogPublicationDependencies } from "@openlup/platform/catalog";
import { canonicalCatalogDraftJson, type CatalogDraftPayloadV3, type CatalogPublishCommand, type CatalogHeadRef } from "@openlup/platform/catalog/contracts";
import type { CatalogRetainedSourceBinding } from "@openlup/platform/catalog/contracts";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { setFixtureCatalogDocument } from "../helpers/storeJourney.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

const containers: PostgresContainer[] = [], pools: Pool[] = [];
let db: Pool;
const admin = randomUUID();
const definition = { key: "example:article", version: 1, units: [{ code: "openlup:g", dimension: "mass" as const, integral: false }],
  netContentUnits: ["openlup:g"], dimensions: [], axes: [], attributes: [{ key: "details", scope: "variant" as const,
    valueType: { kind: "list" as const, item: { kind: "text" as const, maxLength: 1900 }, min: 0, max: 300 }, required: false,
    cardinality: { min: 0, max: 300 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} }],
  validatorRef: `sha256:${"a".repeat(64)}`, validateContent: () => [] };
const registry = createCatalogProductTypeRegistry([definition]);
let authority: ReturnType<typeof createPostgresCatalogPublication<null>>;
let actor: NonNullable<Awaited<ReturnType<typeof authority.authorize>>>;
let paged: { data: Awaited<ReturnType<typeof draft>>; head: CatalogHeadRef };
let foreignPublished: { data: Awaited<ReturnType<typeof draft>>; head: CatalogHeadRef };
function dependencies(afterQuery?: (sql: string, executor: PgQueryExecutor, rows: Record<string, unknown>[]) => void | Promise<void>): CatalogPublicationDependencies<null> {
  return { registry, transactions: { async run(work) { const client = await db.connect();
    try { await client.query("BEGIN"); const result = await work({ async query(sql, values) { const result = await client.query(sql, values); await afterQuery?.(sql, client, result.rows); return result; } }); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } } },
    authorizeHuman: async () => ({ ok: true, userId: admin, role: "admin", isMachineActor: false }),
    rules: { canonicalizeDocument: canonicalCatalogDraftJson, deriveSkuFacts: (document) => ({ derived: (document as { derived: number }).derived }),
      validateProduct: () => [], classifySkuChange: (before, after, context) => {
        if (!context.beforeDocument) return "inconclusive";
        if (canonicalCatalogDraftJson(before.netContent) !== canonicalCatalogDraftJson(after.netContent)
          || canonicalCatalogDraftJson(before.options) !== canonicalCatalogDraftJson(after.options)
          || canonicalCatalogDraftJson(before.attributes) !== canonicalCatalogDraftJson(after.attributes))
          return Array.isArray(after.attributes.details) && after.attributes.details.includes("unknown") ? "inconclusive" : "material";
        return "compatible";
      } },
    readiness: async () => ({ ready: true, reasons: [] }), verifyMedia: async () => false };
}
beforeAll(async () => {
  const container = await runPostgresContainer({ name: `catalog-publication-${process.pid}`, password: "synthetic-catalog-publication" }); containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Publication witnesses require real PostgreSQL");
  db = new Pool({ connectionString: container.connectionString }); pools.push(db);
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  for (const unit of [manifest.baseline, ...manifest.forward]) {
    if (unit.file === "db/platform/migrations/20261122190000_catalog_publication.sql") break;
    await db.query(readFileSync(unit.file, "utf8"));
  }
  await db.query(readFileSync("db/platform/migrations/20261122190000_catalog_publication.sql", "utf8"));
  await installCatalogDefinitions(db, { id: "example:publication", namespace: "example", version: 1, openlupRange: "0.44.x", capabilities: { publish: false }, types: [definition], taxClasses: [] });
  await db.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'publication@example.invalid')", [admin]);
  await db.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())", [admin]);
  authority = createPostgresCatalogPublication(dependencies()); actor = (await authority.authorize(null))!;
  const data = await draft(); let receipt = await commit(data.publication);
  for (let revision = 1; revision <= 100; revision++) receipt = await commit(await incrementalSku(data, receipt.head, revision));
  paged = { data, head: receipt.head };
  const other = await draft(), otherReceipt = await commit(other.publication); foreignPublished = { data: other, head: otherReceipt.head };
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
async function approve(publication: CatalogPublishCommand, target = authority, capability = actor, commandKey = `approve:${publication.commandKey}`) {
  const decision = { schemaVersion: 2 as const, action: "approve" as const, productId: publication.productId, commandKey,
    candidateRef: publication.candidateRef, candidateDigest: publication.candidateDigest, reason: "Verified exact candidate" };
  const result = await target.decision(decision, capability); expect(result.outcome).toBe("committed"); return decision;
}
async function commit(publication: CatalogPublishCommand, target = authority, capability = actor) {
  await approve(publication, target, capability);
  const result = await target.publish(publication, capability);
  expect(result.outcome, JSON.stringify(result)).toBe("committed");
  if (!("receipt" in result)) throw new Error(JSON.stringify(result));
  return result.receipt;
}
async function draft() {
  const productId = randomUUID(), skuId = randomUUID(), draftId = randomUUID(), revisionId = randomUUID(), slug = `article-${productId}`;
  const document = { schemaVersion: 1, id: "example:document", revisionNo: 1, productSlug: slug, derived: 12 }, canonicalText = canonicalCatalogDraftJson(document);
  const digest = createHash("sha256").update(canonicalText).digest("hex");
  const facts = { skuCode: `SKU-${skuId}`, title: "Synthetic article", minQuantity: 1, isAddon: false, facts: { derived: 12 } };
  const gtin = nextGtin();
  const payload: CatalogDraftPayloadV3 = { schemaVersion: 3, product: { id: productId, type: { key: definition.key, version: 1 }, slug,
    primarySkuId: skuId, dimensions: [], documentRevision: { id: revisionId, productId, revisionNo: 1, schemaId: "example:document.v1", documentRef: "example:document", sourceRef: "example:source", digest },
    sharedContent: { schemaVersion: 1, catalogAction: "create", document, presentation: { routePath: { en: `/${slug}` } }, publicationSkus: [facts],
      offerMemberships: [{ skuCode: facts.skuCode, offerVersion: "example:offer", admitted: false }], requestedModes: [{ skuCode: facts.skuCode, modes: [] }] } },
    skus: [{ id: skuId, productId, code: facts.skuCode, options: {}, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 },
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
  payload.skus[0] = { ...payload.skus[0], id: skuId, code: skuCode, identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1 }] };
  const facts = { ...payload.product.sharedContent.publicationSkus[0], skuCode };
  payload.product.sharedContent.publicationSkus = [facts]; payload.product.sharedContent.offerMemberships = []; payload.product.sharedContent.requestedModes = [];
  payload.publication.operations = [
    { op: "create_sku", skuId, productSlug: payload.product.slug!, documentRevisionNo: 1, ...facts },
    { op: "create_identifier", skuCode, scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null },
  ];
  return save(payload, data.draftId, revision, head);
}
async function snapshot() {
  const tables = ["catalog_products", "catalog_skus", "catalog_sku_identifiers", "catalog_product_document_revisions", "catalog_attribute_projection",
    "catalog_draft_heads", "catalog_draft_revisions", "catalog_draft_command_receipts", "catalog_draft_sku_reservations",
    "catalog_publications", "catalog_publication_heads", "catalog_sku_revisions", "catalog_operator_receipts", "catalog_publication_decisions",
    "catalog_publication_pointer_capabilities", "outbox_events", "subscriptions", "subscription_lines", "commerce_orders", "commerce_order_items", "price_entries"];
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await db.query(`SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') AS rows FROM (SELECT to_jsonb(t) AS value FROM public.${table} t) rows`)).rows[0].rows])));
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
  const payload = structuredClone(data.payload); payload.product.sharedContent.catalogAction = "revise";
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
it.todo("catalog_publish_rolls_back_price_and_document_failure"); // pending LC3: real child writer and its retained receipts.
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
  expect(await authority.publish(null as never, Object.freeze({}) as typeof actor)).toMatchObject({ outcome: "unauthorized" });
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
    if (staged || !sql.startsWith("UPDATE public.catalog_skus SET publication_facts")) return;
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
it.todo("W45_V5-2156_predicate_precedence_boundary"); // pending LC3: otherwise-ready real price activation and its complete rollback.
it.each([
  ["net", "fractional", "15", 1], ["net", "zero", "0", 0], ["net", "negative", "-1", 0], ["net", "out_of_range", "2147483648", 0],
  ["gross", "fractional", "15", 1], ["gross", "zero", "0", 0], ["gross", "negative", "-1", 0], ["gross", "out_of_range", "10000000000000000000000000000000000000000", 0],
] as const)("catalog_publication_refuses_%s_%s_mass", async (kind, _case, unscaled, scale) => {
  const data = await draft(), payload = structuredClone(data.payload);
  payload.skus[0][kind === "net" ? "netContent" : "grossMass"] = { dimension: "mass", unit: "openlup:g", unscaled, scale };
  // Native drafts retain opaque quantity input; publication must refuse even
  // when the input did not pass through the stricter TypeScript draft facade.
  const command = await save(payload, data.draftId, 1), before = await snapshot();
  expect(await authority.publish(command, actor)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_integral_grams_required" });
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
      ["catalog_operator_receipts", { kind: "" }, "23514"], ["catalog_operator_receipts", { command_key: " bad " }, "23514"],
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
    const revision = (await client.query("SELECT max(revision)+1 AS next FROM public.catalog_publications WHERE product_id=$1", [records.get("catalog_publications")!.product_id])).rows[0].next;
    const foreignCases: [string, Record<string, unknown>][] = [
      ["catalog_products", { id: randomUUID(), slug: `foreign-${randomUUID()}`, primary_sku_id: null, current_document_revision_id: null, type_key: "example:absent", type_version: 1 }],
      ["catalog_skus", { id: randomUUID(), sku: `FOREIGN-${randomUUID()}`, product_id: randomUUID() }],
      ["catalog_product_document_revisions", { id: randomUUID(), product_id: randomUUID() }],
      ["catalog_publications", { id: randomUUID(), revision, candidate_ref: `v1:${randomUUID()}@1/unpublished`, draft_id: randomUUID() }],
      ["catalog_publications", { id: randomUUID(), revision, candidate_ref: `v1:${randomUUID()}@1/unpublished`, previous_id: foreignPublished.head.publicationId }],
      ["catalog_publications", { id: randomUUID(), revision, candidate_ref: `v1:${randomUUID()}@1/unpublished`, document_revision_id: foreignPublished.data.payload.product.documentRevision!.id }],
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
      if (sql.startsWith("SELECT * FROM public.catalog_operator_receipts") && rows[0]) Object.assign(rows[0].result as object, changed);
    }));
    const capability = (await target.authorize(null))!;
    expect((await target.receipt({ productId: paged.data.productId, commandKey: "publish:1" }, capability)).outcome).not.toBe("found");
    expect((await target.publish(paged.data.publication, capability)).outcome).not.toBe("replayed");
  }
  const unavailable = createPostgresCatalogPublication(dependencies(() => { throw new Error("Synthetic private dependency"); }));
  expect(await unavailable.readbackV2(paged.head)).toEqual({ outcome: "dependency_unavailable", reason: "publication_authority_unavailable" });
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
  expect(await target.publish(command, capability)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_v3_activation_readiness_failed" });
  expect(observed).toBe(true); expect(await snapshot()).toEqual(before);
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
    const command = await save(payload, data.draftId, index + 1); await approve(command); const before = await snapshot(); let checked = false;
    const target = createPostgresCatalogPublication({ ...dependencies(), verifyMedia: async (_executor, supplied) => { checked = true; expect(supplied).toEqual(proof); return false; } });
    const capability = (await target.authorize(null))!, result = await target.publish(command, capability);
    expect(result).toMatchObject({ outcome: "validation_issue", reason: index === 1 || index === 2 ? "catalog_publication_media_evidence_mismatch" : "catalog_publication_media_readiness_unproven" });
    expect(checked).toBe(index === 3); expect(await snapshot()).toEqual(before);
  }
  // Dark media does not imply activation or invoke a proof/readiness network check.
  payload.publication.evidence.media = [proof]; payload.product.sharedContent.requestedModes = [{ skuCode, modes: [] }];
  payload.publication.operations = payload.publication.operations.filter(op => op.op !== "set_eligibility" && op.op !== "set_sku_status");
  const target = createPostgresCatalogPublication({ ...dependencies(), verifyMedia: async () => { throw new Error("Dark media must not need activation proof"); }, globalReadiness: async () => ({ ready: false, reasons: ["unrelated_global_red"] }) });
  const capability = (await target.authorize(null))!, command = await save(payload, data.draftId, 5);
  await commit(command, target, capability);
});

// pending LC3: real effective pricing, settlement/acquisition authority and activation/global rollback.
it.todo("W36_V5-0452_predicate_precedence_boundary");
it.todo("W36_V5-0453_predicate_precedence_boundary");
it.todo("W36_V5-0492_predicate_precedence_boundary");
it.todo("W36_V5-0496_predicate_precedence_boundary");
it.todo("W36_V5-0497_predicate_precedence_boundary");
it.todo("W23_V5-1195_predicate_precedence_boundary");
it.todo("W23_V5-1196_predicate_precedence_boundary");
it.todo("W23_V5-1197_predicate_precedence_boundary");
it.todo("W23_V5-1198_predicate_precedence_boundary");
it.todo("W23_V5-1199_predicate_precedence_boundary");
it.todo("W23_V5-1200_predicate_precedence_boundary");
it.todo("W23_V5-1201_predicate_precedence_boundary");
it.todo("W23_V5-1202_predicate_precedence_boundary");
it.todo("W23_V5-1203_predicate_precedence_boundary");
it.todo("W23_V5-1204_predicate_precedence_boundary");
it.todo("W20_V5-1701_predicate_precedence_boundary");
it.todo("W20_V5-1702_predicate_precedence_boundary");
it.todo("W20_V5-1703_predicate_precedence_boundary");
it.todo("W21_V5-1706_predicate_precedence_boundary");
it.todo("W21_V5-1707_predicate_precedence_boundary");
it.todo("W20_V5-2164_predicate_precedence_boundary");
it.todo("W20_V5-2165_predicate_precedence_boundary");
it.todo("W20_V5-2166_predicate_precedence_boundary");
it.todo("W20_V5-2167_predicate_precedence_boundary");
it.todo("W20_V5-2169_predicate_precedence_boundary");
it.todo("W22_V5-2173_predicate_precedence_boundary");
it.todo("W22_V5-2174_predicate_precedence_boundary");
it.todo("W22_V5-2175_predicate_precedence_boundary");
it.todo("W22_V5-2176_predicate_precedence_boundary");
it.todo("W22_V5-2177_predicate_precedence_boundary");
it.todo("W22_V5-2178_predicate_precedence_boundary");
it.todo("W22_V5-2179_predicate_precedence_boundary");
it.todo("W22_V5-2180_predicate_precedence_boundary");
it.todo("W22_V5-2181_predicate_precedence_boundary");
it.todo("W22_V5-2182_predicate_precedence_boundary");
it.todo("W22_V5-2183_predicate_precedence_boundary");
it.todo("W22_V5-2184_predicate_precedence_boundary");
it.todo("W22_V5-2185_predicate_precedence_boundary");
it.todo("W22_V5-2186_predicate_precedence_boundary");
it.todo("W22_V5-2187_predicate_precedence_boundary");
it.todo("W22_V5-2188_predicate_precedence_boundary");
it.todo("W22_V5-2189_predicate_precedence_boundary");
it.todo("W22_V5-2190_predicate_precedence_boundary");
it.todo("W22_V5-2191_predicate_precedence_boundary");
it.todo("W22_V5-2192_predicate_precedence_boundary");
it.todo("W22_V5-2193_predicate_precedence_boundary");
it.todo("W22_V5-2194_predicate_precedence_boundary");
it.todo("W22_V5-2195_predicate_precedence_boundary");
it.todo("W22_V5-2196_predicate_precedence_boundary");
it.todo("W22_V5-2197_predicate_precedence_boundary");
it.todo("W22_V5-2198_predicate_precedence_boundary");
it.todo("W22_V5-2199_predicate_precedence_boundary");
it.todo("W22_V5-2200_predicate_precedence_boundary");
it.todo("W22_V5-2201_predicate_precedence_boundary");
it.todo("W22_V5-2202_predicate_precedence_boundary");
it.todo("W22_V5-2203_predicate_precedence_boundary");
it.todo("W22_V5-2204_predicate_precedence_boundary");
it.todo("W22_V5-2205_predicate_precedence_boundary");
it.todo("W22_V5-2206_predicate_precedence_boundary");
it.todo("W22_V5-2207_predicate_precedence_boundary");
it.todo("W22_V5-2208_predicate_precedence_boundary");
it.todo("W22_V5-2209_predicate_precedence_boundary");
it.todo("W22_V5-2210_predicate_precedence_boundary");
it.todo("W22_V5-2211_predicate_precedence_boundary");
it.todo("W22_V5-2212_predicate_precedence_boundary");
it.todo("W22_V5-2213_predicate_precedence_boundary");
it.todo("W22_V5-2214_predicate_precedence_boundary");
it.todo("W22_V5-2215_predicate_precedence_boundary");
it.todo("W22_V5-2216_predicate_precedence_boundary");
it.todo("W22_V5-2217_predicate_precedence_boundary");
it.todo("W22_V5-2218_predicate_precedence_boundary");
it.todo("W22_V5-2219_predicate_precedence_boundary");
it.todo("W22_V5-2220_predicate_precedence_boundary");
it.todo("W22_V5-2221_predicate_precedence_boundary");
it.todo("W22_V5-2222_predicate_precedence_boundary");
it.todo("W22_V5-2223_predicate_precedence_boundary");
it.todo("W22_V5-2224_predicate_precedence_boundary");
it.todo("W22_V5-2225_predicate_precedence_boundary");
it.todo("W22_V5-2226_predicate_precedence_boundary");
it.todo("W22_V5-2227_predicate_precedence_boundary");
it.todo("W22_V5-2228_predicate_precedence_boundary");
it.todo("W22_V5-2233_predicate_precedence_boundary");
it.todo("W22_V5-2234_predicate_precedence_boundary");
it.todo("W22_V5-2235_predicate_precedence_boundary");
it.todo("W22_V5-2236_predicate_precedence_boundary");
it.todo("W22_V5-2237_predicate_precedence_boundary");
it.todo("W22_V5-2238_predicate_precedence_boundary");
it.todo("W22_V5-2239_predicate_precedence_boundary");
it.todo("W22_V5-2240_predicate_precedence_boundary");
it.todo("W22_V5-2241_predicate_precedence_boundary");
it.todo("W22_V5-2242_predicate_precedence_boundary");
it.todo("W22_V5-2243_predicate_precedence_boundary");

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
      if (sql.startsWith("SELECT * FROM public.catalog_operator_receipts")) rows[0].result = { ...rows[0].result as object, ...changed };
    }));
    const capability = (await target.authorize(null))!;
    expect(await target.decision(command, capability)).toEqual({ outcome: "dependency_unavailable", reason: "catalog_publication_receipt_invalid" });
    expect(await snapshot()).toEqual(before);
  }
});

it("catalog_publication_dark_primary_preserves_structural_readiness", async () => {
  const data = await draft(), payload = structuredClone(data.payload);
  payload.publication.operations.push({ op: "set_product_status", productSlug: payload.product.slug!, status: "active" });
  const receipt = await commit(await save(payload, data.draftId, 1));
  expect(await authority.readbackV2(receipt.head)).toMatchObject({ outcome: "page", product: { status: "active" },
    items: [{ facts: { status: "draft", sellableStandalone: false, sellableInSubscription: false } }] });
  expect((await db.query("SELECT public.catalog_publication_sku_reasons($1,false) AS reasons", [data.skuId])).rows[0].reasons).toEqual([]);
});
