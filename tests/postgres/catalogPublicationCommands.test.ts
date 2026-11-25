import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresCatalogDraftStoreV4,
  createPostgresCatalogPublicationCommands, createPostgresCommerceQuoteCatalogReadPort, createCatalogProductTypeRegistry, withCatalogPublicationRules,
  buildCatalogReleaseDraftV3, catalogDefinitionDigest, catalogInternalGtin, catalogVariantOptions, readPostgresCatalogMembershipPage,
  type CatalogProductInput, type CatalogDraftPayloadV4, type CatalogPublicationCommand, type CatalogPublicationManifestV2 } from "@openlup/platform/catalog";
import { canonicalCatalogDraftJson, type CatalogDraftPayloadV3, type CatalogHeadRef, type CatalogPublishCommand } from "@openlup/platform/catalog/contracts";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { publicationWireVectors, withCatalogAdmissionFence } from "@openlup/platform/catalog/testing";
import type { CatalogPublishedSku } from "@openlup/platform/catalog";
import * as pricing from "@openlup/platform/pricing";
import { createPostgresCommercePriceAuthorityReadPort } from "@openlup/platform/commerce/server/postgres";
import { createPostgresCatalogPublicationReads } from "../../server/adapters/postgres/catalogPublicationReads.js";
import { authoredPublicationDocument, createCharacterizationQuote, hash, transaction, malformedPublicationPackets, sealedPublicationRemedy } from "./catalogPublicationFixture.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  type PostgresContainer } from "../helpers/postgresContainer.js";

let pool: Pool, quotePool: Pool, authorPool: Pool, legacyPool: Pool, upgradePool: Pool, container: PostgresContainer;
const actor = randomUUID(), otherActor = randomUUID();
const writerForwards = (file: string) => /_catalog_price_(list_basis_select|writer_v2)\.sql$/u.test(file);
const candidateWriterMigrations: string[] = [];
async function installWriterForwards(db: Pool) {
  expect(candidateWriterMigrations).toHaveLength(2);
  for (const file of candidateWriterMigrations) await db.query(readFileSync(file, "utf8"));
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}
const artifact = Buffer.from(`
  const wire = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : 1)));
  module.exports = {
    validateContent: () => [],
    validateProduct: () => [],
    identifyDocument: ({ schemaVersion, id, schemaId, documentRef, productSlug, revisionNo, name }) =>
      ({ schemaId: schemaId ?? ("example:document.v" + schemaVersion), documentRef: documentRef ?? id, productSlug, revisionNo, name }),
    inspectDocument(text) { return { ...this.identifyDocument(JSON.parse(text)), canonicallyEncoded: wire(JSON.parse(text)) === text }; },
    matchesDocument: (document, text) => wire(document) === text,
    deriveSkuFacts: () => ({ derived: 12 }),
    classifySkuChange: () => "compatible",
  };
`);
const registry = createCatalogProductTypeRegistry(withCatalogPublicationRules({ id: "example:rules", namespace: "example",
  version: 1, openlupRange: "1.x", capabilities: {}, taxClasses: [], types: [{
    key: "example:article", version: 1,
    units: [{ code: "openlup:g", dimension: "mass", integral: false }],
    netContentUnits: ["openlup:g"],
    dimensions: [{ key: "finish", kind: "choice", values: ["matte", "gloss"] }],
    axes: [{ key: "finish", attributeKey: "finish" }],
    attributes: [{ key: "finish", scope: "variant", valueType: { kind: "enum", values: [{ id: "matte" }, { id: "gloss" }] },
      required: false, cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} }],
  }, {
    key: "example:volume-item", version: 1,
    units: [{ code: "openlup:g", dimension: "mass", integral: false },
      { code: "example:ml", dimension: "volume", integral: false, factor: { canonicalUnit: "openlup:ml", unscaled: "1", scale: 0 } }],
    netContentUnits: ["openlup:g"],
    ...catalogVariantOptions([{ key: "volume", kind: "quantity", dimension: "volume", units: ["example:ml"], labels: {} }]),
  }] },
() => artifact).types);
const installed = registry.resolve({ key: "example:article", version: 1 })!;
const volumeType = registry.resolve({ key: "example:volume-item", version: 1 })!;
beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-publication-commands-${process.pid}`, password: randomUUID() });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Command proof needs PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString });
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as
    { baseline: { file: string }; forward: { file: string }[] };
  for (const unit of [manifest.baseline, ...manifest.forward]) {
    if (writerForwards(unit.file)) candidateWriterMigrations.push(unit.file);
    else await pool.query(readFileSync(unit.file, "utf8"));
  }
  for (const [index, id] of [actor, otherActor].entries()) {
    await pool.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [id, `operator-${index}@example.invalid`]);
    await pool.query(`INSERT INTO public.platform_human_memberships
      (principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())`, [id]);
  }
  for (const definition of [installed, volumeType]) {
    await pool.query(`INSERT INTO public.catalog_type_versions(type_key,version,definition,definition_digest,validator_ref)
      VALUES($1,1,'{}',$2,$3)`, [definition.key, catalogDefinitionDigest(definition), definition.validatorRef]);
  }
  await pool.query(`INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ'),('settlement_currency','XXX')
    ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`);
  await pool.query("SELECT public.commerce_capture_offer_policy_v2_legacy_baseline()");
  await pool.query("CREATE DATABASE catalog_publication_upgrade TEMPLATE postgres");
  upgradePool = new Pool({ connectionString: container.connectionStringFor("catalog_publication_upgrade") });
  await installWriterForwards(pool);
  // Clone the installation before the command tests introduce other catalogue data.
  await pool.query("CREATE DATABASE catalog_publication_quote TEMPLATE postgres");
  quotePool = new Pool({ connectionString: container.connectionStringFor("catalog_publication_quote") });
  // Membership discovery certifies all publication heads in its database.
  await pool.query("CREATE DATABASE catalog_publication_author TEMPLATE postgres");
  authorPool = new Pool({ connectionString: container.connectionStringFor("catalog_publication_author") });
  await pool.query("CREATE DATABASE catalog_publication_legacy TEMPLATE postgres");
  legacyPool = new Pool({ connectionString: container.connectionStringFor("catalog_publication_legacy") });
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, [pool, quotePool, authorPool, legacyPool, upgradePool]), postgresTeardownTimeoutMs);

function native(query?: (db: PgQueryExecutor, sql: string, args?: unknown[]) => ReturnType<PgQueryExecutor["query"]>, connection = pool) {
  let allowed = true;
  const api = createPostgresCatalogPublicationCommands({
    authorizeHuman: async (userId: string) => ({ ok: true, userId, role: "admin", isMachineActor: false }),
    catalogPublicationOwner: { run: work => transaction(connection, async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      return work({ query: (sql, args) => query ? query(db, sql, args) : db.query(sql, args) });
    }) },
    registry: { resolve(type) {
      if (!allowed) throw new Error("Rules were read on replay");
      return registry.resolve(type);
    } },
  });
  return { ...api, disableRules() { allowed = false; } };
}
type DraftIdentifier = NonNullable<CatalogDraftPayloadV3["skus"][number]["identifiers"]>[number];

function authored(sequence: number, internalIdentifier?: DraftIdentifier) {
  const productId = randomUUID(), draftId = randomUUID(), skuId = randomUUID(), documentId = randomUUID();
  const slug = `article-${sequence}`, code = `ARTICLE-${sequence}`;
  const barcodePrefix = String(590123412340 + sequence);
  const checksum = [...barcodePrefix].reduce((sum, digit, i) => sum + Number(digit) * (i % 2 === 0 ? 1 : 3), 0);
  const barcode = barcodePrefix + String((10 - checksum % 10) % 10);
  const document = authoredPublicationDocument(slug);
  const canonicalText = canonicalCatalogDraftJson(document), digest = hash(canonicalText);
  const ref = { id: documentId, productId, revisionNo: 1, schemaId: "example:document.v1",
    sourceRef: "example:source", documentRef: document.id, digest };
  const facts = { skuCode: code, title: "Example article", minQuantity: 1, isAddon: false, facts: { derived: 12 } };
  const identifier = internalIdentifier ?? { scheme: "gs1:gtin", issuer: "example", value: barcode, packagingLevel: "unit" as const };
  const payload: CatalogDraftPayloadV3 = { schemaVersion: 3, product: { id: productId, type: { key: installed.key, version: 1 },
    dimensions: ["finish"], slug, primarySkuId: skuId, documentRevision: ref,
    sharedContent: { schemaVersion: 1, catalogAction: "create", document, presentation: {}, publicationSkus: [facts],
      requestedModes: [{ skuCode: code, modes: [] }], offerMemberships: [] } },
    skus: [{ id: skuId, productId, code, options: { finish: { kind: "choice", value: "matte" } }, identifiers: [identifier],
      netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 } }],
    publication: { kind: "release", evidence: {}, operations: [
      { op: "create_product", productId, productSlug: slug, name: document.name },
      { op: "register_document_revision", productSlug: slug, revisionId: documentId, revisionNo: 1,
        documentRef: ref.documentRef, sourceRef: ref.sourceRef, canonicalText, digest, provenance: { source: "current_draft" } },
      { op: "move_document_pointer", productSlug: slug, documentRevisionNo: 1 },
      { op: "create_sku", productSlug: slug, documentRevisionNo: 1, skuId, ...facts },
      { op: "create_identifier", skuCode: code, ...identifier, quantity: 1, isPrimary: true, label: null, sourceRef: null },
      { op: "set_primary_sku", productSlug: slug, skuCode: code },
      { op: "set_product_presentation", productSlug: slug, presentation: {} },
    ] },
  };
  return { productId, draftId, skuId, slug, code, barcode, payload };
}
async function save(data: Pick<ReturnType<typeof authored>, "draftId" | "payload">, revision: number,
  payload: CatalogDraftPayloadV3 | CatalogDraftPayloadV4 = data.payload, db = pool) {
  const canonicalCommand = canonicalCatalogDraftJson({ schemaVersion: payload.schemaVersion, action: revision === 1 ? "create" : "revise",
    draftId: data.draftId, commandKey: randomUUID(), expectedRevision: revision - 1, payload });
  const saved = await createPostgresCatalogDraftStoreV4(db).apply({ canonicalCommand, fingerprint: hash(canonicalCommand), actorId: actor });
  if (!("record" in saved)) throw new Error(`Draft save failed: ${JSON.stringify(saved)}`);
  return saved.record;
}
async function prepare(data: { productId: string; draftId: string }, draftRevision: number, expectedHead: CatalogHeadRef | null, db = pool) {
  const { productId, draftId } = data;
  const api = native(undefined, db);
  const candidate = await api.prepareCandidate({ draftId, draftRevision, expectedHead }, (await api.authorize(actor))!);
  if (!("candidateRef" in candidate)) throw new Error(JSON.stringify(candidate));
  const postStateDigest = candidate.preparation?.postStateDigest;
  if (!postStateDigest) throw new Error(`No structural seal: ${JSON.stringify(candidate.preparation)}`);
  const common = { productId, candidateRef: candidate.candidateRef, candidateDigest: candidate.candidateDigest };
  return {
    approve: { ...common, action: "approve", reason: null, commandKey: randomUUID(), postStateDigest } as const,
    revoke: { ...common, action: "revoke", reason: null, commandKey: randomUUID() } as const,
    publish: { ...common, action: "publish", expectedHead, changes: [], commandKey: randomUUID() } as const,
  } satisfies Record<string, CatalogPublicationCommand>;
}

it("commits the sealed plan, refuses revocation after issuance and replays without fresh reads or effects", async () => {
  const data = authored(1);
  await save(data, 1);
  const command = await prepare(data, 1, null);
  const queries: string[] = [];
  const api = native((db, sql, args) => { queries.push(sql); return db.query(sql, args); });
  const who = (await api.authorize(actor))!, other = (await api.authorize(otherActor))!;
  expect(await api.execute(command.revoke, who)).toMatchObject({ outcome: "conflict", reason: "publication_approval_missing" });
  expect(await api.execute({ ...command.approve, postStateDigest: "0".repeat(64) }, who))
    .toMatchObject({ outcome: "conflict", reason: "publication_post_state_changed" });
  const approval = await api.execute(command.approve, who);
  expect(approval).toMatchObject({ outcome: "committed", receipt: { postStateDigest: command.approve.postStateDigest,
    decidedAt: /[.][0-9]{6}Z$/u } });
  const first = await api.execute(command.publish, who);
  expect(first).toMatchObject({ outcome: "committed", receipt: { head: { revision: 1 }, changes: [{ variantId: data.skuId }] } });
  expect(await api.execute(command.revoke, who)).toEqual({ outcome: "conflict", reason: "publication_candidate_already_issued",
    message: "This candidate is already issued; revoking it has no effect. No action is needed." });
  expect(await api.execute(command.publish, other)).toMatchObject({ outcome: "unauthorized" });
  expect(await api.execute({ ...command.revoke, commandKey: command.approve.commandKey }, who))
    .toMatchObject({ outcome: "conflict", reason: "publication_command_key_reused" });
  api.disableRules();
  queries.length = 0;
  expect(await api.execute(command.approve, who)).toEqual({ ...approval, outcome: "replayed" });
  expect(await api.execute(command.publish, who)).toEqual({ ...first, outcome: "replayed" });
  expect(queries.join("\n")).not.toMatch(/catalog_draft_heads|catalog_type_versions|catalog_price_setup_(claim|apply)|\b(INSERT|UPDATE|LOCK TABLE)\b/u);
  expect((await pool.query(`SELECT event_type FROM public.outbox_events WHERE aggregate_id=$1`, [data.productId])).rows)
    .toEqual([{ event_type: "catalog.publication.committed" }]);
});

it("keeps the issued publication receipt byte-identical after installing the price writer", async () => {
  const data = authored(199);
  await save(data, 1, data.payload, upgradePool);
  const command = await prepare(data, 1, null, upgradePool);
  const api = native(undefined, upgradePool), who = (await api.authorize(actor))!;
  expect(await api.execute(command.approve, who)).toMatchObject({ outcome: "committed" });
  expect(await api.execute(command.publish, who)).toMatchObject({ outcome: "committed" });
  const receipts = async () => (await upgradePool.query(`SELECT result FROM public.catalog_operator_receipts
    WHERE scope_id=$1 AND command_key=$2`, [data.productId, command.publish.commandKey])).rows.map(row => Buffer.from(row.result, "utf8"));
  const original = await receipts();
  expect(original).toHaveLength(1);
  await installWriterForwards(upgradePool);
  await upgradePool.query("UPDATE public.catalog_skus SET title='Live drift' WHERE id=$1", [data.skuId]);
  api.disableRules();
  expect(await api.execute(command.publish, who)).toMatchObject({ outcome: "replayed" });
  expect(await receipts()).toEqual(original);
  expect((await upgradePool.query("SELECT count(*)::int AS effects FROM public.outbox_events WHERE aggregate_id=$1",
    [data.productId])).rows).toEqual([{ effects: 1 }]);
});

it.each([1, 2147483647])("characterizes Prepare, Approve and Publish of factorless %i grams", async grams => {
  const data = authored(180 + Number(grams === 1));
  data.payload.skus[0]!.netContent!.unscaled = String(grams);
  await save(data, 1);
  const command = await prepare(data, 1, null);
  const api = native(), who = (await api.authorize(actor))!;
  expect(await api.execute(command.approve, who)).toMatchObject({ outcome: "committed" });
  expect(await api.execute(command.publish, who)).toMatchObject({ outcome: "committed" });
  expect((await pool.query(`SELECT net_weight_g, net_content_unscaled::text, net_content_scale, net_content_unit
    FROM public.catalog_skus WHERE id=$1`, [data.skuId])).rows).toEqual([{
    net_weight_g: grams, net_content_unscaled: String(grams), net_content_scale: 0, net_content_unit: "openlup:g",
  }]);
});

it("lets a new compensation issue equal business facts while retaining unchanged SKU revisions", async () => {
  const data = authored(2);
  const secondary = { scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "unit" as const };
  data.payload.skus[0]!.identifiers!.push(secondary);
  data.payload.publication.operations.splice(5, 0, { op: "create_identifier", skuCode: data.code,
    ...secondary, quantity: 1, isPrimary: false, label: null, sourceRef: null });
  await save(data, 1);
  const original = await prepare(data, 1, null);
  const api = native(), who = (await api.authorize(actor))!;
  expect(await api.execute(original.approve, who)).toMatchObject({ outcome: "committed" });
  const issue = await api.execute(original.publish, who);
  if (!("receipt" in issue) || !("head" in issue.receipt)) throw new Error(JSON.stringify(issue));
  const repaired = structuredClone(data.payload);
  repaired.product.sharedContent.catalogAction = "revise";
  repaired.publication = { kind: "compensation", evidence: {},
    operations: [{ op: "set_product_presentation", productSlug: data.slug, presentation: {} }] };
  await save(data, 2, repaired);
  await pool.query("UPDATE public.catalog_products SET name='Unpublished drift' WHERE id=$1", [data.productId]);
  const gtins = [data.barcode, secondary.value].map(value => value.padStart(14, "0"));
  await transaction(pool, async db => {
    await db.query("UPDATE public.catalog_sku_identifiers SET is_primary=false WHERE catalog_sku_id=$1", [data.skuId]);
    await db.query("UPDATE public.catalog_sku_identifiers SET is_primary=true WHERE catalog_sku_id=$1 AND normalized_value=$2", [data.skuId, gtins[1]]);
  });
  const commands = await prepare(data, 2, issue.receipt.head);
  expect(await api.execute(commands.approve, who)).toMatchObject({ outcome: "committed" });
  expect(await api.execute(commands.publish, who)).toMatchObject({ outcome: "committed",
    receipt: { head: { revision: 2 }, previousHead: issue.receipt.head, changes: [] } });
  expect((await pool.query(`SELECT revision,issued_count FROM public.catalog_publications WHERE product_id=$1 ORDER BY revision`,
    [data.productId])).rows).toEqual([{ revision: 1, issued_count: 1 }, { revision: 2, issued_count: 0 }]);
  expect((await pool.query("SELECT normalized_value FROM public.catalog_sku_identifiers WHERE catalog_sku_id=$1 AND is_primary",
    [data.skuId])).rows).toEqual([{ normalized_value: gtins[0] }]);
  expect(await api.execute(original.publish, who)).toEqual({ ...issue, outcome: "replayed" });
});

it.each([[13, "matching"], [14, "cleared"]] as const)(
  "a fresh publish compares live code with the sealed SKU (%s: %s cache)", async (sequence, cache) => {
    const data = authored(sequence), api = native(), who = (await api.authorize(actor))!;
    await save(data, 1);
    const initial = await prepare(data, 1, null);
    expect(await api.execute(initial.approve, who)).toMatchObject({ outcome: "committed" });
    const issued = await api.execute(initial.publish, who);
    if (!("receipt" in issued) || !("head" in issued.receipt)) throw new Error(JSON.stringify(issued));
    const payload = structuredClone(data.payload);
    payload.product.sharedContent.catalogAction = "revise";
    payload.product.sharedContent.presentation = { routePath: { en: `/new-${sequence}` } };
    payload.publication.operations = [{ op: "set_product_presentation", productSlug: data.slug,
      presentation: payload.product.sharedContent.presentation }];
    await save(data, 2, payload);
    const next = await prepare(data, 2, issued.receipt.head);
    expect(await api.execute(next.approve, who)).toMatchObject({ outcome: "committed" });
    await pool.query(`UPDATE public.catalog_skus SET sku=$2, publication_facts=CASE WHEN $3::boolean
      THEN jsonb_set(publication_facts,'{code}',to_jsonb($2::text)) END WHERE id=$1`,
    [data.skuId, `RENAMED-${sequence}`, cache === "matching"]);
    expect(await api.execute(next.publish, who)).toMatchObject({ outcome: "conflict", reason: "publication_sku_identity_changed",
      message: "A SKU code differs from its published identity. Restore the saved code or prepare a new SKU." });
  });

it("refuses a malformed stored roster before a decision or publication uses it", async () => {
  const data = authored(20), api = native(), who = (await api.authorize(actor))!;
  await save(data, 1);
  const initial = await prepare(data, 1, null);
  expect(await api.execute(initial.approve, who)).toMatchObject({ outcome: "committed" });
  const issued = await api.execute(initial.publish, who);
  if (!("receipt" in issued) || !("head" in issued.receipt)) throw new Error(JSON.stringify(issued));
  const { head } = issued.receipt;
  const payload = structuredClone(data.payload);
  const presentation = { routePath: { en: "/new-20" } };
  payload.product.sharedContent.catalogAction = "revise";
  payload.product.sharedContent.presentation = presentation;
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: data.slug, presentation }];
  await save(data, 2, payload);
  const next = await prepare(data, 2, head);
  const { rows: [row] } = await pool.query("SELECT canonical_state FROM public.catalog_publications WHERE id=$1", [head.publicationId]);
  const manifest = JSON.parse(row!.canonical_state) as CatalogPublicationManifestV2;
  const store = (value: string, digest = hash(value)) => transaction(pool, async db => {
    await db.query("ALTER TABLE public.catalog_publications DISABLE TRIGGER catalog_publications_issued");
    await db.query("UPDATE public.catalog_publications SET canonical_state=$2,digest=$3 WHERE id=$1",
      [head.publicationId, value, digest]);
    await db.query("ALTER TABLE public.catalog_publications ENABLE TRIGGER catalog_publications_issued");
  });
  const readers = createPostgresCatalogPublicationReads({
    transactions: { run: work => transaction(pool, work) },
    authorizeHuman: async () => ({ ok: false }),
    acceptedSource: async (_db, _context, binding) => binding,
  });
  const binding = { kind: "order" as const, sourceId: randomUUID(), lineId: randomUUID(), productId: data.productId,
    skuId: data.skuId, skuRevisionId: manifest.skus[0]!.revisionId, publicationId: head.publicationId,
    documentRevisionId: manifest.product.document!.id };
  const cases = malformedPublicationPackets(row!.canonical_state);
  const refusal = (path: string) => ({ outcome: "validation_issue", reason: "publication_details_invalid", path, message: sealedPublicationRemedy });
  try {
    for (const { text, path, digest } of cases) {
      await store(text, digest);
      expect(await api.execute(next.approve, who)).toMatchObject(refusal(path));
      const preview = await api.prepareCandidate({ draftId: data.draftId, draftRevision: 2, expectedHead: head }, who);
      expect(preview).toMatchObject({ preparation: { structural: { outcome: "blocked-input",
        issues: [{ code: "catalog_publication_manifest_invalid", path, message: sealedPublicationRemedy }] } } });
      expect(preview).not.toHaveProperty("preparation.postStateDigest");
      expect(await readers.readbackV2(head)).toMatchObject(refusal(path));
      expect(await readers.reads.readback(head)).toEqual({
        ...refusal(path), outcome: "dependency_unavailable", reason: "publication_authority_unavailable",
      });
      expect(await readers.resolveRetained(binding, readers.authorizeReadScope("owner"))).toMatchObject(refusal(path));
    }
    await store(row!.canonical_state);
    expect(await api.execute(next.approve, who)).toMatchObject({ outcome: "committed" });
    for (const { text, path, digest } of cases) {
      await store(text, digest);
      expect(await api.execute(next.revoke, who)).toMatchObject(refusal(path));
      expect(await api.execute(next.publish, who)).toMatchObject(refusal(path));
    }
  } finally { await store(row!.canonical_state); }
});

it("resamples legacy GTINs committed between the first read and the catalogue fence", async () => {
  const data = authored(3);
  await save(data, 1);
  const commands = await prepare(data, 1, null);
  const api = native(), who = (await api.authorize(actor))!;
  expect(await api.execute(commands.approve, who)).toMatchObject({ outcome: "committed" });
  let crossed = false;
  const publisher = native(async (db, sql, args) => {
    if (sql.startsWith("LOCK TABLE")) {
      crossed = true;
      // The host defaults to repeatable read. The runner chooses READ COMMITTED
      // before authenticating and then observes the other's committed legacy row.
      await transaction(pool, async other => {
        const id = randomUUID();
        await other.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'legacy-gtin','Legacy article')", [id]);
        await other.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,sellable_standalone) VALUES($1,$1,'LEGACY','Legacy article','draft',false)", [id]);
        await other.query(`INSERT INTO public.catalog_sku_identifiers
          (catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity)
          VALUES($1,'legacy','gtin',$2,'unit',1)`, [id, data.barcode]);
      });
    }
    return db.query(sql, args);
  });
  const publisherCapability = (await publisher.authorize(actor))!;
  expect(await publisher.execute(commands.publish, publisherCapability)).toMatchObject({ outcome: "conflict", reason: "publication_gtin_conflict" });
  expect(crossed).toBe(true);
  expect((await pool.query("SELECT id FROM public.catalog_products WHERE id=$1", [data.productId])).rows).toEqual([]);
});

it("duplicate_internal_sequence_refuses_gtin_conflict", async () => {
  const identifier = { scheme: "gs1:gtin", issuer: "example:internal", value: catalogInternalGtin(200), packagingLevel: "unit" } as const;
  const first = authored(200, identifier);
  const second = authored(201, { ...identifier, issuer: "another:internal" });
  const api = native(), who = (await api.authorize(actor))!;
  await save(first, 1);
  const initial = await prepare(first, 1, null);
  expect(await api.execute(initial.approve, who)).toMatchObject({ outcome: "committed" });
  expect(await api.execute(initial.publish, who)).toMatchObject({ outcome: "committed" });
  await save(second, 1);
  const duplicate = await prepare(second, 1, null);
  expect(await api.execute(duplicate.approve, who)).toMatchObject({ outcome: "committed" });
  expect(await api.execute(duplicate.publish, who)).toMatchObject({
    outcome: "conflict", reason: "publication_gtin_conflict",
    message: "This GTIN is already assigned. Verify the barcode and prepare the draft again.",
  });

  const replacement = catalogInternalGtin(201);
  second.payload.skus[0]!.identifiers![0]!.value = replacement;
  second.payload.publication.operations.find(operation => operation.op === "create_identifier")!.value = replacement;
  await save(second, 2);
  const retry = await prepare(second, 2, null);
  expect(await api.execute(retry.approve, who)).toMatchObject({ outcome: "committed" });
  expect(await api.execute(retry.publish, who)).toMatchObject({ outcome: "committed" });
});

it("waits for the draft-head write conflict before taking a decision timestamp", async () => {
  const data = authored(4);
  await save(data, 1);
  const commands = await prepare(data, 1, null);
  const blocker = await pool.connect();
  const started = latch();
  let settled = false;
  const api = native((db, sql, args) => {
    const result = db.query(sql, args);
    if (sql.includes("ORDER BY draft_id FOR NO KEY UPDATE")) started.resolve();
    return result;
  });
  const who = (await api.authorize(actor))!;
  await blocker.query("BEGIN");
  try {
    await blocker.query("UPDATE public.catalog_draft_heads SET revision=revision WHERE draft_id=$1", [data.draftId]);
    const decision = api.execute(commands.approve, who).finally(() => { settled = true; });
    await started.promise;
    const stamp = (await blocker.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time`)).rows[0].time;
    expect(settled).toBe(false);
    await blocker.query("COMMIT");
    const result = await decision;
    if (!("receipt" in result) || !("decidedAt" in result.receipt)) throw new Error(JSON.stringify(result));
    expect(result.receipt.decidedAt > stamp).toBe(true);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});

it("keeps issuer helpers owner-only while preserving the released price wrapper grant", async () => {
  const { rows } = await pool.query(`SELECT role, signature, has_function_privilege(role,signature,'EXECUTE') AS allowed
    FROM unnest(ARRAY['anon','authenticated']) AS roles(role) CROSS JOIN unnest(ARRAY[
      'public.catalog_publication_record_command(jsonb)','public.catalog_price_setup_claim(text,text)',
      'public.catalog_price_setup_lock_context(uuid,uuid)','public.catalog_price_setup_apply_claimed(jsonb,timestamptz)',
      'public.catalog_price_setup_apply(text,text)']) AS functions(signature)`);
  expect(rows.filter(row => row.allowed)).toEqual([{ role: "authenticated", signature: "public.catalog_price_setup_apply(text,text)", allowed: true }]);
});

it("seals the new issue's receipt on a SKU physically authored in a retained draft revision", async () => {
  const data = authored(5);
  const genesis = structuredClone(data.payload);
  const retainedId = randomUUID(), retainedCode = "RETAINED-5";
  const base = structuredClone(genesis.skus[0]!);
  genesis.skus = [{ ...base, id: retainedId, code: retainedCode, options: { finish: { kind: "choice", value: "gloss" } }, identifiers: [] }];
  genesis.product.primarySkuId = retainedId;
  const retainedFacts = { skuCode: retainedCode, title: "Retained choice", minQuantity: 1, isAddon: false, facts: { derived: 12 } };
  genesis.product.sharedContent.publicationSkus = [retainedFacts];
  genesis.product.sharedContent.requestedModes = [];
  genesis.publication.operations = [];
  const original = await save(data, 1, genesis);

  const payload = structuredClone(data.payload);
  payload.publication.evidence.drafts = [{ draftId: original.draftId, revision: original.revision,
    commandKey: original.commandKey, fingerprint: original.fingerprint }];
  payload.publication.operations.push({ op: "create_sku", productSlug: data.slug, skuId: retainedId,
    documentRevisionNo: 1, ...retainedFacts });
  const issuing = await save(data, 2, payload);
  const commands = await prepare(data, 2, null);
  const api = native(), who = (await api.authorize(actor))!;
  expect(await api.execute(commands.approve, who)).toMatchObject({ outcome: "committed" });
  expect(await api.execute(commands.publish, who)).toMatchObject({ outcome: "committed" });
  expect((await pool.query("SELECT full_facts::jsonb->'source' AS claim FROM public.catalog_sku_revisions WHERE sku_id=$1",
    [retainedId])).rows).toEqual([{ claim: { draftId: issuing.draftId, revision: issuing.revision,
    commandKey: issuing.commandKey, fingerprint: issuing.fingerprint } }]);
});

it.each([[6, "inactive"], [15, "missing"], [16, "expired"], [17, "wrong settlement"]] as const)(
  "rolls back a completed child price when the later list is refused (%s: %s)", async (sequence, problem) => {
  const data = authored(sequence);
  const goodList = randomUUID(), inactiveList = randomUUID();
  await pool.query(`INSERT INTO public.price_lists(id,name,region_code,currency,status,valid_from)
    VALUES($1,'First','ZZ','XXX','active',statement_timestamp()-interval '1 hour')`, [goodList]);
  if (problem !== "missing") await pool.query(`INSERT INTO public.price_lists(id,name,region_code,currency,status,valid_from,valid_to)
    VALUES($1,'Second',$2,'XXX',$3,statement_timestamp()-interval '1 hour',
      CASE WHEN $4::boolean THEN statement_timestamp()-interval '1 minute' END)`,
  [inactiveList, problem === "wrong settlement" ? "XY" : "ZZ", problem === "inactive" ? "draft" : "active", problem === "expired"]);
  const child = { schemaVersion: 1, variantId: data.skuId, mode: "one_time", minQty: 1, amountKind: "gross",
    unitPriceMinor: 1733, expected: { entryId: null, unitPriceMinor: null } } as const;
  data.payload.skus[0]!.priceOperations = [
    { ...child, commandKey: `publication-first-${sequence}`, priceListId: goodList },
    { ...child, commandKey: `publication-second-${sequence}`, priceListId: inactiveList },
  ];
  await save(data, 1);
  const commands = await prepare(data, 1, null);
  let changed = 0;
  let sqlFailure: string | undefined;
  const api = native(async (db, sql, args) => {
    const result = await db.query(sql, args).catch((error: Error) => { sqlFailure = error.message; throw error; });
    if (sql.startsWith("SELECT public.catalog_price_setup_apply_claimed") &&
        (result.rows[0]?.result as { outcome?: string } | undefined)?.outcome === "committed") changed++;
    return result;
  });
  const who = (await api.authorize(actor))!;
  expect(await api.execute(commands.approve, who)).toMatchObject({ outcome: "committed" });
  expect(await api.execute(commands.publish, who), sqlFailure).toMatchObject(problem === "missing"
    ? { outcome: "validation_issue", reason: "price_list_not_found",
      message: "Select an installed, effective price list for the settlement region and currency, then prepare the draft again.",
      path: "skus.priceOperations.priceListId", subject: inactiveList }
    : { outcome: "validation_issue", reason: "price_list_not_active",
      message: "Activate the intended price list or select an effective list for the settlement region and currency." });
  expect(changed).toBe(1);
  expect((await pool.query("SELECT id FROM public.price_entries WHERE variant_id=$1", [data.skuId])).rows).toEqual([]);
  expect((await pool.query("SELECT idempotency_key FROM public.catalog_price_setup_receipts WHERE idempotency_key LIKE $1",
    [`publication-%-${sequence}`])).rows).toEqual([]);
  expect((await pool.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1", [data.productId])).rows).toEqual([]);
  if (problem === "inactive") {
    await pool.query("UPDATE public.price_lists SET status='active' WHERE id=$1", [inactiveList]);
    expect(await api.execute(commands.publish, who)).toMatchObject({ outcome: "committed" });
    expect((await pool.query("SELECT unit_price_minor FROM public.price_entries WHERE variant_id=$1", [data.skuId])).rows)
      .toEqual([{ unit_price_minor: 1733 }, { unit_price_minor: 1733 }]);
    const changed = authored(22), commandKey = `publication-first-${sequence}`;
    changed.payload.skus[0]!.priceOperations = [
      { ...child, commandKey, variantId: changed.skuId, priceListId: goodList, unitPriceMinor: 1800 },
    ];
    await save(changed, 1);
    const next = await prepare(changed, 1, null);
    expect(await api.execute(next.approve, who)).toMatchObject({ outcome: "committed" });
    expect(await api.execute(next.publish, who)).toMatchObject({ outcome: "conflict", reason: "command_key_reused",
      message: `Price command "${commandKey}". Give the changed price operation a fresh command key and prepare the draft again.` });
  }
});

it("asks the original administrator to replay a completed child price command", async () => {
  const data = authored(23), api = native(), who = (await api.authorize(actor))!;
  await save(data, 1);
  const first = await prepare(data, 1, null);
  expect(await api.execute(first.approve, who)).toMatchObject({ outcome: "committed" });
  const issued = await api.execute(first.publish, who);
  if (!("receipt" in issued) || !("head" in issued.receipt)) throw new Error(JSON.stringify(issued));

  const priceListId = randomUUID();
  await pool.query(`INSERT INTO public.price_lists(id,name,region_code,currency,status,valid_from)
    VALUES($1,'Replay list','ZZ','XXX','active',statement_timestamp()-interval '1 hour')`, [priceListId]);
  const child = { schemaVersion: 1, commandKey: randomUUID(), priceListId, variantId: data.skuId,
    mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 1200, expected: { entryId: null, unitPriceMinor: null } } as const;
  const text = pricing.canonicalCatalogPriceSetupCommand(child);
  const completed = await transaction(pool, async db => {
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: otherActor, role: "authenticated" })]);
    return (await db.query("SELECT public.catalog_price_setup_apply($1,$2) AS result", [text, hash(text)])).rows[0]?.result;
  });
  expect(completed).toMatchObject({ outcome: "committed" });

  const payload = structuredClone(data.payload);
  const presentation = { title: "Revised article" };
  Object.assign(payload.product.sharedContent, { catalogAction: "revise", presentation });
  payload.skus[0]!.priceOperations = [child];
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: data.slug, presentation }];
  await save(data, 2, payload);
  const next = await prepare(data, 2, issued.receipt.head);
  expect(await api.execute(next.approve, who)).toMatchObject({ outcome: "committed" });
  expect(await api.execute(next.publish, who)).toMatchObject({ outcome: "unauthorized", reason: "operator_mismatch",
    message: "Have the administrator who completed the child price command replay it." });
  expect(await api.execute(next.publish, (await api.authorize(otherActor))!)).toMatchObject({ outcome: "committed" });
});

it.each(["publish", "revoke"] as const)("serializes %s before the competing command", async first => {
  const data = authored(first === "publish" ? 7 : 8);
  await save(data, 1);
  const commands = await prepare(data, 1, null);
  const inserted = latch(), release = latch(), waiting = latch();
  const leader = native(async (db, sql, args) => {
    const result = await db.query(sql, args);
    if (sql.startsWith("SELECT public.catalog_publication_record_command") &&
      JSON.parse(String(args?.[0])).action === first) {
      inserted.resolve();
      await release.promise;
    }
    return result;
  });
  const who = (await leader.authorize(actor))!;
  expect(await leader.execute(commands.approve, who)).toMatchObject({ outcome: "committed" });
  const follower = native((db, sql, args) => {
    const result = db.query(sql, args);
    if (sql.includes("pg_advisory_xact_lock")) waiting.resolve();
    return result;
  });
  const claimant = (await follower.authorize(actor))!;
  const winner = leader.execute(commands[first], who);
  await Promise.race([inserted.promise, winner.then(result => { throw new Error(JSON.stringify(result)); })]);
  const next = follower.execute(first === "publish" ? commands.revoke : commands.publish, claimant);
  try { await waiting.promise; } finally { release.resolve(); }
  expect(await winner).toMatchObject({ outcome: "committed" });
  expect(await next).toMatchObject({ outcome: "conflict",
    reason: first === "publish" ? "publication_candidate_already_issued" : "publication_approval_missing" });
});

it("enforces marked GTIN uniqueness and still admits a later legacy unmarked identifier", async () => {
  const data = authored(9);
  await save(data, 1);
  const commands = await prepare(data, 1, null);
  const api = native(), who = (await api.authorize(actor))!;
  expect(await api.execute(commands.approve, who)).toMatchObject({ outcome: "committed" });
  expect(await api.execute(commands.publish, who)).toMatchObject({ outcome: "committed" });
  const other = randomUUID();
  await pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'later-legacy','Legacy article')", [other]);
  await pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,sellable_standalone) VALUES($1,$1,'LATER-LEGACY','Legacy article','draft',false)", [other]);
  const insert = (marker: string | null) => pool.query(`INSERT INTO public.catalog_sku_identifiers
    (catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,scheme)
    VALUES($1,'later-legacy','gtin',$2,'unit',1,$3)`, [other, data.barcode.padStart(14, "0"), marker]);
  await expect(insert("gs1:gtin")).rejects.toMatchObject({ code: "23505", constraint: "catalog_publication_gtin_key" });
  await expect(insert(null)).resolves.toMatchObject({ rowCount: 1 });
  expect((await pool.query("SELECT scheme FROM public.catalog_sku_identifiers WHERE catalog_sku_id=$1", [data.skuId])).rows)
    .toEqual([{ scheme: "gs1:gtin" }]);
});

it.each([
  ["document", "publication_document_required", 10],
  ["primarySkuId", "publication_primary_sku_required", 11],
  ["reserved carrier", "publication_reserved_carrier", 12],
] as const)("refuses %s before calling the recorder", async (field, reason, sequence) => {
  const data = authored(sequence);
  if (field === "reserved carrier") {
    const vector = publicationWireVectors.find(item => item.name === "reserved scalar in nested facts")!;
    const entry = data.payload.product.sharedContent.publicationSkus[0]!;
    entry.facts = vector.apply({ facts: entry.facts } as CatalogPublishedSku).facts as typeof entry.facts;
  } else {
    const skip = field === "document"
      ? ["move_document_pointer", "create_sku", "create_identifier", "set_primary_sku"] : ["set_primary_sku"];
    data.payload.publication.operations = data.payload.publication.operations.filter(operation => !skip.includes(operation.op));
  }
  await save(data, 1);
  const called: string[] = [];
  const api = native((db, sql, args) => { called.push(sql); return db.query(sql, args); });
  const who = (await api.authorize(actor))!;
  const preview = await api.prepareCandidate({ draftId: data.draftId, draftRevision: 1, expectedHead: null }, who);
  if (!("candidateRef" in preview)) throw new Error(JSON.stringify(preview));
  const { candidateRef, candidateDigest } = preview;
  expect(await api.execute({ candidateRef, candidateDigest, productId: data.productId, action: "approve",
    commandKey: randomUUID(), postStateDigest: "a".repeat(64) }, who)).toMatchObject({
    outcome: "validation_issue", reason, path: field === "reserved carrier" ?
      "product.sharedContent.publicationSkus.0.facts.values.0.cANonical_TeXt" : `product.${field}`,
  });
  expect(called.every(query => !query.includes("catalog_publication_record_command"))).toBe(true);
});

describe("publication activation prices", () => {
  const listId = randomUUID();
  const quoteListId = randomUUID();
  const authorListId = randomUUID();
  const legacyListId = randomUUID();
  beforeAll(async () => {
    await installActivationPrices(pool, listId);
    await installActivationPrices(quotePool, quoteListId);
    await installActivationPrices(authorPool, authorListId);
    await installActivationPrices(legacyPool, legacyListId, "legacy");
  });

  async function installActivationPrices(db: Pool, listId: string, pricing: "d2c" | "legacy" = "d2c") {
    await db.query("UPDATE public.price_lists SET status='draft' WHERE status='active'");
    await db.query(`INSERT INTO public.price_lists(id,name,region_code,currency,valid_from)
      VALUES($1,'Effective list','ZZ','XXX',statement_timestamp()-interval '1 hour')`, [listId]);
    if (pricing === "d2c") await db.query(`INSERT INTO public.subscription_price_policy_revisions
      (id,revision_no,price_list_id,region_code,currency,channel,effective_from,discount_bps,rounding_quantum_minor,rounding_rule,digest)
      SELECT id,1,$1,'ZZ','XXX','D2C',at,1000,10,'FLOOR_TO_QUANTUM',
        public.catalog_price_setup_policy_digest(id,1,$1,'ZZ','XXX','D2C',at,NULL,1000,10,'FLOOR_TO_QUANTUM')
      FROM (SELECT gen_random_uuid() AS id,date_trunc('milliseconds',statement_timestamp()-interval '1 hour') AS at) timing`, [listId]);
    const base = randomUUID();
    await db.query("INSERT INTO public.catalog_products(id,slug,name,status) VALUES($1,'priced-core','Core item','active')", [base]);
    await db.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,status,sellable_standalone)
      VALUES($1,$1,'PRICED-CORE','Core item','active',true)`, [base]);
    await seedBasePrice(base, db, listId);
    if (pricing === "legacy") await seedSubscriptionEntry(base, db, listId);
    const promotion = {
      status: "active", trigger_type: "automatic", code: null, discount_type: "percentage", applies_to_kind: "order_total",
      valid_from: "2020-01-01T00:00:00Z", valid_to: null, redemption_limit_global: null,
      region_availability: ["ZZ"], benefit_lane: "product", benefit_value_minor: null, v2_mirror_of: null,
    };
    for (const definition of [
      { ...promotion, id: "example:acquisition", promotion_engine_version: "promotion-engine.v2",
        discount_value: 50, stacking_rule: "exclusive", redemption_limit_per_customer: 1, benefit_kind: "target_percentage",
        benefit_value_bps: 5000, eligibility: { first_subscription_purchase: true },
        applies_to_payload: { cart_mode: "subscription", acquisitionTerms: {
          schemaVersion: "subscription-acquisition.v1", revision: "example:terms-1", delivery2DiscountBps: 3500,
        } } },
      { ...promotion, id: "example:bundle", promotion_engine_version: "promotion-engine.v1",
        discount_value: 5, stacking_rule: "stackable_with_any", redemption_limit_per_customer: null, benefit_kind: "percentage",
        benefit_value_bps: 500, eligibility: { min_cart_minor: 12000 }, applies_to_payload: { cart_mode: "one_time" } },
    ]) {
      const text = JSON.stringify(definition);
      await db.query(`INSERT INTO public.commerce_promotion_definitions(promotion_id,definition_fingerprint,definition,active)
        VALUES($1,$2,$3,true)`, [definition.id, hash(text), text]);
    }
    await db.query(`INSERT INTO public.platform_job_controls(job_name,active_driver,enabled,last_status,last_success_at,metadata)
      VALUES('platform-watchdog','worker',true,'success',statement_timestamp(),'{"promotionReady":true}'),
      ('promotion-claim-sweep','worker',true,'success',statement_timestamp(),'{}')
      ON CONFLICT(job_name) DO UPDATE SET enabled=excluded.enabled,last_status=excluded.last_status,
        last_success_at=excluded.last_success_at,metadata=excluded.metadata`);
    expect((await db.query("SELECT public.commerce_offer_policy_v2_readiness() AS result")).rows[0]?.result)
      .toMatchObject({ ready: true, reasons: [] });
  }

  async function seedBasePrice(skuId: string, db = pool, priceListId: string = listId) {
    const id = randomUUID();
    await db.query(`INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,min_qty,amount_kind,unit_price_minor,valid_from)
      VALUES($1,$2,$3,'one_time',1,'gross',1000,statement_timestamp()-interval '1 minute')`, [id, priceListId, skuId]);
    return id;
  }

  async function seedSubscriptionEntry(skuId: string, db: Pool, priceListId: string) {
    const id = randomUUID();
    await db.query(`INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,min_qty,amount_kind,unit_price_minor,valid_from)
      VALUES($1,$2,$3,'subscription',1,'gross',900,statement_timestamp()-interval '1 minute')`, [id, priceListId, skuId]);
    return id;
  }

  const builderSku = (code: string, sequence: number, grams: string) => ({
    code, title: code, netContent: { dimension: "mass", unit: "openlup:g", unscaled: grams, scale: 0 } as const,
    grossMass: { dimension: "mass", unit: "openlup:g", unscaled: "120", scale: 0 } as const,
    identifiers: [{ scheme: "gs1:gtin", issuer: "example:internal", value: catalogInternalGtin(sequence),
      packagingLevel: "unit" as const, isPrimary: true }],
    sell: { oneTime: true, subscription: false }, facts: { derived: 12 }, logisticsRef: `example:fulfillment/${code}`,
  });

  it("requires a released SKU before changing its eligibility", async () => {
    const { release, activation } = buildCatalogReleaseDraftV3({ namespace: "example",
      type: { key: installed.key, version: installed.version }, slug: "new-eligibility", name: "New eligibility",
      presentation: { title: "New eligibility" }, skus: [{ ...builderSku("NEW-ELIGIBILITY", 209, "100"),
        options: { finish: { kind: "choice", value: "matte" } }, attributes: { finish: "matte" } }] });
    const payload = structuredClone(release.payload);
    payload.product.sharedContent.requestedModes = activation.payload.product.sharedContent.requestedModes;
    payload.publication.operations.push(...activation.payload.publication.operations.filter(operation => operation.op === "set_eligibility"));
    const draftId = randomUUID();
    await save({ draftId, payload }, 1, payload, authorPool);
    const api = native(undefined, authorPool);
    const result = await api.prepareCandidate({ draftId, draftRevision: 1, expectedHead: null }, (await api.authorize(actor))!);
    expect(result).toMatchObject({ preparation: { structural: { outcome: "blocked-input", issues: [
      { code: "catalog_publication_operation_source_mismatch", path: "publication.operations.7", subject: "NEW-ELIGIBILITY" },
    ] } } });
  });

  async function publishBuiltProduct(input: CatalogProductInput, pricing: "d2c" | "d2c-recovery" | "legacy") {
    const db = pricing === "legacy" ? legacyPool : authorPool;
    const priceListId = pricing === "legacy" ? legacyListId : authorListId;
    const { release, activation } = buildCatalogReleaseDraftV3(input);
    const data = { productId: release.payload.product.id, draftId: randomUUID(), payload: release.payload };
    const api = native(undefined, db), who = (await api.authorize(actor))!;
    const states = async () => (await db.query(`SELECT p.status AS product_status, s.status, h.publication_id
      FROM public.catalog_products p JOIN public.catalog_skus s ON s.product_id=p.id
      JOIN public.catalog_publication_heads h ON h.product_id=p.id WHERE p.id=$1`, [data.productId])).rows;
    await save(data, 1, release.payload, db);
    const first = await prepare(data, 1, null, db);
    expect(await api.execute(first.approve, who)).toMatchObject({ outcome: "committed" });
    const initial = await api.execute(first.publish, who);
    if (!("receipt" in initial) || !("head" in initial.receipt)) throw new Error(JSON.stringify(initial));
    const releaseHead = initial.receipt.head;
    const draftStates = input.skus.map(() => ({ product_status: "draft", status: "draft", publication_id: releaseHead.publicationId }));
    expect(await states()).toEqual(draftStates);
    async function seedBasePrices() {
      for (const sku of release.payload.skus) await seedBasePrice(sku.id, db, priceListId);
    }
    if (pricing !== "d2c-recovery") await seedBasePrices();
    await save(data, 2, activation.payload, db);
    const next = await prepare(data, 2, releaseHead, db);
    expect(await api.execute(next.approve, who)).toMatchObject({ outcome: "committed" });
    async function expectPriceRefusal() {
      expect(await api.execute(next.publish, who)).toMatchObject({ outcome: "validation_issue", reason: "publication_sku_price_not_ready" });
      expect(await states()).toEqual(draftStates);
    }
    if (pricing === "d2c-recovery") {
      await expectPriceRefusal();
      await seedBasePrices();
      const conflicting = await seedSubscriptionEntry(release.payload.skus[0]!.id, db, priceListId);
      await expectPriceRefusal();
      await db.query("UPDATE public.price_entries SET active=false WHERE id=$1", [conflicting]);
    }
    if (pricing === "legacy") {
      await expectPriceRefusal();
      for (const sku of release.payload.skus) await seedSubscriptionEntry(sku.id, db, priceListId);
    }
    const result = await api.execute(next.publish, who);
    if (!("receipt" in result) || !("head" in result.receipt)) throw new Error(JSON.stringify(result));
    expect(result.outcome).toBe("committed");
    return { head: result.receipt.head, skus: activation.payload.skus };
  }

  it("two_skus_build_release_price_then_activate", async () => {
    const { head, skus } = await publishBuiltProduct({ namespace: "example", type: { key: installed.key, version: installed.version },
      slug: "two-finishes", name: "Example article", presentation: { title: "Example article" }, skus: [
        { ...builderSku("FINISH-MATTE", 203, "100"), primary: true, minQuantity: 2, options: { finish: { kind: "choice", value: "matte" } }, attributes: { finish: "matte" } },
        { ...builderSku("FINISH-GLOSS", 204, "100"), options: { finish: { kind: "choice", value: "gloss" } }, attributes: { finish: "gloss" } },
      ] }, "d2c-recovery");
    const membership = await readPostgresCatalogMembershipPage(authorPool, { offerVersion: "classic", limit: 100, mode: "one_time" });
    if (!("protocol" in membership) || membership.protocol !== "governed") throw new Error(JSON.stringify(membership));
    expect(membership.items.map(({ skuId, logisticsRef, head }) => ({ skuId, logisticsRef, head })))
      .toEqual(skus.map(sku => ({ skuId: sku.id, logisticsRef: sku.logisticsRef, head })).sort((a, b) => a.skuId.localeCompare(b.skuId)));
  });

  it("quantity_option_in_ml_with_gram_net_content_publishes", async () => {
    const volume = { dimension: "volume", unit: "example:ml", unscaled: "50", scale: 0 } as const;
    const { skus } = await publishBuiltProduct({ namespace: "example", type: { key: volumeType.key, version: volumeType.version },
      slug: "labelled-volume", name: "Labelled volume", presentation: { title: "Labelled volume" }, skus: [
        { ...builderSku("VOLUME-50ML", 205, "52"), grossMass: { dimension: "mass", unit: "openlup:g", unscaled: "60", scale: 0 },
          options: { volume: { kind: "quantity", value: volume } }, attributes: { volume } },
      ] }, "d2c");
    expect((await authorPool.query("SELECT net_weight_g, option_values->'volume'->'value' AS volume FROM public.catalog_skus WHERE id=$1",
      [skus[0]!.id])).rows).toEqual([{ net_weight_g: 52, volume }]);
  });

  it("activates with a stored subscription price when the list has no D2C policy history", async () => {
    const { head } = await publishBuiltProduct({ namespace: "example", type: { key: installed.key, version: installed.version },
      slug: "legacy-priced-item", name: "Legacy priced item", presentation: { title: "Legacy priced item" }, skus: [
        { ...builderSku("LEGACY-PRICE", 206, "100"), options: { finish: { kind: "choice", value: "matte" } },
          attributes: { finish: "matte" } },
      ] }, "legacy");
    expect(head.revision).toBe(2);
  });

  async function approvedActivation(sequence: number, isAddon: boolean, missing?: "logistics" | "purchase mode",
    { grams = 100, governed = false, db = pool, internalIdentifier, bundledPrice = false }: {
      grams?: number; governed?: boolean; db?: Pool; internalIdentifier?: DraftIdentifier; bundledPrice?: boolean;
    } = {}) {
    const data = authored(sequence, internalIdentifier), api = native(undefined, db), who = (await api.authorize(actor))!;
    const sku = data.payload.skus[0]!;
    sku.netContent = { ...sku.netContent!, unscaled: String(grams) };
    sku.grossMass = { ...sku.netContent, unscaled: String(grams + 10) };
    if (missing !== "logistics") sku.logisticsRef = "example:logistics";
    data.payload.product.sharedContent.publicationSkus[0]!.isAddon = isAddon;
    const create = data.payload.publication.operations.find(operation => operation.op === "create_sku")!;
    create.isAddon = isAddon;
    if (sku.logisticsRef) data.payload.publication.operations.push({ op: "set_sku_metadata", skuCode: data.code, logisticsRef: sku.logisticsRef });
    const draft: CatalogDraftPayloadV3 | CatalogDraftPayloadV4 = governed
      ? { ...data.payload, schemaVersion: 4 } : data.payload;
    let revision = 1;
    if (internalIdentifier) {
      const missing = structuredClone(draft);
      missing.skus[0]!.identifiers = [];
      missing.publication.operations = missing.publication.operations.filter(operation => operation.op !== "create_identifier");
      await save(data, revision, missing, db);
      const blocked = await api.prepareCandidate({ draftId: data.draftId, draftRevision: revision, expectedHead: null }, who);
      expect(blocked).toMatchObject({ preparation: { structural: { outcome: "blocked-input", issues: expect.arrayContaining([
        { code: "unit_trade_identifier_missing", path: "skus.0.identifiers", phase: "structural", subject: data.code,
          message: "Add a valid unit trade identifier to the SKU, then prepare the draft again. For a product without a GS1 barcode, mint one with catalogInternalGtin." },
      ]) } } });
      revision += 1;
    }
    await save(data, revision, draft, db);
    const first = await prepare(data, revision, null, db);
    expect(await api.execute(first.approve, who)).toMatchObject({ outcome: "committed" });
    const issue = await api.execute(first.publish, who);
    if (!("receipt" in issue) || !("head" in issue.receipt)) throw new Error(JSON.stringify(issue));

    const payload = structuredClone(draft);
    if (bundledPrice) payload.skus[0]!.priceOperations = [{ schemaVersion: 1, commandKey: randomUUID(), variantId: data.skuId,
      priceListId: listId, mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 1000,
      expected: { entryId: null, unitPriceMinor: null } }];
    const membership = { skuCode: data.code, admitted: true, offerVersion: "example:open" };
    const content = payload.product.sharedContent;
    content.catalogAction = "revise";
    content.offerMemberships = [membership];
    content.requestedModes = [{ skuCode: data.code, modes: ["one_time"] }];
    const eligibility = [
      { op: "set_eligibility", skuCode: data.code, sellableStandalone: true, sellableInSubscription: false },
      { op: "set_offer_membership", ...membership },
    ] as const;
    payload.publication.operations = payload.schemaVersion === 4 ? [
      { op: "set_product_lifecycle", productSlug: data.slug, expectedState: "draft", state: "active", children: [] },
      { op: "set_sku_lifecycle", skuCode: data.code, expectedState: "draft", state: "active" },
      ...eligibility,
    ] : [
      { op: "set_product_status", productSlug: data.slug, status: "active" },
      { op: "set_sku_status", skuCode: data.code, status: "active" },
      ...eligibility,
    ];
    if (missing === "purchase mode") {
      content.requestedModes = [{ skuCode: data.code, modes: [] }];
      content.offerMemberships = [];
      payload.publication.operations = payload.publication.operations.slice(0, 1);
    }
    await save(data, revision + 1, payload, db);
    const next = await prepare(data, revision + 1, issue.receipt.head, db);
    expect(await api.execute(next.approve, who)).toMatchObject({ outcome: "committed" });
    const command = governed ? {
      ...next.publish, changes: [{ variantId: data.skuId, expectedRevision: 1, state: "active" }],
    } as const : next.publish;
    return { ...data, api, who, command, head: issue.receipt.head };
  }

  it("projects only recognized readiness evidence and rolls back the staged Publish until exact retry", async () => {
    const { command, productId, skuId, head } = await approvedActivation(71, false, undefined, { bundledPrice: true });
    let inject: (sql: string, result: Awaited<ReturnType<PgQueryExecutor["query"]>>) => Awaited<ReturnType<PgQueryExecutor["query"]>>;
    const api = native(async (db, sql, args) => inject(sql, await db.query(sql, args)));
    const who = (await api.authorize(actor))!;
    const probe = (sql: string) => sql.startsWith("SELECT public.commerce_offer_policy_v2_readiness()");
    const writer = (sql: string) => sql.startsWith("SELECT public.catalog_price_setup_apply_claimed");
    const project = (sql: string) => sql.includes("list.id AS list_id, price.invalid_shape");
    const remedies: Record<string, string> = {
      bundle_5_policy_invalid: "Fix: Restore exactly one qualifying automatic one-time bundle with the promotion owner.",
      promotion_claim_sweep_not_ready: "Fix: Ask the operations owner to enable the promotion claim sweep and verify its configured driver can run it. Recheck: Wait for the next run or have the owner trigger one. Verify successful evidence from the past 15 minutes.",
      promotion_watchdog_not_ready: "Fix: Ask the operations owner to enable the watchdog, verify its operations principal is active, and resolve any enabled failed jobs. Recheck: Wait for the next run or have the owner trigger one. Verify a healthy, successful watchdog run from the past six hours.",
    };
    const refuse = async (subject: string, hard = false) => {
      const result = await api.execute(command, who);
      expect(result).toEqual({ outcome: hard ? "dependency_unavailable" : "validation_issue",
        reason: hard ? "publication_authority_unavailable" : "publication_price_readiness", path: "pricing.readiness", subject,
        message: expect.stringMatching(/^Observed: .+ Cause: .+ Fix: .+ Recheck: .+$/u) });
      expect(JSON.stringify(result)).not.toContain("unapproved_input");
      if (Object.hasOwn(remedies, subject)) expect(result).toHaveProperty("message", expect.stringContaining(remedies[subject]!));
      expect((await pool.query("SELECT publication_id FROM public.catalog_publication_heads WHERE product_id=$1", [productId])).rows)
        .toEqual([{ publication_id: head.publicationId }]);
      expect((await pool.query("SELECT id FROM public.price_entries WHERE variant_id=$1", [skuId])).rows).toEqual([]);
    };
    inject = (sql, result) => project(sql) ? { rows: result.rows.map(row => ({ ...row, list_id: randomUUID() })) } : result;
    await refuse("effective_price_list_changed");
    inject = (sql, result) => project(sql) ? { rows: result.rows.map(row => ({ ...row, list_id: null })) } : result;
    expect(await api.execute(command, who)).toMatchObject({ reason: "price_list_not_active" });
    const raise = (site: typeof probe, code: string, message: string, detail?: string) => {
      inject = (sql, result) => {
        if (site(sql)) throw Object.assign(new Error(message), { code, detail });
        return result;
      };
    };
    for (const reason of pricing.CATALOG_PRICE_SETUP_HARD_REFUSALS) {
      for (const site of [probe, writer]) {
        raise(site, "55000", "catalog_price_setup_" + reason, "unapproved_input");
        await refuse(reason, true);
      }
    }
    for (const reason of ["first_subscription_pair_invalid", "first_subscription_mirror_not_ready", "bundle_5_policy_invalid",
      "catalog_1490_legacy_1340_invalid", "promotion_claim_sweep_not_ready", "promotion_watchdog_not_ready",
      "legacy_frozen_records_invalid", "automatic_v2_money_invalid"]) {
      inject = (sql, result) => probe(sql) ? { rows: [{ result: { ready: false, reasons: ["unapproved_input", reason] } }] } : result;
      await refuse(reason);
    }
    inject = (sql, result) => probe(sql) ? { rows: [{ result: { ready: false, reasons: Array(33).fill("bundle_5_policy_invalid") } }] } : result;
    await refuse("readiness_unverified");
    inject = (sql, result) => probe(sql) ? { rows: [] } : result;
    await refuse("readiness_unverified");
    raise(writer, "55000", "catalog_price_setup_readiness_would_fail", '["unapproved_input","bundle_5_policy_invalid"]');
    await refuse("bundle_5_policy_invalid");
    raise(writer, "55000", "catalog_price_setup_readiness_would_fail", "unapproved_input");
    await refuse("readiness_unverified");
    for (const [site, code, message] of [
      [writer, "22023", "catalog_price_setup_readiness_would_fail"],
      [probe, "55000", "catalog_price_setup_readiness_would_fail"],
      [probe, "55000", "catalog_price_setup_unapproved_input"],
      [writer, "22023", "catalog_price_setup_settlement_context_unverified"],
    ] as const) {
      raise(site, code, message);
      const result = await api.execute(command, who);
      expect(result).toMatchObject({ outcome: "dependency_unavailable", reason: "publication_authority_unavailable" });
      expect(result).not.toHaveProperty("subject");
    }
    raise(writer, "40001", "catalog_price_setup_expected_state_mismatch");
    expect(await api.execute(command, who)).toMatchObject({ outcome: "conflict", reason: "publication_price_changed" });
    inject = (_sql, result) => result;
    expect(await api.execute(command, who)).toMatchObject({ outcome: "committed" });
    expect(await api.execute(command, who)).toMatchObject({ outcome: "replayed" });
    expect((await pool.query("SELECT id FROM public.price_entries WHERE variant_id=$1", [skuId])).rows).toHaveLength(1);
  });

  it.each(["restore first", "enable first"] as const)("commits governed withdrawal, parent-only restore and %s", async order => {
    const data = authored(order === "restore first" ? 81 : 82), api = native(), who = (await api.authorize(actor))!;
    const payload: CatalogDraftPayloadV4 = { ...structuredClone(data.payload), schemaVersion: 4 };
    const sku = payload.skus[0]!;
    sku.grossMass = { ...sku.netContent!, unscaled: "110" };
    sku.logisticsRef = "example:logistics";
    payload.publication.operations.push({ op: "set_sku_metadata", skuCode: data.code, logisticsRef: sku.logisticsRef });
    const reads = createPostgresCatalogPublicationReads({ transactions: { run: work => transaction(pool, work) },
      authorizeHuman: async () => ({ ok: true, userId: actor, role: "admin", isMachineActor: false }) });
    const reader = (await reads.authorize(null))!;
    const issue = async (revision: number, previous: CatalogHeadRef | null, changes: CatalogPublishCommand["changes"] = []) => {
      await save(data, revision, payload);
      const commands = await prepare(data, revision, previous);
      expect(await api.execute(commands.approve, who)).toMatchObject({ outcome: "committed" });
      const publish = { ...commands.publish, changes };
      const result = await api.execute(publish, who);
      if (result.outcome !== "committed" || !("head" in result.receipt)) throw Error(JSON.stringify(result));
      expect(result.receipt.schemaVersion).toBe(3);
      return { publish, result, head: result.receipt.head };
    };
    const initial = await issue(1, null);
    expect(await reads.readbackV2(initial.head)).toMatchObject({ outcome: "unsupported",
      reason: "catalog_publication_use_readback_v3", message: "Read this governed issue with readbackV3." });
    const entry = await seedBasePrice(data.skuId);
    const membership = { skuCode: data.code, admitted: true, offerVersion: "example:governed" };
    const enable = { op: "set_eligibility", skuCode: data.code, sellableStandalone: true, sellableInSubscription: true } as const;
    const restore = { op: "restore_sku", skuCode: data.code, expectedState: "withdrawn" } as const;
    const content = payload.product.sharedContent;
    content.catalogAction = "revise";
    content.offerMemberships = [membership];
    content.requestedModes = [{ skuCode: data.code, modes: ["one_time", "subscription"] }];
    payload.publication.operations = [
      { op: "set_product_lifecycle", productSlug: data.slug, expectedState: "draft", state: "active", children: [] },
      { op: "set_sku_lifecycle", skuCode: data.code, expectedState: "draft", state: "active" },
      enable, { op: "set_offer_membership", ...membership },
    ];
    const active = await issue(2, initial.head, [{ variantId: data.skuId, expectedRevision: 1, state: "active" }]);
    payload.publication.operations = [{ op: "set_product_lifecycle", productSlug: data.slug, expectedState: "active", state: "withdrawn",
      children: [{ skuCode: data.code, expectedState: "active" }] }];
    const withdrawn = await issue(3, active.head, [{ variantId: data.skuId, expectedRevision: 2, state: "withdrawn" }]);
    const dark = await reads.readbackV3(withdrawn.head);
    expect(dark).toMatchObject({ schemaVersion: 3, product: { lifecycleState: "withdrawn" }, items: [{
      facts: { status: "active", lifecycleState: "withdrawn", memberships: [{ admitted: true, offerVersion: membership.offerVersion }],
        sellableStandalone: false, sellableInSubscription: false, netContent: sku.netContent, grossMass: sku.grossMass,
        source: { revision: 3 } },
    }] });
    await expect(pool.query("UPDATE public.catalog_products SET status='draft' WHERE id=$1", [data.productId]))
      .rejects.toMatchObject({ constraint: "catalog_lifecycle_raw_status_fenced" });
    await expect(pool.query("UPDATE public.catalog_skus SET sellable_in_subscription=true WHERE id=$1", [data.skuId]))
      .rejects.toMatchObject({ constraint: "catalog_lifecycle_raw_status_fenced" });
    const legacy = structuredClone(data.payload);
    legacy.product.sharedContent.catalogAction = "revise";
    legacy.publication.operations = [{ op: "set_product_status", productSlug: data.slug, status: "active" }];
    const downgrade = canonicalCatalogDraftJson({ schemaVersion: 3, action: "revise", draftId: data.draftId,
      expectedRevision: 3, commandKey: "legacy-status", payload: legacy });
    expect(await createPostgresCatalogDraftStoreV4(pool).apply({ canonicalCommand: downgrade, fingerprint: hash(downgrade), actorId: actor }))
      .toMatchObject({ outcome: "validation_issue" });

    payload.publication.operations = [{ op: "restore_product", productSlug: data.slug, expectedState: "withdrawn" }];
    const parent = await issue(4, withdrawn.head);
    expect(parent.result.receipt).toMatchObject({ changes: [] });
    const parentPage = await reads.readbackV3(parent.head);
    expect(parentPage).toMatchObject({ product: { lifecycleState: "active" }, items: [{
      reference: "items" in dark ? dark.items[0]!.reference : undefined,
      facts: { lifecycleState: "withdrawn", sellableStandalone: false, sellableInSubscription: false },
    }] });

    payload.publication.operations = order === "restore first" ? [restore, enable] : [enable, restore];
    sku.priceOperations = [{ schemaVersion: 1, commandKey: randomUUID(), variantId: data.skuId, priceListId: listId,
      mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 1500, expected: { entryId: entry, unitPriceMinor: 1000 } }];
    const saved = await save(data, 5, payload);
    expect(saved.payload).toEqual(payload);
    const commands = await prepare(data, 5, parent.head);
    const publish = { ...commands.publish, changes: [{ variantId: data.skuId, expectedRevision: 3, state: "active" as const }] };
    expect(await api.execute(commands.approve, who)).toMatchObject({ outcome: "committed" });
    expect(await api.execute(commands.revoke, who)).toMatchObject({ outcome: "committed" });
    expect(await api.execute(publish, who)).toMatchObject({ outcome: "conflict", reason: "publication_approval_missing" });
    expect(await api.execute({ ...commands.approve, commandKey: randomUUID() }, who)).toMatchObject({ outcome: "committed" });

    const fail = native(async (db, sql, args) => {
      const value = await db.query(sql, args);
      if (sql.includes("catalog_publication_record_command")) await db.query("SELECT 1/0");
      return value;
    });
    expect(await fail.execute(publish, (await fail.authorize(actor))!)).toMatchObject({ outcome: "dependency_unavailable" });
    expect((await pool.query("SELECT id FROM public.price_entries WHERE variant_id=$1 AND active", [data.skuId])).rows)
      .toEqual([{ id: entry }]);
    expect(await reads.receipt({ productId: data.productId, commandKey: publish.commandKey }, reader)).toEqual({ outcome: "absent" });
    expect((await pool.query("SELECT count(*)::int AS count FROM public.outbox_events WHERE aggregate_id=$1 AND aggregate_type='catalog.publication'",
      [data.productId])).rows).toEqual([{ count: 4 }]);
    const restored = await api.execute(publish, who);
    expect(restored).toMatchObject({ outcome: "committed", receipt: { schemaVersion: 3, changes: [{ state: "active", variantRevision: 4 }] } });
    const connection = new Pool({ connectionString: container.connectionString });
    try {
      const reopened = native(undefined, connection);
      reopened.disableRules();
      expect(await reopened.execute(withdrawn.publish, (await reopened.authorize(actor))!)).toEqual({ ...withdrawn.result, outcome: "replayed" });
    } finally { await connection.end(); }
  });

  it("asks for the logistics reference on the SKU being activated", async () => {
    const { api, who, command, code } = await approvedActivation(24, false, "logistics");
    expect(await api.execute(command, who)).toMatchObject({ outcome: "validation_issue",
      reason: "catalog_publication_v3_activation_readiness_failed", path: "skus.0.logisticsRef",
      message: `SKU ${code}. Supply the logistics reference for this SKU.` });
  });

  it("asks for a purchase mode on the primary SKU before product activation", async () => {
    const { api, who, command } = await approvedActivation(25, false, "purchase mode");
    expect(await api.execute(command, who)).toMatchObject({ outcome: "validation_issue",
      reason: "catalog_publication_v3_active_primary_required", path: "product.primarySkuId",
      message: "Activate the primary SKU with a purchase mode, or leave the product in draft." });
  });

  it("refuses an unpriced add-on even when the store passes readiness and rolls back activation", async () => {
    const { api, who, command, code, skuId, productId, head } = await approvedActivation(18, true);
    expect(await api.execute(command, who)).toMatchObject({ outcome: "validation_issue", reason: "publication_sku_price_not_ready",
      message: expect.stringContaining(`SKU ${code}. Set a positive gross base price`) });
    expect((await pool.query(`SELECT s.status,s.sellable_standalone,p.status AS product_status,h.publication_id
      FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id
      JOIN public.catalog_publication_heads h USING(product_id) WHERE s.id=$1`, [skuId])).rows)
      .toEqual([{ status: "draft", sellable_standalone: false, product_status: "draft", publication_id: head.publicationId }]);
    expect((await pool.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1", [productId])).rows).toHaveLength(1);
    expect((await pool.query("SELECT command_key FROM public.catalog_operator_receipts WHERE scope_id=$1 AND command_key=$2",
      [productId, command.commandKey])).rows).toEqual([]);
    await seedBasePrice(skuId);
    const override = (await pool.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
      VALUES($1,$2,'any',1000,statement_timestamp()-interval '1 minute') RETURNING id`, [listId, skuId])).rows[0]?.id;
    expect(await api.execute(command, who)).toMatchObject({ outcome: "validation_issue", reason: "publication_sku_price_shape_invalid",
      message: expect.stringContaining(`SKU ${code}. Use gross one-time or subscription pricing`) });
    await pool.query("DELETE FROM public.price_entries WHERE id=$1", [override]);
    expect(await api.execute(command, who)).toMatchObject({ outcome: "committed" });
  });

  it("sku_with_internal_identifier_publishes_and_quotes", async () => {
    const identifier = { scheme: "gs1:gtin", issuer: "example:internal", value: catalogInternalGtin(202), packagingLevel: "unit" } as const;
    const { api, who, command, code, skuId, slug } =
      await approvedActivation(202, false, undefined, { db: quotePool, internalIdentifier: identifier });
    await seedBasePrice(skuId, quotePool, quoteListId);
    expect(await api.execute(command, who)).toMatchObject({ outcome: "committed" });
    await transaction(quotePool, async db => {
      // The price-readiness seed has no document and cannot participate in the quote read.
      await db.query("UPDATE public.catalog_skus SET sellable_standalone=false WHERE sku='PRICED-CORE'");
      const catalog = createPostgresCommerceQuoteCatalogReadPort(db, { verifyDocument: async (payload, envelope) => {
        expect(payload).toEqual(authoredPublicationDocument(envelope.product.slug));
      } });
      expect(await catalog.listQuoteCatalogItems()).toContainEqual(expect.objectContaining({
        skuId, skuCode: code, variantId: skuId, productSlug: slug, sellability: { oneTime: true, subscription: false },
      }));
      await db.query("UPDATE public.catalog_skus SET sellable_standalone=true WHERE sku='PRICED-CORE'");
    });
  });

  it.each([
    { sequence: 182, grams: 1, receiptVersion: 2 },
    { sequence: 183, grams: 100, receiptVersion: 2 },
    { sequence: 184, grams: 2_147_483_647, receiptVersion: 2 },
    { sequence: 185, grams: 125, receiptVersion: 3 },
  ])("quotes a requested SKU from a v$receiptVersion publication with $grams grams and independent gross", async ({ sequence, grams, receiptVersion }) => {
    const governed = receiptVersion === 3;
    const { api, who, command, code, skuId, slug } = await approvedActivation(sequence, false, undefined, { grams, governed, db: quotePool });
    await seedBasePrice(skuId, quotePool, quoteListId);
    expect(await api.execute(command, who)).toMatchObject({ outcome: "committed", receipt: { schemaVersion: receiptVersion } });
    expect((await quotePool.query(`SELECT net_weight_g, gross_mass_unscaled::text AS gross,
      publication_facts->'schemaVersion' AS facts_version FROM public.catalog_skus WHERE id=$1`, [skuId])).rows)
      .toEqual([{ net_weight_g: grams, gross: String(grams + 10), facts_version: governed ? 3 : null }]);
    const db = await quotePool.connect();
    try {
      await db.query("BEGIN");
      // The price-readiness seed has no document. Every published fixture stays visible to the released scan.
      await db.query("UPDATE public.catalog_skus SET sellable_standalone=false WHERE sku='PRICED-CORE'");
      const catalog = createPostgresCommerceQuoteCatalogReadPort(db, { verifyDocument: async (payload, envelope) => {
        expect(payload).toEqual(authoredPublicationDocument(envelope.product.slug));
        expect(envelope.documentRevision.digest).toBe(hash(canonicalCatalogDraftJson(payload)));
      } });
      const quote = createCharacterizationQuote(pricing, catalog, pricing.createCommercePriceAuthorityPort(createPostgresCommercePriceAuthorityReadPort(db)));
      const result = await quote.createServerAuthoritativeQuote({ mode: "one_time", promoCodes: [], lines: [{ sku: code, quantity: 2 }] });
      // Pinned integrated main b30c9f805 offers the net grams and prices two sale units at 2,000.
      expect(result.quote).toMatchObject({ totalGross: { amountMinor: 2000, currency: "XXX" }, context: { grams: [grams] },
        lines: [{ sku: code, productSlug: slug, quantity: 2, unitPriceGross: { amountMinor: 1000, currency: "XXX" } }] });
    } finally {
      await db.query("ROLLBACK").finally(() => db.release());
    }
  });

  it("returns publication busy when activation reaches the purchase fence and commits on retry", async () => {
    const { api, who, command, head, productId, skuId } =
      await approvedActivation(186, false, undefined, { governed: true, db: quotePool });
    await seedBasePrice(skuId, quotePool, quoteListId);
    const { rows: [client] } = await quotePool.query<{ id: string }>(
      "INSERT INTO public.clients(email) VALUES('fence-buyer@example.invalid') RETURNING id");
    await withCatalogAdmissionFence(quotePool, {
      key: randomUUID(), clientId: client!.id, skuIds: [skuId], revisionIds: [], priceListId: quoteListId, timeoutMs: 2000,
    }, async () => {
      await expect(api.execute(command, who)).resolves.toMatchObject({ outcome: "conflict", reason: "publication_busy" });
      expect((await quotePool.query("SELECT publication_id FROM public.catalog_publication_heads WHERE product_id=$1", [productId])).rows)
        .toEqual([{ publication_id: head.publicationId }]);
    });
    await expect(api.execute(command, who)).resolves.toMatchObject({ outcome: "committed" });
  });

  it("holds the reused LC3 context after readiness and through issuance", async () => {
    const { command, skuId } = await approvedActivation(19, false);
    const entryId = await seedBasePrice(skuId);
    const read = latch(), issue = latch();
    const publisher = native(async (db, sql, args) => {
      const result = await db.query(sql, args);
      if (sql.startsWith("SELECT public.commerce_offer_policy_v2_readiness()")) {
        read.resolve();
        await issue.promise;
      }
      return result;
    });
    const pending = publisher.execute(command, (await publisher.authorize(actor))!);
    const text = pricing.canonicalCatalogPriceSetupCommand({ schemaVersion: 1, commandKey: randomUUID(), variantId: skuId,
      priceListId: listId, mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 1,
      expected: { entryId, unitPriceMinor: 1000 } });
    const price = () => transaction(pool, async db => {
      await db.query("SET LOCAL lock_timeout='500ms'");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: otherActor, role: "authenticated" })]);
      return db.query("SELECT public.catalog_price_setup_apply($1,$2)", [text, hash(text)]);
    });
    try {
      await Promise.race([read.promise, pending.then(result => { throw new Error(JSON.stringify(result)); })]);
      await expect(price()).rejects.toMatchObject({ code: "55P03", where: expect.stringContaining("catalog_price_setup_lock_context") });
    } finally {
      issue.resolve();
      await pending;
    }
    expect(await pending).toMatchObject({ outcome: "committed" });
    await expect(price()).rejects.toMatchObject({ message: "catalog_price_setup_readiness_would_fail" });
  });

  it("requires an effective price before presentation-only compensation restores a dark add-on", async () => {
    const { api, who, command, skuId, ...data } = await approvedActivation(21, true);
    const entry = await seedBasePrice(skuId);
    const issued = await api.execute(command, who);
    if (!("receipt" in issued) || !("head" in issued.receipt)) throw new Error(JSON.stringify(issued));
    const { head } = issued.receipt;
    const payload = structuredClone(data.payload);
    payload.product.sharedContent.catalogAction = "revise";
    payload.product.sharedContent.offerMemberships = [{ skuCode: data.code, admitted: true, offerVersion: "example:open" }];
    payload.product.sharedContent.requestedModes = [{ skuCode: data.code, modes: ["one_time"] }];
    payload.publication = { kind: "compensation", evidence: {},
      operations: [{ op: "set_product_presentation", productSlug: data.slug, presentation: {} }] };
    const draft = { ...data, skuId };
    await save(draft, 3, payload);
    const next = await prepare(draft, 3, head);
    expect(await api.execute(next.approve, who)).toMatchObject({ outcome: "committed" });
    await pool.query("UPDATE public.catalog_skus SET sellable_standalone=false WHERE id=$1", [skuId]);
    await pool.query("DELETE FROM public.price_entries WHERE id=$1", [entry]);
    expect(await api.execute(next.publish, who)).toMatchObject({ outcome: "validation_issue", reason: "publication_sku_price_not_ready",
      message: expect.stringContaining(`SKU ${data.code}`) });
    const state = () => pool.query(`SELECT s.sellable_standalone,h.publication_id FROM public.catalog_skus s
      JOIN public.catalog_publication_heads h USING(product_id) WHERE s.id=$1`, [skuId]);
    expect((await state()).rows).toEqual([{ sellable_standalone: false, publication_id: head.publicationId }]);
    await seedBasePrice(skuId);
    expect(await api.execute(next.publish, who)).toMatchObject({ outcome: "committed", receipt: { changes: [] } });
    expect((await state()).rows[0]?.sellable_standalone).toBe(true);
  });
});


const publicationTest = it.extend("publicationUrl", { scope: "file" }, async () => {
  const forward = "db/platform/migrations/q2_20261123192500_catalog_publication_authority.sql";
  await transaction(pool, async db => {
    await db.query("SET LOCAL openlup.qualified.role_mode = 'installer-managed'");
    await db.query(readFileSync(forward, "utf8"));
  });
  const password = randomUUID();
  await pool.query(`ALTER ROLE openlup_catalog_publication PASSWORD '${password}'`);
  const url = new URL(container.connectionString);
  url.username = "openlup_catalog_publication";
  url.password = password;
  return url.href;
});

publicationTest("checks every proposed price list during Prepare through the publication login", async ({ publicationUrl }) => {
  const publisher = new Pool({ connectionString: publicationUrl, max: 1 });
  const missing = randomUUID(), inactive = randomUUID(), future = randomUUID(), expired = randomUUID();
  const wrongRegion = randomUUID(), wrongCurrency = randomUUID(), valid = randomUUID();
  const installedLists = [inactive, future, expired, wrongRegion, wrongCurrency, valid];
  try {
    const data = authored(40);
    await pool.query(`INSERT INTO public.price_lists(id,name,region_code,currency,status,valid_from,valid_to) VALUES
      ($1,'Inactive','ZZ','XXX','archived',now()-interval '1 hour',NULL),
      ($2,'Future','ZZ','XXX','active',now()+interval '1 hour',NULL),
      ($3,'Expired','ZZ','XXX','active',now()-interval '2 hours',now()-interval '1 hour'),
      ($4,'Other region','AA','XXX','active',now()-interval '1 hour',NULL),
      ($5,'Other currency','ZZ','XTS','active',now()-interval '1 hour',NULL),
      ($6,'Effective','ZZ','XXX','active',now()-interval '1 hour',NULL)`,
    installedLists);
    const prices = [missing, ...installedLists].map(priceListId => ({
      schemaVersion: 1 as const, commandKey: randomUUID(), priceListId, variantId: data.skuId,
      mode: "one_time" as const, minQty: 1 as const, amountKind: "gross" as const, unitPriceMinor: 1733,
      expected: { entryId: null, unitPriceMinor: null },
    }));
    data.payload.skus[0]!.priceOperations = prices;
    await save(data, 1);
    const api = native(undefined, publisher), who = (await api.authorize(actor))!;
    const priceIssues = async (draftRevision: number) => {
      const preview = await api.prepareCandidate({ draftId: data.draftId, draftRevision, expectedHead: null }, who);
      expect(preview).toMatchObject({ preparation: { postStateDigest: expect.any(String) } });
      if (!("issues" in preview)) throw new Error(JSON.stringify(preview));
      return preview.issues.filter(({ code }) => code.startsWith("price_list_") || code === "price_validation_unavailable");
    };
    expect(await priceIssues(1)).toEqual([
      { path: "skus.0.priceOperations.0.priceListId", code: "price_list_not_found" },
      ...[1, 2, 3, 4, 5].map(index => ({ path: `skus.0.priceOperations.${index}.priceListId`, code: "price_list_not_active" })),
    ]);
    data.payload.skus[0]!.priceOperations = [prices.at(-1)!];
    await save(data, 2);
    expect(await priceIssues(2)).toEqual([]);
  } finally {
    await publisher.end();
    await pool.query("DELETE FROM public.price_lists WHERE id=ANY($1::uuid[])", [installedLists]);
  }
});

publicationTest("commits deferred publication checks through the restricted login", async ({ publicationUrl }) => {
  const publisher = new Pool({ connectionString: publicationUrl, max: 1 });
  try {
    expect((await publisher.query(`SELECT session_user,current_user,rolsuper,rolinherit,rolbypassrls,
      EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid=oid OR member=oid) AS memberships,
      has_column_privilege('public.catalog_publications','canonical_state','SELECT') AS issue_read,
      has_table_privilege('public.catalog_publications','INSERT') AS issue_insert,
      has_table_privilege('public.catalog_publications','UPDATE,DELETE,TRUNCATE') AS issue_mutation,
      has_any_column_privilege('public.catalog_product_document_revisions','UPDATE') AS document_mutation,
      has_any_column_privilege('public.catalog_attribute_projection','UPDATE') AS projection_mutation,
      has_any_column_privilege('public.outbox_events','SELECT,UPDATE') AS outbox_read_or_update,
      has_column_privilege('public.catalog_draft_heads','revision','UPDATE') AS draft_fence,
      has_column_privilege('public.catalog_draft_heads','status','UPDATE') AS draft_status_update,
      has_function_privilege('public.catalog_publication_record_command(jsonb)','EXECUTE') AS recorder,
      has_function_privilege('public.catalog_draft_apply(text,text,text)','EXECUTE') AS draft_writer
      FROM pg_catalog.pg_roles WHERE rolname=current_user`)).rows).toEqual([{
      session_user: "openlup_catalog_publication", current_user: "openlup_catalog_publication", rolsuper: false,
      rolinherit: false, rolbypassrls: false, memberships: false, issue_read: true, issue_insert: false, issue_mutation: false,
      document_mutation: false, projection_mutation: false, outbox_read_or_update: false, draft_fence: true,
      draft_status_update: false, recorder: true, draft_writer: false,
    }]);
    const refuseStatement = (sql: string, args?: unknown[]) => transaction(publisher, async db => {
      await db.query("SAVEPOINT permission_probe");
      await expect(db.query(sql, args)).rejects.toMatchObject({ code: "42501" });
      await db.query("ROLLBACK TO SAVEPOINT permission_probe");
    });
    for (const sql of [
      "INSERT INTO public.catalog_publication_decisions(actor_id) SELECT NULL::uuid WHERE false",
      "INSERT INTO public.catalog_operator_receipts(actor_id) SELECT NULL::uuid WHERE false",
      "INSERT INTO public.outbox_events(event_type) SELECT NULL::text WHERE false",
      "INSERT INTO public.price_entries(mode) SELECT NULL::text WHERE false",
      "INSERT INTO public.catalog_price_setup_receipts(status) SELECT NULL::text WHERE false",
      "SELECT public.catalog_price_setup_claim(NULL,NULL)",
      "SELECT public.catalog_price_setup_apply_claimed(NULL,NULL)",
      "SELECT value_text FROM public.commerce_settings",
      "SELECT principal_id FROM public.platform_human_memberships",
      "SELECT description FROM public.catalog_products",
      "SELECT created_at FROM public.catalog_sku_identifiers",
    ]) await refuseStatement(sql);
    await refuseStatement("SELECT public.catalog_publication_record_command('{}'::jsonb)");
    await pool.query("INSERT INTO public.catalog_tax_classes VALUES ('example:standard','Standard','active')");
    expect(await transaction(publisher, db => db.query("SELECT status FROM public.catalog_tax_classes FOR SHARE")))
      .toMatchObject({ rows: [{ status: "active" }] });
    await expect(publisher.query("UPDATE public.catalog_tax_classes SET status='retired'")).rejects.toMatchObject({ code: "42501" });
    const data = authored(26), priceListId = randomUUID();
    data.payload.skus[0]!.attributes = { finish: "matte" };
    await pool.query(`INSERT INTO public.price_lists(id,name,region_code,currency,status,valid_from)
      VALUES($1,'Publication list','ZZ','XXX','active',statement_timestamp()-interval '1 hour')`, [priceListId]);
    data.payload.skus[0]!.priceOperations = [{ schemaVersion: 1, commandKey: randomUUID(), variantId: data.skuId, priceListId,
      mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 1733, expected: { entryId: null, unitPriceMinor: null } }];
    await save(data, 1);
    await refuseStatement("UPDATE public.catalog_draft_heads SET revision=revision+1 WHERE draft_id=$1", [data.draftId]);
    const prepared = await prepare(data, 1, null);
    let sqlFailure: string | undefined;
    const api = native(async (db, sql, args) => db.query(sql, args).catch((error: Error) => {
      sqlFailure = error.message;
      throw error;
    }), publisher);
    const who = (await api.authorize(actor))!;
    const readers = createPostgresCatalogPublicationReads({ transactions: { run: work => transaction(publisher, work) },
      authorizeHuman: async () => ({ ok: true, userId: actor, role: "admin", isMachineActor: false }) });
    await publisher.query("CREATE TEMP TABLE publication_session_fixture (id pg_catalog.uuid)");
    const { rows: paths } = await publisher.query(`SELECT expected.signature, p.proconfig
      FROM unnest($1::text[]) WITH ORDINALITY AS expected(signature, position)
      LEFT JOIN pg_catalog.pg_proc p ON p.oid=expected.signature::pg_catalog.regprocedure
      ORDER BY expected.position`, [[
      "public.catalog_publication_record_command(jsonb)",
      "public.catalog_publication_admit()",
      "public.catalog_publication_assert_receipt(uuid,text)",
      "public.catalog_publication_assert_issued(uuid,uuid)",
      "public.catalog_publication_candidate_source(uuid,text,text)",
      "public.platform_human_membership_is_administrator(uuid)",
      "public.catalog_price_setup_region_code()",
      "public.catalog_price_setup_settlement_currency()",
    ]]);
    expect(paths).toHaveLength(8);
    for (const { signature, proconfig } of paths)
      expect(proconfig, signature).toContainEqual(expect.stringMatching(/^search_path=pg_catalog, (?:public, )?pg_temp$/u));
    expect(await readers.reads.current(data.productId)).toEqual({ outcome: "unpublished" });
    expect(await api.prepareCandidate({ draftId: data.draftId, draftRevision: 1, expectedHead: null }, who), sqlFailure)
      .toMatchObject({ candidateDigest: prepared.approve.candidateDigest, preparation: { postStateDigest: expect.any(String) } });
    const approved = await api.execute(prepared.approve, who);
    expect(approved, sqlFailure).toMatchObject({ outcome: "committed" });

    const otherProduct = randomUUID();
    await pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES ($1,'unrelated-publication','Unrelated product')", [otherProduct]);
    const bindingRefusal = { code: "42501", message: "catalog_publication_write_binding_required" };
    let mixedError: unknown;
    const mixed = createPostgresCatalogPublicationCommands({ registry,
      authorizeHuman: async (userId: string) => ({ ok: true, userId, role: "admin", isMachineActor: false }),
      catalogPublicationOwner: { run: work => transaction(publisher, async db => {
        const receipt = await work(db);
        expect(await db.query("UPDATE public.catalog_products SET name='Unbound edit' WHERE id=$1", [otherProduct])).toMatchObject({ rowCount: 1 });
        return receipt;
      }).catch(error => { mixedError = error; throw error; }) },
    });
    await mixed.execute(prepared.publish, (await mixed.authorize(actor))!);
    expect(mixedError).toMatchObject(bindingRefusal);
    expect((await pool.query("SELECT name FROM public.catalog_products WHERE id=$1", [otherProduct])).rows).toEqual([{ name: "Unrelated product" }]);
    expect((await pool.query("SELECT id FROM public.catalog_publications WHERE product_id=$1", [data.productId])).rows).toEqual([]);

    const published = await api.execute(prepared.publish, who);
    expect(published, sqlFailure).toMatchObject({ outcome: "committed", receipt: { head: { revision: 1 } } });
    if (!("receipt" in published) || !("head" in published.receipt)) throw new Error("publication receipt required");
    const { head, commandKey } = published.receipt;
    await refuseStatement("INSERT INTO pg_temp.catalog_publication_issued_products SELECT NULL::uuid WHERE false");
    expect(await readers.reads.current(data.productId)).toMatchObject({ outcome: "found", head });
    expect(await readers.readbackV2(head)).toMatchObject({ outcome: "page", head, schemaVersion: 2 });
    expect(await readers.reads.history(data.productId, null)).toMatchObject({ outcome: "page", receipts: [{ head }] });
    expect(await readers.receipt({ productId: data.productId, commandKey }, (await readers.authorize(actor))!))
      .toEqual({ outcome: "found", receipt: published.receipt });
    expect((await pool.query("SELECT revision FROM public.catalog_publication_heads WHERE product_id=$1", [data.productId])).rows)
      .toEqual([{ revision: 1 }]);
    expect((await pool.query("SELECT mode,min_qty,amount_kind,unit_price_minor FROM public.price_entries WHERE variant_id=$1", [data.skuId])).rows)
      .toEqual([{ mode: "one_time", min_qty: 1, amount_kind: "gross", unit_price_minor: 1733 }]);
    const priceBefore = (await pool.query("SELECT id,active,unit_price_minor FROM public.price_entries WHERE variant_id=$1", [data.skuId])).rows;
    const priceKey = randomUUID();
    const replacement = pricing.canonicalCatalogPriceSetupCommand({ ...data.payload.skus[0]!.priceOperations![0]!,
      commandKey: priceKey, unitPriceMinor: 1999, expected: { entryId: priceBefore[0]!.id, unitPriceMinor: 1733 } });
    await expect(transaction(publisher, async db => {
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, role: "authenticated" })]);
      expect((await db.query("SELECT public.catalog_price_setup_apply($1,$2) AS result", [replacement, hash(replacement)])).rows[0]?.result)
        .toMatchObject({ outcome: "committed", receipt: { current: { unitPriceMinor: 1999 } } });
    })).rejects.toMatchObject(bindingRefusal);
    expect((await pool.query("SELECT id,active,unit_price_minor FROM public.price_entries WHERE variant_id=$1", [data.skuId])).rows).toEqual(priceBefore);
    expect((await pool.query("SELECT 1 FROM public.catalog_price_setup_receipts WHERE idempotency_key=$1", [priceKey])).rowCount).toBe(0);
    expect((await pool.query("SELECT attribute_key,text_value FROM public.catalog_attribute_projection WHERE sku_id=$1", [data.skuId])).rows)
      .toEqual([{ attribute_key: "finish", text_value: "matte" }]);
    expect((await pool.query(`SELECT e.event_type, e.idempotency_key=h.publication_id::text AS matches
      FROM public.outbox_events e JOIN public.catalog_publication_heads h ON h.product_id=e.aggregate_id
      WHERE e.aggregate_id=$1`, [data.productId])).rows).toEqual([{ event_type: "catalog.publication.committed", matches: true }]);

    // Every statement succeeds. The real COMMIT on the publishing connection refuses it.
    for (const [sql, args] of [
      ["UPDATE public.catalog_products SET name='Unbound product' WHERE id=$1", [data.productId]],
      ["UPDATE public.catalog_skus SET status='archived' WHERE id=$1", [data.skuId]],
      ["DELETE FROM public.catalog_sku_identifiers WHERE catalog_sku_id=$1", [data.skuId]],
      [`INSERT INTO public.catalog_product_document_revisions
        (product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest)
        VALUES ($1,2,'example:document.v1','unbound','{}','example:source','{}',$2)`, [data.productId, "0".repeat(64)]],
      [`INSERT INTO public.catalog_attribute_projection
        (sku_id,publication_revision,attribute_key,definition_version,value_ordinal,value_kind,text_value)
        VALUES ($1,2,'finish',1,1,'enum','matte')`, [data.skuId]],
    ] as const) {
      let wrote = false;
      await expect(transaction(publisher, async db => {
        expect(await db.query(sql, [...args])).toMatchObject({ rowCount: 1 });
        wrote = true;
      })).rejects.toMatchObject(bindingRefusal);
      expect(wrote).toBe(true);
    }

    const repaired = structuredClone(data.payload);
    delete repaired.skus[0]!.priceOperations;
    repaired.product.sharedContent.catalogAction = "revise";
    repaired.publication = { kind: "compensation", evidence: {},
      operations: [{ op: "set_product_presentation", productSlug: data.slug, presentation: {} }] };
    await save(data, 2, repaired);
    const compensation = await prepare(data, 2, head);
    expect(await api.execute(compensation.approve, who), sqlFailure).toMatchObject({ outcome: "committed" });
    // Keep the runner's approved write set so the next attempt exercises the SQL check at COMMIT.
    const recorder = "SELECT public.catalog_publication_record_command($1::jsonb) AS result";
    const projection: { sql: string; args: unknown[] | undefined }[] = [];
    let recorded: unknown[] | undefined;
    const preview = native((db, sql, args) => {
      if (sql === recorder) {
        recorded = args;
        throw new Error("Discard the tentative compensation");
      }
      if (/^(INSERT|UPDATE|DELETE) /u.test(sql)) projection.push({ sql, args });
      return db.query(sql, args);
    }, publisher);
    await preview.execute(compensation.publish, (await preview.authorize(actor))!);
    expect(recorded).toHaveLength(1);
    await save(data, 3, repaired);
    await expect(transaction(publisher, async db => {
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, role: "authenticated" })]);
      for (const { sql, args } of projection) await db.query(sql, args);
      expect((await db.query(recorder, recorded)).rows[0]?.result).toEqual(expect.any(String));
    })).rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_draft_advanced" });
    expect(await readers.reads.current(data.productId)).toMatchObject({ outcome: "found", head });

    await pool.query("UPDATE public.catalog_products SET name='Unpublished drift' WHERE id=$1", [data.productId]);
    const currentCompensation = await prepare(data, 3, head);
    expect(await api.execute(currentCompensation.approve, who), sqlFailure).toMatchObject({ outcome: "committed" });
    expect(await api.execute(currentCompensation.publish, who), sqlFailure)
      .toMatchObject({ outcome: "committed", receipt: { previousHead: head, head: { revision: 2 }, changes: [] } });
  } finally { await publisher.end(); }
});

publicationTest("commits approval and publication with a session temporary uuid type", async ({ publicationUrl }) => {
  const data = authored(27);
  await save(data, 1);
  const prepared = await prepare(data, 1, null);
  const publisher = new Pool({ connectionString: publicationUrl, max: 1, idleTimeoutMillis: 0 });
  try {
    await publisher.query("CREATE TYPE pg_temp.uuid AS (value text)");
    // Caller-side casts use the built-in type. The functions' own paths must protect their casts.
    await publisher.query("SET search_path = pg_catalog, public, pg_temp");
    let sqlFailure: string | undefined;
    const api = native(async (db, sql, args) => db.query(sql, args).catch((error: Error) => {
      sqlFailure = error.message;
      throw error;
    }), publisher);
    const who = (await api.authorize(actor))!;
    expect(await api.execute(prepared.approve, who), sqlFailure).toMatchObject({
      outcome: "committed", receipt: { productId: data.productId, postStateDigest: prepared.approve.postStateDigest },
    });
    expect(await api.execute(prepared.publish, who), sqlFailure).toMatchObject({
      outcome: "committed", receipt: { productId: data.productId, head: { revision: 1 },
        changes: [{ variantId: data.skuId, sku: data.code, variantRevision: 1 }] },
    });
  } finally { await publisher.end(); }
});

publicationTest("publishes and reads a governed genesis through the restricted login", async ({ publicationUrl }) => {
  const publisher = new Pool({ connectionString: publicationUrl });
  try {
    const data = authored(85), draft: CatalogDraftPayloadV4 = { ...data.payload, schemaVersion: 4 };
    await save(data, 1, draft);
    const commands = await prepare(data, 1, null);
    const api = native(undefined, publisher), who = (await api.authorize(actor))!;
    expect(await api.execute(commands.approve, who)).toMatchObject({ outcome: "committed" });
    const result = await api.execute(commands.publish, who);
    if (result.outcome !== "committed" || !("head" in result.receipt)) throw Error(JSON.stringify(result));
    const reads = createPostgresCatalogPublicationReads({ transactions: { run: work => transaction(publisher, work) },
      authorizeHuman: async () => ({ ok: true, userId: actor, role: "admin", isMachineActor: false }) });
    expect(await reads.readbackV3(result.receipt.head)).toMatchObject({ outcome: "page", schemaVersion: 3 });
  } finally { await publisher.end(); }
});

it("refuses governed archive and the five legacy lifecycle RPCs before changing live data", async () => {
  const data = authored(83), api = native(), who = (await api.authorize(actor))!;
  const payload: CatalogDraftPayloadV4 = { ...structuredClone(data.payload), schemaVersion: 4 };
  await save(data, 1, payload);
  const initial = await prepare(data, 1, null);
  expect(await api.execute(initial.approve, who)).toMatchObject({ outcome: "committed" });
  const issued = await api.execute(initial.publish, who);
  if (issued.outcome !== "committed" || !("head" in issued.receipt)) throw Error(JSON.stringify(issued));
  payload.product.sharedContent.catalogAction = "revise";
  payload.publication.operations = [{ op: "set_sku_lifecycle", skuCode: data.code, expectedState: "draft", state: "archived" }];
  await save(data, 2, payload);
  const preview = await api.prepareCandidate({ draftId: data.draftId, draftRevision: 2, expectedHead: issued.receipt.head }, who);
  expect(preview).toMatchObject({ issues: expect.arrayContaining([{ code: "catalog_publication_v3_compile_archive_refused", path: "publication.operations.0" }]) });
  payload.publication.operations = [{ op: "set_product_lifecycle", productSlug: data.slug, expectedState: "draft", state: "archived", children: [] }];
  await save(data, 3, payload);
  const archive = await prepare(data, 3, issued.receipt.head);
  expect(await api.execute(archive.approve, who)).toMatchObject({ outcome: "committed" });
  expect(await api.execute(archive.publish, who)).toMatchObject({ outcome: "validation_issue",
    reason: "catalog_archive_barrier_unavailable", message: expect.stringContaining("Keep the product or SKU withdrawn") });
  for (const routine of ["admin_archive_catalog_sku", "admin_activate_catalog_product", "admin_archive_catalog_product",
    "admin_restore_catalog_product", "admin_deactivate_catalog_product"])
    await expect(pool.query(`SELECT public.${routine}($1,$2,'preview')`, [actor, "missing"]))
      .rejects.toMatchObject({ code: "42501", message: "legacy_catalog_mutation_fenced" });
  expect((await pool.query("SELECT revision FROM public.catalog_publication_heads WHERE product_id=$1", [data.productId])).rows)
    .toEqual([{ revision: 1 }]);
});

it("requires explicit adoption before a legacy issued head can carry v4 effects", async () => {
  const data = authored(84), api = native(), who = (await api.authorize(actor))!;
  await save(data, 1);
  const initial = await prepare(data, 1, null);
  expect(await api.execute(initial.approve, who)).toMatchObject({ outcome: "committed" });
  const issued = await api.execute(initial.publish, who);
  if (issued.outcome !== "committed" || !("head" in issued.receipt)) throw Error(JSON.stringify(issued));
  const reads = createPostgresCatalogPublicationReads({ transactions: { run: work => transaction(pool, work) },
    authorizeHuman: async () => ({ ok: true, userId: actor, role: "admin", isMachineActor: false }) });
  expect(await reads.readbackV3(issued.receipt.head)).toMatchObject({ outcome: "unsupported",
    reason: "catalog_publication_use_readback_v2", message: "Read this legacy issue with readbackV2." });
  const payload: CatalogDraftPayloadV4 = { ...structuredClone(data.payload), schemaVersion: 4 };
  payload.product.sharedContent.catalogAction = "revise";
  payload.publication.operations = [{ op: "set_product_lifecycle", productSlug: data.slug, expectedState: "draft", state: "active", children: [] }];
  await save(data, 2, payload);
  const preview = await api.prepareCandidate({ draftId: data.draftId, draftRevision: 2, expectedHead: issued.receipt.head }, who);
  const legacyRemedy = {
    code: "catalog_lifecycle_evidence_unavailable", message: expect.stringContaining("Keep revising it with schema-3 drafts"),
  };
  expect(preview).toMatchObject({ preparation: { structural: { issues: expect.arrayContaining([
    expect.objectContaining({ ...legacyRemedy, path: "publication" }),
    expect.objectContaining({ ...legacyRemedy, path: "publication.operations" }),
  ]) } } });
  expect(preview).not.toHaveProperty("preparation.postStateDigest");
  expect(await api.execute(initial.publish, who)).toEqual({ ...issued, outcome: "replayed" });
});
