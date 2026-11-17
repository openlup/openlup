import { expect, it } from "vitest";
import { catalogDraftPayloadV3Schema } from "../../src/catalog/draftV3Schemas.js";
import { catalogDraftPayloadV4Schema, catalogLifecycleTransitionV2, catalogAuthoritativeLifecycleV2, catalogAcceptedReferenceV2Schema } from "../../src/catalog/lifecycleV2.js";
import { compileCatalogPublication } from "../../src/catalog/publicationValidation.js";
import type { CatalogDraftPayloadV4, CatalogLifecycleStateV2, CatalogDraftPublicationOperationV4 } from "../../src/catalog/contracts/lifecycleV2.js";
import { input } from "./fixtures/publicationInput.js";

const states: CatalogLifecycleStateV2[] = ["draft", "active", "withdrawn", "archived"];
const admitted = new Set(["draft:active", "draft:archived", "active:active", "active:withdrawn", "withdrawn:archived"]);
it.each(states.flatMap(from => states.map(to => ({ from, to }))))("product and SKU transition matrix $from → $to", ({ from, to }) => {
  expect(catalogLifecycleTransitionV2(from, to)).toBe(admitted.has(`${from}:${to}`));
  expect(catalogLifecycleTransitionV2(from, to, true)).toBe(from === "withdrawn" && to === "active");
});
function governed() {
  const source = input(), payload = { ...source.payload, schemaVersion: 4 } as CatalogDraftPayloadV4;
  return { ...source, payload, record: { ...source.record, payload } };
}
function active() {
  const source = governed(), first = compileCatalogPublication(source);
  if (!("lifecycleState" in first.product) || !("lifecycleState" in first.skus[0]!)) throw new Error("Missing governed facts");
  first.product.lifecycleState = "active"; first.product.status = "active";
  first.skus[0].lifecycleState = "active"; first.skus[0].status = "active";
  return { source, first };
}
function revision(operations: CatalogDraftPublicationOperationV4[]) {
  const { source, first } = active();
  const payload: CatalogDraftPayloadV4 = { ...source.payload, product: { ...source.payload.product,
    sharedContent: { ...source.payload.product.sharedContent, catalogAction: "revise" } }, publication: { kind: "release", evidence: {}, operations } };
  return { ...source, product: first.product, skus: first.skus, documents: first.documents, payload, record: { ...source.record, revision: 2, payload } };
}
it("keeps v1/v2/v3 decoding strict while adding lifecycle commands", () => {
  const value = governed();
  expect(catalogDraftPayloadV4Schema.safeParse(value.payload).success).toBe(true);
  expect(catalogDraftPayloadV3Schema.safeParse(value.payload).success).toBe(false);
  value.payload.publication.operations.push({ op: "set_product_status", productSlug: "article", status: "active" } as never);
  expect(catalogDraftPayloadV4Schema.safeParse(value.payload).success).toBe(false);
});
it("withdraws all child rights atomically without changing physical facts", () => {
  const value = revision([{ op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "withdrawn", children: [{ skuCode: "ARTICLE", expectedState: "active" }] }]);
  value.skus[0]!.sellableStandalone = true;
  const after = compileCatalogPublication(value);
  expect(catalogAuthoritativeLifecycleV2(after.product)).toBe("withdrawn");
  expect(catalogAuthoritativeLifecycleV2(after.skus[0]!)).toBe("withdrawn");
  expect(after.skus[0]!.status).toBe("active");
  expect([after.skus[0]!.sellableStandalone, after.skus[0]!.sellableInSubscription]).toEqual([false, false]);
  expect(after.skus[0]!.netContent).toEqual(value.skus[0]!.netContent);
  expect(after.skus[0]!.memberships).toEqual(value.skus[0]!.memberships);
});
it("binds the entire child withdrawal set into the candidate", () => {
  const value = revision([{ op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "withdrawn", children: [] }]);
  expect(() => compileCatalogPublication(value)).toThrow("catalog_lifecycle_child_effects_mismatch");
});
it("requires genuine same-command parent withdrawal for the last active child", () => {
  const value = revision([{ op: "set_sku_lifecycle", skuCode: "ARTICLE", expectedState: "active", state: "withdrawn" }]);
  expect(() => compileCatalogPublication(value)).toThrow("catalog_lifecycle_last_active_child");
  value.payload.publication.operations.push({ op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "withdrawn", children: [{ skuCode: "ARTICLE", expectedState: "withdrawn" }] });
  expect(catalogAuthoritativeLifecycleV2(compileCatalogPublication(value).product)).toBe("withdrawn");
});
it("restoring a parent never implicitly restores children or fresh-sale flags", () => {
  const value = revision([{ op: "restore_product", productSlug: "article", expectedState: "withdrawn" }]);
  Object.assign(value.product!, { lifecycleState: "withdrawn" });
  Object.assign(value.skus[0]!, { lifecycleState: "withdrawn" });
  const result = compileCatalogPublication(value);
  expect(result.activation).toBe(true);
  expect(catalogAuthoritativeLifecycleV2(result.product)).toBe("active");
  expect(catalogAuthoritativeLifecycleV2(result.skus[0]!)).toBe("withdrawn");
  expect(result.skus[0]!.sellableStandalone).toBe(false);
});
it("terminal archive cannot resurrect through raw status or restoration", () => {
  const value = revision([{ op: "restore_product", productSlug: "article", expectedState: "withdrawn" }]);
  Object.assign(value.product!, { status: "archived", lifecycleState: "archived" });
  expect(() => compileCatalogPublication(value)).toThrow("catalog_lifecycle_state_conflict");
  expect(() => catalogAuthoritativeLifecycleV2(input().skus[0]!)).toThrow();
});
it("keeps the primary SKU archive refusal", () => {
  const value = revision([{ op: "set_sku_lifecycle", skuCode: "ARTICLE", expectedState: "withdrawn", state: "archived" }]);
  Object.assign(value.skus[0]!, { lifecycleState: "withdrawn" });
  expect(() => compileCatalogPublication(value)).toThrow("catalog_publication_v3_compile_archive_refused");
});
it.each(["material", "inconclusive"] as const)("catalog_material_change_requires_successor_sku: %s", impact => {
  const value = revision([{ op: "set_product_presentation", productSlug: "article", presentation: {} }]);
  value.payload.skus[0]!.attributes = { changed: "physical" };
  value.rules = { ...value.rules, classifySkuChange: () => impact };
  expect(() => compileCatalogPublication(value)).toThrow("sku_identity_change_requires_new_sku");
});
it("rejects incomplete accepted references and never infers legacy lineage", () => {
  expect(catalogAcceptedReferenceV2Schema.safeParse({ schemaVersion: 2, skuCode: "ARTICLE", skuRevisionId: null }).success).toBe(false);
});

// Pack-owned data stays opaque to the lifecycle contract. Native publication
// remains mass-only; these refusal witnesses do not qualify nonmass serving.
it.each([
  { pack: "supplement", dimension: "count", unit: "openlup:piece", before: { strength: "10" }, after: { strength: "20" } },
  { pack: "cosmetic", dimension: "volume", unit: "openlup:ml", before: { inci: "formula-a" }, after: { inci: "formula-b" } },
  { pack: "pet-food", dimension: "mass", unit: "openlup:g", before: { recipe: "recipe-a" }, after: { recipe: "recipe-b" } },
] as const)("preserves successor refusal for the $pack pack model", ({ dimension, unit, before, after }) => {
  for (const impact of ["material", "inconclusive"] as const) {
    const value = revision([{ op: "set_product_presentation", productSlug: "article", presentation: {} }]);
    const quantity = { dimension, unit, unscaled: "100", scale: 0 };
    value.skus[0]!.netContent = quantity;
    value.skus[0]!.attributes = { ...before };
    value.payload.skus[0]!.netContent = { ...quantity };
    value.payload.skus[0]!.attributes = { ...after };
    value.rules = { ...value.rules, classifySkuChange: () => impact };
    expect(() => compileCatalogPublication(value)).toThrow("sku_identity_change_requires_new_sku");
    value.payload.skus[0]!.attributes = { ...before };
    value.payload.skus[0]!.netContent = { ...quantity, unscaled: "200" };
    expect(() => compileCatalogPublication(value)).toThrow("sku_identity_change_requires_new_sku");
  }
});
it("keeps a translated presentation edit compatible without changing identity", () => {
  const value = revision([{ op: "set_product_presentation", productSlug: "article", presentation: { label: "Corrected translation" } }]);
  value.payload.product.sharedContent.presentation = { label: "Corrected translation" };
  const result = compileCatalogPublication(value);
  expect(result.skus[0]!.netContent).toEqual(value.skus[0]!.netContent);
  expect(result.skus[0]!.options).toEqual(value.skus[0]!.options);
  expect(result.product.presentation).toEqual({ label: "Corrected translation" });
});
