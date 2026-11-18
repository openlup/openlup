import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogAdmissionInput } from "./contracts/admission.js";
import type { CommerceQuoteCatalogItemV2 } from "../pricing/index.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";

/** Call on the accepting transaction, after commerce prelocking and replay.
 * The shared guards remain held until that same connection commits or rolls back.
 * @experimental
 */
export interface CatalogAdmissionPort {
  assertCurrent(db: PgQueryExecutor, input: CatalogAdmissionInput): Promise<void>;
}

/** Build the facts to retain with a quote or an edit preview from the selected V2 rows.
 * Reuse them at acceptance. The transaction-bound admission assertion owns check order.
 * @experimental
 */
export function buildCatalogAdmissionFromServing(input: Omit<CatalogAdmissionInput, "heads" | "skuRevisions"> & {
  lines: readonly { item: Pick<CommerceQuoteCatalogItemV2, "productId" | "acceptedReference">; quantity: number }[];
}): CatalogAdmissionInput {
  const { lines, ...context } = input;
  const heads = new Map<string, CatalogAdmissionInput["heads"][number]>();
  const skuRevisions = lines.map(({ item, quantity }) => {
    const { productId, acceptedReference: reference } = item;
    const head = { productId, head: reference.publicationHead };
    heads.set(canonicalCatalogDraftJson(head), head);
    return { reference, quantity };
  });
  return { ...context, heads: [...heads.values()], skuRevisions };
}
/** The native SQL assertion is the single admission authority.
 * @experimental
 */
export function createPostgresCatalogAdmission(): CatalogAdmissionPort {
  return {
    async assertCurrent(db, input) {
      await db.query("SELECT public.catalog_admission_assert_current($1::jsonb,$2::jsonb,$3::text,$4::jsonb,$5::jsonb,$6::text)",
        [canonicalCatalogDraftJson(input.heads), canonicalCatalogDraftJson(input.skuRevisions), input.mode,
          canonicalCatalogDraftJson(input.offerEvidence), canonicalCatalogDraftJson(input.priceContextVersions), input.purpose]);
    },
  };
}
