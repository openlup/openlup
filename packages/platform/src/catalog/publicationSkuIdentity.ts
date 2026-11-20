import type { PgQueryExecutor } from "../data/index.js";
import { publicationRefuse } from "./publicationError.js";

/** Check the live code against the revision referenced by the checked manifest. */
export async function assertPublishedSkuIdentity(db: PgQueryExecutor, productId?: string): Promise<void> {
  const { rows } = await db.query(`WITH manifests AS MATERIALIZED (
    SELECT p.product_id,public.catalog_publication_manifest_text(p.product_id,p.canonical_state,p.digest,false)::jsonb AS state
    FROM public.catalog_publication_heads h
    JOIN public.catalog_publications p ON (p.product_id,p.id)=(h.product_id,h.publication_id)
    WHERE ($1::uuid IS NULL OR h.product_id=$1)
  )
    SELECT 1 FROM manifests p
    CROSS JOIN LATERAL jsonb_array_elements(p.state->'skus') member
    JOIN public.catalog_sku_revisions r ON r.id::text=member->>'revisionId' AND r.product_id=p.product_id
    JOIN public.catalog_skus s ON (s.product_id,s.id)=(r.product_id,r.sku_id)
    WHERE s.sku IS DISTINCT FROM r.sku_code LIMIT 1`, [productId ?? null]);
  if (rows.length) publicationRefuse("catalog_publication_sku_identity_changed", "conflict");
}
