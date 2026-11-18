import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { assertCatalogPublicationGrossMass, assertCatalogPublicationPreparation, compileCatalogPublication, publicationJson } from "../../src/catalog/publicationValidation.js";
import { canonicalCatalogDraftJson } from "../../src/catalog/contracts/draft.js";

import { input, definition, rules } from "./fixtures/publicationInput.js";
it("W32_V5-0597_predicate_precedence_boundary", () => {
  const data = input();
  data.payload.publication.operations.splice(1, 0, { op: "set_product_status", productSlug: "article", status: "active" });
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_product_incomplete");
  data.payload.publication.operations.splice(1, 1);
  data.payload.publication.operations.push({ op: "set_product_status", productSlug: "article", status: "active" });
  expect(compileCatalogPublication(data).product.status).toBe("active");
});
it("W35_V5-0448_predicate_precedence_boundary", () => {
  const data = input();
  for (const identifiers of [[], [{ scheme: "gs1:gtin", issuer: "example", value: "5901234123458", packagingLevel: "unit" as const }],
    [{ scheme: "gs1:gtin", issuer: "example", value: "5901234123457", packagingLevel: "case" as const, quantity: 2 }]]) {
    data.payload.skus[0].identifiers = identifiers;
    expect(() => assertCatalogPublicationPreparation(data.payload)).toThrow("unit_trade_identifier_missing");
    expect(() => compileCatalogPublication(data)).toThrow("unit_trade_identifier_missing");
  }
});
it.each(["W50_V6-N001_predicate_precedence_boundary", "W50_V6-N002_predicate_precedence_boundary"])("%s", () => {
  const data = input();
  for (const slug of ["a", "0", "z0_a-b", "a".repeat(64)]) { data.payload.product.slug = slug; expect(() => assertCatalogPublicationPreparation(data.payload)).not.toThrow(); }
  for (const slug of [undefined, null, 4, {}, "", "a".repeat(65), "A", "_a", "-a", " a", "a ", "a\na", "ą", "a.b", "a/b"] as unknown[]) {
    Object.assign(data.payload.product, { slug });
    expect(() => assertCatalogPublicationPreparation(data.payload)).toThrow("commerce_product_slug_unsupported");
  }
});
it("W17_V5-1853_predicate_precedence_boundary", () => {
  const data = input();
  expect(compileCatalogPublication(data).skus[0].grossMass).toBeNull();
  expect(() => assertCatalogPublicationGrossMass(data.payload.skus[0].netContent!, null, definition)).toThrow("catalog_publication_gross_mass_required");
});
it.each(["W17_V5-1854_predicate_precedence_boundary", "W17_V5-1855_predicate_precedence_boundary"])("%s", () => {
  const net = input().payload.skus[0].netContent!;
  for (const gross of [{ ...net, dimension: "volume" as const }, { ...net, unscaled: "0" }, { ...net, scale: -1 }, { ...net, unit: "example:unknown" }])
    expect(() => assertCatalogPublicationGrossMass(net, gross, definition)).toThrow();
});
it("W17_V5-1856_predicate_precedence_boundary", () => {
  const net = { dimension: "mass" as const, unit: "openlup:g", unscaled: "9007199254740993", scale: 9 };
  for (const [unscaled, accepts] of [["9007199254740992", false], ["9007199254740993", true], ["9007199254740994", true]] as const) {
    const compare = () => assertCatalogPublicationGrossMass(net, { ...net, unscaled }, definition);
    if (accepts) expect(compare).not.toThrow(); else expect(compare).toThrow("catalog_publication_gross_below_net");
  }
  expect(() => assertCatalogPublicationGrossMass({ ...net, unscaled: "100", scale: 0 },
    { ...net, unit: "openlup:kg", unscaled: "1", scale: 1 }, definition)).not.toThrow();
});
it("W25_V5-0602_predicate_precedence_boundary", () => {
  const data = input(), first = compileCatalogPublication(data);
  data.product = first.product; data.skus = first.skus; data.documents = first.documents;
  data.payload.product.sharedContent.catalogAction = "revise";
  data.payload.publication.operations = [{ op: "set_derived_sku_facts", skuCode: "ARTICLE", documentRevisionNo: 1, netContent: first.skus[0].netContent, facts: first.skus[0].facts }];
  data.payload.publication.kind = "compensation";
  data.payload.skus[0].grossMass = { dimension: "mass", unit: "openlup:g", unscaled: "200", scale: 0 };
  for (const classification of ["material", "inconclusive"] as const) {
    data.rules = { ...rules, classifySkuChange: () => classification };
    expect(() => compileCatalogPublication(data)).toThrow("sku_identity_change_requires_new_sku");
  }
  data.rules = rules;
  expect(compileCatalogPublication(data).skus[0]).toEqual({ ...first.skus[0], grossMass: data.payload.skus[0].grossMass });
});
it("rejects an omitted sibling whose derived facts no longer match the document", () => {
  const data = input(), first = compileCatalogPublication(data);
  data.product = first.product; data.skus = first.skus; data.documents = first.documents;
  data.payload.product.sharedContent.catalogAction = "revise"; data.payload.publication.kind = "compensation";
  data.payload.skus = []; delete data.payload.product.primarySkuId;
  data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
  data.rules = { ...rules, deriveSkuFacts: () => ({ derived: 13 }) };
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_derived_facts_mismatch");
});
it("retains canonical draft limits while allowing publication facts above one MiB", () => {
  const data = { value: "é".repeat(530_000) };
  expect(() => canonicalCatalogDraftJson(data)).toThrow();
  expect(Buffer.byteLength(publicationJson(data))).toBeGreaterThan(1_048_576);
  expect(() => publicationJson(data, 1_048_576)).toThrow("catalog_publication_envelope_too_large");
});
it.each([
  ["MC5-D-043 fractional gross", { dimension: "mass", unit: "openlup:g", unscaled: "1005", scale: 1 }, true],
  ["MC5-D-043 short gross", { dimension: "mass", unit: "openlup:g", unscaled: "9999", scale: 2 }, false],
  ["MC5-D-043 non-mass gross", { dimension: "count", unit: "openlup:piece", unscaled: "100", scale: 0 }, false],
] as const)("catalog_publish_typed_readiness_and_projection %s", (_name, grossMass, ready) => {
  const data = input();
  data.payload.skus[0]!.grossMass = grossMass;
  if (ready) expect(compileCatalogPublication(data).skus[0]?.grossMass).toEqual(grossMass);
  else expect(() => compileCatalogPublication(data)).toThrow(grossMass.dimension === "mass"
    ? "catalog_publication_gross_below_net" : "catalog_publication_gross_mass_invalid");
});

it("classifies published physical identity with both immutable document contexts", () => {
  const data = input(), first = compileCatalogPublication(data);
  data.product = first.product; data.skus = first.skus; data.documents = first.documents;
  data.payload.product.sharedContent.catalogAction = "revise";
  const document = { ...data.payload.product.sharedContent.document, specification: "Changed physical material" };
  const canonicalText = canonicalCatalogDraftJson(document), digest = createHash("sha256").update(canonicalText).digest("hex");
  const reference = { ...data.payload.product.documentRevision!, id: "40000000-0000-4000-8000-000000000002", revisionNo: 2, digest };
  data.payload.product.documentRevision = reference; data.payload.product.sharedContent.document = document;
  data.payload.publication.operations = [
    { op: "register_document_revision", productSlug: "article", revisionId: reference.id, revisionNo: 2, documentRef: reference.documentRef, sourceRef: reference.sourceRef, canonicalText, digest, provenance: { source: "current_draft" } },
    { op: "move_document_pointer", productSlug: "article", documentRevisionNo: 2 },
  ];
  let classified = false;
  data.rules = { ...rules, classifySkuChange: (before, after, context) => {
    classified = true; expect(before).toEqual(first.skus[0]); expect(after.facts).toEqual(before.facts);
    expect(context.beforeDocument).toEqual(first.documents[0]); expect(context.afterDocument.reference).toEqual(reference);
    return "material";
  } };
  expect(() => compileCatalogPublication(data)).toThrow("sku_identity_change_requires_new_sku"); expect(classified).toBe(true);
});
