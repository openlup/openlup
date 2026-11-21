import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogPublicationFacts } from "./contracts/draftV3.js";
import type { CatalogDocumentRevisionRef } from "./contracts/foundation.js";
import type { CatalogHeadRef } from "./contracts/lifecycle.js";
import { catalogDocumentRevisionRefSchema } from "./foundationSchemas.js";
import type { CatalogSkuRevisionRef } from "./publicationContracts.js";
import { z } from "./validation.js";

const id = z.guid().refine(value => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const offer = z.string().min(1).max(240)
  .refine(value => value.trim() === value && !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value));
const mode = z.enum(["one_time", "subscription"]).nullable();
const cursor = z.object({ skuId: id, headDigest: digest, offerVersion: offer, mode }).strict();
const pageInput = z.object({ offerVersion: offer, cursor: cursor.nullish(), limit: z.number().int().min(1).max(100), mode: mode.optional() }).strict();
const revision = z.number().int().min(1).max(2_147_483_647);
const member = z.object({
  head: z.object({ publicationId: id, revision, documentDigest: digest }).strict() satisfies z.ZodType<CatalogHeadRef>,
  document: catalogDocumentRevisionRefSchema.extend({ id, productId: id, revisionNo: revision }) satisfies z.ZodType<CatalogDocumentRevisionRef>,
  skuRevision: z.object({ skuId: id, revisionId: id, revision, digest }).strict() satisfies z.ZodType<CatalogSkuRevisionRef>,
  skuId: id, skuCode: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/u), productId: id, productSlug: z.string().min(1),
  netWeightG: revision, sellableStandalone: z.boolean(), sellableInSubscription: z.boolean(),
  presentation: z.record(z.string(), z.json()).nullable(),
  logisticsRef: z.string().min(1).max(500).refine(value => value.trim() === value).nullable(),
}).strict();
const page = z.discriminatedUnion("protocol", [
  z.object({ protocol: z.literal("legacy"), headDigest: z.null(), items: z.tuple([]), nextCursor: z.null() }).strict(),
  z.object({ protocol: z.literal("governed"), headDigest: digest, items: z.array(member).max(100), nextCursor: cursor.nullable() }).strict(),
]);
const wire = z.union([
  z.object({ kind: z.literal("page"), value: page }).strict(),
  z.object({ kind: z.literal("refusal"), reason: z.enum(["invalid_request", "unknown_offer", "head_moved"]) }).strict(),
  z.object({ kind: z.literal("refusal"), reason: z.literal("inconsistent_evidence"), detail: z.literal("catalog_publication_live_drift").optional() }).strict(),
]);

/** @experimental */
export type CatalogMembershipCursor = { skuId: string; headDigest: string; offerVersion: string; mode: "one_time" | "subscription" | null };
/** @experimental */
export type CatalogMembershipPageInput = { offerVersion: string; limit: number; mode?: CatalogMembershipCursor["mode"]; cursor?: CatalogMembershipCursor | null };
/** @experimental */
export type CatalogDiscoveryEvidence = { head: CatalogHeadRef; document: CatalogDocumentRevisionRef; skuRevision: CatalogSkuRevisionRef };
/** @experimental */
export type CatalogMembershipItem = CatalogDiscoveryEvidence & { skuId: string; skuCode: string; productId: string; productSlug: string;
  netWeightG: number; sellableStandalone: boolean; sellableInSubscription: boolean; presentation: CatalogPublicationFacts | null; logisticsRef: string | null };
/** @experimental */
export type CatalogMembershipPageResult = { protocol: "legacy"; headDigest: null; items: []; nextCursor: null }
  | { protocol: "governed"; headDigest: string; items: CatalogMembershipItem[]; nextCursor: CatalogMembershipCursor | null }
  | CatalogDiscoveryRefusal;
/** @experimental */
export type CatalogDiscoveryRefusal = { outcome: "validation_issue" | "unauthorized" | "conflict" | "dependency_unavailable"; reason: string; retryable?: true };

const unavailable = { outcome: "dependency_unavailable", reason: "catalog_publication_read_unavailable" } as const;
const invalid = { outcome: "validation_issue", reason: "catalog_offer_memberships_page_input_invalid" } as const;

function readError(error: unknown): CatalogDiscoveryRefusal {
  if (!(error instanceof Error) || !("code" in error)) return unavailable;
  if (error.code === "40001") return { outcome: "conflict", reason: "catalog_publication_transaction_conflict", retryable: true };
  if (error.code === "55P03") return { outcome: "conflict", reason: "catalog_publication_read_busy", retryable: true };
  // In this single-function SELECT, aclcheck_error reports position for schema lookup
  // and where for a denial inside the function. Entry-point EXECUTE denial has neither.
  if (error.code === "42501" && "routine" in error && error.routine === "aclcheck_error"
    && !("position" in error && error.position) && !("where" in error && error.where)) {
    return { outcome: "unauthorized", reason: "catalog_publication_read_not_authorized" };
  }
  return unavailable;
}

/** Read one governed page in the caller's statement snapshot.
 * @experimental
 */
export async function readPostgresCatalogMembershipPage(db: PgQueryExecutor, input: CatalogMembershipPageInput): Promise<CatalogMembershipPageResult> {
  const query = pageInput.safeParse(input);
  if (!query.success) return invalid;
  const { offerVersion, cursor: after, limit, mode: requestedMode = null } = query.data;
  if (after && (after.offerVersion !== offerVersion || after.mode !== requestedMode)) return invalid;
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await db.query("SELECT public.catalog_offer_memberships_page($1,$2,$3,$4) AS result", [offerVersion, after ?? null, limit, requestedMode]));
  } catch (error) {
    return readError(error);
  }
  if (rows.length !== 1) return unavailable;
  const decoded = wire.safeParse(rows[0]?.result);
  if (!decoded.success) return unavailable;
  if (decoded.data.kind === "refusal") {
    if (decoded.data.reason === "inconsistent_evidence") return { ...unavailable, reason: decoded.data.detail ?? unavailable.reason };
    if (decoded.data.reason === "head_moved") return { outcome: "conflict", reason: "catalog_publication_head_moved", retryable: true };
    return invalid;
  }
  const { items, nextCursor, headDigest } = decoded.data.value;
  if ((after && headDigest !== after.headDigest) || items.length > limit || items.some((item, index) =>
    item.document.productId !== item.productId || item.head.documentDigest !== item.document.digest || item.skuRevision.skuId !== item.skuId
    || (items[index - 1]?.skuId ?? after?.skuId ?? "") >= item.skuId
    || !((requestedMode !== "subscription" && item.sellableStandalone) || (requestedMode !== "one_time" && item.sellableInSubscription)))
    || (nextCursor && (nextCursor.skuId !== items.at(-1)?.skuId || items.length !== limit || nextCursor.headDigest !== headDigest
      || nextCursor.offerVersion !== offerVersion || nextCursor.mode !== requestedMode))) return unavailable;
  return decoded.data.value;
}
