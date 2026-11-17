import { createNativeCatalogRenewalCodecV2, createPostgresRenewalStore } from "@openlup/platform/subscriptions";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { createPostgresCatalogPublication, installCatalogDefinitions, catalogDefinitionDigest, assertCatalogAcceptedReferenceV2, catalogAcceptedReferenceV2Schema, createCatalogProductTypeRegistry, type CatalogPublicationRules } from "@openlup/platform/catalog";
import { canonicalCatalogDraftJson, type CatalogDraftPayloadV4, type CatalogHeadRef, type CatalogPublishCommand, type CatalogAcceptedReferenceV2 } from "@openlup/platform/catalog/contracts";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
const productId = "10000000-0000-4000-8000-000000000001", skuId = "20000000-0000-4000-8000-000000000001";
const draftId = "30000000-0000-4000-8000-000000000001", documentId = "40000000-0000-4000-8000-000000000001";
const definition = { key: "example:article", version: 1, units: [{ code: "openlup:g", dimension: "mass" as const, integral: false }], netContentUnits: ["openlup:g"], dimensions: [], axes: [], validatorRef: `sha256:${"a".repeat(64)}`, validateContent: () => [] };
const registry = createCatalogProductTypeRegistry([definition]);
const rules: CatalogPublicationRules = { canonicalizeDocument: canonicalCatalogDraftJson, deriveSkuFacts: document => ({ derived: (document as { derived: number }).derived }), validateProduct: () => [], classifySkuChange: () => "compatible" };
function input(): { payload: CatalogDraftPayloadV4 } {
  const document = { schemaVersion: 1, derived: 12 }, canonicalText = canonicalCatalogDraftJson(document), digest = createHash("sha256").update(canonicalText).digest("hex");
  const facts = { skuCode: "ARTICLE", title: "Synthetic article", minQuantity: 1, isAddon: false, facts: { derived: 12 } };
  return { payload: { schemaVersion: 4, product: { id: productId, type: { key: definition.key, version: 1 }, dimensions: [], slug: "article", primarySkuId: skuId,
    documentRevision: { id: documentId, productId, revisionNo: 1, schemaId: "example:document.v1", documentRef: "example:document", sourceRef: "example:source", digest },
    sharedContent: { schemaVersion: 1, catalogAction: "create", document, presentation: {}, publicationSkus: [facts], requestedModes: [{ skuCode: "ARTICLE", modes: [] }], offerMemberships: [] } },
    skus: [{ id: skuId, productId, code: "ARTICLE", options: {}, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 }, identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: "5901234123457", packagingLevel: "unit" }] }],
    publication: { kind: "release", evidence: {}, operations: [
      { op: "create_product", productId, productSlug: "article", name: "Synthetic article" },
      { op: "register_document_revision", productSlug: "article", revisionId: documentId, revisionNo: 1, documentRef: "example:document", sourceRef: "example:source", canonicalText, digest, provenance: { source: "current_draft" } },
      { op: "move_document_pointer", productSlug: "article", documentRevisionNo: 1 },
      { op: "create_sku", productSlug: "article", documentRevisionNo: 1, skuId, ...facts },
      { op: "create_identifier", skuCode: "ARTICLE", scheme: "gs1:gtin", issuer: "example", value: "5901234123457", packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null },
      { op: "set_primary_sku", productSlug: "article", skuCode: "ARTICLE" }, { op: "set_product_presentation", productSlug: "article", presentation: {} },
    ] } } };
}
const containers: PostgresContainer[] = [], pools: Pool[] = [];
let pool: Pool, db: PoolClient;
let readiness: (requirePrice: boolean) => Promise<{ ready: boolean; reasons: string[] }>;
let authority: ReturnType<typeof createPostgresCatalogPublication<null>>;
let actor: NonNullable<Awaited<ReturnType<typeof authority.authorize>>>;
const admin = randomUUID();
beforeAll(async () => {
  const container = await runPostgresContainer({ name: `catalog-lifecycle-${process.pid}`, password: "synthetic-lifecycle" }); containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Lifecycle witnesses require real PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString }); pools.push(pool);
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  for (const unit of [manifest.baseline, ...manifest.forward]) await pool.query(readFileSync(unit.file, "utf8"));
  await installCatalogDefinitions(pool, { id: "example:lifecycle", namespace: "example", version: 1, openlupRange: "0.44.x", capabilities: { publish: false }, types: [definition], taxClasses: [] });
  await pool.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'lifecycle@example.invalid')", [admin]);
  await pool.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())", [admin]);
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(containers, pools), postgresTeardownTimeoutMs);
beforeEach(async () => {
  db = await pool.connect(); await db.query("BEGIN");
  readiness = async () => ({ ready: true, reasons: [] });
  authority = createPostgresCatalogPublication({ registry, rules, authorizeHuman: async () => ({ ok: true, userId: admin, role: "admin", isMachineActor: false }),
    readiness: async (_db, _state, requirePrice) => readiness(requirePrice), verifyMedia: async () => false, globalReadiness: async () => ({ ready: true, reasons: [] }),
    transactions: { async run(work) { await db.query("SAVEPOINT publication"); try { const result = await work(db); await db.query("RELEASE SAVEPOINT publication"); return result; }
      catch (error) { await db.query("ROLLBACK TO SAVEPOINT publication"); throw error; } } } });
  actor = (await authority.authorize(null))!;
});
afterEach(async () => { await db.query("ROLLBACK"); db.release(); });
async function publish(payload: CatalogDraftPayloadV4, revision = 0, head: CatalogHeadRef | null = null) {
  const command = { schemaVersion: 4, action: revision ? "revise" : "create", draftId,
    commandKey: `draft:${revision}`, expectedRevision: revision, payload }, text = canonicalCatalogDraftJson(command);
  const saved = (await db.query("SELECT public.catalog_draft_apply($1,$2,'operator:synthetic') AS result", [text, createHash("sha256").update(text).digest("hex")])).rows[0].result;
  expect(saved.outcome, JSON.stringify(saved)).toBe("committed");
  const candidateRef = `v1:${command.draftId}@${revision + 1}/${head ? `${head.publicationId}@${head.revision}` : "unpublished"}`;
  const candidateDigest = createHash("sha256").update('["catalog-candidate",1,').update(canonicalCatalogDraftJson(payload)).update(",")
    .update(canonicalCatalogDraftJson([{ ...payload.product.type, definitionDigest: catalogDefinitionDigest(definition) }])).update(",").update(canonicalCatalogDraftJson(head)).update("]").digest("hex");
  const publication: CatalogPublishCommand = { productId: payload.product.id, commandKey: `publish:${revision}`, candidateRef, candidateDigest, expectedHead: head, changes: [] };
  expect(await authority.decision({ schemaVersion: 2, action: "approve", productId: payload.product.id, commandKey: `approve:${revision}`, candidateRef, candidateDigest, reason: "Exact synthetic candidate" }, actor)).toMatchObject({ outcome: "committed" });
  return { result: await authority.publish(publication, actor), command: publication };
}
async function seed() {
  const payload = { ...input().payload, schemaVersion: 4 } as CatalogDraftPayloadV4;
  const first = await publish(payload); expect(first.result.outcome, JSON.stringify(first.result)).toBe("committed");
  if (!("receipt" in first.result)) throw new Error("Missing publication receipt");
  const client = randomUUID(), subscription = randomUUID();
  await db.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,clock_timestamp()+interval '28 days')", [subscription, client]);
  return { payload, first, client, subscription, sku: payload.skus[0]!.id, code: payload.skus[0]!.code!, product: payload.product.id };
}
async function obligations(sku: string) { return (await db.query("SELECT public.catalog_bound_obligations_v2($1) AS result", [sku])).rows[0].result; }
it("catalog_legacy_binding_is_not_inferred_from_current_document", async () => {
  const f = await seed();
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,3,0,617,'XXX')", [f.subscription, f.sku]);
  if (!("receipt" in f.first.result)) throw new Error("Missing first head");
  const payload = structuredClone(f.payload), document = { schemaVersion: 1, derived: 12, label: "Later editorial document" };
  const canonicalText = canonicalCatalogDraftJson(document), digest = createHash("sha256").update(canonicalText).digest("hex"), revisionId = randomUUID();
  payload.product.sharedContent = { ...payload.product.sharedContent, catalogAction: "revise", document };
  payload.product.documentRevision = { ...payload.product.documentRevision!, id: revisionId, revisionNo: 2, digest };
  payload.publication.operations = [{ op: "register_document_revision", productSlug: payload.product.slug!, revisionId, revisionNo: 2, documentRef: "example:document", sourceRef: "example:source", canonicalText, digest, provenance: { source: "current_draft" } }, { op: "move_document_pointer", productSlug: payload.product.slug!, documentRevisionNo: 2 }];
  expect((await publish(payload,1,f.first.result.receipt.head)).result).toMatchObject({ outcome: "committed" });
  expect((await db.query("SELECT catalog_sku_revision_id FROM public.subscription_lines")).rows).toEqual([{ catalog_sku_revision_id: null }]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "complete", obligations: [{ family: "template", skuRevisionId: null }] });
});
it("catalog_archive_refuses_outstanding_obligations", async () => {
  const f = await seed(), order = randomUUID();
  await db.query("WITH o AS (INSERT INTO public.commerce_orders(id,status,currency_code,total_amount_minor) VALUES($1,'fulfilled','XXX',617) RETURNING id) INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) SELECT id,$2,1,1,617,617 FROM o", [order, f.sku]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "complete", obligations: [{ family: "outstanding_order", sourceId: order }] });
  expect(await archive(f)).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
});
it("same-SKU binding refuses a foreign revision and preserves historical NULL", async () => {
  const f = await seed(), foreign = randomUUID();
  const constraint = (await db.query(`SELECT c.confdeltype,c.convalidated,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.n) AS source_keys,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.n) AS target_keys
    FROM pg_constraint c WHERE c.conname='subscription_lines_catalog_sku_revision_fkey'`)).rows;
  expect(constraint).toEqual([{ confdeltype: "r", convalidated: true,
    source_keys: ["variant_id", "catalog_sku_revision_id"], target_keys: ["sku_id", "id"] }]);
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,1,0,617,'XXX')", [f.subscription,f.sku]);
  await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$2,'OTHER','Synthetic other')", [foreign, f.product]);
  const revision = (await db.query("SELECT id FROM public.catalog_sku_revisions WHERE sku_id=$1", [f.sku])).rows[0].id;
  await db.query("SAVEPOINT mismatch");
  await expect(db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code,catalog_sku_revision_id) VALUES($1,$2,1,0,617,'XXX',$3)", [f.subscription, foreign, revision])).rejects.toMatchObject({ code: "23503" });
  await db.query("ROLLBACK TO SAVEPOINT mismatch");
  expect((await db.query("SELECT catalog_sku_revision_id FROM public.subscription_lines WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{ catalog_sku_revision_id: null }]);
});
it("refuses old raw status writes against lifecycle-governed facts", async () => {
  const f = await seed(); await db.query("SAVEPOINT raw_status");
  await expect(db.query("UPDATE public.catalog_skus SET status='active' WHERE id=$1", [f.sku])).rejects.toMatchObject({ code: "42501", message: "catalog_lifecycle_raw_status_fenced" });
  await db.query("ROLLBACK TO SAVEPOINT raw_status");
  expect(await authority.publish(f.first.command, actor)).toMatchObject({ outcome: "replayed", receipt: "receipt" in f.first.result ? f.first.result.receipt : null });
});

it.each([
  "admin_archive_catalog_sku", "admin_activate_catalog_product", "admin_archive_catalog_product",
  "admin_restore_catalog_product", "admin_deactivate_catalog_product",
] as const)("legacy lifecycle entrypoint refuses before state access: %s", async name => {
  const before = (await db.query("SELECT count(*) FROM public.catalog_publications")).rows;
  await db.query("SAVEPOINT legacy_entrypoint");
  await expect(db.query(`SELECT public.${name}(NULL,NULL)`)).rejects.toMatchObject({ code: "42501", message: "legacy_catalog_mutation_fenced" });
  await db.query("ROLLBACK TO SAVEPOINT legacy_entrypoint");
  expect((await db.query("SELECT count(*) FROM public.catalog_publications")).rows).toEqual(before);
});

async function archive(f: Awaited<ReturnType<typeof seed>>) {
  const payload = structuredClone(f.payload);
  payload.product.sharedContent.catalogAction = "revise";
  payload.publication.operations = [{ op: "set_product_lifecycle", productSlug: payload.product.slug!, expectedState: "draft", state: "archived", children: [] }];
  if (!("receipt" in f.first.result)) throw new Error("Missing first head");
  return (await publish(payload, 1, f.first.result.receipt.head)).result;
}
async function order(f: Awaited<ReturnType<typeof seed>>, status = "paid") {
  const id = randomUUID();
  await db.query("WITH o AS (INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,$3,'XXX',617) RETURNING id) INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) SELECT id,$4,1,1,617,617 FROM o", [id, f.client, status, f.sku]);
  return id;
}
async function frozen(f: Awaited<ReturnType<typeof seed>>, sku = f.code) {
  const id = randomUUID();
  await db.query("INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,claim_token,claim_generation,claimed_by,claimed_at,lease_expires_at) VALUES($1,$2,clock_timestamp(),2,$3,$4,$5::jsonb,$6,1,'synthetic',clock_timestamp(),clock_timestamp()+interval '1 minute')", [id, f.subscription, `synthetic-renewal-operation:${id}`, "a".repeat(64), JSON.stringify({ lines: [{ sku, quantity: 3 }] }), randomUUID()]);
  return id;
}
it.each(["active", "paused"])("template obligation blocks archive: %s including legacy NULL", async status => {
  const f = await seed();
  await db.query("UPDATE public.subscriptions SET status=$2 WHERE id=$1", [f.subscription, status]);
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,1,0,617,'XXX')", [f.subscription, f.sku]);
  expect(await archive(f)).toMatchObject({ outcome: "validation_issue", reason: "catalog_archive_refuses_outstanding_obligations" });
});
it("retained renewal lines block archive independently of the current template", async () => {
  const f = await seed();
  await db.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref) VALUES($1,'XXX','synthetic','sandbox',clock_timestamp(),'synthetic')", [f.subscription]);
  await db.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,$2,3,617)", [f.subscription, f.code]);
  expect(await archive(f)).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
});
it("pending activation and missing attachment template block archive", async () => {
  const f = await seed(), id = await order(f, "pending_payment");
  await db.query("INSERT INTO public.subscription_activations(order_id,client_id,cadence_days,declare_idempotency_key) VALUES($1,$2,28,$3)", [id, f.client, `activate:${id}`]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "complete", obligations: [{ family: "pending_activation", sourceId: id }] });
  expect(await archive(f)).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
});
it("frozen renewal survives template replacement", async () => {
  const f = await seed(), id = await frozen(f);
  await db.query("UPDATE public.subscriptions SET template_version=template_version+1 WHERE id=$1", [f.subscription]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "complete", obligations: [{ family: "frozen_renewal", sourceId: id }] });
  expect(await archive(f)).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
});
it.each(["waiting", "stock_secured"])("stock wait obligation blocks archive: %s", async state => {
  const f = await seed(), operation = await frozen(f, "OTHER");
  const id = randomUUID();
  await db.query("INSERT INTO public.subscription_stock_wait_cases(id,subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits) SELECT $1,$2,$3,$4,scheduled_at,cycle_number,$5,'{}',$6::jsonb,operation_fingerprint,identity_key,'[]' FROM public.subscription_renewal_operations WHERE id=$4", [id, f.subscription, f.client, operation, state, JSON.stringify({ lines: [{ sku: f.code, quantity: 3 }] })]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "complete", obligations: [{ family: "stock_wait", sourceId: id }] });
  expect(await archive(f)).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
});
it("unknown evidence and the unavailable barrier both refuse archive", async () => {
  const f = await seed();
  expect(await archive(f)).toMatchObject({ outcome: "dependency_unavailable", reason: "catalog_archive_barrier_unavailable" });
  const op = await frozen(f);
  await db.query("UPDATE public.subscription_renewal_operations SET cycle_snapshot='{}' WHERE id=$1", [op]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "unknown", reason: "catalog_obligation_evidence_unknown" });
  // Use a fresh command key because the failed archive has no publication receipt.
  expect((await publish({ ...f.payload, product: { ...f.payload.product, sharedContent: { ...f.payload.product.sharedContent, catalogAction: "revise" } }, publication: { kind: "release", evidence: {}, operations: [{ op: "set_product_lifecycle", productSlug: f.payload.product.slug!, expectedState: "draft", state: "archived", children: [] }] } }, 2, "receipt" in f.first.result ? f.first.result.receipt.head : null)).result).toMatchObject({ reason: "catalog_obligation_evidence_unknown" });
});
it("verifies the complete immutable acceptance tuple and refuses forged fields", async () => {
  const f = await seed();
  if (!("receipt" in f.first.result)) throw new Error("Missing first head");
  const publication = (await db.query("SELECT canonical_state FROM public.catalog_publications WHERE id=$1", [f.first.result.receipt.head.publicationId])).rows[0];
  const manifest = JSON.parse(publication.canonical_state);
  const referenceRow = manifest.skus[0];
  const skuRow = (await db.query("SELECT full_facts FROM public.catalog_sku_revisions WHERE id=$1", [referenceRow.revisionId])).rows[0];
  const page = { head: f.first.result.receipt.head, product: manifest.product }, sku = { reference: referenceRow, facts: JSON.parse(skuRow.full_facts) };
  const reference: CatalogAcceptedReferenceV2 = { schemaVersion: 2, skuId: f.sku, skuCode: f.code, skuRevisionId: sku.reference.revisionId,
    publicationHead: page.head, typeRef: page.product.type, definitionDigest: page.product.definitionDigest, optionDigest: sku.facts.optionDigest, netContent: sku.facts.netContent };
  expect(await assertCatalogAcceptedReferenceV2(db, reference)).toEqual(reference);
  for (const changed of [{ skuCode: "FORGED" }, { definitionDigest: "f".repeat(64) }, { optionDigest: "f".repeat(64) }, { publicationHead: { ...page.head, documentDigest: "f".repeat(64) } }, { netContent: { ...reference.netContent, unscaled: "999" } }]) {
    await db.query("SAVEPOINT tuple");
    await expect(assertCatalogAcceptedReferenceV2(db, { ...reference, ...changed })).rejects.toMatchObject({ code: "22023" });
    await db.query("ROLLBACK TO SAVEPOINT tuple");
  }
});

it.each([
  ["D-accepted-typeRef", { typeRef: { key: "example:uninstalled", version: 1 } }],
  ["D-accepted-definitionDigest", { definitionDigest: "f".repeat(64) }],
  ["D-accepted-demandPolicyRef", { demandPolicyRef: "example:forged-policy@1" }],
] as const)("%s: only the supplied tuple field differs from retained facts", async (_rule, change) => {
  const standing = await standingActive(await seed());
  expect(await assertCatalogAcceptedReferenceV2(db, standing.accepted)).toEqual(standing.accepted);
  await db.query("SAVEPOINT supplied_tuple");
  await expect(assertCatalogAcceptedReferenceV2(db, { ...standing.accepted, ...change })).rejects.toMatchObject({ code: "22023", message: "catalog_accepted_reference_mismatch" });
  await db.query("ROLLBACK TO SAVEPOINT supplied_tuple");
});
it("D-acceptance-immutable: a captured order acceptance cannot be cleared", async () => {
  const standing = await standingActive(await seed()), order = randomUUID();
  const acceptance = { schemaVersion: 2, lines: [standing.accepted] };
  await db.query("INSERT INTO public.commerce_orders(id,currency_code,total_amount_minor,catalog_acceptance) VALUES($1,'XXX',0,$2::jsonb)", [order,JSON.stringify(acceptance)]);
  await db.query("SAVEPOINT immutable_acceptance");
  // No frozen snapshot exists, and NULL needs no tuple verification: only immutability refuses.
  await expect(db.query("UPDATE public.commerce_orders SET catalog_acceptance=NULL WHERE id=$1", [order])).rejects.toMatchObject({ code: "55000", message: "catalog_acceptance_immutable" });
  await db.query("ROLLBACK TO SAVEPOINT immutable_acceptance");
  expect((await db.query("SELECT catalog_acceptance FROM public.commerce_orders WHERE id=$1", [order])).rows).toEqual([{ catalog_acceptance: acceptance }]);
});
it("D-retained-v1-bytes: the new carrier is v2 and the legacy renderer keeps its bytes", async () => {
  const f = await seed(), standing = await standingActive(f), order = randomUUID();
  const acceptance = { schemaVersion: 2, lines: [standing.accepted] };
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code,catalog_sku_revision_id) VALUES($1,$2,3,0,617,'XXX',$3)", [f.subscription,f.sku,standing.accepted.skuRevisionId]);
  await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',0)", [order,f.client]);
  await db.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3::jsonb,clock_timestamp())", [order,f.subscription,JSON.stringify({ templateId: "synthetic", shippingAmountMinor: 0, acquisitionRef: null, renewalTerms: { version: "native.renewal-terms.v1" } })]);
  const legacy = (await db.query("SELECT public.subscription_renewal_purchase_terms($1)::text AS bytes", [f.subscription])).rows;
  await db.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref,catalog_acceptance) VALUES($1,'XXX','synthetic','sandbox',clock_timestamp(),'synthetic',$2::jsonb)", [f.subscription,JSON.stringify(acceptance)]);
  const current = (await db.query("SELECT public.subscription_renewal_purchase_terms_v2($1) AS facts", [f.subscription])).rows[0].facts;
  const expected = JSON.parse(legacy[0].bytes);
  expect(expected.renewalTerms.version).toBe("native.renewal-terms.v1");
  expect(current).toEqual({ ...expected, renewalTerms: { ...expected.renewalTerms, version: "native.renewal-terms.v2", catalogAcceptance: acceptance } });
  expect((await db.query("SELECT public.subscription_renewal_purchase_terms($1)::text AS bytes", [f.subscription])).rows).toEqual(legacy);
});

async function replacement(f: Awaited<ReturnType<typeof seed>>, id: string) {
  const predecessor = randomUUID(), leaf = randomUUID();
  await db.query("INSERT INTO public.fulfillment_ports(port_key,provider_type) VALUES('lifecycle:manual','manual')");
  await db.query("INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,status,create_idempotency_key) VALUES($1,$2,'lifecycle:manual','manual','exception',$3)", [predecessor,id,`parcel:${predecessor}`]);
  await db.query("INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,status,create_idempotency_key,replaces_shipment_id,sequence_no,replacement_reason) VALUES($1,$2,'lifecycle:manual','manual','in_transit',$3,$4,1,'lost')", [leaf,id,`parcel:${leaf}`,predecessor]);
  await db.query("INSERT INTO public.fulfillment_parcel_reservation_sets(shipment_id,order_id) VALUES($1,$2)", [leaf,id]);
  await db.query("INSERT INTO public.fulfillment_parcel_lines(shipment_id,order_item_id,sku_id,sku,quantity) SELECT $1,id,$2,$3,1 FROM public.commerce_order_items WHERE order_id=$4", [leaf,f.sku,f.code,id]);
  return { predecessor, leaf };
}
it("catalog_archive_refuses_undelivered_replacement", async () => {
  const f = await seed(), id = await order(f, "cancelled");
  await db.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1", [f.subscription]);
  const { predecessor, leaf } = await replacement(f,id);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "complete", obligations: [{ family: "replacement", sourceId: leaf }] });
  expect(await archive(f)).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
  await db.query("UPDATE public.fulfillment_shipments SET delivered_at=clock_timestamp(),status='delivered' WHERE id=$1", [leaf]);
  expect(await obligations(f.sku)).toEqual({ schemaVersion: 2, outcome: "complete", obligations: [] });
  expect((await db.query("SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1", [predecessor])).rows[0].delivered_at).toBeNull();
});
it("undelivered replacement without usable parcel identity refuses absence", async () => {
  const f = await seed(), id = await order(f, "cancelled");
  const { leaf } = await replacement(f,id);
  await db.query("UPDATE public.fulfillment_parcel_lines SET sku_id=NULL,sku=NULL WHERE shipment_id=$1", [leaf]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "unknown", reason: "catalog_obligation_evidence_unknown" });
  expect(await archive(f)).toMatchObject({ reason: "catalog_obligation_evidence_unknown" });
});
it("graduation obligation uses retained basis and accepted edit evidence", async () => {
  const f = await seed(), id = randomUUID();
  await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',0)", [id,f.client]);
  const basis = (await db.query("SELECT template_version FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].template_version;
  const facts = { renewalTerms: { version: "native.renewal-terms.v1", starterPack: { schemaVersion: "1", basisTemplateVersion: basis,
    starterIntervalDays: 28, delivery2: { discountBps: 0, discountMinor: 0, basisSubtotalMinor: 617 }, graduation: { cadenceDays: 28,
      lines: [{ sku: f.code, qty: 3, sortOrder: 0, isAddon: false, quoteLine: { unitPriceGross: { amountMinor: 617 }, lineSubtotalGross: { amountMinor: 1851 } } }] } } } };
  await db.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3::jsonb,clock_timestamp())", [id,f.subscription,JSON.stringify(facts)]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "complete", obligations: [{ family: "graduation", sourceId: id }] });
  expect(await archive(f)).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
  await db.query("UPDATE public.subscriptions SET template_version=template_version+1 WHERE id=$1", [f.subscription]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "unknown" });
  const event = randomUUID();
  await db.query("INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload) VALUES($1,$2,'subscription.customer_self_service.update_bundle',$3,$4::jsonb)", [event,f.subscription,`edit:${event}`,JSON.stringify({ templateVersion: basis + 1 })]);
  await db.query("INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,quote_hash,expected_template_version,proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,status,expires_at,accepted_event_id,accepted_at) VALUES($1,$2,$3,$4,$5,'[]',28,0,0,'XXX','accepted',clock_timestamp()+interval '1 hour',$6,clock_timestamp())", [f.subscription,`quote:${event}`,"b".repeat(64),"c".repeat(64),basis,event]);
  expect(await obligations(f.sku)).toEqual({ schemaVersion: 2, outcome: "complete", obligations: [] });
});
// Standing immutable active facts exercise servicing. This fixture does not qualify activation or the later price writer.
async function standingActive(f: Awaited<ReturnType<typeof seed>>) {
  if (!("receipt" in f.first.result)) throw new Error("Missing first head");
  const old = (await db.query("SELECT * FROM public.catalog_publications WHERE id=$1", [f.first.result.receipt.head.publicationId])).rows[0];
  const manifest = JSON.parse(old.canonical_state), reference = manifest.skus[0];
  const prior = (await db.query("SELECT * FROM public.catalog_sku_revisions WHERE id=$1", [reference.revisionId])).rows[0];
  const facts = { ...JSON.parse(prior.full_facts), lifecycleState: "active", status: "active" };
  manifest.product = { ...manifest.product, lifecycleState: "active", status: "active" };
  const publication = randomUUID(), revision = randomUUID(), text = canonicalCatalogDraftJson(facts), digest = createHash("sha256").update(text).digest("hex");
  manifest.skus = [{ ...reference, revisionId: revision, revision: 2, digest }];
  const canonical = canonicalCatalogDraftJson(manifest), hash = createHash("sha256").update(canonical).digest("hex");
  await db.query("INSERT INTO public.catalog_lifecycle_write_capabilities(transaction_id,product_id,fingerprint) VALUES(pg_current_xact_id(),$1,$2)", [f.product,hash]);
  await db.query("UPDATE public.catalog_products SET status='active',publication_facts=$2::jsonb WHERE id=$1", [f.product,JSON.stringify(manifest.product)]);
  await db.query("UPDATE public.catalog_skus SET status='active',publication_facts=$2::jsonb WHERE id=$1", [f.sku,text]);
  await db.query("INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id) VALUES($1,$2,2,$3,$4,1,$5,$6,$7,$8,$6,$9)", [publication,f.product,old.id,old.draft_id,`standing:${publication}`,hash,old.document_revision_id,canonical,admin]);
  await db.query("INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest) VALUES($1,$2,$3,2,$4,$5,$6)", [revision,f.sku,f.product,publication,text,digest]);
  await db.query("UPDATE public.catalog_publication_heads SET publication_id=$2,revision=2 WHERE product_id=$1", [f.product,publication]);
  await db.query("DELETE FROM public.catalog_lifecycle_write_capabilities WHERE product_id=$1", [f.product]);
  const head = { ...f.first.result.receipt.head, publicationId: publication, revision: 2 };
  const accepted: CatalogAcceptedReferenceV2 = { schemaVersion: 2, skuId: f.sku, skuCode: f.code, skuRevisionId: revision, publicationHead: head,
    typeRef: manifest.product.type, definitionDigest: manifest.product.definitionDigest, optionDigest: facts.optionDigest, netContent: facts.netContent };
  return { head, accepted };
}
function withdrawal(f: Awaited<ReturnType<typeof seed>>): CatalogDraftPayloadV4 {
  const payload = structuredClone(f.payload); payload.product.sharedContent.catalogAction = "revise";
  payload.publication.operations = [{ op: "set_product_lifecycle", productSlug: payload.product.slug!, expectedState: "active", state: "withdrawn", children: [{ skuCode: f.code, expectedState: "active" }] }];
  return payload;
}
it("catalog_withdraw_preserves_retained_subscription_read", async () => {
  const f = await seed(), standing = await standingActive(f), id = randomUUID();
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code,catalog_sku_revision_id) VALUES($1,$2,3,0,617,'XXX',$3)", [f.subscription,f.sku,standing.accepted.skuRevisionId]);
  await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',0)", [id,f.client]);
  await db.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3::jsonb,clock_timestamp())", [id,f.subscription,JSON.stringify({ templateId: "synthetic", shippingAmountMinor: 0, acquisitionRef: null, renewalTerms: { version: "native.renewal-terms.v1" } })]);
  await db.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref,catalog_acceptance) VALUES($1,'XXX','synthetic','sandbox',clock_timestamp(),'synthetic',$2::jsonb)", [f.subscription,JSON.stringify({ schemaVersion: 2, lines: [standing.accepted] })]);
  const before = (await db.query("SELECT to_jsonb(s) AS subscription,(SELECT jsonb_agg(to_jsonb(l)) FROM public.subscription_lines l WHERE l.subscription_id=s.id) AS lines FROM public.subscriptions s WHERE id=$1", [f.subscription])).rows;
  const retained = (await db.query("SELECT public.subscription_renewal_purchase_terms_v2($1) AS facts", [f.subscription])).rows;
  readiness = async () => { throw new Error("Unrelated activation readiness outage"); };
  expect((await publish(withdrawal(f),1,standing.head)).result).toMatchObject({ outcome: "committed" });
  expect((await db.query("SELECT public.subscription_renewal_purchase_terms_v2($1) AS facts", [f.subscription])).rows).toEqual(retained);
  expect((await db.query("SELECT to_jsonb(s) AS subscription,(SELECT jsonb_agg(to_jsonb(l)) FROM public.subscription_lines l WHERE l.subscription_id=s.id) AS lines FROM public.subscriptions s WHERE id=$1", [f.subscription])).rows).toEqual(before);
  expect(await assertCatalogAcceptedReferenceV2(db, standing.accepted)).toEqual(standing.accepted);
  expect((await db.query("SELECT status,sellable_standalone,sellable_in_subscription,publication_facts->>'lifecycleState' AS lifecycle FROM public.catalog_skus WHERE id=$1", [f.sku])).rows).toEqual([{ status: "active", sellable_standalone: false, sellable_in_subscription: false, lifecycle: "withdrawn" }]);
});
it("catalog_restore_rechecks_current_readiness", async () => {
  const f = await seed(), standing = await standingActive(f), payload = withdrawal(f);
  const withdrawn = (await publish(payload,1,standing.head)).result;
  if (!("receipt" in withdrawn)) throw new Error(JSON.stringify(withdrawn));
  payload.publication.operations = [{ op: "restore_product", productSlug: payload.product.slug!, expectedState: "withdrawn" }];
  readiness = async () => ({ ready: false, reasons: ["current_readiness_unavailable"] });
  expect((await publish(payload,2,withdrawn.receipt.head)).result).toMatchObject({ reason: "catalog_publication_v3_activation_readiness_failed" });
  expect((await db.query("SELECT publication_id FROM public.catalog_publication_heads WHERE product_id=$1", [f.product])).rows[0].publication_id).toBe(withdrawn.receipt.head.publicationId);
});
it("catalog_material_change_requires_successor_sku", async () => {
  const f = await seed();
  if (!("receipt" in f.first.result)) throw new Error("Missing first head");
  const payload = structuredClone(f.payload); payload.product.sharedContent.catalogAction = "revise";
  payload.skus[0]!.netContent!.unscaled = "200";
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: {} }];
  expect((await publish(payload,1,f.first.result.receipt.head)).result).toMatchObject({ reason: "sku_identity_change_requires_new_sku" });
});
it.each(["receipt", "outbox"] as const)("late %s failure rolls back withdrawal, child facts, revisions and head", async point => {
  const f = await seed(), standing = await standingActive(f);
  const before = (await db.query("SELECT (SELECT jsonb_agg(to_jsonb(p)) FROM public.catalog_products p) AS products,(SELECT jsonb_agg(to_jsonb(s)) FROM public.catalog_skus s) AS skus,(SELECT jsonb_agg(to_jsonb(h)) FROM public.catalog_publication_heads h) AS heads,(SELECT count(*) FROM public.catalog_publications) AS publications,(SELECT count(*) FROM public.catalog_sku_revisions) AS revisions")).rows;
  await db.query("CREATE FUNCTION public.lifecycle_test_late_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_late_failure'; END; $$");
  const table = point === "receipt" ? "catalog_operator_receipts" : "outbox_events";
  const when = point === "outbox" ? " WHEN (NEW.event_type='catalog.publication.committed')" : " WHEN (NEW.kind='publish')";
  await db.query(`CREATE TRIGGER lifecycle_test_late_failure BEFORE INSERT ON public.${table} FOR EACH ROW${when} EXECUTE FUNCTION public.lifecycle_test_late_failure()`);
  expect((await publish(withdrawal(f),1,standing.head)).result).toMatchObject({ outcome: "dependency_unavailable" });
  expect((await db.query("SELECT (SELECT jsonb_agg(to_jsonb(p)) FROM public.catalog_products p) AS products,(SELECT jsonb_agg(to_jsonb(s)) FROM public.catalog_skus s) AS skus,(SELECT jsonb_agg(to_jsonb(h)) FROM public.catalog_publication_heads h) AS heads,(SELECT count(*) FROM public.catalog_publications) AS publications,(SELECT count(*) FROM public.catalog_sku_revisions) AS revisions")).rows).toEqual(before);
});

it("all seven obligation families independently survive in one archive decision", async () => {
  const f = await seed(), id = await order(f), operation = await frozen(f);
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,1,0,617,'XXX')", [f.subscription,f.sku]);
  await db.query("INSERT INTO public.subscription_activations(order_id,client_id,cadence_days,declare_idempotency_key) VALUES($1,$2,28,$3)", [id,f.client,`activate:${id}`]);
  await replacement(f,id);
  await db.query("INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits) SELECT $1,$2,id,scheduled_at,cycle_number,'waiting','{}',cycle_snapshot,operation_fingerprint,identity_key,'[]' FROM public.subscription_renewal_operations WHERE id=$3", [f.subscription,f.client,operation]);
  const graduate = randomUUID(), basis = (await db.query("SELECT template_version FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].template_version;
  await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',0)", [graduate,f.client]);
  await db.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3::jsonb,clock_timestamp())", [graduate,f.subscription,JSON.stringify({ renewalTerms: { starterPack: { basisTemplateVersion: basis, graduation: { lines: [{ sku: f.code, qty: 3 }] } } } })]);
  const result = await obligations(f.sku);
  expect(result.outcome).toBe("complete");
  expect(new Set(result.obligations.map((value: { family: string }) => value.family))).toEqual(new Set(["template","pending_activation","frozen_renewal","outstanding_order","replacement","stock_wait","graduation"]));
  expect(await archive(f)).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
});
it("filtered evidence never becomes an empty complete obligation result", async () => {
  const f = await seed();
  await db.query("CREATE ROLE lifecycle_reader NOLOGIN");
  await db.query("GRANT SELECT ON public.catalog_skus TO lifecycle_reader");
  await db.query("GRANT EXECUTE ON FUNCTION public.catalog_bound_obligations_v2(uuid) TO lifecycle_reader");
  await db.query("SET LOCAL ROLE lifecycle_reader");
  const result = await obligations(f.sku);
  expect(["unknown","unavailable"]).toContain(result.outcome);
  await db.query("RESET ROLE");
});

it("new native freezes persist complete accepted references and replay after reconnect", async () => {
  const f = await seed(), standing = await standingActive(f), cycle = randomUUID(), orderId = randomUUID();
  await db.query("UPDATE public.subscriptions SET started_at=clock_timestamp()-interval '28 days',next_cycle_at=date_trunc('milliseconds',clock_timestamp())-interval '1 second' WHERE id=$1", [f.subscription]);
  await db.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) SELECT $1,id,started_at,'paid' FROM public.subscriptions WHERE id=$2", [cycle,f.subscription]);
  await db.query("WITH o AS (INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,status,currency_code,total_amount_minor) VALUES($1,$2,$3,'paid','XXX',1851) RETURNING id) INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) SELECT id,$4,1,3,617,1851 FROM o", [orderId,f.client,cycle,f.sku]);
  await db.query("INSERT INTO public.subscription_activations(order_id,client_id,subscription_id,cadence_days,state,payment_fingerprint,activation_idempotency_key,declare_idempotency_key,activated_at) VALUES($1,$2,$3,28,'active',$4,$5,$6,clock_timestamp())", [orderId,f.client,f.subscription,"a".repeat(64),`active:${orderId}`,`declare:${orderId}`]);
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code,catalog_sku_revision_id) VALUES($1,$2,3,0,617,'XXX',$3)", [f.subscription,f.sku,standing.accepted.skuRevisionId]);
  const acceptance = { schemaVersion: 2, lines: [standing.accepted] };
  await db.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref,catalog_acceptance) VALUES($1,'XXX','synthetic','sandbox',clock_timestamp(),'synthetic',$2::jsonb)", [f.subscription,JSON.stringify(acceptance)]);
  await db.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,$2,3,617)", [f.subscription,f.code]);
  await db.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3::jsonb,clock_timestamp())", [orderId,f.subscription,JSON.stringify({ templateId: "synthetic", shippingAmountMinor: 0, acquisitionRef: null, renewalTerms: { version: "native.renewal-terms.v1" } })]);
  // Fixture installation commits before the business transaction takes commerce locks.
  await db.query("COMMIT"); db.release(true); db = await pool.connect(); await db.query("BEGIN");
  const now = (await db.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value")).rows[0].value;
  const codec = createNativeCatalogRenewalCodecV2(value => catalogAcceptedReferenceV2Schema.parse(value));
  const builder = createPostgresRenewalStore(db,codec,work => work(db)), due = (await builder.listDue(10,now)).find(value => value.subscriptionId === f.subscription);
  if (!due) throw new Error("Missing recorded due subscription");
  const snapshot = await builder.buildCycleSnapshots(due), store = createPostgresRenewalStore(db,codec);
  expect(snapshot.frozenRevision).toBe("native.purchase-renewal.v3");
  expect(snapshot.pricingSnapshot.totalAmountMinor).toBe(1851);
  const claim = await store.claimDue({ snapshot, workerId: "synthetic", now });
  const rows = (await db.query("SELECT cycle_snapshot,catalog_acceptance FROM public.subscription_renewal_operations WHERE id=$1", [claim.operationId])).rows;
  expect(rows[0].catalog_acceptance).toEqual(acceptance);
  expect(rows[0].cycle_snapshot).toEqual(codec.encode(snapshot));
  await db.query("COMMIT"); db.release(true); db = await pool.connect(); await db.query("BEGIN");
  const reconnected = createPostgresRenewalStore(db,createNativeCatalogRenewalCodecV2(value => catalogAcceptedReferenceV2Schema.parse(value)));
  expect(await reconnected.claimDue({ snapshot, workerId: "synthetic", now })).toMatchObject({ operationId: claim.operationId, replayed: true });
  await db.query("SAVEPOINT immutable_snapshot");
  await expect(db.query("UPDATE public.subscription_renewal_operations SET cycle_snapshot=jsonb_set(cycle_snapshot,'{totalAmountMinor}','1') WHERE id=$1", [claim.operationId])).rejects.toMatchObject({ code: "55000", message: "catalog_acceptance_snapshot_immutable" });
  await db.query("ROLLBACK TO SAVEPOINT immutable_snapshot");
  expect((await db.query("SELECT cycle_snapshot,catalog_acceptance FROM public.subscription_renewal_operations WHERE id=$1", [claim.operationId])).rows).toEqual(rows);
});
