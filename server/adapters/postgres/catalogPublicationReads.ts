import type { PgQueryExecutor } from "@openlup/platform/data";
import { z } from "zod";
import type { VerifiedCatalogPublisher, CatalogPublicationReadPort } from "@openlup/platform/catalog";
import type { CatalogFullPublicationV2, CatalogPublicationReceiptV2, CatalogPublishedSku, CatalogSkuRevisionRef,
  CatalogRetainedSourceBinding, CatalogPublicationFailure } from "./catalogPublicationWire.js";
import type { CatalogHeadRef, CatalogPublicationReceipt, CatalogPublicationRefusal } from "@openlup/platform/catalog/contracts";
import { CATALOG_PUBLICATION_LIMITS as limits } from "./catalogPublicationWire.js";
import { catalogPublishedSkuSchema, catalogPublicationManifestSchema, CatalogPublicationError,
  publicationJson, publicationDigest, publicationRefuse } from "./catalogPublicationWire.js";

declare const verifiedReadScope: unique symbol;
/** @experimental */
export interface VerifiedCatalogReadScope { readonly [verifiedReadScope]: true }

/** @experimental */
export interface CatalogPublicationReadDependencies<Context> {
  transactions: { run<T>(work: (db: PgQueryExecutor) => Promise<T>): Promise<T> };
  authorizeHuman(context: Context): Promise<{ ok: true; userId: string; role: string; isMachineActor: boolean } | { ok: false }>;
  /** The host verifies ownership of the accepted account, order or fulfilment line in this snapshot. */
  acceptedSource?(db: PgQueryExecutor, context: Context, binding: CatalogRetainedSourceBinding):
    Promise<CatalogRetainedSourceBinding | null | "unauthorized">;
}

const id = z.guid().refine(value => value === value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const key = z.string().min(1).refine(value => Buffer.byteLength(value) <= 200 && !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value));
const headSchema = z.object({ publicationId: id, revision, documentDigest: digest }).strict();
const selectorSchema = z.object({ kind: z.enum(["account", "order", "fulfilment"]), sourceId: id, lineId: id,
  productId: id, skuId: id, skuRevisionId: id, publicationId: id, documentRevisionId: id }).strict();
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
const observation = z.object({ productId: id, variantId: id, sku: z.string().min(1), state: z.enum(["draft", "active", "withdrawn"]), variantRevision: revision,
  publicationHead: headSchema.nullable(), draftRef: z.object({ draftId: id, revision }).strict().nullable() }).strict();
const receiptSchema: z.ZodType<CatalogPublicationReceiptV2> = z.object({ schemaVersion: z.literal(2), productId: id, commandKey: key, fingerprint: digest,
  actorId: id, previousHead: headSchema.nullable(), head: headSchema, publicationDigest: digest, committedAt: instant, changes: z.array(observation) }).strict();
const sqlRefusals = {
  catalog_publication_wire_invalid: ["publication_details_invalid", "Some publication details are invalid. Review the product and its revisions, then try again."],
  catalog_publication_manifest_invalid: ["publication_details_invalid", "The publication contains invalid product details. Review the product and prepare it again."],
  catalog_publication_head_invalid: ["publication_changed", "The current publication changed. Reload the product and try again."],
  catalog_publication_lineage_invalid: ["publication_version_invalid", "The selected previous publication is unavailable. Reload the product and select its current publication."],
  catalog_publication_document_invalid: ["publication_content_changed", "The selected product content differs from the approved revision. Review the product and prepare it again."],
  catalog_publication_issue_sealed: ["publication_requires_new_revision", "This publication is complete. Create a new publication to add the revision."],
  catalog_publication_sku_revision_invalid: ["publication_revision_invalid", "The product revisions do not match this publication. Reload the product and prepare it again."],
  catalog_publication_receipt_invalid: ["publication_incomplete", "The publication is incomplete. Reload the product and check its publication status before you try again."],
  catalog_publication_candidate_invalid: ["publication_approval_invalid", "Approval does not match the selected product revision. Review and approve that revision again."],
  catalog_publication_pointer_capability_unconsumed: ["publication_content_not_saved", "The selected product content was not saved. Select the content again and retry."],
} as const;
type AdmissionDiagnostic = keyof typeof sqlRefusals;
type AdmissionRefusal = { outcome: "validation_issue"; reason: (typeof sqlRefusals)[AdmissionDiagnostic][0]; message: string };
const readInvalid = "catalog_publication_read_invalid";

function requireCondition(condition: unknown, reason = readInvalid, outcome: CatalogPublicationFailure["outcome"] = "dependency_unavailable"): asserts condition {
  if (!condition) publicationRefuse(reason, outcome);
}

const deferredForeignKeys = new Map([
  ["catalog_publications_previous_fk", "catalog_publication_lineage_invalid"],
  ["catalog_publication_heads_issue_fk", "catalog_publication_head_invalid"],
  ["catalog_sku_revisions_issue_fk", "catalog_publication_issue_sealed"],
  ["catalog_operator_receipts_issue_fk", "catalog_publication_receipt_invalid"],
  ["catalog_publication_decisions_receipt_fk", "catalog_publication_receipt_invalid"],
]);

/** Maps publication admission diagnostics after the transaction has rolled back.
 * @experimental
 */
export function catalogPublicationAdmissionRefusal(error: unknown): AdmissionRefusal | null {
  if (!error || typeof error !== "object" || !("code" in error) ||
    !("constraint" in error) || typeof error.constraint !== "string") return null;
  const name = error.code === "23503" ? deferredForeignKeys.get(error.constraint)
    : error.code === "23514" ? error.constraint : undefined;
  const refusal = name && Object.hasOwn(sqlRefusals, name) ? sqlRefusals[name as AdmissionDiagnostic] : undefined;
  return refusal ? { outcome: "validation_issue", reason: refusal[0], message: refusal[1] } : null;
}

function failure(error: unknown): CatalogPublicationFailure {
  if (error instanceof CatalogPublicationError) return { outcome: error.outcome, reason: error.code };
  const refusal = catalogPublicationAdmissionRefusal(error);
  return refusal ? { ...refusal, outcome: "dependency_unavailable" } : { outcome: "dependency_unavailable", reason: "publication_authority_unavailable" };
}

function legacyFailure(result: CatalogPublicationFailure): CatalogPublicationRefusal {
  const reasons = {
    unauthorized: "publisher_not_authorized", conflict: "head_conflict", dependency_unavailable: "publication_authority_unavailable",
    unsupported: "publication_not_supported", validation_issue: "candidate_invalid",
  } as const;
  return { outcome: result.outcome, reason: reasons[result.outcome] };
}
function legacyReceipt(receipt: CatalogPublicationReceiptV2): CatalogPublicationReceipt {
  return { commandKey: receipt.commandKey, fingerprint: receipt.fingerprint, actorId: receipt.actorId,
    previousHead: receipt.previousHead, head: receipt.head, changes: receipt.changes };
}
const equal = (left: unknown, right: unknown) => publicationJson(left) === publicationJson(right);

async function verifiedIssue(db: PgQueryExecutor, publicationId: string, productId?: string) {
  // The assertion verifies the history graph using the same immutable rows
  // as admission. Always bind the document by the recorded composite FK.
  const { rows } = await db.query(`SELECT p.id,p.product_id,p.revision,p.canonical_state,p.digest,r.result,
    d.digest AS document_digest,
    jsonb_build_object('id',d.id,'productId',d.product_id,'revisionNo',d.revision_no,
      'schemaId',d.schema_id,'documentRef',d.document_ref,'sourceRef',d.source_ref,'digest',d.digest) AS document_reference,
    public.catalog_publication_assert_issued(p.product_id,p.id) AS admitted
    FROM public.catalog_publications p
    LEFT JOIN public.catalog_product_document_revisions d ON (d.product_id,d.id)=(p.product_id,p.document_revision_id)
    LEFT JOIN public.catalog_operator_receipts r ON (r.scope_id,r.command_key)=(p.product_id,p.command_key)
    WHERE p.id=$1::uuid AND ($2::uuid IS NULL OR p.product_id=$2::uuid)`, [publicationId, productId ?? null]);
  if (!rows.length) return null;
  const row = rows[0]!;
  requireCondition(rows.length === 1 && row.id === publicationId && (productId === undefined || row.product_id === productId));
  const head = headSchema.parse({ publicationId, revision: row.revision, documentDigest: row.document_digest });
  const manifest = catalogPublicationManifestSchema.parse(JSON.parse(row.canonical_state as string));
  requireCondition(equal(manifest.product.document, row.document_reference), "catalog_publication_document_invalid");
  requireCondition(manifest.product.id === row.product_id && manifest.product.document?.digest === head.documentDigest
    && publicationJson(manifest) === row.canonical_state
    && publicationDigest(manifest) === row.digest, "catalog_publication_manifest_invalid");
  const receipt = receiptSchema.parse(JSON.parse(row.result as string));
  requireCondition(receipt.productId === manifest.product.id && receipt.publicationDigest === row.digest && equal(receipt.head, head)
    && publicationJson(receipt, limits.receiptBytes) === row.result, "catalog_publication_receipt_invalid");
  publicationJson({ outcome: "found", receipt }, limits.receiptBytes);
  return { head, manifest, receipt };
}
type Issue = NonNullable<Awaited<ReturnType<typeof verifiedIssue>>>;

async function issueFacts(db: PgQueryExecutor, issue: Issue, references: readonly CatalogSkuRevisionRef[]) {
  const { rows } = await db.query(`SELECT id,sku_id,sku_code,digest,revision,full_facts FROM public.catalog_sku_revisions
    WHERE product_id=$1 AND id=ANY($2::uuid[])`, [issue.manifest.product.id, references.map(ref => ref.revisionId)]);
  const byId = new Map(rows.map(row => [row.id, row]));
  requireCondition(rows.length === references.length && rows.length === byId.size, "catalog_publication_sku_revision_invalid");
  return references.map(reference => {
    const row = byId.get(reference.revisionId);
    requireCondition(row && row.sku_id === reference.skuId && row.digest === reference.digest && row.revision === reference.revision,
      "catalog_publication_sku_revision_invalid");
    const facts = catalogPublishedSkuSchema.parse(JSON.parse(row.full_facts as string));
    requireCondition(facts.id === reference.skuId && facts.productId === issue.manifest.product.id && facts.code === row.sku_code
      && publicationJson(facts, limits.skuBytes) === row.full_facts && publicationDigest(facts, limits.skuBytes) === reference.digest,
    "catalog_publication_sku_revision_invalid");
    return { reference, facts };
  });
}

async function currentIssue(db: PgQueryExecutor, productId: string) {
  const { rows } = await db.query(`SELECT
    (SELECT publication_id FROM public.catalog_publication_heads WHERE product_id=$1) AS id,
    EXISTS(SELECT 1 FROM public.catalog_products WHERE id=$1) AS product_exists,
    public.catalog_publication_assert_head($1,false) AS admitted`, [productId]);
  const row = rows[0];
  requireCondition(rows.length === 1 && typeof row?.product_exists === "boolean");
  if (row.id === null) {
    requireCondition(!row.product_exists, "catalog_publication_lineage_unknown", "unsupported");
    return null;
  }
  requireCondition(id.safeParse(row.id).success);
  const issue = await verifiedIssue(db, row.id as string, productId);
  requireCondition(issue);
  return issue;
}

async function assertCurrentProjection(db: PgQueryExecutor, issue: Issue) {
  const { product, skus } = issue.manifest;
  const { rows } = await db.query(`SELECT p.publication_facts=$2::jsonb AND
    p.slug=$3 AND p.name=$4 AND p.status=$5 AND p.primary_sku_id=$6 AND p.current_document_revision_id=$7
    AND p.type_key=$8 AND p.type_version=$9 AND p.variant_axes=$10 AND p.attribute_values=$11::jsonb
    AND (SELECT count(*) FROM public.catalog_skus WHERE product_id=p.id)=$12 AS matches
    FROM public.catalog_products p WHERE p.id=$1`, [
    product.id, publicationJson(product), product.slug, product.name, product.status, product.primarySkuId, product.document?.id,
    product.type.key, product.type.version, product.axes, publicationJson(product.attributes), skus.length,
  ]);
  requireCondition(rows.length === 1 && rows[0]?.matches === true, "catalog_publication_live_drift", "conflict");
  const changed = await db.query(`SELECT 1 FROM jsonb_array_elements($2::jsonb) AS member
    JOIN public.catalog_sku_revisions r ON r.id=(member->>'revisionId')::uuid AND r.product_id=$1
    LEFT JOIN public.catalog_skus s ON s.id=r.sku_id AND s.product_id=r.product_id
    CROSS JOIN LATERAL (SELECT r.full_facts::jsonb AS facts) f
    CROSS JOIN LATERAL (
      SELECT coalesce(jsonb_agg(entry.fact ORDER BY entry.fact),'[]'::jsonb) AS facts
      FROM (
        SELECT jsonb_build_object('issuer',i.issuer,'normalized',i.normalized_value,'kind',i.identifier_kind,
          'packagingLevel',CASE WHEN i.pack_kind='unit' THEN 'unit' ELSE 'case' END,
          'quantity',i.quantity,'isPrimary',i.is_primary) AS fact
        FROM public.catalog_sku_identifiers i WHERE i.catalog_sku_id=s.id
      ) entry
    ) recorded
    CROSS JOIN LATERAL (
      SELECT coalesce(jsonb_agg(entry.fact ORDER BY entry.fact),'[]'::jsonb) AS facts
      FROM (
        SELECT jsonb_build_object('issuer',i->'issuer','packagingLevel',i->'packagingLevel',
          'quantity',i->'quantity','isPrimary',i->'isPrimary','normalized',CASE WHEN i->>'scheme'='gs1:gtin' THEN lpad(i->>'value',14,'0') ELSE i->>'value' END,
          'kind',CASE WHEN i->>'scheme'='gs1:gtin' THEN 'gtin' ELSE 'other' END) AS fact
        FROM jsonb_array_elements(f.facts->'identifiers') i
      ) entry
    ) expected
    WHERE (s.publication_facts=f.facts AND s.sku=r.sku_code AND s.title=f.facts->>'title'
      AND s.status=f.facts->>'status' AND s.sellable_standalone=(f.facts->>'sellableStandalone')::boolean
      AND s.sellable_in_subscription=(f.facts->>'sellableInSubscription')::boolean
      AND s.min_order_qty=(f.facts->>'minQuantity')::integer AND s.is_addon=(f.facts->>'isAddon')::boolean
      AND s.attribute_values=f.facts->'attributes' AND s.option_values=f.facts->'options'
      AND s.net_content_dimension=f.facts #>> '{netContent,dimension}'
      AND s.net_content_unit=f.facts #>> '{netContent,unit}'
      AND s.net_content_scale=(f.facts #>> '{netContent,scale}')::integer
      AND s.net_content_unscaled=(f.facts #>> '{netContent,unscaled}')::numeric
      AND s.gross_mass_dimension IS NOT DISTINCT FROM f.facts #>> '{grossMass,dimension}'
      AND s.gross_mass_unit IS NOT DISTINCT FROM f.facts #>> '{grossMass,unit}'
      AND s.gross_mass_scale IS NOT DISTINCT FROM (f.facts #>> '{grossMass,scale}')::integer
      AND s.gross_mass_unscaled IS NOT DISTINCT FROM (f.facts #>> '{grossMass,unscaled}')::numeric
      AND s.asset_ref IS NOT DISTINCT FROM f.facts #>> '{assetRefs,0}'
      AND recorded.facts=expected.facts) IS DISTINCT FROM true LIMIT 1`, [product.id, publicationJson(skus)]);
  requireCondition(changed.rows.length === 0, "catalog_publication_live_drift", "conflict");
}

type Cursor = { kind: "history" | "facts"; productId: string; highWater: number; before: number };
const encodeCursor = (value: Cursor) => Buffer.from(publicationJson({ schemaVersion: 1, ...value })).toString("base64url");
function decodeCursor(value: string | null, productId: string, kind: Cursor["kind"]) {
  if (value === null) return null;
  try {
    if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
    const schema = z.object({ schemaVersion: z.literal(1), kind: z.literal(kind), productId: z.literal(productId), highWater: revision,
      before: z.number().int().min(0).max(2_147_483_647) }).strict();
    const result = schema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (encodeCursor(result) !== value || kind === "history" && result.before > result.highWater) throw new Error();
    return result;
  } catch { return publicationRefuse("catalog_publication_cursor_invalid"); }
}

function observations(issue: Issue, facts: { facts: CatalogPublishedSku; reference: CatalogSkuRevisionRef }[]) {
  return facts.map(({ facts: sku, reference }) => ({ productId: sku.productId, variantId: sku.id, sku: sku.code,
    state: sku.status === "archived" ? "withdrawn" as const : sku.status, variantRevision: reference.revision,
    publicationHead: issue.head, draftRef: { draftId: sku.source.draftId, revision: sku.source.revision } }));
}

/** Reads admitted native history in one snapshot. The host controls whether to bind it.
 * @experimental
 */
export function createPostgresCatalogPublicationReads<Context>(deps: CatalogPublicationReadDependencies<Context>) {
  const operators = new WeakMap<object, string>();
  const readers = new WeakMap<object, { context: Context }>();
  const read = <T>(work: (db: PgQueryExecutor) => Promise<T>) => deps.transactions.run(async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows } = await db.query(`SELECT current_setting('transaction_isolation')='repeatable read'
      AND current_setting('transaction_read_only')='on' AS admitted`);
    requireCondition(rows.length === 1 && rows[0]?.admitted === true);
    return work(db);
  });

  async function authorize(context: Context): Promise<VerifiedCatalogPublisher | null> {
    const auth = await deps.authorizeHuman(context);
    if (auth?.ok !== true || auth.role !== "admin" || auth.isMachineActor !== false || !id.safeParse(auth.userId).success) return null;
    const capability = Object.freeze({});
    operators.set(capability, auth.userId);
    return capability as VerifiedCatalogPublisher;
  }

  async function exact(db: PgQueryExecutor, head: CatalogHeadRef) {
    requireCondition(headSchema.safeParse(head).success, "catalog_publication_query_invalid", "validation_issue");
    const issue = await verifiedIssue(db, head.publicationId);
    requireCondition(issue, "catalog_publication_absent", "unsupported");
    requireCondition(equal(issue.head, head), "head_conflict", "conflict");
    return issue;
  }

  async function receipt(scope: { productId: string; commandKey: string }, capability: VerifiedCatalogPublisher) {
    try {
      requireCondition(id.safeParse(scope.productId).success && key.safeParse(scope.commandKey).success,
        "catalog_publication_query_invalid", "validation_issue");
      return await read(async db => {
        const actor = operators.get(capability);
        requireCondition(actor, "publisher_not_authorized", "unauthorized");
        const membership = await db.query("SELECT public.platform_human_membership_is_administrator($1::uuid) AS allowed", [actor]);
        requireCondition(membership.rows.length === 1 && membership.rows[0]?.allowed === true, "publisher_not_authorized", "unauthorized");
        const { rows } = await db.query(`SELECT p.id,r.kind,r.publication_id
          FROM (SELECT id FROM public.catalog_publications WHERE product_id=$1 AND command_key=$2) p
          FULL JOIN (SELECT kind,publication_id FROM public.catalog_operator_receipts
            WHERE scope_id=$1 AND command_key=$2 AND kind='publish') r ON p.id=r.publication_id`, [scope.productId, scope.commandKey]);
        if (!rows.length) return { outcome: "absent" as const };
        const row = rows[0]!;
        requireCondition(rows.length === 1 && row.kind === "publish" && row.publication_id === row.id && id.safeParse(row.id).success,
          "catalog_publication_receipt_invalid");
        const issue = await verifiedIssue(db, row.id as string, scope.productId);
        requireCondition(issue?.receipt.commandKey === scope.commandKey, "catalog_publication_receipt_invalid");
        return { outcome: "found" as const, receipt: issue.receipt };
      });
    } catch (error) { return failure(error); }
  }

  const reads: CatalogPublicationReadPort = {
    async current(productId) {
      try {
        requireCondition(id.safeParse(productId).success, "catalog_publication_query_invalid", "validation_issue");
        return await read(async db => {
          const issue = await currentIssue(db, productId);
          if (!issue) return { outcome: "unpublished" };
          await assertCurrentProjection(db, issue);
          const result = { outcome: "found" as const, head: issue.head, documentRef: issue.manifest.product.document!.documentRef,
            observations: observations(issue, await issueFacts(db, issue, issue.manifest.skus)) };
          publicationJson(result, limits.pageBytes);
          return result;
        });
      } catch (error) { return legacyFailure(failure(error)); }
    },
    async readback(head) {
      try {
        return await read(async db => {
          const issue = await exact(db, head);
          const result = { outcome: "found" as const, head: issue.head, documentRef: issue.manifest.product.document!.documentRef,
            observations: observations(issue, await issueFacts(db, issue, issue.manifest.skus)) };
          publicationJson(result, limits.pageBytes);
          return result;
        });
      } catch (error) { return legacyFailure(failure(error)); }
    },
    async history(productId, cursor) {
      try {
        requireCondition(id.safeParse(productId).success, "catalog_publication_query_invalid", "validation_issue");
        const pointer = decodeCursor(cursor, productId, "history");
        return await read(async db => {
          const start = await currentIssue(db, productId);
          const highWater = pointer?.highWater ?? start?.head.revision ?? 0;
          const { rows } = await db.query(`SELECT id,revision FROM public.catalog_publications
            WHERE product_id=$1 AND revision<=$2 AND ($3::integer IS NULL OR revision<$3)
            ORDER BY revision DESC LIMIT $4`, [productId, highWater, pointer?.before ?? null, limits.pageItems + 1]);
          const receipts: CatalogPublicationReceipt[] = [];
          let itemBytes = 0;
          let nextCursor: string | null = null;
          for (const [index, row] of rows.slice(0, limits.pageItems).entries()) {
            requireCondition(id.safeParse(row.id).success);
            const issue = await verifiedIssue(db, row.id as string, productId);
            requireCondition(issue && issue.head.revision === row.revision);
            const item = legacyReceipt(issue.receipt);
            const continuation = index + 1 < rows.length
              ? encodeCursor({ kind: "history", productId, highWater, before: issue.head.revision }) : null;
            const itemSize = Buffer.byteLength(publicationJson(item)) + (index === 0 ? 0 : 1);
            const envelope = Buffer.byteLength(publicationJson({ outcome: "page", receipts: [], limit: limits.pageItems, nextCursor: continuation }));
            if (envelope + itemBytes + itemSize > limits.historyBytes) {
              requireCondition(receipts.length, "catalog_publication_history_item_too_large");
              break;
            }
            itemBytes += itemSize;
            receipts.push(item);
            nextCursor = continuation;
          }
          const result = { outcome: "page" as const, receipts, limit: limits.pageItems, nextCursor };
          publicationJson(result, limits.historyBytes);
          return result;
        });
      } catch (error) { return legacyFailure(failure(error)); }
    },
    async receipt() { return { outcome: "unsupported", reason: "publication_not_supported" }; },
  };

  async function readbackV2(head: CatalogHeadRef, cursor: string | null = null): Promise<CatalogFullPublicationV2 | CatalogPublicationFailure> {
    try {
      return await read(async db => {
        const issue = await exact(db, head);
        const { product, skus } = issue.manifest;
        const pointer = decodeCursor(cursor, product.id, "facts");
        const offset = pointer?.before ?? 0;
        requireCondition((!pointer || pointer.highWater === head.revision) && offset <= skus.length, "catalog_publication_cursor_invalid", "validation_issue");
        const wanted = skus.slice(offset, offset + limits.pageItems);
        const { rows } = await db.query(`SELECT id,octet_length(full_facts) AS bytes FROM public.catalog_sku_revisions
          WHERE product_id=$1 AND id=ANY($2::uuid[])`, [product.id, wanted.map(ref => ref.revisionId)]);
        const sizes = new Map(rows.map(row => [row.id, row.bytes]));
        requireCondition(rows.length === wanted.length && sizes.size === wanted.length, "catalog_publication_sku_revision_invalid");
        const selected: CatalogSkuRevisionRef[] = [];
        let itemBytes = 0;
        let nextCursor: string | null = null;
        for (const [index, reference] of wanted.entries()) {
          const bytes = sizes.get(reference.revisionId);
          requireCondition(typeof bytes === "number" && bytes >= 2 && bytes <= limits.skuBytes, "catalog_publication_sku_revision_invalid");
          const continuation = offset + index + 1 < skus.length
            ? encodeCursor({ kind: "facts", productId: product.id, highWater: head.revision, before: offset + index + 1 }) : null;
          const base = Buffer.byteLength(publicationJson({ outcome: "page", schemaVersion: 2, head, product, items: [], nextCursor: continuation }));
          const itemSize = Buffer.byteLength(publicationJson({ reference, facts: null })) - 4 + bytes + (index === 0 ? 0 : 1);
          if (base + itemBytes + itemSize > limits.pageBytes) {
            requireCondition(selected.length, "catalog_publication_readback_item_too_large");
            break;
          }
          itemBytes += itemSize;
          selected.push(reference);
          nextCursor = continuation;
        }
        const result = { outcome: "page" as const, schemaVersion: 2 as const, head: issue.head, product,
          items: await issueFacts(db, issue, selected), nextCursor };
        publicationJson(result, limits.pageBytes);
        return result;
      });
    } catch (error) { return failure(error); }
  }

  async function resolveRetained(input: CatalogRetainedSourceBinding, scope: VerifiedCatalogReadScope) {
    try {
      const reader = readers.get(scope);
      requireCondition(reader, "retained_read_not_authorized", "unauthorized");
      requireCondition(selectorSchema.safeParse(input).success, "catalog_publication_query_invalid", "validation_issue");
      const acceptedSource = deps.acceptedSource;
      requireCondition(acceptedSource, "retained_revision_unavailable", "unsupported");
      return await read(async db => {
        const accepted = await acceptedSource(db, reader.context, input);
        requireCondition(accepted !== "unauthorized", "retained_read_not_authorized", "unauthorized");
        requireCondition(accepted !== null, "retained_revision_unavailable", "unsupported");
        requireCondition(equal(accepted, input), "retained_source_mismatch", "unauthorized");
        const issue = await verifiedIssue(db, input.publicationId, input.productId);
        requireCondition(issue, "retained_revision_unavailable", "unsupported");
        const reference = issue.manifest.skus.find(item => item.skuId === input.skuId && item.revisionId === input.skuRevisionId);
        requireCondition(reference && issue.manifest.product.document?.id === input.documentRevisionId, "retained_source_mismatch");
        const [item] = await issueFacts(db, issue, [reference]);
        const result = { outcome: "found" as const, head: issue.head, product: issue.manifest.product, reference, sku: item!.facts };
        publicationJson(result, limits.pageBytes);
        return result;
      });
    } catch (error) { return failure(error); }
  }

  return {
    reads, authorize, receipt, readbackV2, resolveRetained,
    authorizeReadScope(context: Context): VerifiedCatalogReadScope {
      const scope = Object.freeze({});
      readers.set(scope, { context });
      return scope as VerifiedCatalogReadScope;
    },
    readPort(capability: VerifiedCatalogPublisher): CatalogPublicationReadPort {
      return { ...reads, async receipt(scope) {
        const result = await receipt(scope, capability);
        return result.outcome === "found" ? { outcome: "found", receipt: legacyReceipt(result.receipt) }
          : result.outcome === "absent" ? result : legacyFailure(result);
      } };
    },
  };
}
