import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogAdmissionInput } from "./contracts/admission.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";

/** Call on the accepting transaction, after commerce prelocking and replay.
 * The shared guards remain held until that same connection commits or rolls back.
 * @experimental
 */
export interface CatalogAdmissionPort {
  assertCurrent(db: PgQueryExecutor, input: CatalogAdmissionInput): Promise<void>;
}
/** The native SQL assertion is the single admission authority.
 * @experimental
 */
export function createPostgresCatalogAdmission(): CatalogAdmissionPort {
  return {
    async assertCurrent(db, input) {
      await db.query("SELECT public.catalog_admission_assert_current($1::jsonb,$2::jsonb,$3::text,$4::jsonb,$5::jsonb,$6::text)",
        [canonicalCatalogDraftJson(input.heads), canonicalCatalogDraftJson(input.skuRevisions), input.mode,
          canonicalCatalogDraftJson(input.retainedPriceContextVersions === undefined ? input.offerEvidence
            : { ...input.offerEvidence, retainedPriceContextVersions: input.retainedPriceContextVersions }),
          canonicalCatalogDraftJson(input.priceContextVersions), input.purpose]);
    },
  };
}
