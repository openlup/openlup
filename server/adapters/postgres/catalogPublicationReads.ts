import type { PgQueryExecutor } from "@openlup/platform/data";
import { z } from "zod";
import { createPostgresCatalogPublicationReads as createExactReads, nativeCatalogPublication, type VerifiedCatalogPublisher, type CatalogPublicationReadPort,
  type CatalogPublicationReceiptV2, type CatalogSkuRevisionRef,
  type CatalogRetainedSourceBinding, type CatalogPublicationFailure } from "@openlup/platform/catalog";
import type { CatalogHeadRef, CatalogPublicationReceipt, CatalogPublicationRefusal } from "@openlup/platform/catalog/contracts";

const { limits, decodePublicationPacket, requireDecodedPublication, decodeStoredPublicationReceipt, decodeStoredPublicationSku,
  publicationJson, publicationDigest, SKU_PAGE_DEPTH, publicationReadFailure, publicationRefuse, publicationRemedy } = nativeCatalogPublication;

type AdmissionDiagnostic = Parameters<typeof publicationRefuse>[0];

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
const headSchema = z.object({ publicationId: id, revision, documentDigest: digest }).strict();
const selectorSchema = z.object({ kind: z.enum(["account", "order", "fulfilment"]), sourceId: id, lineId: id,
  productId: id, skuId: id, skuRevisionId: id, publicationId: id, documentRevisionId: id }).strict();
// Every read refusal uses a code from the remedy map, so a new reason without a remedy does not compile.
const refuse = (reason: AdmissionDiagnostic, outcome: CatalogPublicationFailure["outcome"] = "dependency_unavailable"): never =>
  publicationRefuse(reason, outcome);
function requireCondition(condition: unknown, reason: AdmissionDiagnostic = "catalog_publication_read_invalid",
  outcome: CatalogPublicationFailure["outcome"] = "dependency_unavailable"): asserts condition {
  if (!condition) refuse(reason, outcome);
}

/** Released ports narrow the reason by outcome and keep the same remedy. */
function legacyFailure(result: CatalogPublicationFailure): CatalogPublicationRefusal {
  // Only stored data decoding attaches a field path to validation failures in this adapter.
  const outcome = result.outcome === "validation_issue" && result.path !== undefined
    ? "dependency_unavailable" : result.outcome;
  const reasons = {
    unauthorized: "publisher_not_authorized", conflict: "head_conflict", dependency_unavailable: "publication_authority_unavailable",
    unsupported: "publication_not_supported", validation_issue: "candidate_invalid",
  } as const;
  return { ...result, outcome, reason: reasons[outcome] };
}
function legacyReceipt(receipt: CatalogPublicationReceiptV2): CatalogPublicationReceipt {
  return { commandKey: receipt.commandKey, fingerprint: receipt.fingerprint, actorId: receipt.actorId,
    previousHead: receipt.previousHead, head: receipt.head, changes: receipt.changes };
}
const equal = (left: unknown, right: unknown) => publicationJson(left) === publicationJson(right);

async function verifiedIssue(db: PgQueryExecutor, publicationId: string, productId?: string) {
  // Admission seals the graph. Bind the exact document and original result
  // without replaying every issued SKU to read one retained page.
  const { rows } = await db.query(`SELECT p.id,p.product_id,p.revision,p.canonical_state,p.digest,r.result,
    p.command_key,p.command_fingerprint,p.actor_id,
    to_char(p.committed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS committed_at,
    d.digest AS document_digest,
    jsonb_build_object('id',d.id,'productId',d.product_id,'revisionNo',d.revision_no,
      'schemaId',d.schema_id,'documentRef',d.document_ref,'sourceRef',d.source_ref,'digest',d.digest) AS document_reference
    FROM public.catalog_publications p
    LEFT JOIN public.catalog_product_document_revisions d ON (d.product_id,d.id)=(p.product_id,p.document_revision_id)
    JOIN public.catalog_operator_receipts r ON (r.scope_id,r.command_key)=(p.product_id,p.command_key)
      AND r.kind='publish' AND r.publication_id=p.id AND r.actor_id=p.actor_id AND r.fingerprint=p.command_fingerprint
    WHERE p.id=$1::uuid AND ($2::uuid IS NULL OR p.product_id=$2::uuid)`, [publicationId, productId ?? null]);
  if (!rows.length) return null;
  const row = rows[0]!;
  requireCondition(rows.length === 1 && row.id === publicationId && (productId === undefined || row.product_id === productId));
  const head = headSchema.parse({ publicationId, revision: row.revision, documentDigest: row.document_digest });
  const manifest = requireDecodedPublication(decodePublicationPacket({ manifest: row.canonical_state }));
  await db.query("SELECT public.catalog_publication_manifest_text($1,$2,$3,false)", [row.product_id, row.canonical_state, row.digest]);
  requireCondition(equal(manifest.product.document, row.document_reference), "catalog_publication_document_invalid");
  requireCondition(manifest.product.id === row.product_id && manifest.product.document?.digest === head.documentDigest
    && publicationDigest(manifest) === row.digest, "catalog_publication_manifest_invalid");
  const receipt = decodeStoredPublicationReceipt(row.result);
  requireCondition(receipt.productId === manifest.product.id && receipt.publicationDigest === row.digest && equal(receipt.head, head)
    && receipt.commandKey === row.command_key && receipt.fingerprint === row.command_fingerprint && receipt.actorId === row.actor_id
    && receipt.committedAt === row.committed_at,
    "catalog_publication_receipt_invalid");
  publicationJson({ outcome: "found", receipt }, limits.receiptBytes);
  return { head, manifest, receipt };
}
type Issue = NonNullable<Awaited<ReturnType<typeof verifiedIssue>>>;

async function issueFacts(db: PgQueryExecutor, issue: Issue, references: readonly CatalogSkuRevisionRef[]) {
  const { rows } = await db.query(`SELECT r.id,r.sku_id,r.sku_code,r.digest,r.revision,
    CASE WHEN public.catalog_publication_sku_facts(r) IS NOT NULL THEN r.full_facts END AS full_facts
    FROM public.catalog_sku_revisions r WHERE r.product_id=$1 AND r.id=ANY($2::uuid[])`, [issue.manifest.product.id, references.map(ref => ref.revisionId)]);
  const byId = new Map(rows.map(row => [row.id, row]));
  requireCondition(rows.length === references.length && rows.length === byId.size, "catalog_publication_sku_revision_invalid");
  return references.map(reference => {
    const row = byId.get(reference.revisionId);
    requireCondition(row && row.sku_id === reference.skuId && row.digest === reference.digest && row.revision === reference.revision,
      "catalog_publication_sku_revision_invalid");
    const facts = decodeStoredPublicationSku(row.full_facts);
    requireCondition(facts.id === reference.skuId && facts.productId === issue.manifest.product.id && facts.code === row.sku_code
      && publicationDigest(facts, limits.skuBytes, SKU_PAGE_DEPTH) === reference.digest,
    "catalog_publication_sku_revision_invalid");
    return { reference, facts };
  });
}

async function observations(db: PgQueryExecutor, issue: Issue): Promise<CatalogPublicationReceipt["changes"]> {
  const { product, skus } = issue.manifest;
  const { rows } = await db.query(`SELECT r.id,r.sku_id,r.sku_code,r.digest,r.revision,
    r.full_facts::jsonb->>'status' AS status,p.draft_id,p.draft_revision
    FROM public.catalog_sku_revisions r
    JOIN public.catalog_publications p ON (p.product_id,p.id)=(r.product_id,r.publication_id)
    WHERE r.product_id=$1 AND r.id=ANY($2::uuid[])`,
    [product.id, skus.map(ref => ref.revisionId)]);
  const byId = new Map(rows.map(row => [row.id, row]));
  requireCondition(rows.length === skus.length && rows.length === byId.size, "catalog_publication_sku_revision_invalid");
  return skus.map(reference => {
    const row = byId.get(reference.revisionId);
    requireCondition(row && row.sku_id === reference.skuId && row.digest === reference.digest && row.revision === reference.revision,
      "catalog_publication_sku_revision_invalid");
    const { sku_code: sku, status, draft_id: draftId, draft_revision: draftRevision } = row;
    requireCondition(typeof sku === "string" && typeof draftId === "string" && typeof draftRevision === "number"
      && (status === "draft" || status === "active" || status === "archived"), "catalog_publication_sku_revision_invalid");
    return { productId: product.id, variantId: reference.skuId, sku,
      state: status === "archived" ? "withdrawn" : status, variantRevision: reference.revision,
      publicationHead: issue.head, draftRef: { draftId, revision: draftRevision } };
  });
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

  async function exact(db: PgQueryExecutor, head: CatalogHeadRef) {
    requireCondition(headSchema.safeParse(head).success, "catalog_publication_query_invalid", "validation_issue");
    const issue = await verifiedIssue(db, head.publicationId);
    requireCondition(issue, "catalog_publication_absent", "unsupported");
    requireCondition(equal(issue.head, head), "head_conflict", "conflict");
    return issue;
  }

  const native = createExactReads(deps);
  const reads: CatalogPublicationReadPort = {
    async current(productId) {
      const result = await native.reads.current(productId);
      return "reason" in result ? legacyFailure(result) : result;
    },
    async readback(head) {
      try {
        return await read(async db => {
          const issue = await exact(db, head);
          const result = { outcome: "found" as const, head: issue.head, documentRef: issue.manifest.product.document!.documentRef,
            observations: await observations(db, issue) };
          publicationJson(result, limits.pageBytes);
          return result;
        });
      } catch (error) { return legacyFailure(publicationReadFailure(error)); }
    },
    async history(productId, cursor) {
      const result = await native.reads.history(productId, cursor);
      return "reason" in result ? legacyFailure(result) : result;
    },
    async receipt() {
      return { outcome: "unsupported", reason: "publication_not_supported", message: publicationRemedy("catalog_publication_receipt_unsupported") };
    },
  };

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
    } catch (error) { return publicationReadFailure(error); }
  }

  return {
    ...native, reads, resolveRetained,
    authorizeReadScope(context: Context): VerifiedCatalogReadScope {
      const scope = Object.freeze({});
      readers.set(scope, { context });
      return scope as VerifiedCatalogReadScope;
    },
    readPort(capability: VerifiedCatalogPublisher): CatalogPublicationReadPort {
      return { ...reads, async receipt(scope) {
        const result = await native.receipt(scope, capability);
        return result.outcome === "found" ? { outcome: "found", receipt: legacyReceipt(result.receipt) }
          : result.outcome === "absent" ? result : legacyFailure(result);
      } };
    },
  };
}
