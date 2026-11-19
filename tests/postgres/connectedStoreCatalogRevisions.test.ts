import { setFixtureCatalogDocument } from "../helpers/storeJourney.js";
import { createHash, randomUUID } from "node:crypto";
import { Pool, type QueryConfig } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createPostgresCatalogPublication, createCatalogProductTypeRegistry, catalogDefinitionDigest, installCatalogDefinitions, catalogAcceptedReferenceV2Schema } from "@openlup/platform/catalog";
import { canonicalCatalogDraftJson, type CatalogDraftPayloadV3, type CatalogDraftPayloadV4, type CatalogPublishCommand, type CatalogHeadRef } from "@openlup/platform/catalog/contracts";
import { createNativeCatalogRenewalCodecV2, createPostgresRenewalStore } from "@openlup/platform/subscriptions";
import { PostgresTransferError } from "@openlup/platform/portability";
import type { ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, journeyCensus, journeySelection, storeJourneyResources,
  type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const resources = storeJourneyResources();
const at = "2026-09-15T00:00:00Z";
const products = [randomUUID(), randomUUID(), randomUUID()];
const latest = [randomUUID(), randomUUID()];
let source: JourneyInstallation, target: JourneyInstallation, lifecycleSource: JourneyInstallation;
let lifecycleHistory: Awaited<ReturnType<typeof seedPublicationHistory>>;
let packet: ConnectedNativeStoreCapture, freshTarget: ConnectedNativeStoreCapture;
let targetNumber = 0;
let retainedPublication: { first: CatalogHeadRef; second: CatalogHeadRef; productId: string; receipt: unknown };

beforeAll(async () => {
  source = await resources.installation("catalog-source");
  for (const [index, product] of products.entries()) {
    await source.owner.query(`INSERT INTO public.catalog_products(id,slug,name,created_at,updated_at)
      VALUES($1,$2,'Synthetic document product',$3,$3)`, [product, `document-product-${index}`, at]);
    if (index !== 1) {
      const sku = randomUUID();
      await source.owner.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,created_at,updated_at)
        VALUES($1,$2,$3,'Synthetic SKU',$4,$4)`, [sku, product, `DOCUMENT-SKU-${index}`, at]);
      await source.owner.query("UPDATE public.catalog_products SET primary_sku_id=$2 WHERE id=$1", [product, sku]);
    }
    if (index === 2) continue;
    for (const revision of [1, 2]) {
      await source.owner.query(`INSERT INTO public.catalog_product_document_revisions
        (id,product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest,created_at)
        VALUES($1,$2,$3,'synthetic.v1',$4,
          '{"amount":9007199254740993,"currency":"XXX","label":"Synthetic document"}',
          'https://example.invalid/catalog','{"source":"synthetic"}',$5,$6)`,
      [revision === 2 ? latest[index] : randomUUID(), product, revision,
        `document:${index}:${revision}`, String(revision).repeat(64), at]);
    }
    await setFixtureCatalogDocument(source.owner, product, latest[index]);
  }
  retainedPublication = await seedPublicationHistory(source.owner);
  packet = await captureStoreJourney(source.owner, "catalog-document-source");
  lifecycleSource = await resources.installation("lifecycle-source");
  lifecycleHistory = await seedPublicationHistory(lifecycleSource.owner, 4, lifecycleSource.runtime);
}, postgresSetupTimeoutMs);

beforeEach(async () => {
  target = await resources.installation(`catalog-target-${++targetNumber}`);
  freshTarget = await captureStoreJourney(target.owner, "catalog-document-target");
}, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

const restore = (owner = target.owner, captured = packet) => restoreConnectedNativeStore({
  owner, installation: journeySelection, packet: captured, freshTarget,
});

// Observe or perturb real SQL on the owned transaction, without replacing any
// query result, schema object, constraint or qualification evidence.
function observedOwner(before: (sql: string, query: (sql: string, values?: unknown[]) => Promise<unknown>) => Promise<void>,
  onError: (sql: string, error: unknown) => void = () => undefined): Pool {
  return { async connect() {
    const client = await target.owner.connect();
    return {
      async query(sql: string | QueryConfig, values?: unknown[]) {
        const text = typeof sql === "string" ? sql : sql.text;
        await before(text, (statement, parameters) => client.query(statement, parameters));
        try { return typeof sql === "string" ? await client.query(sql, values) : await client.query(sql); }
        catch (error) { onError(text, error); throw error; }
      },
      release: (destroy?: boolean) => client.release(destroy),
    };
  } } as unknown as Pool;
}

// Each case bound is about 4x its slowest hosted run, rounded up to 5 s.
// Container setup retains its separate deadline; cases keep retry at zero.
it("carries two revisions per revised product, resolves the latest pointer and replays byte-exactly", async () => {
  const before = await journeyCensus(source.owner);
  expect(packet.owned.find(table => table.table === "catalog_product_document_revisions")?.rows)
    .toEqual(before.catalog_product_document_revisions);
  expect(before.catalog_product_document_revisions).toHaveLength(5);
  expect(await restore()).toEqual({ captureSha256: packet.sha256, replayed: false, neutralizedHistoricalHoldNotifications: 0 });
  expect(await journeyCensus(target.owner)).toEqual(before);
  expect((await target.owner.query(`SELECT p.id,p.current_document_revision_id,r.product_id,r.revision_no,
    r.id=(SELECT r2.id FROM public.catalog_product_document_revisions r2
      WHERE r2.product_id=p.id ORDER BY r2.revision_no DESC LIMIT 1) AS latest
    FROM public.catalog_products p JOIN public.catalog_product_document_revisions r
      ON r.id=p.current_document_revision_id WHERE p.id=ANY($1::uuid[]) ORDER BY p.slug`, [products])).rows)
    .toEqual(products.slice(0, 2).map((id, index) => ({ id, current_document_revision_id: latest[index],
      product_id: id, revision_no: 2, latest: true })));
  expect(await restore()).toEqual({ captureSha256: packet.sha256, replayed: true, neutralizedHistoricalHoldNotifications: 0 });
  expect(await journeyCensus(target.owner)).toEqual(before);
}, 105_000);

it("refuses another product's revision at the pointer foreign key and rolls back to pristine rows", async () => {
  const pristine = await journeyCensus(target.owner);
  expect(packet.observation.cluster).not.toBe(freshTarget.observation.cluster);
  const corrupted = structuredClone(packet);
  const table = corrupted.owned.find(value => value.table === "catalog_products")!;
  let patched = false;
  table.rows = table.rows.map(row => {
    if ((JSON.parse(row) as { id: string }).id !== products[0]) return row;
    const changed = row.replace(`"current_document_revision_id": "${latest[0]}"`,
      `"current_document_revision_id": "${latest[1]}"`);
    expect(changed).not.toBe(row);
    patched = true; return changed;
  });
  expect(patched).toBe(true);
  const { sha256: _old, ...body } = corrupted;
  corrupted.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  let pointerError: unknown;
  const owner = observedOwner(async () => undefined, (sql, error) => {
    if (sql.includes("catalog_publication_pointer_capabilities") || sql.startsWith("UPDATE public.catalog_products p SET current_document_revision_id=")) pointerError = error;
  });
  await expect(restore(owner, corrupted)).rejects.toBeInstanceOf(PostgresTransferError);
  expect(pointerError).toMatchObject({ code: "23503", table: "catalog_publication_pointer_capabilities" });
  expect(await journeyCensus(target.owner)).toEqual(pristine);
}, 60_000);

it("preserves a null document pointer and a null primary SKU without changing product rows", async () => {
  expect(await restore()).toMatchObject({ replayed: false });
  const before = await journeyCensus(source.owner), after = await journeyCensus(target.owner);
  expect(after.catalog_products).toEqual(before.catalog_products);
  expect((await target.owner.query(`SELECT id,current_document_revision_id,primary_sku_id
    FROM public.catalog_products WHERE id=$1`, [products[1]])).rows)
    .toEqual([{ id: products[1], current_document_revision_id: latest[1], primary_sku_id: null }]);
  expect((await target.owner.query(`SELECT p.id,p.current_document_revision_id,p.primary_sku_id IS NOT NULL AS has_sku,
    (SELECT count(*)::int FROM public.catalog_product_document_revisions r WHERE r.product_id=p.id) AS revisions
    FROM public.catalog_products p WHERE p.id=$1`, [products[2]])).rows)
    .toEqual([{ id: products[2], current_document_revision_id: null, has_sku: true, revisions: 0 }]);
}, 75_000);

it("refuses a changed staged product at the guarded pointer update and rolls back every row", async () => {
  const pristine = await journeyCensus(target.owner);
  let changed = false;
  const owner = observedOwner(async (sql, query) => {
    if (changed || !sql.startsWith("UPDATE public.catalog_products p SET current_document_revision_id=")) return;
    // This product has no primary SKU, so that separate cycle cannot mask a
    // missing document-pointer guard or exactly-one-row check.
    await query("UPDATE public.catalog_products SET name='Changed staged product' WHERE id=$1", [products[1]]);
    changed = true;
  });
  await expect(restore(owner)).rejects.toMatchObject({ code: "target_conflict", table: "catalog_products" });
  expect(changed).toBe(true);
  expect(await journeyCensus(target.owner)).toEqual(pristine);
}, 65_000);

const publicationAdmin = randomUUID();
const publicationDefinition = { key: "example:transfer-article", version: 1, units: [{ code: "openlup:g", dimension: "mass" as const, integral: true }],
  netContentUnits: ["openlup:g"], dimensions: [], axes: [], validatorRef: `sha256:${"a".repeat(64)}`, validateContent: () => [] };
function publicationAuthority(owner: Pool, ownsRetained = false) {
  return createPostgresCatalogPublication({ registry: createCatalogProductTypeRegistry([publicationDefinition]),
    transactions: { async run(work) { const client = await owner.connect(); try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
      catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } } },
    authorizeHuman: async () => ({ ok: true as const, userId: publicationAdmin, role: "admin", isMachineActor: false }),
    rules: { canonicalizeDocument: canonicalCatalogDraftJson, deriveSkuFacts: () => ({}), validateProduct: () => [], classifySkuChange: () => "compatible" as const },
    readiness: async () => ({ ready: true, reasons: [] }), verifyMedia: async () => false,
    acceptedSource: async (_db, _context, binding) => ownsRetained ? binding : "unauthorized",
  });
}
async function seedPublicationHistory(owner: Pool, schemaVersion: 3 | 4 = 3, draftWriter = owner) {
  await installCatalogDefinitions(owner, { id: "example:transfer", namespace: "example", version: 1, openlupRange: "0.44.x", capabilities: { publish: false }, types: [publicationDefinition], taxClasses: [] });
  await owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'transfer-publication@example.invalid')", [publicationAdmin]);
  await owner.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())", [publicationAdmin]);
  const authority = publicationAuthority(owner), actor = (await authority.authorize(undefined))!, productId = randomUUID(), skuId = randomUUID(), draftId = randomUUID(), documentId = randomUUID();
  const canonicalText = canonicalCatalogDraftJson({ label: "Retained transfer article" }), digest = createHash("sha256").update(canonicalText).digest("hex");
  const skuCode = `TRANSFER-${skuId}`, slug = `retained-${productId}`, facts = { skuCode, title: "Retained article", minQuantity: 1, isAddon: false, facts: {} };
  const payload: CatalogDraftPayloadV3 | CatalogDraftPayloadV4 = { schemaVersion, product: { id: productId, slug, type: { key: publicationDefinition.key, version: 1 }, dimensions: [], primarySkuId: skuId,
    documentRevision: { id: documentId, productId, revisionNo: 1, schemaId: "example:transfer.v1", documentRef: "example:transfer", sourceRef: "example:source", digest },
    sharedContent: { schemaVersion: 1, catalogAction: "create", document: JSON.parse(canonicalText), presentation: {}, publicationSkus: [facts], offerMemberships: [], requestedModes: [{ skuCode, modes: [] }] } },
    skus: [{ id: skuId, productId, code: skuCode, options: {}, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 }, identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: "5901234123457", packagingLevel: "unit", quantity: 1 }] }],
    publication: { kind: "release", evidence: {}, operations: [
      { op: "create_product", productId, productSlug: slug, name: "Retained article" },
      { op: "register_document_revision", productSlug: slug, revisionId: documentId, revisionNo: 1, documentRef: "example:transfer", sourceRef: "example:source", canonicalText, digest, provenance: { source: "current_draft" } },
      { op: "move_document_pointer", productSlug: slug, documentRevisionNo: 1 }, { op: "create_sku", skuId, productSlug: slug, documentRevisionNo: 1, ...facts },
      { op: "create_identifier", skuCode, scheme: "gs1:gtin", issuer: "example", value: "5901234123457", packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null },
      { op: "set_primary_sku", productSlug: slug, skuCode }, { op: "set_product_presentation", productSlug: slug, presentation: {} },
    ] } };
  let head: CatalogHeadRef | null = null, first: CatalogHeadRef | null = null, receipt: unknown;
  let firstCommand: CatalogPublishCommand | undefined;
  let frozen: Awaited<ReturnType<typeof seedFrozenTransfer>> | undefined;
  for (const expectedRevision of [0, 1]) {
    if (expectedRevision) { payload.product.sharedContent.catalogAction = "revise"; payload.product.sharedContent.presentation = { label: "Second presentation" };
      payload.publication.operations = [{ op: "set_product_presentation", productSlug: slug, presentation: payload.product.sharedContent.presentation }]; }
    const command = { schemaVersion, action: expectedRevision ? "revise" : "create", draftId, commandKey: `draft:${expectedRevision + 1}`, expectedRevision, payload }, text = canonicalCatalogDraftJson(command);
    expect((await draftWriter.query("SELECT public.catalog_draft_apply($1,$2,'operator:synthetic') AS result", [text, createHash("sha256").update(text).digest("hex")])).rows[0].result.outcome).toBe("committed");
    const candidateRef = `v1:${draftId}@${expectedRevision + 1}/${head ? `${head.publicationId}@${head.revision}` : "unpublished"}`;
    const candidateDigest = createHash("sha256").update('["catalog-candidate",1,').update(canonicalCatalogDraftJson(payload)).update(",")
      .update(canonicalCatalogDraftJson([{ ...payload.product.type, definitionDigest: catalogDefinitionDigest(publicationDefinition) }])).update(",").update(canonicalCatalogDraftJson(head)).update("]").digest("hex");
    const publish = { commandKey: `publish:${expectedRevision + 1}`, productId, candidateRef, candidateDigest, expectedHead: head, changes: [] };
    expect((await authority.decision({ schemaVersion: 2, action: "approve", productId, candidateRef, candidateDigest, commandKey: `approve:${expectedRevision + 1}`, reason: "Verified transfer facts" }, actor)).outcome).toBe("committed");
    firstCommand ??= publish;
    const result = await authority.publish(publish, actor); expect(result.outcome, JSON.stringify(result)).toBe("committed");
    if (!("receipt" in result)) throw new Error("Missing publication receipt");
    head = result.receipt.head; first ??= head; receipt = result.receipt;
    if (schemaVersion === 4 && expectedRevision === 0) {
      frozen = await seedFrozenTransfer(owner, head);
      (await owner.connect()).release(true);
    }
  }
  return { productId, first: first!, second: head!, receipt, firstCommand: firstCommand!, frozen };
}
it("transfers immutable publication predecessors, exact SKU revisions, decisions and recoverable receipts", async () => {
  const before = await publicationAuthority(source.owner).readbackV2(retainedPublication.first);
  expect(await restore()).toMatchObject({ replayed: false });
  const authority = publicationAuthority(target.owner), actor = (await authority.authorize(undefined))!;
  expect(await authority.readbackV2(retainedPublication.first)).toEqual(before);
  expect(await authority.reads.current(retainedPublication.productId)).toMatchObject({ outcome: "found", head: retainedPublication.second });
  expect(await authority.receipt({ productId: retainedPublication.productId, commandKey: "publish:2" }, actor)).toEqual({ outcome: "found", receipt: retainedPublication.receipt });
  expect((await target.owner.query("SELECT count(*)::int AS count FROM public.catalog_publication_pointer_capabilities")).rows).toEqual([{ count: 0 }]);
  for (const name of ["catalog_publications", "catalog_sku_revisions", "catalog_publication_heads", "catalog_operator_receipts", "catalog_publication_decisions"])
    expect((await journeyCensus(target.owner))[name]).toEqual((await journeyCensus(source.owner))[name]);
});

it("refuses nonempty transient publication capabilities during capture", async () => {
  const row = (await source.owner.query("SELECT product_id,document_revision_id FROM public.catalog_publications LIMIT 1")).rows[0];
  const fingerprint = "a".repeat(64);
  await source.owner.query("INSERT INTO public.catalog_publication_pointer_capabilities(transaction_id,product_id,revision_id,command_fingerprint) VALUES(pg_current_xact_id(),$1,$2,$3)", [row.product_id, row.document_revision_id, fingerprint]);
  try { await expect(captureStoreJourney(source.owner, "catalog-capability-refusal")).rejects.toMatchObject({ code: "unsupported_table" }); }
  finally { await source.owner.query("DELETE FROM public.catalog_publication_pointer_capabilities WHERE product_id=$1 AND revision_id=$2 AND command_fingerprint=$3", [row.product_id, row.document_revision_id, fingerprint]); }
});

it("refuses nonempty transient lifecycle capabilities during capture", async () => {
  const product = retainedPublication.productId;
  await source.owner.query("INSERT INTO public.catalog_lifecycle_write_capabilities(transaction_id,product_id,fingerprint) VALUES(pg_current_xact_id(),$1,$2)", [product,"a".repeat(64)]);
  try { await expect(captureStoreJourney(source.owner,"lifecycle-capability-refusal")).rejects.toMatchObject({ code: "unsupported_table" }); }
  finally { await source.owner.query("DELETE FROM public.catalog_lifecycle_write_capabilities WHERE product_id=$1", [product]); }
});

async function seedFrozenTransfer(owner: Pool, head: CatalogHeadRef) {
  const page = await publicationAuthority(owner).readbackV3(head);
  if (page.outcome !== "page") throw new Error(JSON.stringify(page));
  const sku = page.items[0]!, customer = randomUUID(), subscription = randomUUID();
  const reference = { schemaVersion: 2, skuId: sku.facts.id, skuCode: sku.facts.code, skuRevisionId: sku.reference.revisionId, publicationHead: page.head,
    typeRef: page.product.type, definitionDigest: page.product.definitionDigest, optionDigest: sku.facts.optionDigest, netContent: sku.facts.netContent };
  const acceptance = { schemaVersion: 2, lines: [reference] };
  const now = (await owner.query(`SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`)).rows[0].at;
  await owner.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [customer,`${customer}@example.invalid`]);
  await owner.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,$3)", [subscription,customer,now]);
  const codec = createNativeCatalogRenewalCodecV2(value => catalogAcceptedReferenceV2Schema.parse(value));
  const snapshot = codec.freeze({ subscription_id: subscription, client_id: customer, cadence_days: 28, template_version: 1, scheduled_at: now,
    currency_code: "XXX", stock_source_key: "synthetic", settlement_channel_key: "sandbox", authorization_ref: "synthetic-authorization",
    payer_account_ref: null, unattended_charge_authorized_at: now, next_cycle_number: 1, paid_cycle_count: 1,
    activation_cycle_id: randomUUID(), activation_cycle_paid: true, delivery_admission: "allowed",
    purchase_facts: { templateId: "synthetic-template", shippingAmountMinor: 0, acquisitionRef: null,
      renewalTerms: { version: "native.renewal-terms.v1" } },
    lines: [{ lineOrdinal: 1, sku: sku.facts.code, quantity: 3, unitAmountMinor: 617 }], catalog_acceptance: acceptance,
  }, { subscriptionId: subscription, scheduledAt: now, scheduledInstant: Date.parse(now) });
  const claim = await createPostgresRenewalStore(owner, codec).claimDue({ snapshot, workerId: "synthetic-transfer", now });
  return { customer, subscription, acceptance: JSON.stringify(acceptance), codec, snapshot, claim, now };
}
it.each(["receipt", "preview", "both"] as const)("LC5-D-016 LC5-D-068 LC5-D-069 LC5-A-033 transfer governed facts, nullable bindings and frozen replay: %s", async mode => {
  const held = mode === "both" ? lifecycleSource : await resources.installation(`lifecycle-${mode}-source`);
  const history = mode === "both" ? lifecycleHistory : await seedPublicationHistory(held.owner, 4, held.runtime);
  const sourceAuthority = publicationAuthority(held.owner);
  const page = await sourceAuthority.readbackV3(history.first);
  if (page.outcome !== "page") throw new Error(JSON.stringify(page));
  expect(await sourceAuthority.readbackV2(history.first)).toMatchObject({ outcome: "unsupported", reason: "catalog_lifecycle_reader_required" });
  const sku = page.items[0]!, legacySubscription = randomUUID(), order = randomUUID(), line = randomUUID();
  if (!history.frozen) throw new Error("Missing retained freeze");
  const { customer, subscription, acceptance, codec, snapshot, claim, now } = history.frozen;
  await held.owner.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code,catalog_sku_revision_id) VALUES($1,$2,3,0,617,'XXX',$3)", [subscription,sku.facts.id,sku.reference.revisionId]);
  await held.owner.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,clock_timestamp()+interval '28 days')", [legacySubscription,customer]);
  await held.owner.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,3,0,617,'XXX')", [legacySubscription,sku.facts.id]);
  await held.owner.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref,catalog_acceptance) VALUES($1,'XXX','synthetic','sandbox',clock_timestamp(),'synthetic',$2::jsonb)", [subscription,acceptance]);
  await held.owner.query(`WITH created AS (
    INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',1851) RETURNING id
  ) INSERT INTO public.commerce_order_items(id,order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
    SELECT $3,id,$4,1,3,617,1851 FROM created`, [order,customer,line,sku.facts.id]);
  await held.owner.query("UPDATE public.commerce_orders SET catalog_acceptance=$2::jsonb WHERE id=$1", [order,acceptance]);
  const emptyOrder = randomUUID(), withReceipt = mode !== "preview", withPreview = mode !== "receipt";
  const receiptBody = { orderDraft: { orderId: `order_${emptyOrder}`, quoteSnapshot: { quote: { lines: [{ sku: sku.facts.code, quantity: 1 }] } } } };
  const receiptKey = `retained:${emptyOrder}`;
  let linked: { previewId: string; eventId: string; arguments: unknown[] } | undefined;
  const writer = await held.owner.connect();
  try {
    await writer.query("BEGIN");
    if (withReceipt) {
      await writer.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor,catalog_acceptance) VALUES($1,$2,'XXX',0,$3::jsonb)",
        [emptyOrder,customer,acceptance]);
      await writer.query("INSERT INTO public.commerce_order_draft_receipts(order_id,idempotency_key,request_fingerprint,response_payload) VALUES($1,$2,$3,$4::jsonb)",
        [emptyOrder,receiptKey,"a".repeat(32),JSON.stringify(receiptBody)]);
    } else {
      await writer.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor,metadata,catalog_acceptance) VALUES($1,$2,'XXX',0,$3::jsonb,$4::jsonb)",
        [emptyOrder,customer,JSON.stringify({ orderDraftSnapshot: { lines: [{ sku: sku.facts.code, quantity: 1 }] } }),acceptance]);
    }

    if (withPreview) {
      const priceList = randomUUID(), previewActor = randomUUID(), applyActor = randomUUID();
      const clock = (await writer.query("SELECT statement_timestamp() AS now,statement_timestamp()+interval '1 hour' AS expiry")).rows[0];
      await writer.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Retained transfer prices','AA','XXX')", [priceList]);
      await writer.query("UPDATE public.subscriptions SET currency_code='XXX',price_list_id=$2 WHERE id=$1", [legacySubscription,priceList]);
      await writer.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
        VALUES($1,'XXX','synthetic','sandbox',$2,'synthetic')`, [legacySubscription,clock.now]);
      await writer.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [legacySubscription]);
      await writer.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_minimum_base_units','1') ON CONFLICT(key) DO UPDATE SET value_text='1'");
      const base = [{ variantId: sku.facts.id, qty: 3 }], addons: never[] = [], planDays = 29;
      const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
      const baseLines = [{ ...base[0], quoteLine: { sku: sku.facts.code, quantity: 3, unitPriceGross: money(617), lineSubtotalGross: money(1851) } }];
      const request = { base, addons, planDays }, compositionConstraint = { kind: "plan_days", value: planDays };
      const quote = { baseLines, addonLines: [], compositionConstraint };
      const totals = { currentRecurringPrice: money(1851), newRecurringPrice: money(1851), delta: money(0) };
      const hash = createHash("sha256").update(`transfer:${legacySubscription}`).digest("hex");
      const preview = (await writer.query("SELECT public.subscription_quote_preview_record($1,$2,$3,'update_package_template',$4,1,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9) AS result",
        [previewActor,customer,legacySubscription,hash,clock.expiry,JSON.stringify(request),JSON.stringify(quote),JSON.stringify(totals),clock.now])).rows[0].result;
      const command = { ...request, acceptedQuoteHash: hash, expectedTemplateVersion: 1 };
      const args = [applyActor,customer,`transfer:${legacySubscription}`,legacySubscription,JSON.stringify({ ...command, request: command, ...quote, ...totals }),clock.now];
      const applied = (await writer.query("SELECT public.subscription_package_edit_apply($1,$2,$3,$4,$5::jsonb,$6) AS result", args)).rows[0].result;
      expect(applied).toMatchObject({ status: "applied", templateVersion: 2 });
      await writer.query("UPDATE public.subscription_events SET catalog_acceptance=$2::jsonb WHERE id=$1", [applied.eventId,acceptance]);
      linked = { previewId: preview.id, eventId: applied.eventId, arguments: args };
    }
    await writer.query("COMMIT");
  } catch (error) {
    await writer.query("ROLLBACK");
    throw error;
  } finally { writer.release(true); }

  if (withReceipt) {
    expect((await held.owner.query(`SELECT o.metadata,r.response_payload,
      EXISTS(SELECT 1 FROM public.commerce_order_items i WHERE i.order_id=o.id) AS has_items
      FROM public.commerce_orders o JOIN public.commerce_order_draft_receipts r ON r.order_id=o.id WHERE o.id=$1`, [emptyOrder])).rows)
      .toEqual([{ metadata: {}, response_payload: receiptBody, has_items: false }]);
  }
  if (linked) {
    expect((await held.owner.query("SELECT accepted_event_id FROM public.subscription_quote_previews WHERE id=$1", [linked.previewId])).rows)
      .toEqual([{ accepted_event_id: linked.eventId }]);
  }
  const captured = await captureStoreJourney(held.owner,`lifecycle-${mode}-source`), before = await journeyCensus(held.owner);
  const pristine = await journeyCensus(target.owner);
  for (const companion of [withReceipt ? "commerce_order_draft_receipts" : null, linked ? "subscription_quote_previews" : null]) {
    if (!companion) continue;
    const corrupted = structuredClone(captured);
    const table = corrupted.owned.find(value => value.table === companion)!;
    expect(table.rows).toHaveLength(1);
    table.rows = [];
    const { sha256: _old, ...body } = corrupted;
    corrupted.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    let refusal: unknown;
    await expect(restore(observedOwner(async () => undefined, (sql,error) => {
      if (sql === "SET CONSTRAINTS ALL IMMEDIATE") refusal = error;
    }),corrupted)).rejects.toMatchObject({ code: "target_conflict" });
    expect(refusal).toMatchObject({ code: "22023", message: "catalog_acceptance_line_mismatch" });
    expect(await journeyCensus(target.owner)).toEqual(pristine);
  }
  expect(await restore(target.owner,captured)).toMatchObject({ replayed: false });
  expect(await journeyCensus(target.owner)).toEqual(before);
  expect((await target.owner.query("SELECT catalog_acceptance FROM public.commerce_orders WHERE id=$1", [emptyOrder])).rows).toEqual([{ catalog_acceptance: JSON.parse(acceptance) }]);
  expect(await publicationAuthority(target.owner).readbackV3(history.first)).toEqual(page);
  expect(await publicationAuthority(target.owner).readbackV3(history.second)).toMatchObject({ outcome: "page", head: history.second });
  const reader = publicationAuthority(target.owner, true), scope = reader.authorizeReadScope(undefined);
  const binding = { kind: "order" as const, sourceId: order, lineId: line, productId: history.productId,
    skuId: sku.facts.id, skuRevisionId: sku.reference.revisionId, publicationId: history.first.publicationId,
    documentRevisionId: page.product.document!.id };
  expect(await reader.resolveRetained(binding,scope)).toEqual({
    outcome: "found", head: history.first, product: page.product, sku: sku.facts, reference: sku.reference,
  });
  const renewed = createPostgresRenewalStore(target.owner, codec);
  expect(await renewed.claimDue({ snapshot, workerId: "synthetic-transfer", now })).toMatchObject({ operationId: claim.operationId, replayed: true });
  expect((await target.owner.query("SELECT cycle_snapshot FROM public.subscription_renewal_operations WHERE id=$1", [claim.operationId])).rows)
    .toEqual([{ cycle_snapshot: codec.encode(snapshot) }]);
  expect((await target.owner.query("SELECT catalog_sku_revision_id FROM public.subscription_lines WHERE subscription_id=$1", [subscription])).rows).toEqual([{ catalog_sku_revision_id: sku.reference.revisionId }]);
  expect((await target.owner.query("SELECT catalog_sku_revision_id FROM public.subscription_lines WHERE subscription_id=$1", [legacySubscription])).rows).toEqual([{ catalog_sku_revision_id: null }]);
  (await target.owner.connect()).release(true);
  if (linked) {
    const replay = (await target.owner.query("SELECT public.subscription_package_edit_apply($1,$2,$3,$4,$5::jsonb,$6) AS result", linked.arguments)).rows[0].result;
    expect(replay).toMatchObject({ status: "replayed", originalStatus: "applied", eventId: linked.eventId });
  }
  if (withReceipt) expect((await target.owner.query("SELECT response_payload FROM public.commerce_order_draft_receipts WHERE idempotency_key=$1", [receiptKey])).rows)
    .toEqual([{ response_payload: receiptBody }]);
  const reconnected = publicationAuthority(target.owner), actor = (await reconnected.authorize(undefined))!;
  expect(await reconnected.publish(history.firstCommand,actor)).toMatchObject({ outcome: "replayed" });
  expect(await journeyCensus(target.owner)).toEqual(before);
  expect(await restore(target.owner,captured)).toMatchObject({ replayed: true });
  expect(await journeyCensus(target.owner)).toEqual(before);


  if (mode !== "both") return;

  // This fixture has two valid immutable revision records with the same code.
  // The malformed history must stay unusable through every retained reader.
  const duplicateSku = randomUUID(), revision = randomUUID(), publication = randomUUID();
  const historyRow = (await target.owner.query("SELECT * FROM public.catalog_publications WHERE id=$1", [history.second.publicationId])).rows[0];
  const retained = JSON.parse(historyRow.canonical_state);
  const duplicate = canonicalCatalogDraftJson({ ...sku.facts, id: duplicateSku });
  const digest = createHash("sha256").update(duplicate).digest("hex");
  retained.skus.push({ skuId: duplicateSku, revisionId: revision, revision: 1, digest });
  retained.skus.sort((a: { skuId: string }, b: { skuId: string }) => a.skuId < b.skuId ? -1 : 1);
  const canonical = canonicalCatalogDraftJson(retained);
  await target.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$2,$3,'Duplicate witness')", [duplicateSku,history.productId,`SECOND-${duplicateSku}`]);
  const legacy = await target.owner.connect();
  try {
    await legacy.query("BEGIN");
    await legacy.query("ALTER TABLE public.catalog_publications DISABLE TRIGGER catalog_publications_roster_final");
    await legacy.query(`INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id)
    SELECT $1,product_id,revision+1,id,draft_id,draft_revision,'test:roster:candidate',candidate_digest,document_revision_id,$2,$3,actor_id
    FROM public.catalog_publications WHERE id=$4`, [publication,canonical,createHash("sha256").update(canonical).digest("hex"),historyRow.id]);
    await legacy.query("INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest) VALUES($1,$2,$3,1,$4,$5,$6)",
    [revision,duplicateSku,history.productId,publication,duplicate,digest]);
    await legacy.query("ALTER TABLE public.catalog_publications ENABLE TRIGGER catalog_publications_roster_final");
    await legacy.query("COMMIT");
  } catch (error) {
    await legacy.query("ROLLBACK");
    throw error;
  } finally { legacy.release(); }
  const malformed = { ...history.second, publicationId: publication, revision: history.second.revision+1 };
  await expect(target.owner.query("UPDATE public.catalog_publication_heads SET publication_id=$2,revision=$3 WHERE product_id=$1", [history.productId,publication,malformed.revision]))
    .rejects.toMatchObject({ code: "23514", message: "catalog_publication_sku_revision_invalid" });
  const refusal = { outcome: "dependency_unavailable", reason: "catalog_publication_sku_revision_invalid" };
  expect(await reader.readbackV3(malformed)).toEqual(refusal);
  expect(await reader.resolveRetained({ kind: "order", sourceId: order, lineId: randomUUID(), productId: history.productId,
    skuId: duplicateSku, skuRevisionId: revision, publicationId: publication, documentRevisionId: historyRow.document_revision_id }, reader.authorizeReadScope(undefined)))
    .toEqual(refusal);
  const accepted = JSON.parse(acceptance).lines[0];
  await expect(target.owner.query("SELECT public.catalog_accepted_reference_assert_v2($1::jsonb)", [
    JSON.stringify({ ...accepted, publicationHead: malformed }),
  ])).rejects.toMatchObject({ code: "22023", message: "catalog_accepted_reference_mismatch" });
});
