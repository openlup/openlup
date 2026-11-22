import type { CatalogAdmissionPort } from "./contracts/admission.js";
import { catalogAdmissionEvidenceSchema } from "./catalogAdmissionSchema.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { quoteDigest } from "../pricing/index.js";
import { isDeepStrictEqual } from "node:util";

/** Assert owner evidence on the supplied transaction without obtaining mutation authority.
 * @experimental
 */
export function createPostgresCatalogAdmission(): CatalogAdmissionPort {
  return {
    async assertCurrent(db, input) {
      const evidence = catalogAdmissionEvidenceSchema.safeParse(input.evidence);
      const digest = quoteDigest("catalog.owner-quote.v0", input.ownerDocument);
      if (!evidence.success || evidence.data.quoteDigest !== digest) throw new Error("catalog_admission_evidence_binding_mismatch");
      if (!isDeepStrictEqual(input.reviewedProjection, input.ownerDocument.reviewedProjection)) {
        throw new Error("catalog_admission_quote_projection_moved");
      }
      await db.query("SELECT public.catalog_admission_assert_current($1::jsonb,$2::jsonb,$3::text,$4::jsonb,$5::jsonb,$6::text)", [
        canonicalCatalogDraftJson(input.reviewedProjection), canonicalCatalogDraftJson(input.ownerDocument),
        input.mode, canonicalCatalogDraftJson(input.context), JSON.stringify(evidence.data), digest,
      ]);
    },
  };
}
