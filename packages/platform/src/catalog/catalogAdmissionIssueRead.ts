import type { PgQueryExecutor } from "../data/index.js";
import { catalogAdmissionHeadSchema, catalogAdmissionRefSchema } from "./catalogAdmissionSchema.js";
import { refuseSelected, selectedDigest as digest, selectedUuid as uuid } from "./catalogSelectedAdmissionWrite.js";
import { z } from "./validation.js";

const pageSize = z.number().int().min(1).max(100);
const cursor = z.strictObject({
  selectedSkuId: uuid, offerVersion: catalogAdmissionRefSchema, mode: z.literal("admission_issue"),
  offset: z.number().int().min(1).max(499), limit: pageSize, headDigest: digest, binding: digest,
});
const issue = catalogAdmissionHeadSchema.extend({ kind: z.enum(["declaring", "compared"]), skuRevisionId: uuid });
const page = z.strictObject({ kind: z.literal("page"), value: z.strictObject({
  issues: z.array(issue).max(100), consultedHeads: z.array(catalogAdmissionHeadSchema).max(100),
  rosterCount: z.number().int().min(1).max(500), nextCursor: cursor.nullable(),
}) });
const refusal = z.union([
  z.strictObject({ kind: z.literal("refusal"), reason: z.enum(["invalid_request", "unknown_offer", "head_moved", "inconsistent_evidence"]) }),
  z.strictObject({ kind: z.literal("refusal"), reason: z.literal("invalid_request"), detail: z.literal("catalog_admission_selection_ineligible") }),
  z.strictObject({ kind: z.literal("refusal"), reason: z.literal("inconsistent_evidence"),
    detail: z.enum(["catalog_publication_live_drift", "catalog_admission_membership_cap_exceeded", "catalog_admission_page_cap_exceeded"]) }),
]);

function refusePage(raw: unknown): never {
  const parsed = refusal.safeParse(raw);
  if (parsed.success) {
    const value = parsed.data;
    if (value.reason === "unknown_offer") return refuseSelected("membership", "Choose an eligible published subscription offer.");
    if ("detail" in value) {
      if (value.detail === "catalog_admission_selection_ineligible") return refuseSelected("line", "Choose an eligible SKU in the same offer.");
      if (value.detail === "catalog_publication_live_drift") return refuseSelected("membership", "Have the catalogue owner reconcile the live listing with its publication, then read the offer again.");
      if (value.detail === "catalog_admission_membership_cap_exceeded") return refuseSelected("membership", "Use a smaller supported offer.");
    } else {
      if (value.reason === "invalid_request") return refuseSelected("membership", "Restart the bound catalogue read from page one.");
      if (value.reason === "inconsistent_evidence") return refuseSelected("membership", "Have the catalogue owner reconcile the publication evidence, then read the offer again.");
    }
  }
  return refuseSelected("membership", "Have the catalogue owner verify the installed reader and restart from page one.");
}

export async function readAdmissionIssues(db: PgQueryExecutor, offerVersion: string, selectedSkuId: string,
  selectedRevision: string, sourceOrdinal: 1 | 2, limit = 100) {
  if (!catalogAdmissionRefSchema.safeParse(offerVersion).success || !uuid.safeParse(selectedSkuId).success
    || !uuid.safeParse(selectedRevision).success || !pageSize.safeParse(limit).success
    || (sourceOrdinal !== 1 && sourceOrdinal !== 2)) return refusePage(null);
  let continuation: z.infer<typeof cursor> | null = null;
  let count: number | undefined;
  const issues: Array<z.infer<typeof issue> & { sourceOrdinal: 1 | 2 }> = [];
  const heads = new Map<string, z.infer<typeof catalogAdmissionHeadSchema>>();
  const revisions = new Set<string>();
  for (let index = 0; index < 20; index++) {
    const { rows } = await db.query("SELECT public.catalog_offer_memberships_page($1::text,$2::jsonb,$3::integer,'admission_issue') AS result",
      [offerVersion, JSON.stringify({ selectedSkuId, ...(continuation ? { continuation } : {}) }), limit]);
    if (rows.length !== 1) return refusePage(null);
    const decoded = page.safeParse(rows[0]!.result);
    if (!decoded.success) return refusePage(rows[0]!.result);
    const { rosterCount, issues: slice, consultedHeads, nextCursor } = decoded.data.value;
    count ??= rosterCount;
    const products = new Set(slice.map(row => row.productId));
    if (count !== rosterCount || count > 20 * limit || slice.length !== Math.min(limit, count - issues.length)
      || consultedHeads.length !== products.size) return refusePage(null);
    for (const head of consultedHeads) {
      const prior = heads.get(head.productId);
      if (!products.delete(head.productId) || (prior && (prior.publicationId !== head.publicationId
        || prior.revision !== head.revision || prior.documentDigest !== head.documentDigest))) return refusePage(null);
      heads.set(head.productId, head);
    }
    for (const row of slice) {
      if (revisions.has(row.skuRevisionId)) return refusePage(null);
      revisions.add(row.skuRevisionId);
      issues.push({ ...row, sourceOrdinal });
    }
    if (nextCursor === null) {
      const declaring = issues.filter(row => row.kind === "declaring");
      if (issues.length !== count || declaring.length !== 1 || declaring[0]!.skuRevisionId !== selectedRevision) return refusePage(null);
      return { issues, consultedHeads: [...heads.values()] };
    }
    if (nextCursor.selectedSkuId !== selectedSkuId || nextCursor.offerVersion !== offerVersion || nextCursor.limit !== limit
      || nextCursor.offset !== issues.length || nextCursor.offset % limit !== 0 || nextCursor.offset >= count
      || (continuation && continuation.headDigest !== nextCursor.headDigest)) return refusePage(null);
    continuation = nextCursor;
  }
  return refusePage(null);
}
