import type { CatalogDraftPayloadV3, CatalogPublicationFacts } from "./contracts/draftV3.js";
import type { CatalogPublicationEvidence } from "./publicationEvidence.js";

type PublicationOperation = CatalogDraftPayloadV3["publication"]["operations"][number];
export const sealedPresentation = (presentation: CatalogPublicationFacts | null): CatalogPublicationFacts => presentation ?? {};

type PublicationEligibility = Extract<PublicationOperation, { op: "set_eligibility" }>;
export function enablesSku(operation: PublicationOperation): operation is PublicationEligibility {
  return operation.op === "set_eligibility" && (operation.sellableStandalone || operation.sellableInSubscription);
}

export function requiredPromotions(operations: readonly PublicationOperation[], current: Pick<CatalogPublicationEvidence, "product" | "skus">) {
  const enabling = new Set(operations.filter(enablesSku).map(operation => operation.skuCode));
  return { product: enabling.size > 0 && current.product?.status === "draft",
    skus: current.skus.filter(sku => enabling.has(sku.code) && sku.status === "draft").map(sku => sku.code) };
}

/** Adapts presentation and compiles required draft-status effects before sealing the v3 batch.
 * @experimental
 */
export function compileCatalogPublicationDraft(payload: CatalogDraftPayloadV3, presentation: CatalogPublicationFacts | null,
  current?: Pick<CatalogPublicationEvidence, "product" | "skus">): CatalogDraftPayloadV3 {
  const { operations } = payload.publication;
  let compiled = operations;
  if (current?.product) {
    const required = requiredPromotions(operations, current);
    const missing = new Set(required.skus);
    for (const operation of operations)
      if (operation.op === "set_sku_status" && operation.status === "active") missing.delete(operation.skuCode);
    compiled = operations.flatMap(operation => enablesSku(operation) && missing.delete(operation.skuCode)
      ? [operation, { op: "set_sku_status", skuCode: operation.skuCode, status: "active" }] : [operation]);
    if (required.product && !compiled.some(operation => operation.op === "set_product_status" && operation.status === "active")) {
      let index = compiled.length;
      while (compiled[index - 1]?.op === "set_offer_membership") index--;
      compiled.splice(index, 0, { op: "set_product_status", productSlug: current.product.slug, status: "active" });
    }
  }
  return { ...payload, product: { ...payload.product, sharedContent: {
    ...payload.product.sharedContent, presentation: sealedPresentation(presentation),
  } }, publication: { ...payload.publication, operations: compiled } };
}
