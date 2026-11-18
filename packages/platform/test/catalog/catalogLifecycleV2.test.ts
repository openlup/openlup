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
it.each([false, true])("LC5-A-004 requires the parent to finish withdrawn after its last active child withdrawal, restored=%s", restore => {
  const value = revision([{ op: "set_sku_lifecycle", skuCode: "ARTICLE", expectedState: "active", state: "withdrawn" }]);
  expect(() => compileCatalogPublication(value)).toThrow("catalog_lifecycle_last_active_child");
  value.payload.publication.operations.push({ op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "withdrawn", children: [{ skuCode: "ARTICLE", expectedState: "withdrawn" }] });
  if (restore) {
    value.payload.publication.operations.push({ op: "restore_product", productSlug: "article", expectedState: "withdrawn" });
    expect(() => compileCatalogPublication(value)).toThrow("catalog_lifecycle_last_active_child");
    return;
  }
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

it("P32-governed-prefix: activation needs a complete product at that operation", () => {
  const value = governed();
  value.payload.publication.operations.splice(1, 0, { op: "set_product_lifecycle", productSlug: "article", expectedState: "draft", state: "active", children: [] });
  // The later operations supply both fields: final-state checks cannot prove the prefix.
  expect(() => compileCatalogPublication(value)).toThrow("catalog_publication_v3_compile_product_incomplete");
  value.payload.publication.operations.push(value.payload.publication.operations.splice(1, 1)[0]!);
  expect(catalogAuthoritativeLifecycleV2(compileCatalogPublication(value).product)).toBe("active");
});
it.each(["sellableStandalone", "sellableInSubscription"] as const)("P28-archive-enabled-flags: nonprimary draft archive checks staged %s", flag => {
  const archive = { op: "set_sku_lifecycle", skuCode: "OTHER", expectedState: "draft", state: "archived" } as const;
  const value = revision([archive]);
  const otherId = "20000000-0000-4000-8000-000000000002";
  value.skus.push({ ...structuredClone(value.skus[0]!), id: otherId, code: "OTHER", status: "draft", lifecycleState: "draft" });
  value.payload.skus.push({ ...structuredClone(value.payload.skus[0]!), id: otherId, code: "OTHER" });
  value.payload.product.sharedContent.requestedModes.push({ skuCode: "OTHER", modes: [] });
  expect(catalogAuthoritativeLifecycleV2(compileCatalogPublication(value).skus[1]!)).toBe("archived");
  value.payload.product.sharedContent.requestedModes[1]!.modes = [flag === "sellableStandalone" ? "one_time" : "subscription"];
  value.payload.publication.operations.unshift({ op: "set_eligibility", skuCode: "OTHER",
    sellableStandalone: flag === "sellableStandalone", sellableInSubscription: flag === "sellableInSubscription" });
  expect(() => compileCatalogPublication(value)).toThrow("catalog_publication_v3_compile_archive_refused");
});
it("P13-governed-explicit-eligibility: v4 SKU activation needs an enabling operation", () => {
  const value = governed();
  value.payload.publication.operations.push({ op: "set_sku_lifecycle", skuCode: "ARTICLE", expectedState: "draft", state: "active" });
  const parsed = catalogDraftPayloadV4Schema.safeParse(value.payload);
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error("Missing explicit eligibility refusal");
  expect(parsed.error.issues).toEqual([expect.objectContaining({ message: "activation requires explicit enabling eligibility" })]);
  value.payload.publication.operations.push({ op: "set_eligibility", skuCode: "ARTICLE", sellableStandalone: true, sellableInSubscription: false });
  expect(catalogDraftPayloadV4Schema.safeParse(value.payload).success).toBe(true);
});
it("P28-primary-immutable: an existing primary cannot switch to another owned SKU", () => {
  const value = revision([{ op: "set_primary_sku", productSlug: "article", skuCode: "OTHER" }]);
  const otherId = "20000000-0000-4000-8000-000000000002";
  value.skus.push({ ...structuredClone(value.skus[0]!), id: otherId, code: "OTHER", status: "draft", lifecycleState: "draft" });
  value.payload.skus.push({ ...structuredClone(value.payload.skus[0]!), id: otherId, code: "OTHER" });
  value.payload.product.primarySkuId = otherId;
  expect(() => compileCatalogPublication(value)).toThrow("catalog_publication_v3_compile_primary_immutable");
  value.product!.primarySkuId = null;
  expect(compileCatalogPublication(value).product.primarySkuId).toBe(otherId);
});
it("P09-membership-independent: withdrawal preserves nonempty admitted and excluded memberships", () => {
  const value = revision([{ op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "withdrawn", children: [{ skuCode: "ARTICLE", expectedState: "active" }] }]);
  const memberships = [{ offerVersion: "example:offer-a@1", admitted: true }, { offerVersion: "example:offer-b@1", admitted: false }];
  value.skus[0]!.memberships = structuredClone(memberships);
  expect(compileCatalogPublication(value).skus[0]!.memberships).toEqual(memberships);
});
it("D-authority-unavailable: a valid legacy SKU has no governed lifecycle authority", () => {
  const legacy = compileCatalogPublication(input()).skus[0]!;
  expect(legacy.status).toBe("draft");
  expect(() => catalogAuthoritativeLifecycleV2(legacy)).toThrow("catalog_lifecycle_authority_unavailable");
});

it.each([
  ["LC5-D-012", "before"],
  ["LC5-D-013", "after"],
  ["LC5-D-055", "absent"],
  ["LC5-D-012 foreign", "foreign"],
  ["LC5-D-012 disabled", "disabled"],
] as const)("restore %s with eligibility %s", (_rule, position) => {
  const enable = { op: "set_eligibility", skuCode: position === "foreign" ? "OTHER" : "ARTICLE",
    sellableStandalone: position !== "disabled", sellableInSubscription: false } as const;
  const restore = { op: "restore_sku", skuCode: "ARTICLE", expectedState: "withdrawn" } as const;
  const operations = position === "absent" ? [restore] : position === "before" ? [enable, restore] : [restore, enable];
  const value = revision(operations);
  const sku = value.skus[0]!;
  Object.assign(sku, { lifecycleState: "withdrawn", grossMass: { ...sku.netContent, unscaled: "110" }, logisticsRef: "example:parcel",
    memberships: [{ offerVersion: "example:offer@1", admitted: true }] });
  value.payload.product.sharedContent.requestedModes[0]!.modes = ["one_time"];
  if (position === "before" || position === "after") {
    expect(compileCatalogPublication(value).skus[0]).toMatchObject({ lifecycleState: "active", sellableStandalone: true });
  } else {
    expect(catalogDraftPayloadV4Schema.safeParse(value.payload)).toMatchObject({ success: false,
      error: { issues: [expect.objectContaining({ message: "activation requires explicit enabling eligibility" })] } });
  }
});

it.each([
  ["LC5-D-014", "version"],
  ["LC5-D-015", "membership"],
  ["LC5-D-016", "duplicate"],
  ["LC5-A-003", "status"],
] as const)("compiler authority %s rejects invalid retained %s before applying operations", (_rule, invalid) => {
  const value = revision([{ op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "withdrawn",
    children: [{ skuCode: "ARTICLE", expectedState: "active" }] }]);
  if (invalid === "version") Object.assign(value.skus[0]!, { schemaVersion: 99 });
  if (invalid === "membership") value.skus[0]!.memberships = [
    { offerVersion: "example:offer", admitted: true }, { offerVersion: "example:offer", admitted: false }];
  if (invalid === "duplicate") value.skus.push({ ...value.skus[0]!, id: "20000000-0000-4000-8000-000000000002" });
  if (invalid === "status") value.skus[0]!.status = "draft";
  expect(() => compileCatalogPublication(value)).toThrow("catalog_publication_sku_revision_invalid");
});

it.each(["set_product_lifecycle", "set_sku_lifecycle", "set_eligibility"] as const)(
  "LC5-D-037 %s refuses an unauthored physical overlay", op => {
    const effect: CatalogDraftPublicationOperationV4 = op === "set_product_lifecycle"
      ? { op, productSlug: "article", expectedState: "active", state: "withdrawn",
        children: [{ skuCode: "ARTICLE", expectedState: "active" }] }
      : op === "set_sku_lifecycle"
        ? { op, skuCode: "ARTICLE", expectedState: "active", state: "withdrawn" }
        : { op, skuCode: "ARTICLE", sellableStandalone: false, sellableInSubscription: false };
    const value = revision([effect]);
    if (op === "set_sku_lifecycle") value.payload.publication.operations.push({
      op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "withdrawn",
      children: [{ skuCode: "ARTICLE", expectedState: "withdrawn" }],
    });
    value.payload.skus[0]!.attributes = { material: "changed" };
    expect(() => compileCatalogPublication(value)).toThrow("catalog_lifecycle_withdrawal_overlay_refused");
  },
);

it.each([
  ["LC5-D-019", { op: "set_product_lifecycle", productSlug: "foreign", expectedState: "active", state: "withdrawn", children: [] }, "catalog_publication_scope_expansion"],
  ["LC5-D-019", { op: "restore_product", productSlug: "foreign", expectedState: "withdrawn" }, "catalog_publication_scope_expansion"],
  ["LC5-D-019", { op: "set_product_lifecycle", productSlug: "foreign", expectedState: "active", state: "active", children: [] }, "catalog_publication_scope_expansion"],
  ["LC5-D-019", { op: "set_product_lifecycle", productSlug: "foreign", expectedState: "draft", state: "archived", children: [] }, "catalog_publication_scope_expansion"],
  ["LC5-D-019", { op: "set_sku_lifecycle", skuCode: "ABSENT", expectedState: "draft", state: "active" }, "catalog_publication_v3_compile_sku_absent"],
  ["LC5-D-019", { op: "set_sku_lifecycle", skuCode: "ABSENT", expectedState: "active", state: "withdrawn" }, "catalog_publication_v3_compile_sku_absent"],
  ["LC5-D-019", { op: "set_eligibility", skuCode: "ABSENT", sellableStandalone: false, sellableInSubscription: false }, "catalog_publication_v3_compile_sku_absent"],
  ["LC5-D-019", { op: "set_sku_lifecycle", skuCode: "ABSENT", expectedState: "draft", state: "archived" }, "catalog_publication_v3_compile_sku_absent"],
  ["LC5-D-019", { op: "restore_sku", skuCode: "ABSENT", expectedState: "withdrawn" }, "catalog_publication_v3_compile_sku_absent"],
  ["LC5-D-019", { op: "set_offer_membership", skuCode: "ABSENT", offerVersion: "example:offer@1", admitted: false }, "catalog_publication_v3_compile_sku_absent"],
  ["LC5-D-020", { op: "set_primary_sku", productSlug: "article", skuCode: "ABSENT" }, "catalog_publication_v3_compile_sku_absent"],
  ["LC5-D-020", { op: "set_primary_sku", productSlug: "article", skuCode: "ARTICLE" }, "catalog_publication_v3_compile_primary_foreign"],
  ["LC5-D-021", { op: "set_primary_sku", productSlug: "article", skuCode: "ARTICLE" }, "catalog_publication_v3_compile_sku_archived"],
  ["LC5-D-024", { op: "restore_product", productSlug: "article", expectedState: "withdrawn" }, "catalog_publication_v3_compile_product_incomplete"],
] satisfies [string, CatalogDraftPublicationOperationV4, string][])(
  "operation proof %s %j", (rule, operation, reason) => {
    const ops = [operation];
    if (operation.op === "restore_sku" || operation.op === "set_sku_lifecycle" && operation.state === "active") ops.push({
      op: "set_eligibility", skuCode: operation.skuCode, sellableStandalone: true, sellableInSubscription: false,
    });
    const value = revision(ops);
    if (reason === "catalog_publication_v3_compile_primary_foreign") delete value.payload.product.primarySkuId;
    if (rule === "LC5-D-021") Object.assign(value.skus[0]!, { status: "archived", lifecycleState: "archived" });
    if (rule === "LC5-D-024") Object.assign(value.product!, { primarySkuId: null, lifecycleState: "withdrawn" });
    expect(() => compileCatalogPublication(value)).toThrow(reason);
  },
);

it.each(["sku withdrawal", "eligibility withdrawal"] as const)(
  "LC5-D-035 LC5-D-036 preserve sealed membership during %s", path => {
    const value = revision(path === "sku withdrawal" ? [
      { op: "set_sku_lifecycle", skuCode: "ARTICLE", expectedState: "active", state: "withdrawn" },
      { op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "withdrawn",
        children: [{ skuCode: "ARTICLE", expectedState: "withdrawn" }] },
    ] : [{ op: "set_eligibility", skuCode: "ARTICLE", sellableStandalone: false, sellableInSubscription: false }]);
    const memberships = [{ offerVersion: "example:admitted@1", admitted: true }, { offerVersion: "example:excluded@1", admitted: false }];
    Object.assign(value.skus[0]!, { sellableStandalone: true, memberships });
    expect(compileCatalogPublication(value).skus[0]!.memberships).toEqual(memberships);
  },
);
it.each(["release", "compensation"] as const)("LC5-D-038 governed no-op as %s", kind => {
  const value = revision([{ op: "set_eligibility", skuCode: "ARTICLE", sellableStandalone: false, sellableInSubscription: false }]);
  value.payload.publication.kind = kind;
  if (kind === "release") expect(() => compileCatalogPublication(value)).toThrow("catalog_publication_v3_compile_change_noop");
  else expect(compileCatalogPublication(value)).toMatchObject({ changed: false });
});

it.each(["x", "ż"] as const)("LC5-D-092 v4 draft UTF-8 boundary with %s", char => {
  const { payload } = governed();
  const document = { padding: "" };
  payload.product.sharedContent.document = document;
  payload.publication.operations.push({ op: "set_product_lifecycle", productSlug: "article", expectedState: "draft", state: "active", children: [] });
  const baseline = Buffer.byteLength(JSON.stringify(payload));
  document.padding = char.repeat(Math.floor((1_048_576 - baseline) / Buffer.byteLength(char)));
  expect(catalogDraftPayloadV4Schema.safeParse(payload).success).toBe(true);
  document.padding += char;
  expect(catalogDraftPayloadV4Schema.safeParse(payload)).toMatchObject({ success: false });
});
