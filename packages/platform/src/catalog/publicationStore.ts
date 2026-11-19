import { createCatalogPriceSetupTransactionWriter, CatalogPriceSetupTransactionError } from "../pricing/index.js";
import { createHash, randomUUID } from "node:crypto";
import type { PgQueryExecutor } from "../data/index.js";
import { canonicalizeCatalogCombinationV2 } from "./variantCombination.js";
import { z } from "./validation.js";
import type { VerifiedCatalogPublisher, CatalogPublicationPort, CatalogPublicationReadPort } from "./publicationPorts.js";
import type { CatalogPublicationDependencies, VerifiedCatalogReadScope } from "./publicationPortsV2.js";
import type { CatalogDecisionCommandV2, CatalogDecisionReceiptV2, CatalogFullPublicationV2, CatalogPublicationReceiptV2,
  CatalogPublicationManifestV2, CatalogSkuRevisionRef, CatalogRetainedSourceBinding, CatalogPublicationFailure, CatalogMembershipPage, CatalogMembershipQuery, CatalogActivationReadiness } from "./contracts/publication.js";
import type { CatalogHeadRef, CatalogPublishCommand, CatalogPublicationReceipt } from "./contracts/lifecycle.js";
import type { CatalogDraftPayloadV3 } from "./contracts/draftV3.js";
import type { CatalogProductState as CatalogPublishedProduct, CatalogSkuState as CatalogPublishedSku, CatalogLifecycleStoredRecord as CatalogDraftPublicationStoredRecord, CatalogDraftPayloadV4, CatalogFullPublicationV3 } from "./contracts/lifecycleV2.js";
import { CATALOG_PUBLICATION_LIMITS } from "./contracts/publication.js";
import { catalogLifecycleStoredRecordSchema as catalogDraftPublicationStoredRecordSchema, catalogLifecycleValidationPayload as catalogDraftV3ValidationPayload, catalogLifecycleProjectionV2 } from "./lifecycleV2.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { validateCatalogDraftV2 } from "./draftV2Validation.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
import { catalogProductTypeRefSchema, catalogQuantitySchema } from "./productTypeSchemas.js";
import { catalogDocumentRevisionRefSchema } from "./foundationSchemas.js";
import type { CatalogProductTypeRegistry } from "./contracts/productTypes.js";
import { validateCatalogPublicationAttributes } from "./attributeValidation.js";
import { prepareCatalogAttributeProjection } from "./attributeProjection.js";
import { catalogPublishedProductSchema, catalogSkuStateSchema as catalogPublishedSkuSchema, catalogPublicationStateSchema as catalogPublicationManifestSchema, catalogPublicationIntegralGrams, assertCatalogPublicationMassInputs, compileCatalogPublication, CatalogPublicationError, publicationRefuse, catalogLifecycleWithdrawalOnly, assertGovernedSkuRoster, assertCatalogPublicationGrossMass,
  publicationJson, publicationDigest, type CatalogPublicationDocument } from "./publicationValidation.js";

const id = z.guid().refine(value => value === value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const key = z.string().min(1).max(240).refine(value => value.trim() === value);
const headSchema = z.object({ publicationId: id, revision, documentDigest: digest }).strict();
const commandSchema = z.object({ schemaVersion: z.literal(2).optional(), commandKey: key, productId: id,
  candidateRef: z.string().min(1).max(200), candidateDigest: digest, expectedHead: headSchema.nullable(),
  changes: z.array(z.object({ variantId: id, expectedRevision: z.number().int().min(0).max(2_147_483_646), state: z.enum(["active", "withdrawn"]) }).strict()).max(10_000),
}).strict();
const decisionSchema = z.object({ schemaVersion: z.literal(2), action: z.enum(["approve", "revoke"]), productId: id, commandKey: key,
  candidateRef: z.string().min(1).max(200), candidateDigest: digest, reason: z.string().min(1).max(1000).refine(value => value.trim() === value) }).strict();
const obligationResultSchema = z.discriminatedUnion("outcome", [
  z.object({ schemaVersion: z.literal(2), outcome: z.literal("complete"), obligations: z.array(z.object({
    family: z.enum(["template", "pending_activation", "frozen_renewal", "outstanding_order", "replacement", "stock_wait", "graduation"]),
    sourceId: id, subscriptionId: id.nullable(), skuId: id, skuCode: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/u), skuRevisionId: id.nullable(),
  }).strict()) }).strict(),
  z.object({ schemaVersion: z.literal(2), outcome: z.literal("unknown"), reason: z.literal("catalog_obligation_evidence_unknown") }).strict(),
  z.object({ schemaVersion: z.literal(2), outcome: z.literal("unavailable"), reason: z.literal("catalog_obligation_evidence_unavailable") }).strict(),
]);
const bindingSchema = z.object({ kind: z.enum(["account", "order", "fulfilment"]), sourceId: id, lineId: id,
  productId: id, skuId: id, skuRevisionId: id, publicationId: id, documentRevisionId: id }).strict();
const equal = (a: unknown, b: unknown) => publicationJson(a) === publicationJson(b);
const require = (value: unknown, code: string, outcome?: CatalogPublicationError["outcome"]) => { if (!value) publicationRefuse(code, outcome); };
const tuple = (db: PgQueryExecutor, sql: string, values: unknown[] = []) => db.query(sql, values).then(result => result.rows);
const membershipQuery = z.object({
  offerVersion: z.string().trim().min(1).max(80),
  cursor: z.object({ skuId: z.guid().transform(value => value.toLowerCase()), headDigest: digest }).strict().nullable(),
  limit: z.number().int().min(1).max(100),
  mode: z.enum(["one_time", "subscription"]).nullish(),
}).strict();
const logistics = z.string().min(1).max(500).refine(value => value === value.trim()).nullable();
const memberRow = z.object({
  skuId: id, skuCode: z.string().min(1).max(160), productId: id, productSlug: z.string().min(1).max(80),
  productType: catalogProductTypeRefSchema, netContent: catalogQuantitySchema, netWeightG: z.number().int().min(1).max(9_999_999),
  sellableStandalone: z.boolean(), sellableInSubscription: z.boolean(),
  presentation: z.record(z.string(), z.json()).nullable(), logisticsRef: logistics, head: headSchema,
  skuRevisionId: id, document: catalogDocumentRevisionRefSchema,
}).strict();
const membershipRow = z.discriminatedUnion("protocol", [
  z.object({ protocol: z.literal("legacy"), headDigest: z.null(), items: z.tuple([]), nextCursor: z.null() }).strict(),
  z.object({ protocol: z.literal("governed"), headDigest: digest, items: z.array(memberRow).max(100), nextCursor: id.nullable() }).strict(),
]);
const readinessSkuCode = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,79}$/u);
const readinessCodes = z.array(readinessSkuCode).min(1).max(100).refine(codes => new Set(codes).size === codes.length);
const readinessReasons = z.array(z.string().regex(/^[a-z][a-z0-9_]{1,119}$/u)).max(32);
const readinessVerdict = z.object({ ready: z.boolean(), reasons: readinessReasons }).strict()
  .refine(item => item.ready === (item.reasons.length === 0));
const readinessRow = z.object({
  protocol: z.literal("governed"),
  headDigest: digest,
  items: z.array(z.object({
    skuCode: readinessSkuCode, skuId: id.nullable(), logisticsRef: logistics, ...readinessVerdict.shape,
    evidence: z.object({ product: catalogPublishedProductSchema, sku: catalogPublishedSkuSchema }).strict().nullable(),
  }).strict().refine(item => item.ready === (item.reasons.length === 0)
    && (!item.ready || item.skuId !== null && item.logisticsRef !== null))).max(100),
}).strict();
const invalidRead = "catalog_publication_read_invalid";
function singletonRead<T>(rows: Record<string, unknown>[], schema: z.ZodType<T>): T {
  const value = schema.safeParse(rows.length === 1 ? rows[0]!.result : undefined);
  return value.success ? value.data : publicationRefuse(invalidRead, "dependency_unavailable");
}
function scopedReadFailure(error: unknown): CatalogPublicationFailure {
  if (error instanceof CatalogPublicationError) return failure(error);
  if (error instanceof Error && "code" in error) {
    if (error.code === "40001") return { outcome: "conflict", reason: error.message === "catalog_publication_live_drift"
      ? error.message : "catalog_publication_head_moved" };
    if (error.code === "55000" && error.message === "catalog_publication_not_adopted") return { outcome: "unsupported", reason: error.message };
    if (error.code === "22023" && error.message === "catalog_offer_memberships_page_input_invalid")
      return { outcome: "validation_issue", reason: error.message };
    if (error.code === "42501") return { outcome: "unauthorized", reason: "catalog_publication_read_not_authorized" };
  }
  return failure(error);
}

/** On a trusted server executor, resolve the page inside the caller's catalogue snapshot.
 * @experimental
 */
export async function readPostgresCatalogMembershipPage(db: PgQueryExecutor, registry: CatalogProductTypeRegistry,
  input: CatalogMembershipQuery): Promise<CatalogMembershipPage | CatalogPublicationFailure> {
  try {
    const query = membershipQuery.safeParse(input);
    if (!query.success) return publicationRefuse("catalog_offer_memberships_page_input_invalid");
    const { offerVersion, cursor, limit, mode } = query.data;
    const page = singletonRead(await tuple(db, "SELECT public.catalog_offer_memberships_page($1,$2,$3,$4,$5) AS result",
      [offerVersion, cursor?.skuId ?? null, limit, mode ?? null, cursor?.headDigest ?? null]), membershipRow);
    require(!cursor || page.headDigest === cursor.headDigest, "catalog_publication_head_moved", "conflict");
    if (page.protocol === "legacy") return page;

    const ids = page.items.map(item => item.skuId);
    require(page.items.length <= limit && new Set(ids).size === ids.length
      && new Set(page.items.map(item => item.skuCode)).size === ids.length
      && ids.every((value, index) => index === 0 || ids[index - 1]! <= value)
      && (!cursor || ids.every(value => cursor.skuId < value))
      && (page.nextCursor === null || ids.length === limit && page.nextCursor === ids.at(-1)), invalidRead, "dependency_unavailable");
    const items = page.items.map(({ productType, netContent, ...item }) => {
      const eligible = mode === "one_time" ? item.sellableStandalone : mode === "subscription"
        ? item.sellableInSubscription : item.sellableStandalone || item.sellableInSubscription;
      require(eligible && item.document.productId === item.productId && item.document.digest === item.head.documentDigest,
        invalidRead, "dependency_unavailable");
      const definition = registry.resolve(productType);
      if (!definition) return publicationRefuse("catalog_publication_readiness_unavailable", "dependency_unavailable");
      require(catalogPublicationIntegralGrams(netContent, definition) === String(item.netWeightG),
        "catalog_publication_live_drift", "conflict");
      return item;
    });
    return { ...page, items, nextCursor: page.nextCursor === null ? null : { skuId: page.nextCursor, headDigest: page.headDigest } };
  } catch (error) { return scopedReadFailure(error); }
}

function failure(error: unknown): CatalogPublicationFailure {
  if (error instanceof CatalogPriceSetupTransactionError) return error.refusal;
  if (error instanceof CatalogPublicationError) return { outcome: error.outcome, reason: error.code };
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "55P03" || code === "40P01") return { outcome: "conflict", reason: "catalog_publication_busy" };
  if (code === "23505") return { outcome: "conflict", reason: "catalog_publication_identity_conflict" };
  if (code === "42501") return { outcome: "unauthorized", reason: "publisher_not_authorized" };
  return { outcome: "dependency_unavailable", reason: "publication_authority_unavailable" };
}
interface StoredPublication { id: string; product_id: string; revision: number; document_revision_id: string; canonical_state: string; digest: string; committed_at: string }
interface RetainedState { head: CatalogHeadRef | null; publication: StoredPublication | null; product: CatalogPublishedProduct | null;
  skus: CatalogPublishedSku[]; references: CatalogSkuRevisionRef[]; documents: CatalogPublicationDocument[] }
/** No default binding. The host supplies trusted authorization, a single-connection transaction and installed adapters.
 * @experimental
 */
export function createPostgresCatalogPublication<Context>(deps: CatalogPublicationDependencies<Context>) {
  const actors = new WeakMap<object, string>(), readers = new WeakMap<object, Context>();
  const prices = deps.prices ?? createCatalogPriceSetupTransactionWriter<VerifiedCatalogPublisher>(capability => {
    const actorId = actors.get(capability); require(actorId, "publisher_not_authorized", "unauthorized"); return actorId!;
  });
  async function authorize(context: Context): Promise<VerifiedCatalogPublisher | null> {
    const auth = await deps.authorizeHuman(context);
    if (!auth.ok || auth.role !== "admin" || auth.isMachineActor !== false || !id.safeParse(auth.userId).success) return null;
    const capability = Object.freeze({}); actors.set(capability, auth.userId); return capability as VerifiedCatalogPublisher;
  }
  async function actor(db: PgQueryExecutor, capability: VerifiedCatalogPublisher): Promise<string> {
    const actorId = typeof capability === "object" && capability !== null ? actors.get(capability) : undefined;
    require(actorId, "publisher_not_authorized", "unauthorized");
    const rows = await tuple(db, "SELECT public.platform_human_membership_is_administrator($1::uuid) AS allowed", [actorId]);
    require(rows.length === 1 && rows[0]!.allowed === true, "publisher_not_authorized", "unauthorized");
    return actorId!;
  }
  async function load(db: PgQueryExecutor, productId: string, historical?: CatalogHeadRef, allowDrift = false, documentRevisions: readonly number[] = [], expected?: { command: CatalogHeadRef | null; candidate: CatalogHeadRef | null }): Promise<RetainedState> {
    // One statement binds the head, full immutable roster/documents and current projections to the same snapshot.
    const rows = await tuple(db, `SELECT (SELECT to_jsonb(h) FROM public.catalog_publication_heads h WHERE h.product_id=$1::uuid) AS head,
      (SELECT to_jsonb(p) FROM public.catalog_products p WHERE p.id=$1::uuid) AS live_product,
      coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.catalog_skus s WHERE s.product_id=$1::uuid),'[]'::jsonb) AS live_skus,
      (SELECT to_jsonb(p) FROM public.catalog_publications p WHERE p.product_id=$1::uuid AND p.id=coalesce($2::uuid,(SELECT publication_id FROM public.catalog_publication_heads WHERE product_id=$1::uuid))) AS publication,
      coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM public.catalog_sku_revisions r WHERE r.product_id=$1::uuid AND r.id IN (
        SELECT (entry->>'revisionId')::uuid FROM public.catalog_publications p, jsonb_array_elements(p.canonical_state::jsonb->'skus') entry
        WHERE p.id=coalesce($2::uuid,(SELECT publication_id FROM public.catalog_publication_heads WHERE product_id=$1::uuid)))),'[]'::jsonb) AS revisions,
      coalesce((SELECT jsonb_agg(to_jsonb(d)) FROM public.catalog_product_document_revisions d WHERE d.product_id=$1::uuid AND (
        d.id=(SELECT document_revision_id FROM public.catalog_publications p WHERE p.id=coalesce($2::uuid,(SELECT publication_id FROM public.catalog_publication_heads WHERE product_id=$1::uuid)))
        OR d.revision_no=ANY($3::integer[]) OR ($2::uuid IS NULL AND d.revision_no=(SELECT max(revision_no) FROM public.catalog_product_document_revisions WHERE product_id=$1::uuid)))),'[]'::jsonb) AS documents`,
    [productId, historical?.publicationId ?? null, documentRevisions]);
    require(rows.length === 1, "catalog_publication_read_invalid", "dependency_unavailable");
    const row = rows[0]!, publication = row.publication as StoredPublication | null;
    const documents = (row.documents as Record<string, unknown>[]).map(document => ({ reference: { id: document.id, productId: document.product_id,
      revisionNo: document.revision_no, schemaId: document.schema_id, documentRef: document.document_ref, sourceRef: document.source_ref, digest: document.digest },
    canonicalText: typeof document.canonical_text === "string" ? document.canonical_text : "", provenance: document.provenance }) as CatalogPublicationDocument);
    const checkHead = (head: CatalogHeadRef | null) => { if (expected) require(equal(expected.command, expected.candidate) && equal(head, expected.command), "head_conflict", "conflict"); };
    if (!publication) {
      checkHead(null);
      require(!historical && row.live_product === null, "catalog_publication_lineage_unknown", "unsupported");
      return { head: null, publication: null, product: null, skus: [], references: [], documents };
    }
    require(publication.product_id === productId && publicationDigest(JSON.parse(publication.canonical_state)) === publication.digest
      && publicationJson(JSON.parse(publication.canonical_state)) === publication.canonical_state, "catalog_publication_manifest_invalid", "dependency_unavailable");
    const manifest = catalogPublicationManifestSchema.parse(JSON.parse(publication.canonical_state));
    require([2, 3].includes(manifest.schemaVersion) && manifest.product.id === productId && Array.isArray(manifest.skus), "catalog_publication_manifest_invalid", "dependency_unavailable");
    const document = documents.find(document => document.reference.id === publication.document_revision_id);
    require(document && equal(manifest.product.document, document.reference), "catalog_publication_document_invalid", "dependency_unavailable");
    require(createHash("sha256").update(document!.canonicalText).digest("hex") === document!.reference.digest,
      "catalog_publication_document_invalid", "dependency_unavailable");
    const head = { publicationId: publication.id, revision: publication.revision, documentDigest: document!.reference.digest };
    require(!historical || equal(head, historical), "head_conflict", "conflict");
    checkHead(head);
    const revisions = row.revisions as Record<string, unknown>[], seen = new Set<string>();
    const skus = manifest.skus.map(reference => {
      const stored = revisions.find(stored => stored.id === reference.revisionId && stored.sku_id === reference.skuId && stored.revision === reference.revision);
      require(stored && stored.digest === reference.digest && typeof stored.full_facts === "string" && !seen.has(reference.skuId), "catalog_publication_sku_revision_invalid", "dependency_unavailable");
      seen.add(reference.skuId);
      const parsed = catalogPublishedSkuSchema.parse(JSON.parse(stored!.full_facts as string));
      require(("schemaVersion" in parsed ? 3 : 2) === manifest.schemaVersion, "catalog_publication_sku_revision_invalid", "dependency_unavailable");
      require(publicationJson(parsed, CATALOG_PUBLICATION_LIMITS.skuBytes) === stored!.full_facts
        && publicationDigest(parsed, CATALOG_PUBLICATION_LIMITS.skuBytes) === reference.digest && parsed.id === reference.skuId && parsed.productId === productId,
      "catalog_publication_sku_revision_invalid", "dependency_unavailable");
      return parsed;
    });
    if (manifest.schemaVersion === 3) assertGovernedSkuRoster(skus);
    if (!historical && !allowDrift) {
      const live = row.live_product as Record<string, unknown> | null, liveSkus = row.live_skus as Record<string, unknown>[];
      require(live && equal(live.publication_facts, manifest.product) && live.slug === manifest.product.slug && live.name === manifest.product.name
        && live.status === manifest.product.status && live.primary_sku_id === manifest.product.primarySkuId && live.current_document_revision_id === manifest.product.document?.id
        && liveSkus.length === skus.length && skus.every(sku => liveSkus.some(live => live.id === sku.id && equal(live.publication_facts, sku)
          && live.sku === sku.code && live.title === sku.title && live.status === sku.status && live.sellable_standalone === sku.sellableStandalone
          && live.sellable_in_subscription === sku.sellableInSubscription && live.min_order_qty === sku.minQuantity && live.is_addon === sku.isAddon)),
      "catalog_publication_live_drift", "conflict");
    }
    if (!historical && !allowDrift) {
      try { await assertProjection(db, { product: manifest.product, skus }); }
      catch (error) { if (error instanceof CatalogPublicationError) publicationRefuse("catalog_publication_live_drift", "conflict"); throw error; }
    }
    return { head, publication, product: manifest.product, skus, references: manifest.skus, documents };
  }
  async function commandGuards(db: PgQueryExecutor, productId: string, candidateRef: string, candidateDigest: string, commandKey: string) {
    const referenceDigest = publicationDigest([candidateRef, candidateDigest]);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`catalog-decision:${referenceDigest}`]);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`catalog-command:${productId}:${commandKey}`]);
    return referenceDigest;
  }
  async function receipt(db: PgQueryExecutor, productId: string, commandKey: string, kind: string, fingerprint: string, actorId: string) {
    const rows = await tuple(db, "SELECT * FROM public.catalog_operator_receipts WHERE scope_id=$1::uuid AND command_key=$2", [productId, commandKey]);
    if (!rows.length) return null;
    require(rows.length === 1 && rows[0]!.actor_id === actorId, "catalog_publication_operator_mismatch", "unauthorized");
    require(rows[0]!.kind === kind && rows[0]!.fingerprint === fingerprint, "catalog_publication_command_key_reused", "conflict");
    if (kind === "publish") return storedPublishReceipt(db, rows[0]!);
    const result = checkedDecisionReceipt(rows[0]!.result);
    const { fingerprint: _fingerprint, actorId: _actorId, decidedAt: _decidedAt, ...originalCommand } = result;
    require(publicationDigest([originalCommand, actorId]) === fingerprint, "catalog_publication_receipt_invalid", "dependency_unavailable");
    require(result.productId === productId && result.commandKey === commandKey && result.fingerprint === fingerprint && result.actorId === actorId
      && result.action === kind, "catalog_publication_receipt_invalid", "dependency_unavailable");
    return result;
  }
  async function storedPublishReceipt(db: PgQueryExecutor, row: Record<string, unknown>) {
    const result = checkedReceipt(row.result);
    require(result.productId === row.scope_id && result.commandKey === row.command_key && result.fingerprint === row.fingerprint
      && result.actorId === row.actor_id && result.head.publicationId === row.publication_id, "catalog_publication_receipt_invalid", "dependency_unavailable");
    const publications = await tuple(db, `SELECT p.revision,p.digest,d.digest AS document_digest,p.previous_id,previous.revision AS previous_revision,previous_document.digest AS previous_document_digest,
      to_char(p.committed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS committed_at
      FROM public.catalog_publications p JOIN public.catalog_product_document_revisions d ON d.id=p.document_revision_id AND d.product_id=p.product_id
      LEFT JOIN public.catalog_publications previous ON previous.id=p.previous_id AND previous.product_id=p.product_id
      LEFT JOIN public.catalog_product_document_revisions previous_document ON previous_document.id=previous.document_revision_id AND previous_document.product_id=previous.product_id
      WHERE p.id=$1::uuid AND p.product_id=$2::uuid`, [result.head.publicationId, result.productId]);
    require(publications.length === 1 && result.head.revision === publications[0]!.revision && result.head.documentDigest === publications[0]!.document_digest
      && result.publicationDigest === publications[0]!.digest && result.committedAt === publications[0]!.committed_at
      && equal(result.previousHead, publications[0]!.previous_id === null ? null : { publicationId: publications[0]!.previous_id, revision: publications[0]!.previous_revision, documentDigest: publications[0]!.previous_document_digest }),
    "catalog_publication_receipt_invalid", "dependency_unavailable");
    publicationJson({ outcome: "found", receipt: result }, CATALOG_PUBLICATION_LIMITS.receiptBytes);
    return result;
  }
  async function candidate(db: PgQueryExecutor, reference: string, expectedDigest: string, productId: string) {
    const match = /^v1:([0-9a-f-]{36})@([1-9][0-9]*)\/(unpublished|([0-9a-f-]{36})@([1-9][0-9]*))$/u.exec(reference);
    require(match && id.safeParse(match[1]).success && revision.safeParse(Number(match[2])).success, "candidate_invalid");
    let expectedHead: CatalogHeadRef | null = null;
    if (match![3] !== "unpublished") {
      const rows = await tuple(db, `SELECT p.id,p.revision,d.digest FROM public.catalog_publications p
        JOIN public.catalog_product_document_revisions d ON d.id=p.document_revision_id AND d.product_id=p.product_id WHERE p.id=$1::uuid AND p.product_id=$2::uuid`, [match![4], productId]);
      require(rows.length === 1 && rows[0]!.revision === Number(match![5]), "head_conflict", "conflict");
      expectedHead = headSchema.parse({ publicationId: rows[0]!.id, revision: rows[0]!.revision, documentDigest: rows[0]!.digest });
    }
    const rows = await tuple(db, "SELECT public.catalog_draft_record($1::uuid,$2::integer) AS record", [match![1], Number(match![2])]);
    const header = z.object({ payload: z.object({ product: z.object({ type: catalogProductTypeRefSchema }) }) }).safeParse(rows[0]?.record);
    if (header.success) {
      const definition = deps.registry.resolve(header.data.payload.product.type);
      if (definition) assertCatalogPublicationMassInputs((rows[0]!.record as { payload: unknown }).payload, definition);
    }
    const record = catalogDraftPublicationStoredRecordSchema.parse(rows[0]?.record);
    require(record.productId === productId && record.payload.schemaVersion >= 3, "candidate_invalid");
    const payload = record.payload as CatalogDraftPayloadV3 | CatalogDraftPayloadV4, definition = deps.registry.resolve(payload.product.type);
    require(definition && definition.validatorRef, "catalog_definition_drift");
    const installed = await tuple(db, "SELECT definition_digest FROM public.catalog_type_versions WHERE type_key=$1 AND version=$2", [definition!.key, definition!.version]);
    require(installed.length === 1 && installed[0]!.definition_digest === catalogDefinitionDigest(definition!), "catalog_definition_drift");
    const computed = createHash("sha256").update('["catalog-candidate",1,').update(canonicalCatalogDraftJson(payload)).update(",")
      .update(canonicalCatalogDraftJson([{ ...payload.product.type, definitionDigest: installed[0]!.definition_digest }])).update(",")
      .update(canonicalCatalogDraftJson(expectedHead)).update("]").digest("hex");
    require(computed === expectedDigest, "candidate_digest_mismatch", "conflict");
    return { record, payload, definition: definition!, expectedHead };
  }
  // Writer, read and retained methods are appended below before the returned factory.
  async function lockCandidate(db: PgQueryExecutor, prepared: Awaited<ReturnType<typeof candidate>>, before: RetainedState) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`catalog-definition:${prepared.definition.key}@${prepared.definition.version}`]);
    await db.query("SELECT type_key FROM public.catalog_type_versions WHERE type_key=$1 AND version=$2 FOR SHARE", [prepared.definition.key, prepared.definition.version]);
    if (prepared.definition.taxClass) {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`catalog-tax:${prepared.definition.taxClass}`]);
      const rows = await tuple(db, "SELECT key FROM public.catalog_tax_classes WHERE key=$1 AND status='active' FOR SHARE", [prepared.definition.taxClass]);
      require(rows.length === 1, "catalog_tax_class_unavailable");
    }
    const explicit = prepared.payload.publication.evidence.drafts ?? [];
    const claims = [prepared.record, ...explicit, ...(before.product ? [before.product.source] : []), ...before.skus.map(sku => sku.source)];
    const draftIds = [...new Set(claims.map(claim => claim.draftId))].sort();
    for (const draftId of draftIds) await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`catalog-draft:${draftId}`]);
    const heads = await tuple(db, "SELECT * FROM public.catalog_draft_heads WHERE draft_id=ANY($1::uuid[]) ORDER BY draft_id FOR NO KEY UPDATE", [draftIds]);
    for (const claim of [prepared.record, ...explicit]) require(heads.some(head => head.draft_id === claim.draftId && head.revision === claim.revision && head.status === "open"), "catalog_publication_draft_advanced", "conflict");
    const retained: CatalogDraftPublicationStoredRecord[] = [];
    const distinct = new Set<string>();
    for (const claim of [...explicit, ...(before.product ? [before.product.source] : []), ...before.skus.map(sku => sku.source)]) {
      const key = `${claim.draftId}@${claim.revision}`;
      if (key === `${prepared.record.draftId}@${prepared.record.revision}`)
        require(claim.commandKey === prepared.record.commandKey && claim.fingerprint === prepared.record.fingerprint, "catalog_publication_source_mismatch");
      if (distinct.has(key) || key === `${prepared.record.draftId}@${prepared.record.revision}`) continue; distinct.add(key);
      const rows = await tuple(db, "SELECT public.catalog_draft_record($1::uuid,$2::integer) AS record", [claim.draftId, claim.revision]);
      const source = catalogDraftPublicationStoredRecordSchema.parse(rows[0]?.record);
      require(source.productId === prepared.record.productId && source.commandKey === claim.commandKey && source.fingerprint === claim.fingerprint, "catalog_publication_source_mismatch");
      retained.push(source);
    }
    const activationCodes = new Set(prepared.payload.publication.operations.flatMap(operation =>
      operation.op === "set_eligibility" && (operation.sellableStandalone || operation.sellableInSubscription) ? [operation.skuCode] : []));
    for (const sku of before.skus) if (sku.status === "active" && (sku.sellableStandalone || sku.sellableInSubscription)
      && prepared.payload.publication.operations.some(operation => operation.op === "set_offer_membership" && operation.admitted && operation.skuCode === sku.code
        || operation.op === "move_document_pointer" && operation.productSlug === before.product?.slug
        || operation.op === "set_product_status" && operation.status === "active" && operation.productSlug === before.product?.slug)) activationCodes.add(sku.code);
    const sources = [prepared.record, ...retained];
    const currentSourceCodes = new Set([...activationCodes, ...(prepared.payload.publication.evidence.media ?? []).map(claim => claim.skuCode)]);
    for (const code of currentSourceCodes) {
      const source = prepared.payload.skus.some(sku => sku.code === code) ? prepared.record
        : sources.find(source => explicit.some(claim => equal(claim, { draftId: source.draftId, revision: source.revision, commandKey: source.commandKey, fingerprint: source.fingerprint }))
          && source.payload.skus.some(sku => sku.code === code))
          ?? sources.find(source => { const claim = before.skus.find(sku => sku.code === code)?.source;
            return claim && source.draftId === claim.draftId && source.revision === claim.revision; });
      if (!source && !activationCodes.has(code)) continue;
      require(source, "catalog_publication_operation_source_missing");
      require(heads.some(head => head.draft_id === source!.draftId && head.revision === source!.revision && head.status === "open"), "catalog_publication_draft_advanced", "conflict");
    }
    const guard = await tuple(db, "SELECT pg_try_advisory_xact_lock(hashtextextended('catalog-publication-global',0)) AS allowed");
    require(guard[0]?.allowed === true, "catalog_publication_busy", "conflict");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`catalog-lineage:${prepared.record.productId}`]);
    await db.query("SELECT product_id FROM public.catalog_publication_heads WHERE product_id=$1::uuid FOR NO KEY UPDATE", [prepared.record.productId]);
    await db.query("SELECT id FROM public.catalog_products WHERE id=$1::uuid ORDER BY id FOR NO KEY UPDATE", [prepared.record.productId]);
    await db.query("SELECT id FROM public.catalog_skus WHERE product_id=$1::uuid ORDER BY id FOR NO KEY UPDATE", [prepared.record.productId]);
    return { retained, activationCodes };
  }
  function checkReadinessResult(result: { ready: boolean; reasons: readonly string[] }) {
    require(typeof result?.ready === "boolean" && Array.isArray(result.reasons) && result.reasons.length <= 100
      && new Set(result.reasons).size === result.reasons.length && result.reasons.every(reason => typeof reason === "string" && /^[a-z][a-z0-9_]{0,159}$/u.test(reason)),
    "catalog_publication_readiness_invalid", "dependency_unavailable");
    require(result.ready && result.reasons.length === 0, "catalog_publication_v3_activation_readiness_failed");
  }
  async function checkSkuReadiness(db: PgQueryExecutor, sku: CatalogPublishedSku, price: boolean) {
    const rows = await tuple(db, "SELECT public.catalog_publication_sku_reasons($1::uuid,$2::boolean) AS reasons", [sku.id, price]);
    require(rows.length === 1 && equal(rows[0]!.reasons, []), price ? "catalog_publication_v3_activation_readiness_failed" : "catalog_publication_v3_structural_readiness_failed");
  }
  async function checkGlobalReadiness(db: PgQueryExecutor) {
    require(deps.globalReadiness, "catalog_publication_readiness_unavailable", "dependency_unavailable");
    checkReadinessResult(await deps.globalReadiness!(db));
  }
  async function checkReadiness(db: PgQueryExecutor, state: { product: CatalogPublishedProduct; skus: CatalogPublishedSku[] }, payload: CatalogDraftPayloadV3, activation: boolean) {
    const operations = payload.publication.operations;
    const hasPresentation = operations.some(operation => operation.op === "set_product_presentation");
    const wholeProduct = operations.some(operation => operation.op === "move_document_pointer"
      || operation.op === "set_product_status" && operation.status === "active");
    const structural = state.skus.filter(sku => wholeProduct || operations.some(operation => operation.op === "create_sku" && operation.skuCode === sku.code
      || operation.op === "set_offer_membership" && operation.admitted && operation.skuCode === sku.code));
    const priced = state.skus.filter(sku => operations.some(operation => operation.op === "set_eligibility" && operation.skuCode === sku.code
      && (operation.sellableStandalone || operation.sellableInSubscription)) || structural.includes(sku) && sku.status === "active"
      && (sku.sellableStandalone || sku.sellableInSubscription) && sku.memberships.some(row => row.admitted));
    const check = (result: { ready: boolean; reasons: readonly string[] }, reason: string) => {
      require(typeof result?.ready === "boolean" && Array.isArray(result.reasons) && result.reasons.length <= 100
        && new Set(result.reasons).size === result.reasons.length && result.reasons.every(reason => typeof reason === "string" && /^[a-z][a-z0-9_]{0,159}$/u.test(reason)), "catalog_publication_readiness_invalid", "dependency_unavailable");
      require(result.ready && result.reasons.length === 0, reason);
    };
    for (const [skus, requirePrice] of [[structural, false], [priced, true]] as const) {
      const reason = requirePrice ? "catalog_publication_v3_activation_readiness_failed" : "catalog_publication_v3_structural_readiness_failed";
      for (const sku of skus) {
        const rows = await tuple(db, "SELECT public.catalog_publication_sku_reasons($1::uuid,$2::boolean) AS reasons", [sku.id, requirePrice]);
        require(rows.length === 1 && equal(rows[0]!.reasons, []), reason);
      }
      if (skus.length || !requirePrice && hasPresentation) check(await deps.readiness(db, { product: state.product, skus: [...skus] }, requirePrice), reason);
    }
    if (activation) {
      require(deps.globalReadiness, "catalog_publication_readiness_unavailable", "dependency_unavailable");
      check(await deps.globalReadiness!(db), "catalog_publication_v3_activation_readiness_failed");
    }
  }
  function governedReadiness(payload: CatalogDraftPayloadV4, skus: readonly CatalogPublishedSku[], before: readonly CatalogPublishedSku[]) {
    const operations = payload.publication.operations;
    const activatesParent = operations.some(op => op.op === "set_product_lifecycle" && op.state === "active");
    const restoresParent = operations.some(op => op.op === "restore_product");
    const movesDocument = operations.some(op => op.op === "move_document_pointer");
    const allChildren = activatesParent || restoresParent || movesDocument || operations.some(op => op.op === "create_product");
    const affected = new Set<string>(), admitted = new Set<string>();
    const enabled = new Map<string, Pick<CatalogPublishedSku, "sellableStandalone" | "sellableInSubscription">>();
    for (const op of operations) {
      if (op.op === "create_sku" || op.op === "set_derived_sku_facts" || op.op === "set_offer_membership" && op.admitted) affected.add(op.skuCode);
      if (op.op === "set_offer_membership" && op.admitted) admitted.add(op.skuCode);
      if (op.op === "set_eligibility" && (op.sellableStandalone || op.sellableInSubscription)) {
        const prior = enabled.get(op.skuCode);
        enabled.set(op.skuCode, { sellableStandalone: op.sellableStandalone || prior?.sellableStandalone === true,
          sellableInSubscription: op.sellableInSubscription || prior?.sellableInSubscription === true });
      }
    }
    const authored = new Set(enabled.keys());
    for (const sku of before) {
      if (sku.status === "active" && (sku.sellableStandalone || sku.sellableInSubscription)
        && (activatesParent || restoresParent || movesDocument || admitted.has(sku.code))) authored.add(sku.code);
    }
    const structurallyAffected = (sku: CatalogPublishedSku) => allChildren || affected.has(sku.code);
    const structural = skus.filter(structurallyAffected);
    const commercial = skus.filter(sku => enabled.has(sku.code) || structurallyAffected(sku) && "lifecycleState" in sku && sku.lifecycleState === "active"
      && (sku.sellableStandalone || sku.sellableInSubscription) && sku.memberships.some(row => row.admitted)).map(sku => {
      const intent = enabled.get(sku.code);
      // Readiness sees commanded sale modes even when a later effect clears them.
      return intent ? { ...sku, sellableStandalone: sku.sellableStandalone || intent.sellableStandalone,
        sellableInSubscription: sku.sellableInSubscription || intent.sellableInSubscription } : sku;
    });
    return { structural, commercial, authored, activatesParent, restoresParent, enabling: enabled.size > 0 };
  }
  async function checkGovernedReadiness(db: PgQueryExecutor, product: CatalogPublishedProduct, skus: CatalogPublishedSku[], evidence: ReturnType<typeof governedReadiness>) {
    for (const sku of evidence.structural) await checkSkuReadiness(db, sku, false);
    if (evidence.structural.length) checkReadinessResult(await deps.readiness(db, { product, skus: evidence.structural }, false));
    for (const sku of evidence.commercial) await checkSkuReadiness(db, sku, true);
    if (evidence.commercial.length) {
      checkReadinessResult(await deps.readiness(db, { product, skus: evidence.commercial }, true));
      const rows = await tuple(db, `SELECT bool_and(public.catalog_price_setup_sale_ready(sku_id)) AS ready
        FROM unnest($1::uuid[]) AS affected(sku_id)`, [evidence.commercial.map(sku => sku.id)]);
      require(rows[0]?.ready === true, "catalog_publication_v3_activation_readiness_failed");
    }
    if (evidence.activatesParent || evidence.restoresParent && evidence.enabling) {
      const primary = skus.find(sku => sku.id === product.primarySkuId && sku.productId === product.id);
      require(primary && "lifecycleState" in primary && primary.lifecycleState === "active" && (primary.sellableStandalone || primary.sellableInSubscription),
        "catalog_publication_v3_active_primary_required");
    }
    if (evidence.activatesParent || evidence.restoresParent) require(product.presentation !== null, "catalog_publication_v3_presentation_required");
    if (evidence.enabling) await checkGlobalReadiness(db);
  }
  async function decision(input: CatalogDecisionCommandV2, capability: VerifiedCatalogPublisher) {
    try {
      let command: CatalogDecisionCommandV2;
      try { command = decisionSchema.parse(JSON.parse(canonicalCatalogDraftJson(input))); }
      catch { return publicationRefuse("catalog_publication_command_invalid"); }
      return await deps.transactions.run(async db => {
        await db.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        const actorId = await actor(db, capability);
        const prepared = await candidate(db, command.candidateRef, command.candidateDigest, command.productId);
        const fingerprint = publicationDigest([command, actorId]);
        const referenceDigest = await commandGuards(db, command.productId, command.candidateRef, command.candidateDigest, command.commandKey);
        const original = await receipt(db, command.productId, command.commandKey, command.action, fingerprint, actorId);
        if (original) return { outcome: "replayed" as const, receipt: checkedDecisionReceipt(original) };
        const balance = await tuple(db, "SELECT coalesce(sum(CASE action WHEN 'approve' THEN 1 ELSE -1 END),0)::integer AS balance FROM public.catalog_publication_decisions WHERE candidate_reference_digest=$1", [referenceDigest]);
        require(balance[0]?.balance === (command.action === "approve" ? 0 : 1), "catalog_publication_decision_balance_invalid", "conflict");
        const time = (await tuple(db, "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value"))[0]!.value as string;
        const result: CatalogDecisionReceiptV2 = { ...command, fingerprint, actorId, decidedAt: time };
        publicationJson({ outcome: "committed", receipt: result }, CATALOG_PUBLICATION_LIMITS.receiptBytes);
        await db.query("INSERT INTO public.catalog_operator_receipts(kind,scope_id,command_key,fingerprint,actor_id,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)", [command.action, command.productId, command.commandKey, fingerprint, actorId, publicationJson(result)]);
        await db.query(`INSERT INTO public.catalog_publication_decisions(id,product_id,candidate_ref,candidate_digest,candidate_reference_digest,action,actor_id,command_key,fingerprint,reason,decided_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz)`, [randomUUID(), command.productId, command.candidateRef, command.candidateDigest, referenceDigest, command.action, actorId, command.commandKey, fingerprint, command.reason, time]);
        return { outcome: "committed" as const, receipt: result };
      });
    } catch (error) { return failure(error); }
  }
  async function publish(input: CatalogPublishCommand, capability: VerifiedCatalogPublisher) {
    try {
      return await deps.transactions.run(async db => {
        await db.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        const actorId = await actor(db, capability);
        let command: z.infer<typeof commandSchema>;
        try { command = commandSchema.parse(JSON.parse(canonicalCatalogDraftJson(input))); }
        catch { return publicationRefuse("catalog_publication_command_invalid"); }
        const fingerprint = publicationDigest([command, actorId]);
        const referenceDigest = await commandGuards(db, command.productId, command.candidateRef, command.candidateDigest, command.commandKey);
        const original = await receipt(db, command.productId, command.commandKey, "publish", fingerprint, actorId);
        if (original) return { outcome: "replayed" as const, receipt: checkedReceipt(original) };
        const prepared = await candidate(db, command.candidateRef, command.candidateDigest, command.productId);
        const approval = await tuple(db, "SELECT coalesce(sum(CASE action WHEN 'approve' THEN 1 ELSE -1 END),0)::integer AS balance FROM public.catalog_publication_decisions WHERE candidate_reference_digest=$1", [referenceDigest]);
        require(approval[0]?.balance === 1, "catalog_publication_approval_required");
        require((await tuple(db, "SELECT id FROM public.catalog_publications WHERE candidate_ref=$1", [command.candidateRef])).length === 0, "catalog_publication_candidate_already_published", "conflict");
        const documentRevisions = prepared.payload.publication.operations.flatMap(operation => operation.op === "register_document_revision" ? [operation.revisionNo] : []);
        if (prepared.payload.product.documentRevision) documentRevisions.push(prepared.payload.product.documentRevision.revisionNo);
        const preliminary = await load(db, command.productId, undefined, true, documentRevisions);
        const { retained: retainedSources, activationCodes } = await lockCandidate(db, prepared, preliminary);
        const priceCommands = prepared.payload.skus.flatMap(sku => sku.priceOperations ?? []);
        let prelockedBatch: unknown;
        if (priceCommands.length) {
          const ids = [...new Set(priceCommands.map(price => price.variantId))];
          const ownership = await tuple(db, `SELECT id AS sku_id,product_id FROM public.catalog_skus WHERE id=ANY($1::uuid[])
            UNION ALL SELECT sku_id,product_id FROM public.catalog_draft_sku_reservations WHERE draft_id=$2::uuid AND sku_id=ANY($1::uuid[])`, [ids, prepared.record.draftId]);
          require(ownership.every(row => row.product_id === command.productId) && ids.every(id => ownership.some(row => row.sku_id === id)), "catalog_price_parent_mismatch");
          prelockedBatch = await prices.prelock(db, capability, command.productId, priceCommands);
        }
        const current = await load(db, command.productId, undefined, prepared.payload.publication.kind === "compensation", documentRevisions, { command: command.expectedHead, candidate: prepared.expectedHead });
        await candidate(db, command.candidateRef, command.candidateDigest, command.productId);
        const changeIds = new Set<string>();
        for (const change of command.changes) {
          require(!changeIds.has(change.variantId), "catalog_publication_duplicate_variant"); changeIds.add(change.variantId);
          require((current.references.find(reference => reference.skuId === change.variantId)?.revision ?? 0) === change.expectedRevision, "catalog_publication_variant_revision_conflict", "conflict");
        }
        const validation = await validateCatalogDraftV2(catalogDraftV3ValidationPayload(prepared.payload), deps.registry, deps.attributeReferences);
        // Incoming rows are incremental. Retained facts satisfy only these two
        // absence issues; supplied invalid facts still refuse, and the compiler
        // revalidates the complete affected state below.
        require(validation.valid && validation.readiness.publication.issues.every(issue =>
          issue.code === "primary_sku_missing" && current.product?.primarySkuId !== null && current.product !== null
          || issue.code === "sku_missing" && current.skus.length > 0), "candidate_invalid");
        const compiled = compileCatalogPublication({ ...prepared, product: current.product, skus: current.skus, documents: current.documents, retainedSources, rules: deps.rules });
        for (const change of command.changes) require(compiled.skus.some(sku => sku.id === change.variantId
          && (change.state === "withdrawn" ? "lifecycleState" in sku ? sku.lifecycleState === "withdrawn" : sku.status === "archived" : "lifecycleState" in sku ? sku.lifecycleState === "active" : sku.status === "active")), "catalog_publication_variant_state_mismatch");
        const mediaSources = [prepared.record, ...retainedSources].filter((source): source is typeof source & { payload: CatalogDraftPayloadV3 | CatalogDraftPayloadV4 } => source.payload.schemaVersion >= 3);
        function mediaSource(code: string) {
          const retained = current.skus.find(sku => sku.code === code)?.source;
          return mediaSources.find(source => source.draftId === prepared.record.draftId && source.revision === prepared.record.revision && source.payload.skus.some(sku => sku.code === code))
            ?? mediaSources.find(source => prepared.payload.publication.evidence.drafts?.some(claim => claim.draftId === source.draftId && claim.revision === source.revision)
              && source.payload.skus.some(sku => sku.code === code))
            ?? mediaSources.find(source => retained && source.draftId === retained.draftId && source.revision === retained.revision);
        }
        for (const claim of prepared.payload.publication.evidence.media ?? []) {
          const source = mediaSource(claim.skuCode), sku = source?.payload.skus.find(sku => sku.code === claim.skuCode);
          require(sku && claim.mediaRef === source!.payload.product.sharedContent.presentation.mediaRef
            && equal(claim.assetRefs, [...(sku.assetRefs ?? [])].sort()), "catalog_publication_media_evidence_mismatch");
        }
        const withdrawalOnly = prepared.payload.schemaVersion === 4 && catalogLifecycleWithdrawalOnly(prepared.payload);
        const governedEvidence = prepared.payload.schemaVersion === 4 ? governedReadiness(prepared.payload, compiled.skus, current.skus) : undefined;
        const checkedSkus = governedEvidence ? compiled.skus.filter(sku => governedEvidence.authored.has(sku.code))
          : compiled.skus.filter(sku => activationCodes.has(sku.code));
        for (const sku of checkedSkus) {
          const source = mediaSource(sku.code);
          require(source, "catalog_publication_operation_source_missing");
          if (governedEvidence || prepared.payload.publication.operations.some(operation => operation.op === "set_eligibility" && operation.skuCode === sku.code
            && (operation.sellableStandalone || operation.sellableInSubscription))) {
            const heads = await tuple(db, "SELECT revision,status FROM public.catalog_draft_heads WHERE draft_id=$1", [source!.draftId]);
            require(heads[0]?.revision === source!.revision && heads[0]?.status === "open", "catalog_publication_draft_advanced", "conflict");
          }
          {
            const authored = source!.payload.skus.find(row => row.code === sku.code);
            require(authored && authored.id === sku.id && authored.productId === sku.productId && equal(authored.netContent, sku.netContent),
              "catalog_publication_operation_source_missing");
            assertCatalogPublicationGrossMass(sku.netContent, authored!.grossMass ?? null, prepared.definition);
          }
          const content = compiled.product.presentation ?? {};
          const hasMedia = sku.assetRefs.length > 0 || typeof content.mediaRef === "string";
          if (!hasMedia) continue;
          const claim = source!.payload.publication.evidence.media?.find(claim => claim.skuCode === sku.code);
          require(claim && claim.mediaRef === content.mediaRef && equal(claim.assetRefs, [...sku.assetRefs].sort()) && await deps.verifyMedia(db, claim), "catalog_publication_media_readiness_unproven");
        }
        const next = (current.head?.revision ?? 0) + 1;
        require(Number.isSafeInteger(next) && next <= 2_147_483_647, "catalog_publication_revision_limit");
        const publicationId = randomUUID();
        await applyOperations(db, prepared.payload, compiled, current, fingerprint, prepared.definition);
        if (priceCommands.length) {
          for (const price of priceCommands) require(compiled.skus.some(sku => sku.id === price.variantId && sku.productId === command.productId), "catalog_price_parent_mismatch");
          // The sole atomic price write call. It uses this executor and cannot commit independently.
          await prices.applyInTransaction(db, capability, command.productId, prelockedBatch);
        }
        if (!withdrawalOnly) await projectAttributes(db, compiled, prepared.definition, next);
        if (governedEvidence) await checkGovernedReadiness(db, compiled.product, compiled.skus, governedEvidence);
        else await checkReadiness(db, compiled, prepared.payload as CatalogDraftPayloadV3, compiled.activation);
        const references: CatalogSkuRevisionRef[] = compiled.skus.map(sku => {
          const digest = publicationDigest(sku, CATALOG_PUBLICATION_LIMITS.skuBytes), prior = current.references.find(reference => reference.skuId === sku.id);
          return prior?.digest === digest ? prior : { skuId: sku.id, revisionId: randomUUID(), revision: (prior?.revision ?? 0) + 1, digest };
        });
        const manifest = { schemaVersion: "schemaVersion" in compiled.product ? 3 as const : 2 as const, product: compiled.product, skus: references };
        const canonicalState = publicationJson(manifest), publicationDigestValue = publicationDigest(manifest);
        const head = { publicationId, revision: next, documentDigest: compiled.product.document!.digest };
        const committedAt = (await tuple(db, "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value"))[0]!.value as string;
        // Verify the complete projection before making a durable head or receipt visible.
        await assertProjection(db, compiled);
        await db.query(`INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id,committed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz)`, [publicationId, command.productId, next, current.head?.publicationId ?? null,
          prepared.record.draftId, prepared.record.revision, command.candidateRef, command.candidateDigest, compiled.product.document!.id, canonicalState, publicationDigestValue, actorId, committedAt]);
        for (const reference of references) if (!current.references.some(prior => prior.revisionId === reference.revisionId)) {
          const sku = compiled.skus.find(sku => sku.id === reference.skuId)!;
          await db.query("INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [reference.revisionId, reference.skuId, command.productId, reference.revision, publicationId, publicationJson(sku, CATALOG_PUBLICATION_LIMITS.skuBytes), reference.digest]);
        }
        const result: CatalogPublicationReceiptV2 = { schemaVersion: 2, productId: command.productId, commandKey: command.commandKey, fingerprint, actorId,
          previousHead: current.head, head, publicationDigest: publicationDigestValue, committedAt,
          changes: compiled.skus.filter(sku => !current.references.some(prior => prior.revisionId === references.find(reference => reference.skuId === sku.id)!.revisionId)).map(sku => ({
            productId: command.productId, variantId: sku.id, sku: sku.code, state: "lifecycleState" in sku ? sku.lifecycleState === "archived" ? "withdrawn" : sku.lifecycleState : sku.status === "archived" ? "withdrawn" : sku.status,
            variantRevision: references.find(reference => reference.skuId === sku.id)!.revision, publicationHead: head,
            draftRef: { draftId: prepared.record.draftId, revision: prepared.record.revision } })) };
        publicationJson({ outcome: "committed", receipt: result }, CATALOG_PUBLICATION_LIMITS.receiptBytes);
        await db.query(`INSERT INTO public.catalog_publication_heads(product_id,publication_id,revision) VALUES($1,$2,$3)
          ON CONFLICT(product_id) DO UPDATE SET publication_id=EXCLUDED.publication_id,revision=EXCLUDED.revision`, [command.productId, publicationId, next]);
        await db.query("INSERT INTO public.catalog_operator_receipts(kind,scope_id,command_key,fingerprint,actor_id,publication_id,result) VALUES('publish',$1,$2,$3,$4,$5,$6::jsonb)", [command.productId, command.commandKey, fingerprint, actorId, publicationId, publicationJson(result)]);
        await db.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload)
          VALUES('catalog_product',$1,'catalog.publication.committed',$2,$3::jsonb)`, [command.productId, `catalog-publication:${publicationId}`, publicationJson({ schemaVersion: 2, productId: command.productId, head, digest: publicationDigestValue })]);
        require((await tuple(db, "SELECT count(*)::integer AS remaining FROM public.catalog_publication_pointer_capabilities WHERE transaction_id=pg_current_xact_id()"))[0]?.remaining === 0, "catalog_publication_pointer_capability_unconsumed");
        await load(db, command.productId);
        if (prepared.payload.schemaVersion === 4) await db.query("DELETE FROM public.catalog_lifecycle_write_capabilities WHERE transaction_id=pg_current_xact_id() AND product_id=$1", [command.productId]);
        return { outcome: "committed" as const, receipt: result };
      });
    } catch (error) { return failure(error); }
  }
  async function applyOperations(db: PgQueryExecutor, payload: CatalogDraftPayloadV3 | CatalogDraftPayloadV4, state: { product: CatalogPublishedProduct; skus: CatalogPublishedSku[]; documents: CatalogPublicationDocument[] },
    before: RetainedState, fingerprint: string, definition: NonNullable<ReturnType<typeof deps.registry.resolve>>) {
    const product = state.product;
    if (payload.schemaVersion === 4 && before.product) await db.query("INSERT INTO public.catalog_lifecycle_write_capabilities(transaction_id,product_id,fingerprint) VALUES(pg_current_xact_id(),$1,$2)", [product.id, fingerprint]);
    async function pointer(documentId: string) {
      await db.query("INSERT INTO public.catalog_publication_pointer_capabilities(transaction_id,product_id,revision_id,command_fingerprint) VALUES(pg_current_xact_id(),$1,$2,$3)", [product.id, documentId, fingerprint]);
      await db.query("UPDATE public.catalog_products SET current_document_revision_id=$2 WHERE id=$1 AND current_document_revision_id IS DISTINCT FROM $2::uuid", [product.id, documentId]);
      await db.query("DELETE FROM public.catalog_publication_pointer_capabilities WHERE transaction_id=pg_current_xact_id() AND product_id=$1 AND revision_id=$2 AND command_fingerprint=$3", [product.id, documentId, fingerprint]);
    }
    for (const operation of payload.publication.operations) {
      if (operation.op === "create_product") {
        await db.query(`INSERT INTO public.catalog_products(id,slug,name,status,type_key,type_version,variant_axes,attribute_values,publication_facts)
          VALUES($1,$2,$3,'draft',$4,$5,$6::text[],$7::jsonb,$8::jsonb)`, [product.id, product.slug, operation.name, product.type.key,
          product.type.version, product.axes, publicationJson(product.attributes), payload.schemaVersion === 4 ? null : publicationJson(product)]);
        if (payload.schemaVersion === 4) await db.query("INSERT INTO public.catalog_lifecycle_write_capabilities(transaction_id,product_id,fingerprint) VALUES(pg_current_xact_id(),$1,$2)", [product.id, fingerprint]);
      } else if (operation.op === "register_document_revision") {
        const document = state.documents.find(document => document.reference.id === operation.revisionId)!;
        const existing = await tuple(db, "SELECT * FROM public.catalog_product_document_revisions WHERE product_id=$1 AND (id=$2 OR revision_no=$3)", [product.id, operation.revisionId, operation.revisionNo]);
        if (!existing.length) await db.query(`INSERT INTO public.catalog_product_document_revisions(id,product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest,canonical_text)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10)`, [operation.revisionId, product.id, operation.revisionNo, document.reference.schemaId,
          document.reference.documentRef, operation.canonicalText, document.reference.sourceRef, publicationJson(document.provenance), document.reference.digest, operation.canonicalText]);
      } else if (operation.op === "move_document_pointer") {
        const document = state.documents.find(document => document.reference.revisionNo === operation.documentRevisionNo)!;
        const current = await tuple(db, "SELECT current_document_revision_id FROM public.catalog_products WHERE id=$1", [product.id]);
        if (current[0]?.current_document_revision_id !== document.reference.id) await pointer(document.reference.id);
        if (payload.schemaVersion === 3) await db.query("UPDATE public.catalog_products SET publication_facts=jsonb_set(publication_facts,'{document}',$2::jsonb) WHERE id=$1", [product.id, publicationJson(document.reference)]);
      } else if (operation.op === "create_sku") {
        const sku = state.skus.find(sku => sku.id === operation.skuId)!;
        await db.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,status,min_order_qty,is_addon,sellable_standalone,sellable_in_subscription,net_weight_g)
          VALUES($1,$2,$3,$4,'draft',$5,$6,false,false,$7::integer)`, [sku.id, product.id, sku.code, sku.title, sku.minQuantity, sku.isAddon, catalogPublicationIntegralGrams(sku.netContent, definition)]);
      } else if (operation.op === "create_identifier") {
        const sku = state.skus.find(sku => sku.code === operation.skuCode)!;
        const gtin = operation.scheme === "gs1:gtin";
        const normalized = gtin ? operation.value.padStart(14, "0") : operation.value;
        if (gtin) {
          // The publication guard is held. Compare with legacy GTINs as well as
          // identifiers created by publication, regardless of their issuer.
          const existing = await tuple(db, `SELECT 1 FROM public.catalog_sku_identifiers
            WHERE identifier_kind='gtin' AND ltrim(normalized_value,'0')=ltrim($1,'0') LIMIT 1`, [normalized]);
          require(existing.length === 0, "catalog_publication_identity_conflict", "conflict");
        }
        await db.query(`INSERT INTO public.catalog_sku_identifiers(catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,is_primary,scheme,original_value,display_label,source_ref)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [sku.id, operation.issuer, gtin ? "gtin" : "other",
          normalized, operation.packagingLevel === "case" ? "collective" : "unit",
          operation.quantity, operation.isPrimary, operation.scheme, operation.value, operation.label, operation.sourceRef]);
      } else if (operation.op === "set_primary_sku") {
        const sku = state.skus.find(sku => sku.code === operation.skuCode)!;
        if (payload.schemaVersion === 4) await db.query("UPDATE public.catalog_products SET primary_sku_id=$2 WHERE id=$1", [product.id, sku.id]);
        else await db.query("UPDATE public.catalog_products SET primary_sku_id=$2::uuid,publication_facts=jsonb_set(publication_facts,'{primarySkuId}',to_jsonb($2::text)) WHERE id=$1", [product.id, sku.id]);
      } else if (operation.op === "set_product_lifecycle" || operation.op === "restore_product" || operation.op === "set_sku_lifecycle" || operation.op === "restore_sku") {
        if ((operation.op === "set_product_lifecycle" || operation.op === "set_sku_lifecycle") && operation.state === "archived") {
          const ids = operation.op === "set_product_lifecycle" ? state.skus.map(sku => sku.id) : state.skus.filter(sku => sku.code === operation.skuCode).map(sku => sku.id);
          for (const skuId of ids) {
            const rows = await tuple(db, "SELECT public.catalog_bound_obligations_v2($1::uuid) AS result", [skuId]);
            const parsed = obligationResultSchema.safeParse(rows.length === 1 ? rows[0]!.result : undefined);
            if (!parsed.success) return publicationRefuse("catalog_obligation_evidence_unknown", "dependency_unavailable");
            const result = parsed.data;
            if (result.outcome !== "complete") return publicationRefuse(result.reason, "dependency_unavailable");
            require(result.obligations.every(obligation => obligation.skuId === skuId
              && state.skus.some(sku => sku.id === skuId && sku.code === obligation.skuCode)),
            "catalog_obligation_evidence_unknown", "dependency_unavailable");
            require(result.obligations.length === 0, "catalog_archive_refuses_outstanding_obligations");
          }
          publicationRefuse("catalog_archive_barrier_unavailable", "dependency_unavailable");
        }
        // This slot does not qualify archive. Updates are non-key writes under the existing lineage guard.
        if (operation.op === "set_product_lifecycle" || operation.op === "restore_product") {
          await db.query("UPDATE public.catalog_products SET status=$2,updated_at=statement_timestamp() WHERE id=$1", [product.id, operation.op === "restore_product" ? "active" : catalogLifecycleProjectionV2(operation.state)]);
          if (operation.op === "set_product_lifecycle" && operation.state === "withdrawn")
            await db.query("UPDATE public.catalog_skus SET sellable_standalone=false,sellable_in_subscription=false,updated_at=statement_timestamp() WHERE product_id=$1", [product.id]);
        } else {
          const sku = state.skus.find(sku => sku.code === operation.skuCode)!;
          if (operation.op === "set_sku_lifecycle" && operation.state === "withdrawn")
            await db.query("UPDATE public.catalog_skus SET status='active',sellable_standalone=false,sellable_in_subscription=false,updated_at=statement_timestamp() WHERE id=$1", [sku.id]);
          else await db.query("UPDATE public.catalog_skus SET status=$2,updated_at=statement_timestamp() WHERE id=$1", [sku.id, operation.op === "restore_sku" ? "active" : catalogLifecycleProjectionV2(operation.state)]);
        }
      } else if (operation.op === "set_product_status") await db.query("UPDATE public.catalog_products SET status=$2,publication_facts=jsonb_set(publication_facts,'{status}',to_jsonb($2::text)) WHERE id=$1", [product.id, operation.status]);
      else if (operation.op === "set_product_presentation") await db.query("UPDATE public.catalog_products SET publication_facts=jsonb_set(publication_facts,'{presentation}',$2::jsonb) WHERE id=$1", [product.id, publicationJson(operation.presentation)]);
      else if (operation.op === "set_sku_status") await db.query(`UPDATE public.catalog_skus SET status=$2,
        publication_facts=jsonb_set(publication_facts,'{status}',to_jsonb($2::text)) WHERE product_id=$1 AND sku=$3`, [product.id, operation.status, operation.skuCode]);
      else if (operation.op === "set_eligibility" && payload.schemaVersion === 4)
        await db.query("UPDATE public.catalog_skus SET sellable_standalone=$2,sellable_in_subscription=$3,updated_at=statement_timestamp() WHERE product_id=$1 AND sku=$4",
          [product.id, operation.sellableStandalone, operation.sellableInSubscription, operation.skuCode]);
      else if (operation.op === "set_eligibility") await db.query(`UPDATE public.catalog_skus SET sellable_standalone=$2,sellable_in_subscription=$3,
        publication_facts=jsonb_set(jsonb_set(publication_facts,'{sellableStandalone}',to_jsonb($2::boolean)),'{sellableInSubscription}',to_jsonb($3::boolean))
        WHERE product_id=$1 AND sku=$4`, [product.id, operation.sellableStandalone, operation.sellableInSubscription, operation.skuCode]);
      else if (operation.op === "set_sku_metadata") await db.query(`UPDATE public.catalog_skus SET
        publication_facts=jsonb_set(publication_facts,'{logisticsRef}',$2::jsonb) WHERE product_id=$1 AND sku=$3`, [product.id, publicationJson(operation.logisticsRef), operation.skuCode]);
      else if (operation.op === "set_derived_sku_facts") await db.query(`UPDATE public.catalog_skus SET
        publication_facts=jsonb_set(publication_facts,'{facts}',$2::jsonb) WHERE product_id=$1 AND sku=$3`, [product.id, publicationJson(operation.facts), operation.skuCode]);
      else if (operation.op === "set_offer_membership") await db.query(`UPDATE public.catalog_skus SET publication_facts=jsonb_set(publication_facts,'{memberships}',
        (SELECT jsonb_agg(member ORDER BY member->>'offerVersion' COLLATE "C") FROM
          (SELECT member FROM jsonb_array_elements(publication_facts->'memberships') AS member WHERE member->>'offerVersion'<>$2
            UNION ALL SELECT $3::jsonb) AS members)) WHERE product_id=$1 AND sku=$4`,
      [product.id, operation.offerVersion, publicationJson({ offerVersion: operation.offerVersion, admitted: operation.admitted }), operation.skuCode]);
    }
    if (payload.schemaVersion === 4) {
      await db.query("UPDATE public.catalog_products SET publication_facts=$2::jsonb,attribute_values=$3::jsonb,variant_axes=$4::text[] WHERE id=$1",
        [product.id, publicationJson(product), publicationJson(product.attributes), product.axes]);
    } else if (before.product) {
      const fields = ["source", "content", "attributes", "axes"] as const;
      const patch = Object.fromEntries(fields.filter(name => !equal(before.product![name], product[name])).map(name => [name, product[name]]));
      await db.query("UPDATE public.catalog_products SET publication_facts=publication_facts || $2::jsonb WHERE id=$1", [product.id, publicationJson(patch)]);
      if ("attributes" in patch) await db.query("UPDATE public.catalog_products SET attribute_values=$2::jsonb WHERE id=$1", [product.id, publicationJson(product.attributes)]);
      if ("axes" in patch) await db.query("UPDATE public.catalog_products SET variant_axes=$2::text[] WHERE id=$1", [product.id, product.axes]);
    }
    for (const sku of state.skus) {
      const prior = before.skus.find(prior => prior.id === sku.id);
      if (prior && equal(prior, sku)) continue;
      if (prior && payload.schemaVersion === 3) {
        const patch = Object.fromEntries(Object.entries(sku).filter(([name, value]) => !equal(prior[name as keyof CatalogPublishedSku], value)));
        await db.query("UPDATE public.catalog_skus SET publication_facts=publication_facts || $2::jsonb WHERE id=$1", [sku.id, publicationJson(patch, CATALOG_PUBLICATION_LIMITS.skuBytes)]);
        if ("attributes" in patch) await db.query("UPDATE public.catalog_skus SET attribute_values=$2::jsonb WHERE id=$1", [sku.id, publicationJson(sku.attributes)]);
        if ("grossMass" in patch) await db.query(`UPDATE public.catalog_skus SET gross_mass_dimension=$2,gross_mass_unscaled=$3::numeric,
          gross_mass_scale=$4,gross_mass_unit=$5 WHERE id=$1`, [sku.id, sku.grossMass?.dimension ?? null, sku.grossMass?.unscaled ?? null, sku.grossMass?.scale ?? null, sku.grossMass?.unit ?? null]);
        if ("assetRefs" in patch) await db.query("UPDATE public.catalog_skus SET asset_ref=$2 WHERE id=$1", [sku.id, sku.assetRefs[0] ?? null]);
        continue;
      }
      const identity = canonicalizeCatalogCombinationV2({ definition, axes: product.axes, options: sku.options });
      await db.query(`UPDATE public.catalog_skus SET publication_facts=$2::jsonb,attribute_values=$3::jsonb,option_values=$4::jsonb,
        canonical_option_bytes=$5::bytea,combination_digest=$6::bytea,net_content_dimension=$7,net_content_unscaled=$8::numeric,net_content_scale=$9,net_content_unit=$10,
        gross_mass_dimension=$11,gross_mass_unscaled=$12::numeric,gross_mass_scale=$13,gross_mass_unit=$14,asset_ref=$15 WHERE id=$1`,
      [sku.id, publicationJson(sku, CATALOG_PUBLICATION_LIMITS.skuBytes), publicationJson(sku.attributes), publicationJson(sku.options), identity.canonicalOptionBytes, identity.combinationDigest,
        sku.netContent.dimension, sku.netContent.unscaled, sku.netContent.scale, sku.netContent.unit,
        sku.grossMass?.dimension ?? null, sku.grossMass?.unscaled ?? null, sku.grossMass?.scale ?? null, sku.grossMass?.unit ?? null, sku.assetRefs[0] ?? null]);
    }
  }
  async function assertProjection(db: PgQueryExecutor, state: { product: CatalogPublishedProduct; skus: CatalogPublishedSku[] }) {
    const rows = await tuple(db, `SELECT p.publication_facts=$2::jsonb AND p.slug=$3 AND p.name=$4 AND p.status=$5
      AND p.primary_sku_id=$6::uuid AND p.current_document_revision_id=$7::uuid AND p.type_key=$8 AND p.type_version=$9
      AND p.variant_axes=$10::text[] AND p.attribute_values=$11::jsonb AS valid,
      (SELECT count(*)::integer FROM public.catalog_skus s WHERE s.product_id=p.id) AS sku_count FROM public.catalog_products p WHERE p.id=$1`,
    [state.product.id, publicationJson(state.product), state.product.slug, state.product.name, state.product.status, state.product.primarySkuId,
      state.product.document?.id, state.product.type.key, state.product.type.version, state.product.axes, publicationJson(state.product.attributes)]);
    require(rows[0]?.valid === true && rows[0]?.sku_count === state.skus.length, "catalog_publication_post_state_mismatch");
    const definition = deps.registry.resolve(state.product.type);
    require(definition, "catalog_definition_drift");
    for (const sku of state.skus) {
      const identity = canonicalizeCatalogCombinationV2({ definition: definition!, axes: state.product.axes, options: sku.options });
      const rows = await tuple(db, `SELECT s.publication_facts=$2::jsonb AND s.sku=$3 AND s.product_id=$4::uuid AND s.title=$5 AND s.status=$6
        AND s.min_order_qty=$7 AND s.is_addon=$8 AND s.sellable_standalone=$9 AND s.sellable_in_subscription=$10
        AND s.attribute_values=$11::jsonb AND s.option_values=$12::jsonb
        AND s.net_content_dimension=$13 AND s.net_content_unscaled=$14::numeric AND s.net_content_scale=$15 AND s.net_content_unit=$16
        AND s.gross_mass_dimension IS NOT DISTINCT FROM $17 AND s.gross_mass_unscaled IS NOT DISTINCT FROM $18::numeric
        AND s.gross_mass_scale IS NOT DISTINCT FROM $19::smallint AND s.gross_mass_unit IS NOT DISTINCT FROM $20
        AND s.canonical_option_bytes=$21::bytea AND s.combination_digest=$22::bytea
        AND s.asset_ref IS NOT DISTINCT FROM $23::text AND s.net_weight_g=$24::integer AS valid
        FROM public.catalog_skus s WHERE s.id=$1`, [sku.id, publicationJson(sku, CATALOG_PUBLICATION_LIMITS.skuBytes), sku.code, sku.productId, sku.title, sku.status,
        sku.minQuantity, sku.isAddon, sku.sellableStandalone, sku.sellableInSubscription, publicationJson(sku.attributes), publicationJson(sku.options),
        sku.netContent.dimension, sku.netContent.unscaled, sku.netContent.scale, sku.netContent.unit, sku.grossMass?.dimension ?? null,
        sku.grossMass?.unscaled ?? null, sku.grossMass?.scale ?? null, sku.grossMass?.unit ?? null,
        identity.canonicalOptionBytes, identity.combinationDigest, sku.assetRefs[0] ?? null,
        catalogPublicationIntegralGrams(sku.netContent, definition!)]);
      require(rows[0]?.valid === true, "catalog_publication_post_state_mismatch");
      const identifiers = await tuple(db, `SELECT scheme,issuer,original_value AS value,normalized_value AS normalized,identifier_kind AS kind,CASE pack_kind WHEN 'unit' THEN 'unit' ELSE 'case' END AS "packagingLevel",
        quantity,is_primary AS "isPrimary",display_label AS label,source_ref AS "sourceRef" FROM public.catalog_sku_identifiers WHERE catalog_sku_id=$1 ORDER BY normalized_value,issuer`, [sku.id]);
      const sort = (values: unknown[]) => values.map(value => publicationJson(value)).sort();
      require(equal(sort(identifiers), sort(sku.identifiers.map(identifier => ({ ...identifier,
        normalized: identifier.scheme === "gs1:gtin" ? identifier.value.padStart(14, "0") : identifier.value,
        kind: identifier.scheme === "gs1:gtin" ? "gtin" : "other" })))), "catalog_publication_post_state_mismatch");
    }
  }
  async function projectAttributes(db: PgQueryExecutor, state: { product: CatalogPublishedProduct; skus: CatalogPublishedSku[] }, definition: NonNullable<ReturnType<typeof deps.registry.resolve>>, revision: number) {
    await db.query("DELETE FROM public.catalog_attribute_projection WHERE sku_id=ANY($1::uuid[])", [state.skus.map(sku => sku.id)]);
    for (const sku of state.skus) {
      const validation = await validateCatalogPublicationAttributes(definition, { productAttributes: state.product.attributes, skus: [{ id: sku.id, attributes: sku.attributes }] }, deps.attributeReferences);
      const projection = prepareCatalogAttributeProjection(validation, String(revision));
      require(projection.prepared, "catalog_publication_attribute_projection_invalid");
      if (!projection.prepared) continue;
      for (const row of projection.rows) await db.query(`INSERT INTO public.catalog_attribute_projection
        (sku_id,publication_revision,attribute_key,definition_version,value_ordinal,value_kind,text_value,numeric_value,bool_value,date_value,ref_value,quantity_dimension,canonical_unit,canonical_value)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9,$10::date,$11,$12,$13,$14::numeric)`,
      [row.sku_id, row.publication_revision, row.attribute_key, row.definition_version, row.value_ordinal, row.value_kind, row.text_value,
        row.numeric_value, row.bool_value, row.date_value, row.ref_value, row.quantity_dimension, row.canonical_unit, row.canonical_value]);
    }
  }
  function legacyReceipt(receipt: CatalogPublicationReceiptV2): CatalogPublicationReceipt {
    return { commandKey: receipt.commandKey, fingerprint: receipt.fingerprint, actorId: receipt.actorId, previousHead: receipt.previousHead, head: receipt.head, changes: receipt.changes };
  }
  function legacyFailure(result: CatalogPublicationFailure) {
    return { outcome: result.outcome, reason: result.outcome === "unauthorized" ? "publisher_not_authorized" : result.outcome === "conflict" ? "head_conflict"
      : result.outcome === "dependency_unavailable" ? "publication_authority_unavailable" : result.outcome === "unsupported" ? "publication_not_supported" : "candidate_invalid" } as const;
  }
  async function found(head: CatalogHeadRef | null, productId: string | null) {
    return deps.transactions.run(async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      if (head) {
        require(headSchema.safeParse(head).success, "catalog_publication_query_invalid");
        const rows = await tuple(db, "SELECT product_id FROM public.catalog_publications WHERE id=$1::uuid", [head.publicationId]);
        require(rows.length === 1, "catalog_publication_absent", "unsupported"); productId = rows[0]!.product_id as string;
      }
      require(id.safeParse(productId).success, "catalog_publication_query_invalid");
      return load(db, productId!, head ?? undefined);
    });
  }
  const reads: CatalogPublicationReadPort = {
    async current(productId) {
      try { const state = await found(null, productId); const result = state.head ? { outcome: "found" as const, head: state.head, documentRef: state.product!.document!.documentRef,
        observations: observations(state) } : { outcome: "unpublished" as const };
        publicationJson(result, CATALOG_PUBLICATION_LIMITS.pageBytes); return result;
      } catch (error) { return legacyFailure(failure(error)); }
    },
    async readback(head) {
      try { const state = await found(head, null); const result = { outcome: "found" as const, head: state.head!, documentRef: state.product!.document!.documentRef, observations: observations(state) };
        publicationJson(result, CATALOG_PUBLICATION_LIMITS.pageBytes); return result; }
      catch (error) { return legacyFailure(failure(error)); }
    },
    async receipt(_scope) { return { outcome: "unsupported", reason: "publication_not_supported" }; },
    async history(productId, cursor) {
      try {
        require(id.safeParse(productId).success, "catalog_publication_query_invalid");
        const pointer = decodeCursor(cursor, productId, "history");
        return await deps.transactions.run(async db => {
          await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
          const lineage = await tuple(db, `SELECT EXISTS(SELECT 1 FROM public.catalog_products WHERE id=$1::uuid)
            AND NOT EXISTS(SELECT 1 FROM public.catalog_publications WHERE product_id=$1::uuid) AS unknown`, [productId]);
          require(lineage[0]?.unknown === false, "catalog_publication_lineage_unknown", "unsupported");
          const rows = await tuple(db, `SELECT p.revision,p.id,r.result,r.scope_id,r.command_key,r.fingerprint,r.actor_id,r.publication_id FROM public.catalog_publications p JOIN public.catalog_operator_receipts r ON r.publication_id=p.id AND r.kind='publish'
            WHERE p.product_id=$1::uuid AND p.revision <= coalesce($2::integer,(SELECT max(revision) FROM public.catalog_publications WHERE product_id=$1::uuid))
            AND ($3::integer IS NULL OR p.revision < $3) ORDER BY p.revision DESC LIMIT 101`, [productId, pointer?.highWater ?? null, pointer?.before ?? null]);
          const highWater = pointer?.highWater ?? rows[0]?.revision as number | undefined;
          const receipts: CatalogPublicationReceipt[] = [];
          for (const row of rows.slice(0, 100)) {
            const receipt = await storedPublishReceipt(db, row);
            require(receipt.productId === productId && receipt.schemaVersion === 2, "catalog_publication_receipt_invalid", "dependency_unavailable");
            const result = legacyReceipt(receipt), test = { outcome: "page", receipts: [...receipts, result], limit: 100,
              nextCursor: encodeCursor({ kind: "history", productId, highWater: highWater!, before: row.revision as number }) };
            try { publicationJson(test, CATALOG_PUBLICATION_LIMITS.historyBytes); } catch { if (!receipts.length) throw new CatalogPublicationError("catalog_publication_history_item_too_large"); break; }
            receipts.push(result);
          }
          const last = receipts.at(-1)?.head.revision;
          const result = { outcome: "page" as const, receipts, limit: 100, nextCursor: rows.length > receipts.length
            ? encodeCursor({ kind: "history", productId, highWater: highWater!, before: last! }) : null };
          publicationJson(result, CATALOG_PUBLICATION_LIMITS.historyBytes); return result;
        });
      } catch (error) { return legacyFailure(failure(error)); }
    },
  };
  async function recoverReceipt(scope: { productId: string; commandKey: string }, capability: VerifiedCatalogPublisher) {
    try {
      require(id.safeParse(scope.productId).success && key.safeParse(scope.commandKey).success, "catalog_publication_query_invalid");
      return await deps.transactions.run(async db => {
        await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await actor(db, capability);
        const rows = await tuple(db, "SELECT * FROM public.catalog_operator_receipts WHERE kind='publish' AND scope_id=$1 AND command_key=$2", [scope.productId, scope.commandKey]);
        if (!rows.length) return { outcome: "absent" as const };
        const receipt = await storedPublishReceipt(db, rows[0]!);
        require(receipt.productId === scope.productId && receipt.commandKey === scope.commandKey, "catalog_publication_receipt_invalid", "dependency_unavailable");
        const result = { outcome: "found" as const, receipt };
        publicationJson(result, CATALOG_PUBLICATION_LIMITS.receiptBytes); return result;
      });
    } catch (error) { return failure(error); }
  }
  function readPort(capability: VerifiedCatalogPublisher): CatalogPublicationReadPort {
    return { ...reads, async receipt(scope) {
      const result = await recoverReceipt(scope, capability);
      return result.outcome === "found" ? { outcome: "found", receipt: legacyReceipt(result.receipt) }
        : result.outcome === "absent" ? result : legacyFailure(result);
    } };
  }
  function observations(state: RetainedState) {
    return state.skus.map(sku => ({ productId: sku.productId, variantId: sku.id, sku: sku.code,
      state: "lifecycleState" in sku ? sku.lifecycleState === "archived" ? "withdrawn" as const : sku.lifecycleState : sku.status === "archived" ? "withdrawn" as const : sku.status, variantRevision: state.references.find(reference => reference.skuId === sku.id)!.revision,
      publicationHead: state.head, draftRef: { draftId: sku.source.draftId, revision: sku.source.revision } }));
  }
  const publication: CatalogPublicationPort = {
    async publish(command, capability) { const result = await publish(command, capability);
      return "receipt" in result ? { outcome: result.outcome, receipt: legacyReceipt(result.receipt) } : legacyFailure(result); },
  };
  async function checkRetainedGovernedRoster(db: PgQueryExecutor, productId: string, manifest: unknown) {
    const rows = await tuple(db, "SELECT public.catalog_lifecycle_roster_resolved_v3($1::uuid,$2::jsonb) AS valid", [productId, publicationJson(manifest)]);
    require(rows.length === 1 && rows[0]?.valid === true, "catalog_publication_sku_revision_invalid", "dependency_unavailable");
  }
  async function readbackFull(head: CatalogHeadRef, cursor: string | null, expectedVersion: 2 | 3) {
    try {
      require(headSchema.safeParse(head).success, "catalog_publication_query_invalid");
      return await deps.transactions.run(async db => {
        await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const rows = await tuple(db, `SELECT p.product_id,p.revision,p.canonical_state,p.digest,d.id AS document_id,d.digest AS document_digest,
          d.revision_no,d.schema_id,d.document_ref,d.source_ref,d.canonical_text FROM public.catalog_publications p JOIN public.catalog_product_document_revisions d
          ON d.id=p.document_revision_id AND d.product_id=p.product_id WHERE p.id=$1::uuid`, [head.publicationId]);
        require(rows.length === 1, "catalog_publication_absent", "unsupported");
        const row = rows[0]!, manifest = catalogPublicationManifestSchema.parse(JSON.parse(row.canonical_state as string));
        require(manifest.schemaVersion === expectedVersion, "catalog_lifecycle_reader_required", "unsupported");
        require(row.revision === head.revision && row.document_digest === head.documentDigest, "head_conflict", "conflict");
        require(publicationJson(manifest) === row.canonical_state && publicationDigest(manifest) === row.digest
          && manifest.product.id === row.product_id && equal(manifest.product.document, { id: row.document_id, productId: row.product_id,
            revisionNo: row.revision_no, schemaId: row.schema_id, documentRef: row.document_ref, sourceRef: row.source_ref, digest: row.document_digest })
          && typeof row.canonical_text === "string"
          && createHash("sha256").update(row.canonical_text).digest("hex") === row.document_digest,
        "catalog_publication_manifest_invalid", "dependency_unavailable");
        if (expectedVersion === 3) await checkRetainedGovernedRoster(db, manifest.product.id, manifest);
        const productId = manifest.product.id, pointer = decodeCursor(cursor, productId, "facts"), offset = pointer?.before ?? 0;
        require(!pointer || pointer.highWater === head.revision, "catalog_publication_cursor_invalid");
        require(offset <= manifest.skus.length, "catalog_publication_cursor_invalid");
        const wanted = manifest.skus.slice(offset, offset + 100);
        const lengths = await tuple(db, `SELECT id,sku_id,revision,digest,octet_length(full_facts) AS bytes FROM public.catalog_sku_revisions
          WHERE product_id=$1::uuid AND id=ANY($2::uuid[])`, [productId, wanted.map(reference => reference.revisionId)]);
        require(lengths.length === wanted.length, "catalog_publication_sku_revision_invalid", "dependency_unavailable");
        const selected: CatalogSkuRevisionRef[] = []; let itemBytes = 0;
        for (const reference of wanted) {
          const stored = lengths.find(stored => stored.id === reference.revisionId);
          require(stored && stored.sku_id === reference.skuId && stored.revision === reference.revision && stored.digest === reference.digest
            && typeof stored.bytes === "number" && stored.bytes > 0 && stored.bytes <= CATALOG_PUBLICATION_LIMITS.skuBytes,
          "catalog_publication_sku_revision_invalid", "dependency_unavailable");
          const count = selected.length + 1, nextCursor = encodeCursor({ kind: "facts", productId, highWater: head.revision, before: offset + count });
          const base = Buffer.byteLength(publicationJson({ outcome: "page", schemaVersion: expectedVersion, head, product: manifest.product, items: [], nextCursor }));
          const bytes = Buffer.byteLength(publicationJson({ reference, facts: {} })) - 2 + (stored!.bytes as number);
          if (base + itemBytes + bytes + count - 1 > CATALOG_PUBLICATION_LIMITS.pageBytes) {
            require(selected.length > 0, "catalog_publication_page_item_too_large"); break;
          }
          itemBytes += bytes; selected.push(reference);
        }
        // Fetch only facts that fit this page. The immutable roster and cheap
        // length probe never load a product's complete fact history into memory.
        const facts = await tuple(db, "SELECT id,full_facts FROM public.catalog_sku_revisions WHERE product_id=$1::uuid AND id=ANY($2::uuid[])",
          [productId, selected.map(reference => reference.revisionId)]);
        require(facts.length === selected.length, "catalog_publication_sku_revision_invalid", "dependency_unavailable");
        const items = selected.map(reference => {
          const stored = facts.find(stored => stored.id === reference.revisionId);
          const value = catalogPublishedSkuSchema.parse(JSON.parse(stored!.full_facts as string));
          require(("schemaVersion" in value ? 3 : 2) === expectedVersion, "catalog_publication_sku_revision_invalid", "dependency_unavailable");
          require(value.id === reference.skuId && value.productId === productId && publicationJson(value, CATALOG_PUBLICATION_LIMITS.skuBytes) === stored!.full_facts
            && publicationDigest(value, CATALOG_PUBLICATION_LIMITS.skuBytes) === reference.digest, "catalog_publication_sku_revision_invalid", "dependency_unavailable");
          return { reference, facts: value };
        });
        const next = offset + items.length;
        require(next > offset || offset === manifest.skus.length, "catalog_publication_cursor_invalid");
        const result = { outcome: "page" as const, schemaVersion: expectedVersion, head, product: manifest.product, items,
          nextCursor: next < manifest.skus.length ? encodeCursor({ kind: "facts", productId, highWater: head.revision, before: next }) : null };
        publicationJson(result, CATALOG_PUBLICATION_LIMITS.pageBytes); return result;
      });
    } catch (error) { return failure(error); }
  }
  async function readbackV2(head: CatalogHeadRef, cursor: string | null = null): Promise<CatalogFullPublicationV2 | CatalogPublicationFailure> {
    return await readbackFull(head, cursor, 2) as CatalogFullPublicationV2 | CatalogPublicationFailure;
  }
  /** @experimental */
  async function readbackV3(head: CatalogHeadRef, cursor: string | null = null): Promise<CatalogFullPublicationV3 | CatalogPublicationFailure> {
    return await readbackFull(head, cursor, 3) as CatalogFullPublicationV3 | CatalogPublicationFailure;
  }
  async function resolveRetained(binding: CatalogRetainedSourceBinding, scope: VerifiedCatalogReadScope) {
    try {
      const input = bindingSchema.parse(binding), context = typeof scope === "object" && scope !== null ? readers.get(scope) : undefined;
      require(typeof scope === "object" && scope !== null && readers.has(scope) && deps.acceptedSource, "retained_read_not_authorized", "unauthorized");
      return await deps.transactions.run(async db => {
        await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const accepted = await deps.acceptedSource!(db, context!, input);
        require(accepted !== "unauthorized", "retained_read_not_authorized", "unauthorized");
        require(accepted !== null, "retained_revision_unavailable", "unsupported");
        require(equal(accepted, input), "retained_source_mismatch", "unauthorized");
        const rows = await tuple(db, `SELECT p.revision,p.canonical_state,p.digest AS manifest_digest,d.digest,d.canonical_text,
          d.revision_no,d.schema_id,d.document_ref,d.source_ref,r.full_facts,r.digest AS sku_digest,r.revision AS sku_revision
          FROM public.catalog_publications p
          JOIN public.catalog_product_document_revisions d ON d.id=p.document_revision_id AND d.product_id=p.product_id
          JOIN public.catalog_sku_revisions r ON r.id=$4 AND r.sku_id=$5 AND r.product_id=p.product_id
          WHERE p.id=$1 AND p.product_id=$2 AND d.id=$3`, [input.publicationId, input.productId, input.documentRevisionId, input.skuRevisionId, input.skuId]);
        require(rows.length === 1, "retained_revision_unavailable", "unsupported");
        const row = rows[0]!, head = { publicationId: input.publicationId, revision: row.revision as number, documentDigest: row.digest as string };
        const manifest = catalogPublicationManifestSchema.parse(JSON.parse(row.canonical_state as string));
        require(publicationJson(manifest) === row.canonical_state && publicationDigest(manifest) === row.manifest_digest
          && manifest.product.id === input.productId && equal(manifest.product.document, { id: input.documentRevisionId, productId: input.productId,
            revisionNo: row.revision_no, schemaId: row.schema_id, documentRef: row.document_ref, sourceRef: row.source_ref, digest: row.digest })
          && typeof row.canonical_text === "string" && createHash("sha256").update(row.canonical_text).digest("hex") === row.digest,
        "catalog_publication_manifest_invalid", "dependency_unavailable");
        if (manifest.schemaVersion === 3) await checkRetainedGovernedRoster(db, manifest.product.id, manifest);
        const reference = manifest.skus.find(reference => reference.skuId === input.skuId && reference.revisionId === input.skuRevisionId
          && reference.digest === row.sku_digest && reference.revision === row.sku_revision);
        require(reference, "retained_revision_unavailable", "unsupported");
        const sku = catalogPublishedSkuSchema.parse(JSON.parse(row.full_facts as string));
        require(("schemaVersion" in sku ? 3 : 2) === manifest.schemaVersion, "catalog_publication_sku_revision_invalid", "dependency_unavailable");
        require(sku.id === input.skuId && sku.productId === input.productId && publicationJson(sku, CATALOG_PUBLICATION_LIMITS.skuBytes) === row.full_facts
          && publicationDigest(sku, CATALOG_PUBLICATION_LIMITS.skuBytes) === reference!.digest, "catalog_publication_sku_revision_invalid", "dependency_unavailable");
        const result = { outcome: "found" as const, head, product: manifest.product, reference: reference!, sku };
        publicationJson(result, CATALOG_PUBLICATION_LIMITS.pageBytes); return result;
      });
    } catch (error) { return failure(error); }
  }
  /** @experimental */
  async function membershipPage(input: CatalogMembershipQuery): Promise<CatalogMembershipPage | CatalogPublicationFailure> {
    try { return await deps.transactions.run(db => readPostgresCatalogMembershipPage(db, deps.registry, input)); }
    catch (error) { return scopedReadFailure(error); }
  }

  /** @experimental */
  async function activationReadiness(skuCodes: readonly string[], expectedHeadDigest: string): Promise<CatalogActivationReadiness | CatalogPublicationFailure> {
    try {
      const codes = readinessCodes.safeParse(skuCodes);
      if (!codes.success || !digest.safeParse(expectedHeadDigest).success)
        return publicationRefuse("catalog_publication_readiness_query_invalid");
      return await deps.transactions.run(async db => {
        await db.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY");
        const batch = singletonRead(await tuple(db, "SELECT public.catalog_publication_activation_readiness($1,$2) AS result",
          [codes.data, expectedHeadDigest]), readinessRow);
        require(batch.headDigest === expectedHeadDigest && batch.items.length === codes.data.length
          && batch.items.every((item, index) => item.skuCode === codes.data[index]),
        "catalog_publication_readiness_authority_changed", "conflict");

        const items: CatalogActivationReadiness["items"] = [];
        for (const { evidence, ...item } of batch.items) {
          if (!evidence) {
            require(item.skuId === null && item.logisticsRef === null && equal(item.reasons, ["sku_not_materialized"]),
              "catalog_publication_readiness_evidence_invalid", "dependency_unavailable");
            items.push(item);
            continue;
          }
          const { product, sku } = evidence;
          require(sku.id === item.skuId && sku.code === item.skuCode && sku.productId === product.id
            && sku.logisticsRef === item.logisticsRef, "catalog_publication_readiness_evidence_invalid", "dependency_unavailable");
          const installed = readinessVerdict.safeParse(await deps.readiness(db, { product, skus: [sku] }, true));
          if (!installed.success) return publicationRefuse("catalog_publication_readiness_invalid", "dependency_unavailable");
          const reasons = readinessReasons.safeParse([...new Set([...item.reasons, ...installed.data.reasons])]);
          if (!reasons.success) return publicationRefuse("catalog_publication_readiness_invalid", "dependency_unavailable");
          items.push({ ...item, reasons: reasons.data, ready: reasons.data.length === 0 });
        }
        return { ...batch, items };
      });
    } catch (error) { return scopedReadFailure(error); }
  }

  return { authorize, authorizeReadScope(context: Context): VerifiedCatalogReadScope { const scope = Object.freeze({}); readers.set(scope, context); return scope as VerifiedCatalogReadScope; },
    publication, reads, readPort, publish, decision, receipt: recoverReceipt, readbackV2,
    /** @experimental */
    readbackV3, resolveRetained, membershipPage, activationReadiness };
}
function encodeCursor(value: { kind: "history" | "facts"; productId: string; highWater: number; before: number }): string {
  return Buffer.from(publicationJson({ schemaVersion: 1, ...value })).toString("base64url");
}
function decodeCursor(value: string | null, productId: string, kind: "history" | "facts") {
  if (value === null) return null;
  try {
    if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
    const schema = z.object({ schemaVersion: z.literal(1), kind: z.literal(kind), productId: z.literal(productId), highWater: revision,
      before: z.number().int().min(0).max(2_147_483_647) }).strict();
    const result = schema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    require(kind !== "history" || result.before <= result.highWater, "catalog_publication_cursor_invalid");
    return result;
  } catch { return publicationRefuse("catalog_publication_cursor_invalid"); }
}
function checkedReceipt(value: unknown): CatalogPublicationReceiptV2 {
  const observation = z.object({ productId: id, variantId: id, sku: z.string().min(1), state: z.enum(["draft", "active", "withdrawn"]), variantRevision: revision,
    publicationHead: headSchema.nullable(), draftRef: z.object({ draftId: id, revision }).strict().nullable() }).strict();
  const schema: z.ZodType<CatalogPublicationReceiptV2> = z.object({ schemaVersion: z.literal(2), productId: id, commandKey: key, fingerprint: digest, actorId: id,
    previousHead: headSchema.nullable(), head: headSchema, publicationDigest: digest, committedAt: instant, changes: z.array(observation) }).strict();
  publicationJson(value, CATALOG_PUBLICATION_LIMITS.receiptBytes);
  const result = schema.parse(value);
  require(result.changes.every(change => change.productId === result.productId && equalHead(change.publicationHead, result.head)), "catalog_publication_receipt_invalid", "dependency_unavailable");
  return result;
}
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
function checkedDecisionReceipt(value: unknown): CatalogDecisionReceiptV2 {
  publicationJson(value, CATALOG_PUBLICATION_LIMITS.receiptBytes);
  return decisionSchema.extend({ fingerprint: digest, actorId: id, decidedAt: instant }).strict().parse(value);
}
function equalHead(a: CatalogHeadRef | null, b: CatalogHeadRef): boolean { return a !== null && publicationJson(a) === publicationJson(b); }
