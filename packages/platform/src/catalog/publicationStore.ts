import { parseCatalogCandidateReference } from "./candidate.js";
import { createCatalogPriceSetupTransactionWriter, CatalogPriceSetupTransactionError } from "../pricing/index.js";
import { createHash, randomUUID } from "node:crypto";
import type { PgQueryExecutor } from "../data/index.js";
import { canonicalizeCatalogCombinationV2 } from "./variantCombination.js";
import { z } from "./validation.js";
import type { VerifiedCatalogPublisher, CatalogPublicationPort, CatalogPublicationReadPort } from "./publicationPorts.js";
import type { CatalogPublicationDependencies, VerifiedCatalogReadScope } from "./publicationPortsV2.js";
import type { CatalogDecisionCommandV2, CatalogDecisionReceiptV2, CatalogFullPublicationV2, CatalogPublicationReceiptV2,
  CatalogPublicationManifestV2, CatalogPublishedProduct, CatalogPublishedSku, CatalogSkuRevisionRef, CatalogRetainedSourceBinding, CatalogPublicationFailure } from "./contracts/publication.js";
import type { CatalogHeadRef, CatalogPublishCommand, CatalogPublicationReceipt } from "./contracts/lifecycle.js";
import type { CatalogDraftPublicationStoredRecord, CatalogDraftPayloadV3 } from "./contracts/draftV3.js";
import { CATALOG_PUBLICATION_LIMITS } from "./contracts/publication.js";
import { catalogDraftPublicationStoredRecordSchema, catalogDraftV3ValidationPayload, resolveCatalogDraftProvenance } from "./draftV3Schemas.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { validateCatalogDraftV2 } from "./draftV2Validation.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
import { catalogProductTypeRefSchema } from "./productTypeSchemas.js";
import { validateCatalogPublicationAttributes } from "./attributeValidation.js";
import { prepareCatalogAttributeProjection } from "./attributeProjection.js";
import { catalogPublishedSkuSchema, catalogPublicationManifestSchema, catalogPublicationIntegralGrams, assertCatalogPublicationMassInputs, assertCatalogPublicationGrossMass, assertCatalogPublicationAuthorship, assertCatalogPublicationPreparation,
  compileCatalogPublicationEffects, CatalogPublicationError, publicationRefuse,
  publicationJson, publicationDigest, comparePublicationText, publicationReadinessReasons, publicationReadinessVerdict, catalogPublicationAffected, type CatalogPublicationDocument } from "./publicationValidation.js";

const receiptColumns = "kind,scope_id,command_key,fingerprint,actor_id,publication_id,result::jsonb AS result";
const id = z.guid().refine(value => value === value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const key = z.string().min(1).refine(value => Buffer.byteLength(value) <= 200 && !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value));
const referenceSchema = z.string().refine(value => parseCatalogCandidateReference(value) !== null);
const headSchema = z.object({ publicationId: id, revision, documentDigest: digest }).strict();
const commandSchema = z.object({ schemaVersion: z.literal(2).optional(), commandKey: key, productId: id,
  candidateRef: referenceSchema, candidateDigest: digest, expectedHead: headSchema.nullable(),
  changes: z.array(z.object({ variantId: id, expectedRevision: z.number().int().min(0).max(2_147_483_646), state: z.enum(["active", "withdrawn"]) }).strict()).max(10_000),
}).strict();
const decisionSchema = z.object({ schemaVersion: z.literal(2), action: z.enum(["approve", "revoke"]), productId: id, commandKey: key,
  candidateRef: referenceSchema, candidateDigest: digest, reason: z.string().refine(value => /[^ ]/u.test(value) && Buffer.byteLength(value) <= 1000).nullable() }).strict();
const bindingSchema = z.object({ kind: z.enum(["account", "order", "fulfilment"]), sourceId: id, lineId: id,
  productId: id, skuId: id, skuRevisionId: id, publicationId: id, documentRevisionId: id }).strict();
const equal = (a: unknown, b: unknown) => publicationJson(a) === publicationJson(b);
const require = (value: unknown, code: string, outcome?: CatalogPublicationError["outcome"]) => { if (!value) publicationRefuse(code, outcome); };
const tuple = (db: PgQueryExecutor, sql: string, values: unknown[] = []) => db.query(sql, values).then(result => result.rows);
const readInvalid = "catalog_publication_read_invalid";
const observedRow = (rows: Record<string, unknown>[]) => {
  require(rows.length === 1, readInvalid, "dependency_unavailable");
  return rows[0]!;
};

function failure(error: unknown): CatalogPublicationFailure {
  if (error instanceof CatalogPriceSetupTransactionError) return error.refusal;
  if (error instanceof CatalogPublicationError) return { outcome: error.outcome, reason: error.code };
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "55P03" || code === "40P01") return { outcome: "conflict", reason: "catalog_publication_busy" };
  if (code === "23505") return { outcome: "conflict", reason: "catalog_publication_identity_conflict" };
  if (code === "42501") return { outcome: "unauthorized", reason: "publisher_not_authorized" };
  return { outcome: "dependency_unavailable", reason: "publication_authority_unavailable" };
}
interface StoredPublication { id: string; product_id: string; revision: number; previous_id: string | null; previous_revision: number | null; document_revision_id: string; canonical_state: string; digest: string; committed_at: string }
interface RetainedState { head: CatalogHeadRef | null; publication: StoredPublication | null; product: CatalogPublishedProduct | null;
  skus: CatalogPublishedSku[]; references: CatalogSkuRevisionRef[]; documents: CatalogPublicationDocument[];
  liveSkus: { id: string; product_id: string; sku: string; status: string; sellable_standalone: boolean; sellable_in_subscription: boolean;
    net_weight_g: number; option_values: unknown }[] }
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
    if (auth?.ok !== true || auth.role !== "admin" || auth.isMachineActor !== false || !id.safeParse(auth.userId).success) return null;
    const capability = Object.freeze({}); actors.set(capability, auth.userId); return capability as VerifiedCatalogPublisher;
  }
  async function actor(db: PgQueryExecutor, capability: VerifiedCatalogPublisher): Promise<string> {
    const actorId = typeof capability === "object" && capability !== null ? actors.get(capability) : undefined;
    require(actorId, "publisher_not_authorized", "unauthorized");
    const rows = await tuple(db, "SELECT public.platform_human_membership_is_administrator($1::uuid) AS allowed", [actorId]);
    require(rows.length === 1 && rows[0]!.allowed === true, "publisher_not_authorized", "unauthorized");
    return actorId!;
  }
  function verifyPredecessor(revisionNo: unknown, previousId: unknown, previousRevision: unknown) {
    require(revision.safeParse(revisionNo).success && (revisionNo === 1 ? previousId === null && previousRevision === null
      : id.safeParse(previousId).success && previousRevision === Number(revisionNo) - 1), readInvalid, "dependency_unavailable");
  }
  async function retainedSkuIndex(db: PgQueryExecutor, productId: string, at: number, references: readonly CatalogSkuRevisionRef[]) {
    const rows = await tuple(db, `SELECT id,sku_id,revision,digest,octet_length(full_facts) AS bytes,sku_code,
      EXISTS(SELECT 1 FROM public.catalog_publications issued WHERE issued.product_id=r.product_id AND issued.id=r.publication_id AND issued.revision<=$3) AS visible,
      EXISTS(SELECT 1 FROM public.catalog_sku_revisions changed JOIN public.catalog_publications issued
        ON issued.product_id=changed.product_id AND issued.id=changed.publication_id
        WHERE changed.product_id=r.product_id AND changed.sku_id=r.sku_id AND changed.revision>r.revision AND issued.revision<=$3) AS superseded
      FROM public.catalog_sku_revisions r WHERE product_id=$1::uuid AND id=ANY($2::uuid[])`, [productId, references.map(ref => ref.revisionId), at]);
    const byId = new Map(rows.map(row => [row.id, row])), codes = new Set<string>();
    require(rows.length === references.length && byId.size === rows.length, "catalog_publication_sku_revision_invalid", "dependency_unavailable");
    for (const reference of references) {
      const row = byId.get(reference.revisionId);
      if (!row || row.sku_id !== reference.skuId || row.revision !== reference.revision || row.digest !== reference.digest
        || typeof row.bytes !== "number" || row.bytes < 2 || row.bytes > CATALOG_PUBLICATION_LIMITS.skuBytes
        || typeof row.sku_code !== "string" || !row.sku_code || codes.has(row.sku_code)
        || row.visible !== true || row.superseded !== false)
        return publicationRefuse("catalog_publication_sku_revision_invalid", "dependency_unavailable");
      codes.add(row.sku_code);
    }
    return byId;
  }
  async function load(db: PgQueryExecutor, productId: string, historical?: CatalogHeadRef, allowDrift = false, documentRevisions: readonly number[] = [], expected?: { command: CatalogHeadRef | null; candidate: CatalogHeadRef | null }): Promise<RetainedState> {
    // One statement binds the head, full immutable roster/documents and current projections to the same snapshot.
    const rows = await tuple(db, `SELECT (SELECT to_jsonb(h) FROM public.catalog_publication_heads h WHERE h.product_id=$1::uuid) AS head,
      (SELECT to_jsonb(p) FROM public.catalog_products p WHERE p.id=$1::uuid) AS live_product,
      coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.catalog_skus s WHERE s.product_id=$1::uuid),'[]'::jsonb) AS live_skus,
      (SELECT to_jsonb(p) || jsonb_build_object('previous_revision', previous.revision) FROM public.catalog_publications p
        LEFT JOIN public.catalog_publications previous ON previous.product_id=p.product_id AND previous.id=p.previous_id
        WHERE p.product_id=$1::uuid AND p.id=coalesce($2::uuid,(SELECT publication_id FROM public.catalog_publication_heads WHERE product_id=$1::uuid))) AS publication,
      (SELECT max(revision) FROM public.catalog_publications p WHERE p.product_id=$1::uuid) AS latest_revision,
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
      require(historical || row.latest_revision === null && row.head === null, readInvalid, "dependency_unavailable");
      checkHead(null);
      require(!historical && row.live_product === null, "catalog_publication_lineage_unknown", "unsupported");
      return { head: null, publication: null, product: null, skus: [], references: [], documents, liveSkus: [] };
    }
    require(publication.product_id === productId && publicationDigest(JSON.parse(publication.canonical_state)) === publication.digest
      && publicationJson(JSON.parse(publication.canonical_state)) === publication.canonical_state, "catalog_publication_manifest_invalid", "dependency_unavailable");
    const manifest = catalogPublicationManifestSchema.parse(JSON.parse(publication.canonical_state));
    require(manifest.schemaVersion === 2 && manifest.product.id === productId && Array.isArray(manifest.skus), "catalog_publication_manifest_invalid", "dependency_unavailable");
    const document = documents.find(document => document.reference.id === publication.document_revision_id);
    require(document && equal(manifest.product.document, document.reference), "catalog_publication_document_invalid", "dependency_unavailable");
    require(createHash("sha256").update(document!.canonicalText).digest("hex") === document!.reference.digest,
      "catalog_publication_document_invalid", "dependency_unavailable");
    const head = { publicationId: publication.id, revision: publication.revision, documentDigest: document!.reference.digest };
    verifyPredecessor(publication.revision, publication.previous_id, publication.previous_revision);
    if (!historical) {
      const pointer = row.head as Record<string, unknown> | null;
      require(pointer?.product_id === productId && pointer.publication_id === publication.id
        && pointer.revision === publication.revision && row.latest_revision === publication.revision, readInvalid, "dependency_unavailable");
    }
    require(!historical || equal(head, historical), "head_conflict", "conflict");
    checkHead(head);
    const roster = await retainedSkuIndex(db, productId, publication.revision, manifest.skus);
    const revisions = row.revisions as Record<string, unknown>[], byId = new Map(revisions.map(stored => [stored.id, stored]));
    require(byId.size === revisions.length && revisions.length === manifest.skus.length, "catalog_publication_sku_revision_invalid", "dependency_unavailable");
    const skus = manifest.skus.map(reference => {
      const stored = byId.get(reference.revisionId);
      require(stored && stored.sku_id === reference.skuId && stored.revision === reference.revision && stored.digest === reference.digest
        && typeof stored.full_facts === "string", "catalog_publication_sku_revision_invalid", "dependency_unavailable");
      const parsed = catalogPublishedSkuSchema.parse(JSON.parse(stored!.full_facts as string));
      require(publicationJson(parsed, CATALOG_PUBLICATION_LIMITS.skuBytes) === stored!.full_facts
        && publicationDigest(parsed, CATALOG_PUBLICATION_LIMITS.skuBytes) === reference.digest && parsed.id === reference.skuId && parsed.productId === productId
        && parsed.code === roster.get(reference.revisionId)?.sku_code, "catalog_publication_sku_revision_invalid", "dependency_unavailable");
      return parsed;
    });
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
      catch (error) {
        if (error instanceof CatalogPublicationError && error.code === "catalog_publication_post_state_mismatch")
          publicationRefuse("catalog_publication_live_drift", "conflict");
        throw error;
      }
    }
    return { head, publication, product: manifest.product, skus, references: manifest.skus, documents, liveSkus: row.live_skus as RetainedState["liveSkus"] };
  }
  async function commandGuards(db: PgQueryExecutor, productId: string, candidateRef: string, candidateDigest: string, commandKey: string) {
    const referenceDigest = publicationDigest([candidateRef, candidateDigest]);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`catalog-decision:${referenceDigest}`]);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`catalog-command:${productId}:${commandKey}`]);
    return referenceDigest;
  }
  async function requireNoPublicationCommand(db: PgQueryExecutor, productId: string, commandKey: string) {
    const { found } = observedRow(await tuple(db, `SELECT EXISTS(
      SELECT 1 FROM public.catalog_publications WHERE product_id=$1::uuid AND command_key=$2) AS found`, [productId, commandKey]));
    require(found === false, "catalog_publication_receipt_invalid", "dependency_unavailable");
  }
  async function receipt(db: PgQueryExecutor, productId: string, commandKey: string, kind: string, fingerprint: string, actorId: string) {
    const rows = await tuple(db, `SELECT ${receiptColumns} FROM public.catalog_operator_receipts WHERE scope_id=$1::uuid AND command_key=$2`, [productId, commandKey]);
    if (kind === "publish" && (!rows.length || rows[0]!.kind !== "publish"))
      await requireNoPublicationCommand(db, productId, commandKey);
    if (!rows.length) return null;
    require(rows.length === 1, "catalog_publication_receipt_invalid", "dependency_unavailable");
    const original = rows[0]!;
    require(original.kind === kind && original.fingerprint === fingerprint, "catalog_publication_command_key_reused", "conflict");
    if (kind === "publish") {
      const result = await storedPublishReceipt(db, original);
      require(result.actorId === actorId, "catalog_publication_operator_mismatch", "unauthorized");
      return result;
    }
    require(original.actor_id === actorId, "catalog_publication_operator_mismatch", "unauthorized");
    const result = checkedDecisionReceipt(original.result);
    const { fingerprint: _fingerprint, actorId: _actorId, decidedAt: _decidedAt, ...originalCommand } = result;
    require(publicationDigest([originalCommand, actorId]) === fingerprint, "catalog_publication_receipt_invalid", "dependency_unavailable");
    require(result.productId === productId && result.commandKey === commandKey && result.fingerprint === fingerprint && result.actorId === actorId
      && result.action === kind && original.publication_id === null, "catalog_publication_receipt_invalid", "dependency_unavailable");
    const decision = await tuple(db, `SELECT candidate_ref,candidate_digest,candidate_reference_digest,action,actor_id,fingerprint,reason,
      to_char(decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at
      FROM public.catalog_publication_decisions WHERE product_id=$1::uuid AND command_key=$2`, [productId, commandKey]);
    const recorded = decision[0];
    require(decision.length === 1 && recorded?.candidate_ref === result.candidateRef && recorded.candidate_digest === result.candidateDigest
      && recorded.candidate_reference_digest === publicationDigest([result.candidateRef, result.candidateDigest])
      && recorded.action === result.action && recorded.actor_id === result.actorId && recorded.fingerprint === result.fingerprint
      && recorded.reason === result.reason && recorded.decided_at === result.decidedAt,
    "catalog_publication_receipt_invalid", "dependency_unavailable");
    return result;
  }
  async function storedPublishReceipt(db: PgQueryExecutor, row: Record<string, unknown>) {
    require(row.kind === "publish", "catalog_publication_receipt_invalid", "dependency_unavailable");
    const result = checkedReceipt(row.result);
    require(result.productId === row.scope_id && result.commandKey === row.command_key && result.fingerprint === row.fingerprint
      && result.actorId === row.actor_id && result.head.publicationId === row.publication_id, "catalog_publication_receipt_invalid", "dependency_unavailable");
    const publications = await tuple(db, `SELECT p.revision,p.digest,d.digest AS document_digest,p.previous_id,previous.revision AS previous_revision,previous_document.digest AS previous_document_digest,
      p.command_key,p.actor_id,(SELECT count(*)::integer FROM public.catalog_operator_receipts WHERE publication_id=p.id) AS receipt_count,
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'productId',p.product_id,'variantId',r.sku_id,'sku',r.sku_code,
          'state',CASE WHEN r.full_facts::jsonb->>'status'='archived' THEN 'withdrawn' ELSE r.full_facts::jsonb->>'status' END,
          'variantRevision',r.revision,'publicationHead',jsonb_build_object('publicationId',p.id,'revision',p.revision,'documentDigest',d.digest),
          'draftRef',jsonb_build_object('draftId',p.draft_id,'revision',p.draft_revision)) ORDER BY entry->>'skuId' COLLATE "C"),'[]'::jsonb)
        FROM (SELECT value AS entry FROM jsonb_array_elements(p.canonical_state::jsonb->'skus')
          EXCEPT SELECT value FROM jsonb_array_elements(previous.canonical_state::jsonb->'skus')) changed
        LEFT JOIN public.catalog_sku_revisions r ON r.id=(entry->>'revisionId')::uuid AND r.publication_id=p.id AND r.product_id=p.product_id
          AND r.sku_id=(entry->>'skuId')::uuid AND r.revision=(entry->>'revision')::integer AND r.digest=entry->>'digest') AS recorded_changes,
      to_char(p.committed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS committed_at
      FROM public.catalog_publications p JOIN public.catalog_product_document_revisions d ON d.id=p.document_revision_id AND d.product_id=p.product_id
      LEFT JOIN public.catalog_publications previous ON previous.id=p.previous_id AND previous.product_id=p.product_id
      LEFT JOIN public.catalog_product_document_revisions previous_document ON previous_document.id=previous.document_revision_id AND previous_document.product_id=previous.product_id
      WHERE p.id=$1::uuid AND p.product_id=$2::uuid`, [result.head.publicationId, result.productId]);
    require(publications.length === 1 && result.head.revision === publications[0]!.revision && result.head.documentDigest === publications[0]!.document_digest
      && result.publicationDigest === publications[0]!.digest && result.committedAt === publications[0]!.committed_at
      && result.commandKey === publications[0]!.command_key && result.actorId === publications[0]!.actor_id && publications[0]!.receipt_count === 1
      && equal(result.changes, publications[0]!.recorded_changes)
      && equal(result.previousHead, publications[0]!.previous_id === null ? null : { publicationId: publications[0]!.previous_id, revision: publications[0]!.previous_revision, documentDigest: publications[0]!.previous_document_digest }),
    "catalog_publication_receipt_invalid", "dependency_unavailable");
    verifyPredecessor(result.head.revision, publications[0]!.previous_id, publications[0]!.previous_revision);
    publicationJson({ outcome: "found", receipt: result }, CATALOG_PUBLICATION_LIMITS.receiptBytes);
    return result;
  }
  async function draftEvidence(db: PgQueryExecutor, draftId: string, draftRevision: number) {
    return observedRow(await tuple(db, `SELECT public.catalog_draft_record($1::uuid,$2::integer) AS record, EXISTS (
      SELECT 1 FROM public.catalog_draft_revisions source
      JOIN public.catalog_draft_command_receipts receipt USING(draft_id,revision,command_key,fingerprint)
      WHERE source.draft_id=$1::uuid AND source.revision=$2::integer) AS receipted`, [draftId, draftRevision]));
  }
  async function candidate(db: PgQueryExecutor, reference: string, expectedDigest: string, productId: string) {
    const parsed = parseCatalogCandidateReference(reference);
    if (!parsed) return publicationRefuse("candidate_invalid");
    let expectedHead: CatalogHeadRef | null = null;
    if (parsed.head) {
      const rows = await tuple(db, `SELECT p.id,p.revision,d.digest FROM public.catalog_publications p
        JOIN public.catalog_product_document_revisions d ON d.id=p.document_revision_id AND d.product_id=p.product_id WHERE p.id=$1::uuid AND p.product_id=$2::uuid`, [parsed.head.publicationId, productId]);
      require(rows.length === 1 && rows[0]!.id === parsed.head.publicationId && rows[0]!.revision === parsed.head.revision, "head_conflict", "conflict");
      expectedHead = headSchema.parse({ publicationId: rows[0]!.id, revision: rows[0]!.revision, documentDigest: rows[0]!.digest });
    }
    const { record: raw, receipted } = await draftEvidence(db, parsed.draftId, parsed.draftRevision);
    require(raw !== null, "candidate_invalid");
    require(receipted === true, "catalog_publication_source_mismatch");
    const header = z.object({ payload: z.object({ product: z.object({ type: catalogProductTypeRefSchema }) }) }).safeParse(raw);
    if (header.success) {
      const definition = deps.registry.resolve(header.data.payload.product.type);
      if (definition) assertCatalogPublicationMassInputs((raw as { payload: unknown }).payload, definition);
    }
    const record = catalogDraftPublicationStoredRecordSchema.parse(raw);
    require(record.draftId === parsed.draftId && record.revision === parsed.draftRevision, readInvalid, "dependency_unavailable");
    require(record.productId === productId && record.payload.schemaVersion === 3, "candidate_invalid");
    require(record.status === "open", "catalog_publication_source_mismatch");
    const payload = record.payload as CatalogDraftPayloadV3, definition = deps.registry.resolve(payload.product.type);
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
  async function lockDraftEvidence(db: PgQueryExecutor, prepared: Awaited<ReturnType<typeof candidate>>, before: RetainedState, publication: boolean) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`catalog-definition:${prepared.definition.key}@${prepared.definition.version}`]);
    await db.query("SELECT type_key FROM public.catalog_type_versions WHERE type_key=$1 AND version=$2 FOR SHARE", [prepared.definition.key, prepared.definition.version]);
    if (prepared.definition.taxClass) {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`catalog-tax:${prepared.definition.taxClass}`]);
      const rows = await tuple(db, "SELECT key FROM public.catalog_tax_classes WHERE key=$1 AND status='active' FOR SHARE", [prepared.definition.taxClass]);
      require(rows.length === 1, "catalog_tax_class_unavailable");
    }
    const explicit = prepared.payload.publication.evidence.drafts ?? [];
    const affected = catalogPublicationAffected(prepared.payload), activationCodes = new Set(affected.enabling);
    for (const sku of before.liveSkus) if (sku.status === "active" && (sku.sellable_standalone || sku.sellable_in_subscription)
      && affected.source(sku.sku)) activationCodes.add(sku.sku);
    const media = prepared.payload.publication.evidence.media ?? [], mediaCodes = new Set(media.map(claim => claim.skuCode));
    const authoredSkus = new Map(prepared.payload.skus.map(sku => [sku.code, sku]));
    for (const claim of media) {
      if (authoredSkus.has(claim.skuCode)) continue;
      if (before.skus.some(sku => sku.code === claim.skuCode))
        return publicationRefuse("catalog_publication_draft_advanced", "conflict");
      return publicationRefuse("catalog_publication_media_evidence_mismatch");
    }
    const currentSourceCodes = new Set([...activationCodes, ...mediaCodes]);
    const fallbackCodes = [...activationCodes].filter(code => !authoredSkus.has(code));
    const publishedSources = before.head && fallbackCodes.length ? await tuple(db, `SELECT DISTINCT ON (sku.sku)
      sku.sku AS code,draft.draft_id,draft.revision,draft.command_key,draft.fingerprint
      FROM public.catalog_publications publication
      JOIN public.catalog_draft_revisions draft ON draft.draft_id=publication.draft_id AND draft.revision=publication.draft_revision
        AND draft.product_id=publication.product_id
      JOIN public.catalog_skus sku ON sku.product_id=publication.product_id
      WHERE publication.product_id=$1::uuid AND publication.revision <= $2 AND sku.sku=ANY($3::text[])
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(draft.payload->'skus') value
          WHERE value->>'id'=sku.id::text AND value->>'code'=sku.sku AND value->>'productId'=sku.product_id::text)
      ORDER BY sku.sku,publication.revision DESC`, [prepared.record.productId, before.head.revision, fallbackCodes]) : [];
    const published = new Map(publishedSources.map(row => [row.code as string, { draftId: row.draft_id as string, revision: row.revision as number,
      commandKey: row.command_key as string, fingerprint: row.fingerprint as string }]));
    const claims = [prepared.record, ...explicit, ...published.values(), ...(before.product ? [before.product.source] : []), ...before.skus.map(sku => sku.source)];
    const draftIds = [...new Set(claims.map(claim => claim.draftId))].sort();
    for (const draftId of draftIds) await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`catalog-draft:${draftId}`]);
    const heads = await tuple(db, "SELECT * FROM public.catalog_draft_heads WHERE draft_id=ANY($1::uuid[]) ORDER BY draft_id FOR NO KEY UPDATE", [draftIds]);
    const primaryKey = `${prepared.record.draftId}@${prepared.record.revision}`;
    const resolved = new Map([[primaryKey, prepared.record]]);
    for (const claim of claims) {
      const key = `${claim.draftId}@${claim.revision}`;
      let source = resolved.get(key);
      if (!source) {
        const evidence = await draftEvidence(db, claim.draftId, claim.revision);
        require(evidence.receipted === true, "catalog_publication_source_mismatch");
        source = catalogDraftPublicationStoredRecordSchema.parse(evidence.record);
        resolved.set(key, source);
      }
      require(source.draftId === claim.draftId && source.revision === claim.revision, readInvalid, "dependency_unavailable");
      require(source.productId === prepared.record.productId && source.status === "open"
        && source.commandKey === claim.commandKey && source.fingerprint === claim.fingerprint, "catalog_publication_source_mismatch");
      const head = heads.find(row => row.draft_id === claim.draftId);
      require(head?.product_id === source.productId, "catalog_publication_draft_advanced", "conflict");
      if (Object.is(claim, prepared.record) || explicit.includes(claim))
        require(head?.revision === source.revision && head.status === "open", "catalog_publication_draft_advanced", "conflict");
    }
    for (const claim of explicit) {
      const source = resolved.get(`${claim.draftId}@${claim.revision}`)!;
      require(source.payload.schemaVersion === 3 && equal(source.payload.product.type, prepared.payload.product.type), "catalog_publication_source_mismatch");
      const reference = source.payload.product.documentRevision;
      require(reference?.productId === source.productId, "catalog_publication_document_source_mismatch");
      const operations = prepared.payload.publication.operations;
      if (!equal(before.product?.document ?? null, reference)) {
        const registration = operations.findIndex(operation => operation.op === "register_document_revision"
          && operation.revisionId === reference?.id && operation.revisionNo === reference.revisionNo && operation.digest === reference.digest
          && operation.documentRef === reference.documentRef && operation.sourceRef === reference.sourceRef
          && equal(resolveCatalogDraftProvenance(operation.provenance, prepared.record), { draftId: source.draftId, draftRevision: source.revision,
            draftCommandKey: source.commandKey, draftFingerprint: source.fingerprint }));
        require(registration >= 0 && operations.slice(registration + 1).some(operation => operation.op === "move_document_pointer"
          && operation.productSlug === source.payload.product.slug && operation.documentRevisionNo === reference?.revisionNo),
        "catalog_publication_v3_document_reference_stale", "conflict");
      }
    }
    const retained = [...resolved.entries()].filter(([key]) => key !== primaryKey).map(([, source]) => source);
    const declared = explicit.map(claim => resolved.get(`${claim.draftId}@${claim.revision}`)!)
      .sort((a, b) => comparePublicationText(a.draftId, b.draftId));
    const selectedSources = new Map<string, CatalogDraftPublicationStoredRecord & { payload: CatalogDraftPayloadV3 }>();
    for (const code of currentSourceCodes) {
      const fallback = published.get(code);
      const source = authoredSkus.has(code) ? prepared.record
        : declared.find(source => source.payload.skus.some(sku => sku.code === code))
          ?? (fallback ? resolved.get(`${fallback.draftId}@${fallback.revision}`) : undefined);
      if (!source || source.payload.schemaVersion !== 3)
        return publicationRefuse(mediaCodes.has(code) ? "catalog_publication_media_evidence_mismatch" : "catalog_publication_operation_source_missing");
      selectedSources.set(code, { ...source, payload: source.payload });
      if (publication || mediaCodes.has(code))
        require(heads.some(head => head.draft_id === source.draftId && head.product_id === source.productId
          && head.revision === source.revision && head.status === "open"), "catalog_publication_draft_advanced", "conflict");
    }
    for (const claim of media) {
      const sku = authoredSkus.get(claim.skuCode)!;
      require(claim.mediaRef === prepared.payload.product.sharedContent.presentation.mediaRef
        && equal(claim.assetRefs, [...(sku.assetRefs ?? [])].sort(comparePublicationText)), "catalog_publication_media_evidence_mismatch");
    }
    return { retained, activationCodes, selectedSources };
  }
  async function lockLineage(db: PgQueryExecutor, productId: string) {
    const guard = await tuple(db, "SELECT pg_try_advisory_xact_lock(hashtextextended('catalog-publication-global',0)) AS allowed");
    const { allowed } = observedRow(guard);
    require(typeof allowed === "boolean", readInvalid, "dependency_unavailable");
    require(allowed, "catalog_publication_busy", "conflict");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`catalog-lineage:${productId}`]);
    // Legacy catalogue writes do not take the publication advisory guard. These
    // relation locks stop their writes while allowing foreign-key readers.
    await db.query(`LOCK TABLE public.catalog_products,public.catalog_skus,public.catalog_sku_identifiers,public.catalog_product_document_revisions
      IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    await db.query("SELECT product_id FROM public.catalog_publication_heads WHERE product_id=$1::uuid FOR NO KEY UPDATE NOWAIT", [productId]);
    await db.query("SELECT id FROM public.catalog_products WHERE id=$1::uuid ORDER BY id FOR NO KEY UPDATE NOWAIT", [productId]);
    await db.query("SELECT id FROM public.catalog_skus WHERE product_id=$1::uuid ORDER BY id FOR NO KEY UPDATE NOWAIT", [productId]);
  }
  function checkReadinessVerdict(result: unknown, reason: string) {
    const verdict = publicationReadinessVerdict.safeParse(result);
    require(verdict.success, "catalog_publication_readiness_invalid", "dependency_unavailable");
    require(verdict.data?.ready === true, reason);
  }
  async function checkReadiness(db: PgQueryExecutor, state: { product: CatalogPublishedProduct; skus: CatalogPublishedSku[] }, payload: CatalogDraftPayloadV3) {
    const affected = catalogPublicationAffected(payload);
    const hasPresentation = payload.publication.operations.some(operation => operation.op === "set_product_presentation");
    const structural = state.skus.filter(sku => affected.structural(sku.code));
    const priced = state.skus.filter(affected.priced);
    for (const [skus, requirePrice] of [[structural, false], [priced, true]] as const) {
      const reason = requirePrice ? "catalog_publication_v3_activation_readiness_failed" : "catalog_publication_v3_structural_readiness_failed";
      for (const sku of skus) {
        const rows = await tuple(db, "SELECT public.catalog_publication_sku_reasons($1::uuid,$2::boolean) AS reasons", [sku.id, requirePrice]);
        const reasons = publicationReadinessReasons.safeParse(rows[0]?.reasons);
        require(rows.length === 1 && reasons.success, "catalog_publication_readiness_invalid", "dependency_unavailable");
        require(reasons.data?.length === 0, reason);
      }
      if (skus.length || !requirePrice && hasPresentation) checkReadinessVerdict(await deps.readiness(db, { product: state.product, skus: [...skus] }, requirePrice), reason);
    }
  }
  async function decision(input: CatalogDecisionCommandV2, capability: VerifiedCatalogPublisher) {
    try {
      let command: CatalogDecisionCommandV2;
      try { command = decisionSchema.parse(JSON.parse(canonicalCatalogDraftJson(input))); }
      catch { return publicationRefuse("catalog_publication_command_invalid"); }
      return await deps.transactions.run(async db => {
        await db.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        const actorId = await actor(db, capability);
        const fingerprint = publicationDigest([command, actorId]);
        const referenceDigest = await commandGuards(db, command.productId, command.candidateRef, command.candidateDigest, command.commandKey);
        const original = await receipt(db, command.productId, command.commandKey, command.action, fingerprint, actorId);
        if (original) return { outcome: "replayed" as const, receipt: checkedDecisionReceipt(original) };
        const balance = await tuple(db, `SELECT coalesce(sum(CASE action WHEN 'approve' THEN 1 ELSE -1 END),0)::integer AS balance,
          count(*)::integer AS registered FROM public.catalog_publication_decisions WHERE candidate_reference_digest=$1 AND product_id=$2::uuid
          AND candidate_ref=$3 AND candidate_digest=$4`, [referenceDigest, command.productId, command.candidateRef, command.candidateDigest]);
        const { balance: count, registered } = observedRow(balance);
        require(Number.isInteger(count) && Number.isInteger(registered), readInvalid, "dependency_unavailable");
        if (registered === 0) {
          const prepared = await candidate(db, command.candidateRef, command.candidateDigest, command.productId);
          const before = await load(db, command.productId, undefined, true);
          const { retained } = await lockDraftEvidence(db, prepared, before, false);
          assertCatalogPublicationAuthorship({ ...prepared, skus: before.skus, retainedSources: retained, rules: deps.rules });
        }
        require(count === (command.action === "approve" ? 0 : 1), "catalog_publication_decision_balance_invalid", "conflict");
        const time = observedRow(await tuple(db, "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value")).value as string;
        require(instant.safeParse(time).success, readInvalid, "dependency_unavailable");
        const result: CatalogDecisionReceiptV2 = { ...command, fingerprint, actorId, decidedAt: time };
        publicationJson({ outcome: "committed", receipt: result }, CATALOG_PUBLICATION_LIMITS.receiptBytes);
        await db.query("INSERT INTO public.catalog_operator_receipts(kind,scope_id,command_key,fingerprint,actor_id,result) VALUES($1,$2,$3,$4,$5,$6)", [command.action, command.productId, command.commandKey, fingerprint, actorId, publicationJson(result)]);
        await db.query(`INSERT INTO public.catalog_publication_decisions(id,product_id,candidate_ref,candidate_digest,candidate_reference_digest,action,actor_id,command_key,fingerprint,reason,decided_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz)`, [randomUUID(), command.productId, command.candidateRef, command.candidateDigest, referenceDigest, command.action, actorId, command.commandKey, fingerprint, command.reason, time]);
        return { outcome: "committed" as const, receipt: result };
      });
    } catch (error) { return failure(error); }
  }
  async function publish(input: CatalogPublishCommand, capability: VerifiedCatalogPublisher) {
    try {
      let command: z.infer<typeof commandSchema>;
      try { command = commandSchema.parse(JSON.parse(canonicalCatalogDraftJson(input))); }
      catch { return publicationRefuse("catalog_publication_command_invalid"); }
      return await deps.transactions.run(async db => {
        await db.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        const actorId = await actor(db, capability);
        const fingerprint = publicationDigest([command, actorId]);
        const referenceDigest = await commandGuards(db, command.productId, command.candidateRef, command.candidateDigest, command.commandKey);
        const original = await receipt(db, command.productId, command.commandKey, "publish", fingerprint, actorId);
        if (original) return { outcome: "replayed" as const, receipt: checkedReceipt(original) };
        const prepared = await candidate(db, command.candidateRef, command.candidateDigest, command.productId);
        const approval = await tuple(db, "SELECT coalesce(sum(CASE action WHEN 'approve' THEN 1 ELSE -1 END),0)::integer AS balance FROM public.catalog_publication_decisions WHERE candidate_reference_digest=$1 AND product_id=$2::uuid", [referenceDigest, command.productId]);
        const count = observedRow(approval).balance;
        require(Number.isInteger(count), readInvalid, "dependency_unavailable");
        require(count === 1, "catalog_publication_approval_required");
        require((await tuple(db, "SELECT id FROM public.catalog_publications WHERE candidate_ref=$1", [command.candidateRef])).length === 0, "catalog_publication_candidate_already_published", "conflict");
        const documentRevisions = prepared.payload.publication.operations.flatMap(operation => operation.op === "register_document_revision" ? [operation.revisionNo] : []);
        if (prepared.payload.product.documentRevision) documentRevisions.push(prepared.payload.product.documentRevision.revisionNo);
        const preliminary = await load(db, command.productId, undefined, true, documentRevisions);
        const { retained: retainedSources, activationCodes, selectedSources } = await lockDraftEvidence(db, prepared, preliminary, true);
        assertCatalogPublicationPreparation(prepared.payload, { definition: prepared.definition, rules: deps.rules });
        assertCatalogPublicationAuthorship({ ...prepared, skus: preliminary.skus, retainedSources, rules: deps.rules });
        for (const operation of prepared.payload.publication.operations) {
          if (operation.op !== "set_derived_sku_facts") continue;
          const live = preliminary.liveSkus.find(sku => sku.sku === operation.skuCode);
          require(live && String(live.net_weight_g) === catalogPublicationIntegralGrams(operation.netContent, prepared.definition),
            "catalog_publication_derived_source_mismatch");
        }
        for (const code of activationCodes) {
          const authored = selectedSources.get(code)?.payload.skus.find(sku => sku.code === code);
          const sku = preliminary.liveSkus.find(sku => sku.sku === code);
          require(authored?.netContent && sku?.id === authored.id && sku.product_id === authored.productId
            && String(sku.net_weight_g) === catalogPublicationIntegralGrams(authored.netContent, prepared.definition)
            && equal(sku.option_values, authored.options), "catalog_publication_operation_source_mismatch");
        }
        await lockLineage(db, command.productId);
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
        const compiled = compileCatalogPublicationEffects({ ...prepared, product: current.product, skus: current.skus, documents: current.documents, retainedSources, rules: deps.rules });
        for (const change of command.changes) require(compiled.skus.some(sku => sku.id === change.variantId
          && (change.state === "withdrawn" ? sku.status === "archived" : sku.status === "active")), "catalog_publication_variant_state_mismatch");
        for (const sku of compiled.skus) {
          if (!activationCodes.has(sku.code)) continue;
          const source = selectedSources.get(sku.code);
          require(source, "catalog_publication_operation_source_missing");
          const authored = source!.payload.skus.find(value => value.code === sku.code)!;
          assertCatalogPublicationGrossMass(authored.netContent!, authored.grossMass ?? null, prepared.definition);
          const mediaRef = compiled.product.presentation?.mediaRef;
          const hasMedia = (authored.assetRefs?.length ?? 0) > 0 || typeof source!.payload.product.sharedContent.presentation.mediaRef === "string";
          if (!hasMedia && sku.assetRefs.length === 0 && typeof mediaRef !== "string") continue;
          const claim = prepared.payload.publication.evidence.media?.find(claim => claim.skuCode === sku.code);
          require(claim && claim.mediaRef === mediaRef && equal(claim.assetRefs, [...(authored.assetRefs ?? [])].sort(comparePublicationText))
            && equal(claim.assetRefs, [...sku.assetRefs].sort(comparePublicationText)), "catalog_publication_media_readiness_unproven");
          const verdict = await deps.verifyMedia(db, claim!);
          require(typeof verdict === "boolean", "catalog_publication_readiness_invalid", "dependency_unavailable");
          require(verdict, "catalog_publication_media_readiness_unproven");
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
        await projectAttributes(db, compiled, prepared.definition, next);
        await checkReadiness(db, compiled, prepared.payload);
        compiled.validateAfterReadiness();
        if (compiled.activation) {
          require(deps.globalReadiness, "catalog_publication_readiness_unavailable", "dependency_unavailable");
          checkReadinessVerdict(await deps.globalReadiness!(db), "catalog_publication_v3_activation_readiness_failed");
        }
        const references: CatalogSkuRevisionRef[] = compiled.skus.map(sku => {
          const digest = publicationDigest(sku, CATALOG_PUBLICATION_LIMITS.skuBytes), prior = current.references.find(reference => reference.skuId === sku.id);
          return prior?.digest === digest ? prior : { skuId: sku.id, revisionId: randomUUID(), revision: (prior?.revision ?? 0) + 1, digest };
        });
        const manifest: CatalogPublicationManifestV2 = { schemaVersion: 2, product: compiled.product, skus: references };
        const canonicalState = publicationJson(manifest), publicationDigestValue = publicationDigest(manifest);
        const head = { publicationId, revision: next, documentDigest: compiled.product.document!.digest };
        const committedAt = observedRow(await tuple(db, "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value")).value as string;
        require(instant.safeParse(committedAt).success, readInvalid, "dependency_unavailable");
        // Verify the complete projection before making a durable head or receipt visible.
        await assertProjection(db, compiled);
        await db.query(`INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id,committed_at,command_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14)`, [publicationId, command.productId, next, current.head?.publicationId ?? null,
          prepared.record.draftId, prepared.record.revision, command.candidateRef, command.candidateDigest, compiled.product.document!.id, canonicalState, publicationDigestValue, actorId, committedAt, command.commandKey]);
        for (const reference of references) if (!current.references.some(prior => prior.revisionId === reference.revisionId)) {
          const sku = compiled.skus.find(sku => sku.id === reference.skuId)!;
          await db.query("INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest,sku_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [reference.revisionId, reference.skuId, command.productId, reference.revision, publicationId, publicationJson(sku, CATALOG_PUBLICATION_LIMITS.skuBytes), reference.digest, sku.code]);
        }
        const result: CatalogPublicationReceiptV2 = { schemaVersion: 2, productId: command.productId, commandKey: command.commandKey, fingerprint, actorId,
          previousHead: current.head, head, publicationDigest: publicationDigestValue, committedAt,
          changes: compiled.skus.filter(sku => !current.references.some(prior => prior.revisionId === references.find(reference => reference.skuId === sku.id)!.revisionId)).map(sku => ({
            productId: command.productId, variantId: sku.id, sku: sku.code, state: sku.status === "archived" ? "withdrawn" : sku.status,
            variantRevision: references.find(reference => reference.skuId === sku.id)!.revision, publicationHead: head,
            draftRef: { draftId: prepared.record.draftId, revision: prepared.record.revision } })) };
        publicationJson({ outcome: "committed", receipt: result }, CATALOG_PUBLICATION_LIMITS.receiptBytes);
        await db.query(`INSERT INTO public.catalog_publication_heads(product_id,publication_id,revision) VALUES($1,$2,$3)
          ON CONFLICT(product_id) DO UPDATE SET publication_id=EXCLUDED.publication_id,revision=EXCLUDED.revision`, [command.productId, publicationId, next]);
        await db.query("INSERT INTO public.catalog_operator_receipts(kind,scope_id,command_key,fingerprint,actor_id,publication_id,result) VALUES('publish',$1,$2,$3,$4,$5,$6)", [command.productId, command.commandKey, fingerprint, actorId, publicationId, publicationJson(result)]);
        await db.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload)
          VALUES('catalog_product',$1,'catalog.publication.committed',$2,$3::jsonb)`, [command.productId, `catalog-publication:${publicationId}`, publicationJson({ schemaVersion: 2, productId: command.productId, head, digest: publicationDigestValue })]);
        const { remaining } = observedRow(await tuple(db, "SELECT count(*)::integer AS remaining FROM public.catalog_publication_pointer_capabilities WHERE transaction_id=pg_current_xact_id()"));
        require(Number.isInteger(remaining), readInvalid, "dependency_unavailable");
        require(remaining === 0, "catalog_publication_pointer_capability_unconsumed");
        await load(db, command.productId);
        return { outcome: "committed" as const, receipt: result };
      });
    } catch (error) { return failure(error); }
  }
  async function applyOperations(db: PgQueryExecutor, payload: CatalogDraftPayloadV3, state: { product: CatalogPublishedProduct; skus: CatalogPublishedSku[]; documents: CatalogPublicationDocument[] },
    before: RetainedState, fingerprint: string, definition: NonNullable<ReturnType<typeof deps.registry.resolve>>) {
    const product = state.product;
    async function pointer(documentId: string) {
      await db.query("INSERT INTO public.catalog_publication_pointer_capabilities(transaction_id,product_id,revision_id,command_fingerprint) VALUES(pg_current_xact_id(),$1,$2,$3)", [product.id, documentId, fingerprint]);
      const updated = await tuple(db, "UPDATE public.catalog_products SET current_document_revision_id=$2 WHERE id=$1 AND current_document_revision_id IS DISTINCT FROM $2::uuid RETURNING id", [product.id, documentId]);
      require(updated.length === 1 && updated[0]?.id === product.id, "catalog_publication_pointer_capability_unconsumed");
      const residue = await tuple(db, "SELECT 1 FROM public.catalog_publication_pointer_capabilities WHERE transaction_id=pg_current_xact_id() LIMIT 1");
      require(residue.length === 0, "catalog_publication_pointer_capability_unconsumed");
    }
    for (const operation of payload.publication.operations) {
      if (operation.op === "create_product") {
        const prefix = { ...product, status: "draft", primarySkuId: null, document: null, presentation: null };
        await db.query(`INSERT INTO public.catalog_products(id,slug,name,status,type_key,type_version,variant_axes,attribute_values,publication_facts)
          VALUES($1,$2,$3,'draft',$4,$5,$6::text[],$7::jsonb,$8::jsonb)`, [product.id, product.slug, operation.name, product.type.key, product.type.version,
          product.axes, publicationJson(product.attributes), publicationJson(prefix)]);
      } else if (operation.op === "register_document_revision") {
        const document = state.documents.find(document => document.reference.id === operation.revisionId)!;
        const values = [operation.revisionId, product.id, operation.revisionNo, document.reference.schemaId,
          document.reference.documentRef, operation.canonicalText, document.reference.sourceRef, publicationJson(document.provenance), document.reference.digest];
        await db.query(`INSERT INTO public.catalog_product_document_revisions
          (id,product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest,canonical_text)
          VALUES($1,$2,$3,$4,$5,$6::text::jsonb,$7,$8::jsonb,$9,$6) ON CONFLICT DO NOTHING`, values);
        // An independent insert can win either identity key. Compare the actual immutable row after that race.
        const saved = await tuple(db, `SELECT id=$1 AND product_id=$2 AND revision_no=$3 AND schema_id=$4 AND document_ref=$5
          AND canonical_text=$6 AND document_payload=$6::text::jsonb AND source_ref=$7 AND provenance=$8::jsonb AND digest=$9 AS matches
          FROM public.catalog_product_document_revisions WHERE id=$1 OR (product_id=$2 AND revision_no=$3)`, values);
        require(saved.length === 1 && saved[0]?.matches === true, "catalog_publication_v3_compile_document_conflict", "conflict");
      } else if (operation.op === "move_document_pointer") {
        const document = state.documents.find(document => document.reference.revisionNo === operation.documentRevisionNo)!;
        const current = observedRow(await tuple(db, "SELECT current_document_revision_id FROM public.catalog_products WHERE id=$1", [product.id]));
        require(current.current_document_revision_id === null || id.safeParse(current.current_document_revision_id).success, readInvalid, "dependency_unavailable");
        if (current.current_document_revision_id !== document.reference.id) await pointer(document.reference.id);
        await db.query("UPDATE public.catalog_products SET publication_facts=jsonb_set(publication_facts,'{document}',$2::jsonb) WHERE id=$1", [product.id, publicationJson(document.reference)]);
      } else if (operation.op === "create_sku") {
        const sku = state.skus.find(sku => sku.id === operation.skuId)!;
        const prefix = { ...sku, status: "draft", sellableStandalone: false, sellableInSubscription: false,
          identifiers: [], memberships: [], logisticsRef: null, facts: operation.facts };
        await db.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,status,min_order_qty,is_addon,sellable_standalone,sellable_in_subscription,net_weight_g,publication_facts)
          VALUES($1,$2,$3,$4,'draft',$5,$6,false,false,$7::integer,$8::jsonb)`, [sku.id, product.id, sku.code, sku.title, sku.minQuantity, sku.isAddon,
          catalogPublicationIntegralGrams(sku.netContent, definition), publicationJson(prefix, CATALOG_PUBLICATION_LIMITS.skuBytes)]);
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
        const { op: _op, skuCode: _skuCode, ...identifier } = operation;
        await db.query(`UPDATE public.catalog_skus SET publication_facts=jsonb_set(publication_facts,'{identifiers}',
          publication_facts->'identifiers' || $2::jsonb) WHERE id=$1`, [sku.id, publicationJson([identifier])]);
      } else if (operation.op === "set_primary_sku") {
        const sku = state.skus.find(sku => sku.code === operation.skuCode)!;
        await db.query("UPDATE public.catalog_products SET primary_sku_id=$2::uuid,publication_facts=jsonb_set(publication_facts,'{primarySkuId}',to_jsonb($2::text)) WHERE id=$1", [product.id, sku.id]);
      } else if (operation.op === "set_product_status") await db.query("UPDATE public.catalog_products SET status=$2,updated_at=transaction_timestamp(),publication_facts=jsonb_set(publication_facts,'{status}',to_jsonb($2::text)) WHERE id=$1", [product.id, operation.status]);
      else if (operation.op === "set_product_presentation") {
        if (operation.presentation !== null) {
          require(deps.presentationReadiness, "catalog_publication_presentation_unavailable", "dependency_unavailable");
          checkReadinessVerdict(await deps.presentationReadiness!(db, product.id, operation.presentation), "catalog_publication_v3_structural_readiness_failed");
        }
        await db.query("UPDATE public.catalog_products SET publication_facts=jsonb_set(publication_facts,'{presentation}',$2::jsonb) WHERE id=$1", [product.id, publicationJson(operation.presentation)]);
      }
      else if (operation.op === "set_sku_status") await db.query(`UPDATE public.catalog_skus SET status=$2,updated_at=transaction_timestamp(),
        publication_facts=jsonb_set(publication_facts,'{status}',to_jsonb($2::text)) WHERE product_id=$1 AND sku=$3`, [product.id, operation.status, operation.skuCode]);
      else if (operation.op === "set_eligibility") await db.query(`UPDATE public.catalog_skus SET sellable_standalone=$2,sellable_in_subscription=$3,updated_at=transaction_timestamp(),
        publication_facts=jsonb_set(jsonb_set(publication_facts,'{sellableStandalone}',to_jsonb($2::boolean)),'{sellableInSubscription}',to_jsonb($3::boolean))
        WHERE product_id=$1 AND sku=$4`, [product.id, operation.sellableStandalone, operation.sellableInSubscription, operation.skuCode]);
      else if (operation.op === "set_sku_metadata") await db.query(`UPDATE public.catalog_skus SET
        publication_facts=jsonb_set(publication_facts,'{logisticsRef}',$2::jsonb) WHERE product_id=$1 AND sku=$3`, [product.id, publicationJson(operation.logisticsRef), operation.skuCode]);
      else if (operation.op === "set_derived_sku_facts") await db.query(`UPDATE public.catalog_skus SET
        publication_facts=jsonb_set(publication_facts,'{facts}',$2::jsonb),updated_at=transaction_timestamp() WHERE product_id=$1 AND sku=$3`, [product.id, publicationJson(operation.facts), operation.skuCode]);
      else if (operation.op === "set_offer_membership") await db.query(`UPDATE public.catalog_skus SET publication_facts=jsonb_set(publication_facts,'{memberships}',
        (SELECT jsonb_agg(member ORDER BY member->>'offerVersion' COLLATE "C") FROM
          (SELECT member FROM jsonb_array_elements(publication_facts->'memberships') AS member WHERE member->>'offerVersion'<>$2
            UNION ALL SELECT $3::jsonb) AS members)) WHERE product_id=$1 AND sku=$4`,
      [product.id, operation.offerVersion, publicationJson({ offerVersion: operation.offerVersion, admitted: operation.admitted }), operation.skuCode]);
    }
    if (before.product) {
      const fields = ["source", "content", "attributes", "axes"] as const;
      const patch = Object.fromEntries(fields.filter(name => !equal(before.product![name], product[name])).map(name => [name, product[name]]));
      await db.query("UPDATE public.catalog_products SET publication_facts=publication_facts || $2::jsonb WHERE id=$1", [product.id, publicationJson(patch)]);
      if ("attributes" in patch) await db.query("UPDATE public.catalog_products SET attribute_values=$2::jsonb WHERE id=$1", [product.id, publicationJson(product.attributes)]);
      if ("axes" in patch) await db.query("UPDATE public.catalog_products SET variant_axes=$2::text[] WHERE id=$1", [product.id, product.axes]);
    }
    for (const sku of state.skus) {
      const prior = before.skus.find(prior => prior.id === sku.id);
      if (prior && equal(prior, sku)) continue;
      if (prior) {
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
    const row = observedRow(rows);
    require(Number.isInteger(row.sku_count) && (row.valid === null || typeof row.valid === "boolean"), readInvalid, "dependency_unavailable");
    require(row.valid === true && row.sku_count === state.skus.length, "catalog_publication_post_state_mismatch");
    const definition = deps.registry.resolve(state.product.type);
    require(definition, "catalog_definition_drift", "dependency_unavailable");
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
      const { valid } = observedRow(rows);
      require(valid === null || typeof valid === "boolean", readInvalid, "dependency_unavailable");
      require(valid === true, "catalog_publication_post_state_mismatch");
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
        require(rows.length > 0, "catalog_publication_absent", "unsupported");
        productId = observedRow(rows).product_id as string;
        require(id.safeParse(productId).success, readInvalid, "dependency_unavailable");
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
          const { unknown } = observedRow(lineage);
          require(typeof unknown === "boolean", readInvalid, "dependency_unavailable");
          require(!unknown, "catalog_publication_lineage_unknown", "unsupported");
          const rows = await tuple(db, `SELECT p.revision,p.id,r.result::jsonb AS result,r.kind,r.scope_id,r.command_key,r.fingerprint,r.actor_id,r.publication_id
            FROM public.catalog_publications p LEFT JOIN public.catalog_operator_receipts r ON r.scope_id=p.product_id AND r.command_key=p.command_key
            WHERE p.product_id=$1::uuid AND p.revision <= coalesce($2::integer,(SELECT max(revision) FROM public.catalog_publications WHERE product_id=$1::uuid))
            AND ($3::integer IS NULL OR p.revision < $3) ORDER BY p.revision DESC LIMIT 101`, [productId, pointer?.highWater ?? null, pointer?.before ?? null]);
          require(rows.every(row => row.kind === "publish" && row.scope_id === productId && row.publication_id === row.id),
            "catalog_publication_receipt_invalid", "dependency_unavailable");
          const highWater = pointer?.highWater ?? rows[0]?.revision as number | undefined;
          const receipts: CatalogPublicationReceipt[] = [];
          for (const [index, row] of rows.slice(0, 100).entries()) {
            const receipt = await storedPublishReceipt(db, row);
            require(receipt.productId === productId && receipt.schemaVersion === 2, "catalog_publication_receipt_invalid", "dependency_unavailable");
            const result = legacyReceipt(receipt), test = { outcome: "page", receipts: [...receipts, result], limit: 100,
              nextCursor: index + 1 < rows.length ? encodeCursor({ kind: "history", productId, highWater: highWater!, before: row.revision as number }) : null };
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
        const rows = await tuple(db, `SELECT ${receiptColumns} FROM public.catalog_operator_receipts WHERE kind='publish' AND scope_id=$1 AND command_key=$2`, [scope.productId, scope.commandKey]);
        if (!rows.length) {
          await requireNoPublicationCommand(db, scope.productId, scope.commandKey);
          return { outcome: "absent" as const };
        }
        require(rows.length === 1, "catalog_publication_receipt_invalid", "dependency_unavailable");
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
      state: sku.status === "archived" ? "withdrawn" as const : sku.status, variantRevision: state.references.find(reference => reference.skuId === sku.id)!.revision,
      publicationHead: state.head, draftRef: { draftId: sku.source.draftId, revision: sku.source.revision } }));
  }
  const publication: CatalogPublicationPort = {
    async publish(command, capability) { const result = await publish(command, capability);
      return "receipt" in result ? { outcome: result.outcome, receipt: legacyReceipt(result.receipt) } : legacyFailure(result); },
  };
  async function readbackV2(head: CatalogHeadRef, cursor: string | null = null): Promise<CatalogFullPublicationV2 | CatalogPublicationFailure> {
    try {
      require(headSchema.safeParse(head).success, "catalog_publication_query_invalid");
      return await deps.transactions.run(async db => {
        await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const rows = await tuple(db, `SELECT p.product_id,p.revision,p.canonical_state,p.digest,d.id AS document_id,d.digest AS document_digest,
          d.revision_no,d.schema_id,d.document_ref,d.source_ref,d.canonical_text,p.id AS publication_id,p.previous_id,previous.revision AS previous_revision
          FROM public.catalog_publications p
          LEFT JOIN public.catalog_publications previous ON previous.product_id=p.product_id AND previous.id=p.previous_id
          LEFT JOIN public.catalog_product_document_revisions d ON d.id=p.document_revision_id AND d.product_id=p.product_id WHERE p.id=$1::uuid`, [head.publicationId]);
        require(rows.length > 0, "catalog_publication_absent", "unsupported");
        const row = observedRow(rows);
        require(row.publication_id === head.publicationId && row.document_id !== null, readInvalid, "dependency_unavailable");
        const manifest = catalogPublicationManifestSchema.parse(JSON.parse(row.canonical_state as string));
        require(row.revision === head.revision && row.document_digest === head.documentDigest, "head_conflict", "conflict");
        require(publicationJson(manifest) === row.canonical_state && publicationDigest(manifest) === row.digest
          && manifest.product.id === row.product_id && equal(manifest.product.document, { id: row.document_id, productId: row.product_id,
            revisionNo: row.revision_no, schemaId: row.schema_id, documentRef: row.document_ref, sourceRef: row.source_ref, digest: row.document_digest })
          && typeof row.canonical_text === "string"
          && createHash("sha256").update(row.canonical_text).digest("hex") === row.document_digest,
        "catalog_publication_manifest_invalid", "dependency_unavailable");
        const productId = manifest.product.id, pointer = decodeCursor(cursor, productId, "facts"), offset = pointer?.before ?? 0;
        require(!pointer || pointer.highWater === head.revision, "catalog_publication_cursor_invalid");
        require(offset <= manifest.skus.length, "catalog_publication_cursor_invalid");
        verifyPredecessor(row.revision, row.previous_id, row.previous_revision);
        const wanted = manifest.skus.slice(offset, offset + 100);
        const indexed = await retainedSkuIndex(db, productId, head.revision, manifest.skus);
        const selected: CatalogSkuRevisionRef[] = []; let itemBytes = 0;
        for (const reference of wanted) {
          const stored = indexed.get(reference.revisionId)!;
          const count = selected.length + 1;
          const nextCursor = offset + count < manifest.skus.length
            ? encodeCursor({ kind: "facts", productId, highWater: head.revision, before: offset + count }) : null;
          const base = Buffer.byteLength(publicationJson({ outcome: "page", schemaVersion: 2, head, product: manifest.product, items: [], nextCursor }));
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
          require(value.id === reference.skuId && value.productId === productId && publicationJson(value, CATALOG_PUBLICATION_LIMITS.skuBytes) === stored!.full_facts
            && publicationDigest(value, CATALOG_PUBLICATION_LIMITS.skuBytes) === reference.digest && value.code === indexed.get(reference.revisionId)?.sku_code,
          "catalog_publication_sku_revision_invalid", "dependency_unavailable");
          return { reference, facts: value };
        });
        const next = offset + items.length;
        require(next > offset || offset === manifest.skus.length, "catalog_publication_cursor_invalid");
        const result = { outcome: "page" as const, schemaVersion: 2 as const, head, product: manifest.product, items,
          nextCursor: next < manifest.skus.length ? encodeCursor({ kind: "facts", productId, highWater: head.revision, before: next }) : null };
        publicationJson(result, CATALOG_PUBLICATION_LIMITS.pageBytes); return result;
      });
    } catch (error) { return failure(error); }
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
          d.revision_no,d.schema_id,d.document_ref,d.source_ref,r.full_facts,r.digest AS sku_digest,r.revision AS sku_revision,d.id AS document_id,
          p.previous_id,previous.revision AS previous_revision,p.id AS publication_id
          FROM public.catalog_publications p
          LEFT JOIN public.catalog_publications previous ON previous.product_id=p.product_id AND previous.id=p.previous_id
          LEFT JOIN public.catalog_product_document_revisions d ON d.id=p.document_revision_id AND d.product_id=p.product_id
          LEFT JOIN public.catalog_sku_revisions r ON r.id=$3 AND r.sku_id=$4 AND r.product_id=p.product_id
          WHERE p.id=$1 AND p.product_id=$2`, [input.publicationId, input.productId, input.skuRevisionId, input.skuId]);
        require(rows.length > 0, "retained_revision_unavailable", "unsupported");
        const row = observedRow(rows);
        require(row.publication_id === input.publicationId, readInvalid, "dependency_unavailable");
        require(id.safeParse(row.document_id).success, readInvalid, "dependency_unavailable");
        require(row.document_id === input.documentRevisionId, "retained_revision_unavailable", "unsupported");
        const head = { publicationId: row.publication_id as string, revision: row.revision as number, documentDigest: row.digest as string };
        const manifest = catalogPublicationManifestSchema.parse(JSON.parse(row.canonical_state as string));
        require(publicationJson(manifest) === row.canonical_state && publicationDigest(manifest) === row.manifest_digest
          && manifest.product.id === input.productId && equal(manifest.product.document, { id: input.documentRevisionId, productId: input.productId,
            revisionNo: row.revision_no, schemaId: row.schema_id, documentRef: row.document_ref, sourceRef: row.source_ref, digest: row.digest })
          && typeof row.canonical_text === "string" && createHash("sha256").update(row.canonical_text).digest("hex") === row.digest,
        "catalog_publication_manifest_invalid", "dependency_unavailable");
        const reference = manifest.skus.find(reference => reference.skuId === input.skuId && reference.revisionId === input.skuRevisionId);
        require(reference, "retained_revision_unavailable", "unsupported");
        verifyPredecessor(row.revision, row.previous_id, row.previous_revision);
        const indexed = await retainedSkuIndex(db, input.productId, row.revision as number, manifest.skus);
        require(reference!.digest === row.sku_digest && reference!.revision === row.sku_revision && typeof row.full_facts === "string", readInvalid, "dependency_unavailable");
        const sku = catalogPublishedSkuSchema.parse(JSON.parse(row.full_facts as string));
        require(sku.code === indexed.get(input.skuRevisionId)?.sku_code, "catalog_publication_sku_revision_invalid", "dependency_unavailable");
        require(sku.id === input.skuId && sku.productId === input.productId && publicationJson(sku, CATALOG_PUBLICATION_LIMITS.skuBytes) === row.full_facts
          && publicationDigest(sku, CATALOG_PUBLICATION_LIMITS.skuBytes) === reference!.digest, "catalog_publication_sku_revision_invalid", "dependency_unavailable");
        const result = { outcome: "found" as const, head, product: manifest.product, reference: reference!, sku };
        publicationJson(result, CATALOG_PUBLICATION_LIMITS.pageBytes); return result;
      });
    } catch (error) { return failure(error); }
  }
  return { authorize, authorizeReadScope(context: Context): VerifiedCatalogReadScope { const scope = Object.freeze({}); readers.set(scope, context); return scope as VerifiedCatalogReadScope; },
    publication, reads, readPort, publish, decision, receipt: recoverReceipt, readbackV2, resolveRetained };
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
  const parsed = decisionSchema.extend({ fingerprint: digest, actorId: id, decidedAt: instant }).strict().safeParse(value);
  if (!parsed.success) return publicationRefuse("catalog_publication_receipt_invalid", "dependency_unavailable");
  return parsed.data;
}
function equalHead(a: CatalogHeadRef | null, b: CatalogHeadRef): boolean { return a !== null && publicationJson(a) === publicationJson(b); }
