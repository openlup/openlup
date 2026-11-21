import { z } from "zod";
import type { PgQueryExecutor } from "../data/index.js";
import type { VerifiedCatalogPublisher } from "./publicationPorts.js";
import { CATALOG_PUBLICATION_LIMITS as limits } from "./publicationContracts.js";
import type { CatalogFullPublicationV2, CatalogFullPublicationV3, CatalogPublishedSkuV3, CatalogPublicationReceiptV2, CatalogPublicationReceiptV3, CatalogSkuRevisionRef,
  CatalogPublicationFailure } from "./publicationContracts.js";
import type { CatalogHeadRef, CatalogPublicationReceipt } from "./contracts/lifecycle.js";
import { decodePublicationPacket, requireDecodedPublication, decodeStoredPublicationReceipt,
  decodeStoredPublicationSku, legacyPublicationReceipt, publicationJson, publicationDigest, SKU_PAGE_DEPTH } from "./publicationCodec.js";
import { publicationReadFailure, publicationRefuse, type AdmissionDiagnostic } from "./publicationError.js";
import { assertPublishedSkuIdentity } from "./publicationSkuIdentity.js";

/** @experimental */
export interface CatalogPublicationReadDependencies<Context> {
  transactions: { run<T>(work: (db: PgQueryExecutor) => Promise<T>): Promise<T> };
  authorizeHuman(context: Context): Promise<{ ok: true; userId: string; role: string; isMachineActor: boolean } | { ok: false }>;
}

const id = z.guid().refine(value => value === value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const key = z.string().min(1).refine(value => Buffer.byteLength(value) <= 200 && !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value));
const headSchema = z.object({ publicationId: id, revision, documentDigest: digest }).strict();
// Every read refusal uses a code from the remedy map, so a new reason without a remedy does not compile.
const refuse = (reason: AdmissionDiagnostic, outcome: CatalogPublicationFailure["outcome"] = "dependency_unavailable"): never =>
  publicationRefuse(reason, outcome);
function requireCondition(condition: unknown, reason: AdmissionDiagnostic = "catalog_publication_read_invalid",
  outcome: CatalogPublicationFailure["outcome"] = "dependency_unavailable"): asserts condition {
  if (!condition) refuse(reason, outcome);
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
  requireCondition(receipt.schemaVersion === manifest.schemaVersion && receipt.productId === manifest.product.id && receipt.publicationDigest === row.digest && equal(receipt.head, head)
    && receipt.commandKey === row.command_key && receipt.fingerprint === row.command_fingerprint && receipt.actorId === row.actor_id
    && receipt.committedAt === row.committed_at,
    "catalog_publication_receipt_invalid");
  publicationJson({ outcome: "found", receipt }, limits.receiptBytes);
  return { head, manifest, receipt };
}
type Issue = NonNullable<Awaited<ReturnType<typeof verifiedIssue>>>;
type PublicationReadFailure = CatalogPublicationFailure & { message: string };
type CurrentPublicationRead = { outcome: "unpublished" }
  | { outcome: "found"; head: CatalogHeadRef; documentRef: string; observations: CatalogPublicationReceipt["changes"] }
  | PublicationReadFailure;
type PublicationHistoryRead = {
  outcome: "page"; receipts: CatalogPublicationReceipt[]; limit: typeof limits.pageItems; nextCursor: string | null;
} | PublicationReadFailure;
type PublicationReceiptRead = { outcome: "absent"; receipt?: undefined } | { outcome: "found"; receipt: CatalogPublicationReceiptV2 | CatalogPublicationReceiptV3 }
  | PublicationReadFailure;

async function issueFacts(db: PgQueryExecutor, issue: Issue, references: readonly CatalogSkuRevisionRef[]) {
  const { rows } = await db.query(`SELECT r.id,r.sku_id,r.sku_code,r.digest,r.revision,
    CASE WHEN public.catalog_publication_sku_facts(jsonb_populate_record(NULL::public.catalog_sku_revisions,
      jsonb_build_object('sku_id',r.sku_id,'product_id',r.product_id,'sku_code',r.sku_code,
        'full_facts',r.full_facts,'digest',r.digest))) IS NOT NULL THEN r.full_facts END AS full_facts
    FROM public.catalog_sku_revisions r WHERE r.product_id=$1 AND r.id=ANY($2::uuid[])`, [issue.manifest.product.id, references.map(ref => ref.revisionId)]);
  const byId = new Map(rows.map(row => [row.id, row]));
  requireCondition(rows.length === references.length && rows.length === byId.size, "catalog_publication_sku_revision_invalid");
  return references.map(reference => {
    const row = byId.get(reference.revisionId);
    requireCondition(row && row.sku_id === reference.skuId && row.digest === reference.digest && row.revision === reference.revision,
      "catalog_publication_sku_revision_invalid");
    const facts = decodeStoredPublicationSku(row.full_facts);
    requireCondition((facts.schemaVersion ?? 2) === issue.manifest.schemaVersion && facts.id === reference.skuId && facts.productId === issue.manifest.product.id && facts.code === row.sku_code
      && publicationDigest(facts, limits.skuBytes, SKU_PAGE_DEPTH) === reference.digest,
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
  const { rows } = await db.query("SELECT public.catalog_publication_live_matches($1,$2,$3) AS matches",
    [product.id, publicationJson(product), publicationJson(skus)]);
  if (rows[0]?.matches !== true) {
    await assertPublishedSkuIdentity(db, product.id);
    refuse("catalog_publication_live_drift", "conflict");
  }
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
  } catch { return refuse("catalog_publication_cursor_invalid", "validation_issue"); }
}

async function observations(db: PgQueryExecutor, issue: Issue): Promise<CatalogPublicationReceipt["changes"]> {
  const { product, skus } = issue.manifest;
  const { rows } = await db.query(`SELECT r.id,r.sku_id,r.sku_code,r.digest,r.revision,
    coalesce(r.full_facts::jsonb->>'lifecycleState',r.full_facts::jsonb->>'status') AS status,p.draft_id,p.draft_revision
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
      && (status === "draft" || status === "active" || status === "archived" || status === "withdrawn"), "catalog_publication_sku_revision_invalid");
    return { productId: product.id, variantId: reference.skuId, sku,
      state: status === "archived" ? "withdrawn" : status, variantRevision: reference.revision,
      publicationHead: issue.head, draftRef: { draftId, revision: draftRevision } };
  });
}

/** Reads admitted history in one snapshot on a host-selected publication connection.
 * The host authorizes current, exact and history and supplies a verified human for receipt recovery.
 * @experimental
 */
export function createPostgresCatalogPublicationReads<Context>(deps: CatalogPublicationReadDependencies<Context>) {
  const operators = new WeakMap<object, string>();
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

  async function receipt(scope: { productId: string; commandKey: string }, capability: VerifiedCatalogPublisher): Promise<PublicationReceiptRead> {
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
    } catch (error) { return publicationReadFailure(error); }
  }

  const reads = {
    async current(productId: string): Promise<CurrentPublicationRead> {
      try {
        requireCondition(id.safeParse(productId).success, "catalog_publication_query_invalid", "validation_issue");
        return await read(async db => {
          const issue = await currentIssue(db, productId);
          if (!issue) return { outcome: "unpublished" as const };
          await assertCurrentProjection(db, issue);
          const result = { outcome: "found" as const, head: issue.head, documentRef: issue.manifest.product.document!.documentRef,
            observations: await observations(db, issue) };
          publicationJson(result, limits.pageBytes);
          return result;
        });
      } catch (error) { return publicationReadFailure(error); }
    },
    async history(productId: string, cursor: string | null): Promise<PublicationHistoryRead> {
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
            const item = legacyPublicationReceipt(issue.receipt);
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
      } catch (error) { return publicationReadFailure(error); }
    },
  };
  function readback(version: 2, head: CatalogHeadRef, cursor: string | null): Promise<CatalogFullPublicationV2 | CatalogPublicationFailure>;
  function readback(version: 3, head: CatalogHeadRef, cursor: string | null): Promise<CatalogFullPublicationV3 | CatalogPublicationFailure>;
  async function readback(version: 2 | 3, head: CatalogHeadRef, cursor: string | null): Promise<CatalogFullPublicationV2 | CatalogFullPublicationV3 | CatalogPublicationFailure> {
    try {
      return await read(async db => {
        const issue = await exact(db, head);
        requireCondition(issue.manifest.schemaVersion === version,
          version === 3 ? "catalog_lifecycle_evidence_unavailable" : "catalog_publication_use_readback_v3", "unsupported");
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
        const emptyPageBytes = Buffer.byteLength(publicationJson({ outcome: "page", schemaVersion: version, head, product, items: [], nextCursor: null }));
        let itemBytes = 0;
        let nextCursor: string | null = null;
        for (const [index, reference] of wanted.entries()) {
          const bytes = sizes.get(reference.revisionId);
          requireCondition(typeof bytes === "number" && bytes >= 2 && bytes <= limits.skuBytes, "catalog_publication_sku_revision_invalid");
          const continuation = offset + index + 1 < skus.length
            ? encodeCursor({ kind: "facts", productId: product.id, highWater: head.revision, before: offset + index + 1 }) : null;
          const base = emptyPageBytes + (continuation === null ? 0 : continuation.length - 2);
          const itemSize = Buffer.byteLength(publicationJson({ reference, facts: null })) - 4 + bytes + (index === 0 ? 0 : 1);
          if (base + itemBytes + itemSize > limits.pageBytes) {
            requireCondition(selected.length, "catalog_publication_readback_item_too_large");
            break;
          }
          itemBytes += itemSize;
          selected.push(reference);
          nextCursor = continuation;
        }
        const items = await issueFacts(db, issue, selected);
        const result = issue.manifest.schemaVersion === 3
          ? { outcome: "page" as const, schemaVersion: 3 as const, head: issue.head, product: issue.manifest.product,
            items: items as { reference: CatalogSkuRevisionRef; facts: CatalogPublishedSkuV3 }[], nextCursor }
          : { outcome: "page" as const, schemaVersion: 2 as const, head: issue.head, product: issue.manifest.product, items, nextCursor };
        publicationJson(result, limits.pageBytes);
        return result;
      });
    } catch (error) { return publicationReadFailure(error); }
  }

  return { reads, authorize, receipt,
    readbackV2: (head: CatalogHeadRef, cursor: string | null = null) => readback(2, head, cursor),
    readbackV3: (head: CatalogHeadRef, cursor: string | null = null) => readback(3, head, cursor),
  };
}
