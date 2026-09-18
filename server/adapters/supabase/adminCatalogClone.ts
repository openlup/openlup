import type { SupabaseClient } from "@supabase/supabase-js";

import type { CreateCatalogDraftRequest } from "../../../src/domains/commerce/adminCatalogContracts.js";
import type { CatalogProductDetail } from "../../../src/domains/commerce/adminCatalogReadContracts.js";
import type { CloneCatalogDraftRequest } from "../../../src/domains/commerce/adminCatalogLifecycleContracts.js";
import { CatalogRpcError } from "../../domains/commerce/adminCatalogDataPort.js";

type CloneDraftPayload = CreateCatalogDraftRequest["product"];

/**
 * @agent-domain-reference
 * Clone orchestration for the catalog LIFECYCLE pack — extracted from
 * `supabaseAdminCatalogDataPort.ts` to keep each file ≤300 LOC.
 *
 * Clone has NO new RPC. It reads the source product via the read data port, maps
 * the structural fields onto a `CreateCatalogDraftRequest` with the caller's NEW
 * slug + NEW sku, and replays it through `admin_upsert_catalog_draft` (the same
 * security boundary) so the clone is born `draft`. A missing source slug surfaces
 * as the read port's NOT_FOUND (P0002 `catalog_product_not_found`).
 */
export function buildCloneCreatePayload(
  source: CatalogProductDetail,
  input: CloneCatalogDraftRequest,
): CloneDraftPayload {
  // The agent-write create path is 1:1 (one product, one SKU). Clone reuses the
  // source's first SKU's structural fields; species comes from the product detail.
  const sourceSku = source.skus[0];
  if (!sourceSku) {
    throw new CatalogRpcError("P0001", "clone_source_has_no_sku");
  }
  return {
    slug: input.slug,
    name: source.name,
    species: (source.species ?? sourceSku.petType ?? "dog") as CloneDraftPayload["species"],
    unit: (sourceSku.unitFormCode ?? sourceSku.formatCode ?? "can") as CloneDraftPayload["unit"],
    sku: input.sku,
    netWeightGrams: sourceSku.netWeightGrams ?? 0,
    kcalPerUnit: sourceSku.kcalPerUnit ?? 0,
    allergens: source.allergens as CloneDraftPayload["allergens"],
  };
}

/**
 * Read the source product detail for a clone. Delegates to the admin catalog read
 * data port (service-role; sees draft/archived rows) lazily imported to keep the
 * write port free of a static read-port dependency. Re-throws the read port's
 * NOT_FOUND so the handler maps it to 404.
 */
export async function loadCloneSource(
  client: SupabaseClient,
  sourceSlug: string,
): Promise<CatalogProductDetail> {
  const { createSupabaseAdminCatalogReadDataPort } = await import(
    "./adminCatalogRead.js"
  );
  return createSupabaseAdminCatalogReadDataPort(client).get(sourceSlug);
}
