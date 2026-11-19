import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { assertCatalogPublicationGrossMass, assertCatalogPublicationPreparation, compileCatalogPublication, compileCatalogPublicationDraft, publicationJson,
  catalogPublicationIntegralGrams, assertCatalogPublicationMassInputs } from "../../src/catalog/publicationValidation.js";
import { catalogDraftPayloadV3Schema } from "../../src/catalog/draftV3Schemas.js";
import { canonicalCatalogDraftJson } from "../../src/catalog/contracts/draft.js";

import { createPostgresCatalogPublication } from "../../src/catalog/publicationStore.js";
import { CATALOG_PUBLICATION_LIMITS } from "../../src/catalog/contracts/publication.js";
import { input, definition, registry, rules } from "./fixtures/publicationInput.js";
it("W32_V5-0597_predicate_precedence_boundary", () => {
  const data = input();
  data.payload.publication.operations.splice(1, 0, { op: "set_product_status", productSlug: "article", status: "active" });
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_product_incomplete");
  data.payload.publication.operations.splice(1, 1);
  data.payload.publication.operations.push({ op: "set_product_status", productSlug: "article", status: "active" });
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_active_primary_required");
  const staged = compileCatalogPublication(input());
  data.product = staged.product; data.skus = staged.skus; data.documents = staged.documents;
  data.payload.product.sharedContent.catalogAction = "revise";
  data.payload.publication.operations = [{ op: "set_product_status", productSlug: "article", status: "active" }];
  data.payload.skus[0].grossMass = data.payload.skus[0].netContent;
  data.payload.skus[0].logisticsRef = "example:logistics";
  data.payload.product.sharedContent.requestedModes = [{ skuCode: "ARTICLE", modes: ["one_time"] }];
  data.payload.product.sharedContent.offerMemberships = [{ skuCode: "ARTICLE", offerVersion: "example:offer", admitted: true }];
  data.payload.publication.operations.splice(data.payload.publication.operations.length - 1, 0,
    { op: "set_sku_metadata", skuCode: "ARTICLE", logisticsRef: "example:logistics" },
    { op: "set_offer_membership", skuCode: "ARTICLE", offerVersion: "example:offer", admitted: true },
    { op: "set_eligibility", skuCode: "ARTICLE", sellableStandalone: true, sellableInSubscription: false },
    { op: "set_sku_status", skuCode: "ARTICLE", status: "active" });
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
  data.payload.skus = []; delete data.payload.product.primarySkuId; Object.assign(data.payload.product.sharedContent, { publicationSkus: [], requestedModes: [], offerMemberships: [] });
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
  ["net", "fractional", "15", 1], ["net", "zero", "0", 0], ["net", "negative", "-1", 0], ["net", "out_of_range", "2147483648", 0],
] as const)("catalog_publication_refuses_%s_%s_mass", (kind, _case, unscaled, scale) => {
  const quantity = { dimension: "mass" as const, unit: "openlup:g", unscaled, scale };
  expect(() => catalogPublicationIntegralGrams(quantity, definition)).toThrow("catalog_publication_integral_grams_required");
  const data = input(); data.payload.skus[0][kind === "net" ? "netContent" : "grossMass"] = quantity;
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_integral_grams_required");
});
it("catalog_publication_preserves_integer_grams_at_native_boundaries", () => {
  for (const [kind, value] of [["net", "1"], ["net", "2147483647"]] as const)
    expect(catalogPublicationIntegralGrams({ dimension: "mass", unit: "openlup:g", unscaled: value, scale: 0 }, definition)).toBe(value);
  expect(catalogPublicationIntegralGrams({ dimension: "mass", unit: "openlup:kg", unscaled: "1", scale: 3 }, definition)).toBe("1");
});

it("classifies published physical identity with both immutable document contexts", () => {
  const data = input(), first = compileCatalogPublication(data);
  data.product = first.product; data.skus = first.skus; data.documents = first.documents;
  data.payload.product.sharedContent.catalogAction = "revise";
  const document = { ...data.payload.product.sharedContent.document, revisionNo: 2, specification: "Changed physical material" };
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

it.each([["draft", false, false], ["draft", true, false], ["active", false, false], ["active", true, false], ["active", false, true]] as const)(
  "cycle1 active primary %s/%s/%s", (status, standalone, subscription) => {
    const data = input(), retained = compileCatalogPublication(data), sku = retained.skus[0];
    sku.status = status; sku.sellableStandalone = standalone; sku.sellableInSubscription = subscription;
    sku.grossMass = sku.netContent; sku.logisticsRef = "example:logistics"; sku.memberships = [{ offerVersion: "example:offer", admitted: true }];
    data.product = retained.product; data.skus = retained.skus; data.documents = retained.documents;
    data.payload.product.sharedContent.catalogAction = "revise";
    data.payload.publication.operations = [{ op: "set_product_status", productSlug: "article", status: "active" }];
    if (status === "active" && (standalone || subscription)) expect(compileCatalogPublication(data).product.status).toBe("active");
    else expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_active_primary_required");
  });
it("cycle1 gross scaled mass is represented without rounding", () => {
  const data = input(); data.payload.skus[0].grossMass = { dimension: "mass", unit: "openlup:g", unscaled: "1005", scale: 1 };
  expect(compileCatalogPublication(data).skus[0].grossMass).toEqual(data.payload.skus[0].grossMass);
});
it("cycle1 duplicate physical draft combinations refuse", () => {
  const data = input(), sku = structuredClone(data.payload.skus[0]);
  sku.id = "20000000-0000-4000-8000-000000000002"; sku.code = "SECOND";
  sku.identifiers = [{ scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "unit" }];
  data.payload.skus.push(sku);
  const facts = { ...data.payload.product.sharedContent.publicationSkus[0], skuCode: "SECOND" };
  data.payload.product.sharedContent.publicationSkus.push(facts);
  data.payload.publication.operations.push({ op: "create_sku", skuId: sku.id, productSlug: "article", documentRevisionNo: 1, ...facts },
    { op: "create_identifier", skuCode: "SECOND", scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null });
  expect(() => compileCatalogPublication(data)).toThrow("duplicate_combination");
});

it("cycle1 declared custom mass conversion preserves exact native grams", () => {
  const custom = { ...definition, netContentUnits: [...definition.netContentUnits, "example:half-gram"], units: [...definition.units, { code: "example:half-gram", dimension: "mass" as const, integral: false,
    factor: { canonicalUnit: "openlup:g" as const, unscaled: "5", scale: 1 } }] };
  const quantity = { dimension: "mass" as const, unit: "example:half-gram", unscaled: "200", scale: 0 };
  expect(catalogPublicationIntegralGrams(quantity, custom)).toBe("100");
  expect(() => catalogPublicationIntegralGrams({ ...quantity, unscaled: "201" }, custom)).toThrow("catalog_publication_integral_grams_required");
});
it("cycle1 nonmass quantities never acquire an integer gram projection", () => {
  const mixed = { ...definition, netContentUnits: [...definition.netContentUnits, "openlup:ml", "openlup:piece"], units: [...definition.units,
    { code: "openlup:ml", dimension: "volume" as const, integral: false, factor: { canonicalUnit: "openlup:ml" as const, unscaled: "1", scale: 0 } },
    { code: "openlup:piece", dimension: "count" as const, integral: true, factor: { canonicalUnit: "openlup:piece" as const, unscaled: "1", scale: 0 } }] };
  for (const [dimension,unit] of [["volume","openlup:ml"],["count","openlup:piece"]] as const)
    expect(() => catalogPublicationIntegralGrams({ dimension, unit, unscaled: "100", scale: 0 }, mixed)).toThrow("catalog_publication_integral_grams_required");
});
it("cycle1 quantity precheck delegates absent and malformed shapes to strict decoding", () => {
  for (const value of [undefined, null, 17, true, "mass", {}, []]) {
    const data = input(); if (value === undefined) delete data.payload.skus[0].netContent;
    else Object.assign(data.payload.skus[0], { netContent: value });
    expect(() => assertCatalogPublicationMassInputs(data.payload, definition)).not.toThrow();
    expect(catalogDraftPayloadV3Schema.safeParse(data.payload).success).toBe(value === undefined);
    if (value === undefined) expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_mass_required_until_mc5");
    else expect(() => compileCatalogPublication(data)).toThrow();
  }
});

it.each(["record product", "record version", "product id", "product slug"])("cycle1 compiler independently refuses %s identity mismatch", kind => {
  const data = input();
  if (kind === "record product") data.record.productId = "10000000-0000-4000-8000-000000000002";
  else if (kind === "record version") data.record = { ...data.record, payload: { ...data.payload, schemaVersion: 2 } } as unknown as typeof data.record;
  else {
    const first = compileCatalogPublication(data);
    data.product = first.product; data.skus = first.skus; data.documents = first.documents;
    data.payload.product.sharedContent.catalogAction = "revise"; data.payload.publication.kind = "compensation";
    data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
    if (kind === "product id") data.product.id = "10000000-0000-4000-8000-000000000002";
    else data.product.slug = "other";
  }
  expect(() => compileCatalogPublication(data)).toThrow(kind.startsWith("record") ? "catalog_publication_source_invalid" : "catalog_publication_product_identity_conflict");
});

it("cycle1 a numeric foreign identifier never substitutes for an authored unit GTIN", () => {
  const data = input(); data.payload.skus[0].identifiers![0].scheme = "example:identifier";
  const identifier = data.payload.publication.operations.find(operation => operation.op === "create_identifier")!;
  if (identifier.op !== "create_identifier") throw new Error("Missing identifier fixture");
  identifier.scheme = "example:identifier"; identifier.isPrimary = false;
  expect(() => assertCatalogPublicationPreparation(data.payload)).toThrow("unit_trade_identifier_missing");
  expect(() => compileCatalogPublication(data)).toThrow("unit_trade_identifier_missing");
});
it("cycle1 nonmass publication keeps its named refusal before numeric gram checks", () => {
  for (const [dimension, unit] of [["volume", "openlup:ml"], ["count", "openlup:piece"]] as const) {
    const data = input();
    data.definition = { ...definition, netContentUnits: [unit], units: [{ code: unit, dimension, integral: dimension === "count",
      factor: { canonicalUnit: unit, unscaled: "1", scale: 0 } }] };
    data.payload.skus[0].netContent = { dimension, unit, unscaled: "100", scale: 0 };
    expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_mass_required_until_mc5");
  }
});

it("cycle1 gross comparison converts declared custom mass units exactly", () => {
  const custom = { ...definition, units: [...definition.units, { code: "example:half-gram", dimension: "mass" as const, integral: false,
    factor: { canonicalUnit: "openlup:g" as const, unscaled: "5", scale: 1 } }] };
  const net = { dimension: "mass" as const, unit: "openlup:g", unscaled: "100", scale: 0 };
  const gross = { ...net, unit: "example:half-gram", unscaled: "200" };
  expect(() => assertCatalogPublicationGrossMass(net, gross, custom)).not.toThrow();
  expect(() => assertCatalogPublicationGrossMass(net, { ...gross, unscaled: "201" }, custom)).not.toThrow();
  expect(() => assertCatalogPublicationGrossMass(net, { ...gross, unscaled: "199" }, custom)).toThrow("catalog_publication_gross_below_net");
});

it("cycle1 compiler checks record product version and retained product identity independently", () => {
  const foreign = "10000000-0000-4000-8000-000000000002";
  const wrongProduct = input(); wrongProduct.record.productId = foreign;
  expect(() => compileCatalogPublication(wrongProduct)).toThrow("catalog_publication_source_invalid");
  const oldVersion = input(); Object.assign(oldVersion.record, { payload: { ...oldVersion.payload, schemaVersion: 2 } });
  expect(() => compileCatalogPublication(oldVersion)).toThrow("catalog_publication_source_invalid");
  for (const field of ["id", "slug", "type"] as const) {
    const data = input(), retained = compileCatalogPublication(data);
    data.product = retained.product; data.skus = retained.skus; data.documents = retained.documents;
    data.payload.product.sharedContent.catalogAction = "revise"; data.payload.publication.kind = "compensation";
    data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
    if (field === "id") data.product.id = foreign;
    if (field === "slug") data.product.slug = "other";
    if (field === "type") data.product.type = { ...data.product.type, version: 2 };
    expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_product_identity_conflict");
  }
});

function retainedPublicationInput() {
  const data = input();
  data.definition = { ...definition, units: definition.units.map(unit => ({ ...unit, factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 0 } })),
    dimensions: [{ key: "pack_size", kind: "quantity", dimension: "mass", units: ["openlup:g"] }], axes: [{ key: "pack_size", attributeKey: "pack_size" }],
    attributes: [{ key: "pack_size", scope: "variant", valueType: { kind: "quantity", dimension: "mass", units: ["openlup:g"] }, required: false,
      cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} }] };
  data.payload.product.dimensions = ["pack_size"];
  data.payload.skus[0].options = { pack_size: { kind: "quantity", value: data.payload.skus[0].netContent! } };
  const first = compileCatalogPublication(data);
  data.product = first.product; data.skus = first.skus; data.documents = first.documents;
  data.payload.product.sharedContent.catalogAction = "revise";
  return data;
}
it("cycle1 retained GS1 identities conflict while foreign numeric identifiers remain distinct", () => {
  for (const scheme of ["gs1:gtin", "example:identifier"]) {
    const data = retainedPublicationInput();
    data.skus[0].identifiers[0].scheme = scheme; data.skus[0].identifiers[0].isPrimary = scheme === "gs1:gtin";
    const sku = data.payload.skus[0]; sku.id = "20000000-0000-4000-8000-000000000002"; sku.code = "SECOND";
    sku.netContent = { ...sku.netContent!, unscaled: "101" }; sku.options = { pack_size: { kind: "quantity", value: sku.netContent } };
    delete data.payload.product.primarySkuId;
    const facts = { ...data.payload.product.sharedContent.publicationSkus[0], skuCode: sku.code };
    data.payload.product.sharedContent.publicationSkus = [facts];
    data.payload.product.sharedContent.requestedModes = [{ skuCode: sku.code, modes: [] }];
    data.payload.publication.operations = [
      { op: "create_sku", productSlug: "article", skuId: sku.id, documentRevisionNo: 1, ...facts },
      { op: "create_identifier", skuCode: sku.code, scheme: "gs1:gtin", issuer: "example", value: "5901234123457", packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null },
    ];
    if (scheme === "gs1:gtin") expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_identifier_conflict");
    else expect(compileCatalogPublication(data).skus).toHaveLength(2);
  }
});
it("cycle1 retained source must belong to the publication product", () => {
  const data = retainedPublicationInput(), foreign = structuredClone(data.record);
  foreign.draftId = "30000000-0000-4000-8000-000000000002";
  foreign.productId = "10000000-0000-4000-8000-000000000002";
  foreign.payload.product.id = foreign.productId;
  foreign.payload.skus[0].productId = foreign.productId;
  data.skus[0].source = { draftId: foreign.draftId, revision: foreign.revision, commandKey: foreign.commandKey, fingerprint: foreign.fingerprint };
  data.retainedSources = [foreign]; data.payload.skus = []; delete data.payload.product.primarySkuId; Object.assign(data.payload.product.sharedContent, { publicationSkus: [], requestedModes: [], offerMemberships: [] });
  data.payload.publication.operations = [{ op: "set_eligibility", skuCode: "ARTICLE", sellableStandalone: false, sellableInSubscription: false }];
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_operation_source_missing");
});

it.each(["declared", "retained", "current draft id", "current revision", "v2 exclusion", "absent SKU", "ambiguous"])(
  "cycle1 operation source selection preserves %s precedence", kind => {
    const data = retainedPublicationInput();
    data.product!.status = "active"; data.skus[0].status = "active";
    const claim = (record: typeof data.record) => ({ draftId: record.draftId, revision: record.revision, commandKey: record.commandKey, fingerprint: record.fingerprint });
    const older = { ...structuredClone(data.record), payload: structuredClone(data.payload) }, selected = { ...structuredClone(data.record), payload: structuredClone(data.payload) };
    older.draftId = "30000000-0000-4000-8000-000000000002"; older.revision = kind === "current draft id" ? 3 : 1;
    selected.draftId = kind === "current revision" ? older.draftId : "30000000-0000-4000-8000-000000000003"; selected.revision = 2;
    selected.fingerprint = "c".repeat(64);
    selected.payload.product.sharedContent.requestedModes = [{ skuCode: "ARTICLE", modes: ["one_time"] }];
    data.record = { ...data.record, draftId: kind === "current revision" ? older.draftId : data.record.draftId, revision: 3 };
    data.payload.skus = []; delete data.payload.product.primarySkuId; Object.assign(data.payload.product.sharedContent, { publicationSkus: [], requestedModes: [], offerMemberships: [] });
    data.skus[0].grossMass = data.skus[0].netContent; data.skus[0].logisticsRef = "example:logistics";
    data.skus[0].memberships = [{ offerVersion: "example:offer", admitted: true }];
    data.skus[0].source = claim(selected);
    data.retainedSources = [older, selected];
    data.payload.publication.evidence.drafts = kind === "retained" ? [] : [claim(selected)];
    if (kind === "retained") delete data.payload.publication.evidence.drafts;
    if (kind === "v2 exclusion") {
      Object.assign(older.payload, { schemaVersion: 2 }); Reflect.deleteProperty(older.payload, "publication");
      data.payload.publication.evidence.drafts!.unshift(claim(older));
    }
    if (kind === "ambiguous") data.payload.publication.evidence.drafts!.unshift(claim(older));
    if (kind === "absent SKU") data.retainedSources = [];
    data.payload.publication.operations = [{ op: "set_eligibility", skuCode: "ARTICLE", sellableStandalone: true, sellableInSubscription: false }];
    if (kind === "absent SKU" || kind === "retained") expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_operation_source_missing");
    else if (kind === "ambiguous") expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_operation_source_ambiguous");
    else expect(compileCatalogPublication(data).skus[0].sellableStandalone).toBe(true);
  });

it("cycle1 create_product never overwrites a retained product", () => {
  const data = retainedPublicationInput();
  data.payload.publication.operations = [{ op: "create_product", productId: data.payload.product.id, productSlug: "article", name: "Replacement" }];
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_product_conflict");
});
it.each(["draftId", "draftRevision", "draftCommandKey", "draftFingerprint"] as const)(
  "cycle1 document provenance independently binds %s", field => {
    const data = input(), operation = data.payload.publication.operations.find(operation => operation.op === "register_document_revision")!;
    if (operation.op !== "register_document_revision") throw new Error("Missing document fixture");
    const provenance = { source: "retained_draft" as const, draftId: data.record.draftId, draftRevision: data.record.revision,
      draftCommandKey: data.record.commandKey, draftFingerprint: data.record.fingerprint };
    if (field === "draftId") provenance.draftId = "30000000-0000-4000-8000-000000000002";
    if (field === "draftRevision") provenance.draftRevision = 2;
    if (field === "draftCommandKey") provenance.draftCommandKey = "draft:other";
    if (field === "draftFingerprint") provenance.draftFingerprint = "c".repeat(64);
    operation.provenance = provenance;
    data.payload.publication.evidence.drafts = [{ draftId: provenance.draftId, revision: provenance.draftRevision, commandKey: provenance.draftCommandKey, fingerprint: provenance.draftFingerprint }];
    expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_document_source_missing");
  });
it.each(["revisionId", "revisionNo", "documentRef", "sourceRef", "digest"] as const)(
  "cycle1 document operation independently binds authored %s", field => {
    const data = input(), reference = data.payload.product.documentRevision!;
    if (field === "revisionId") reference.id = "40000000-0000-4000-8000-000000000002";
    if (field === "revisionNo") reference.revisionNo = 2;
    if (field === "documentRef") reference.documentRef = "example:other-document";
    if (field === "sourceRef") reference.sourceRef = "example:other-source";
    if (field === "digest") reference.digest = "c".repeat(64);
    expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_document_source_mismatch");
  });

it("cycle1 document source parent is checked before its document tuple", () => {
  const data = input(), foreign = { ...structuredClone(data.record), payload: structuredClone(data.payload) };
  foreign.draftId = "30000000-0000-4000-8000-000000000002"; foreign.productId = "10000000-0000-4000-8000-000000000002";
  foreign.payload.product.id = foreign.productId; foreign.payload.skus[0].productId = foreign.productId;
  foreign.payload.product.documentRevision!.productId = foreign.productId;
  data.retainedSources = [foreign];
  const operation = data.payload.publication.operations.find(operation => operation.op === "register_document_revision")!;
  if (operation.op !== "register_document_revision") throw new Error("Missing document fixture");
  operation.provenance = { source: "retained_draft", draftId: foreign.draftId, draftRevision: foreign.revision,
    draftCommandKey: foreign.commandKey, draftFingerprint: foreign.fingerprint };
  data.payload.publication.evidence.drafts = [{ draftId: foreign.draftId, revision: foreign.revision, commandKey: foreign.commandKey, fingerprint: foreign.fingerprint }];
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_document_source_missing");
});
it.each([["malformed and revoked", "", false], ["valid and revoked", "operator:key", true]] as const)(
  "publication checks command syntax before live membership: %s", async (_name, commandKey, checkMembership) => {
    const data = input(), statements: string[] = [];
    const target = createPostgresCatalogPublication({
      registry, rules, readiness: async () => ({ ready: true, reasons: [] }), verifyMedia: async () => false,
      authorizeHuman: async () => ({ ok: true, role: "admin", isMachineActor: false, userId: data.record.draftId }),
      transactions: { run: work => work({ async query(sql) { statements.push(sql); return { rows: [{ allowed: false }] }; } }) },
    });
    const capability = (await target.authorize(null))!;
    const result = await target.publish({ productId: data.record.productId, commandKey, candidateRef: `v1:${data.record.draftId}@1/unpublished`,
      candidateDigest: "a".repeat(64), expectedHead: null, changes: [] }, capability);
    expect(result).toEqual(checkMembership ? { outcome: "unauthorized", reason: "publisher_not_authorized" }
      : { outcome: "validation_issue", reason: "catalog_publication_command_invalid" });
    expect(statements.some(sql => sql.includes("platform_human_membership_is_administrator"))).toBe(checkMembership);
  });

it.each([
  ["wrong digest before invalid JSON", "catalog_publication_v3_document_digest_mismatch"],
  ["correct digest with invalid JSON", "catalog_publication_v3_document_invalid"],
  ["valid schema with noncanonical encoding", "catalog_publication_v3_document_not_canonical"],
  ["different schema with noncanonical encoding", "catalog_publication_v3_document_invalid"],
] as const)("publication document admission reports %s", (mode, reason) => {
  const data = input(), operation = data.payload.publication.operations.find(operation => operation.op === "register_document_revision");
  if (!operation) throw new Error("Missing document operation");
  if (mode.startsWith("different")) data.payload.product.documentRevision!.schemaId = "example:document.v2";
  operation.canonicalText = mode.includes("noncanonical") ? ` ${operation.canonicalText}` : "{ invalid json";
  if (!mode.startsWith("wrong")) {
    const digest = createHash("sha256").update(operation.canonicalText).digest("hex");
    operation.digest = digest;
    data.payload.product.documentRevision!.digest = digest;
  }
  expect(() => compileCatalogPublication(data)).toThrow(reason);
});

it.each(["absent reference", "wrong digest", "different authored document"])("cycle1 document verification preserves %s refusal", kind => {
  const data = input(), operation = data.payload.publication.operations.find(operation => operation.op === "register_document_revision")!;
  if (operation.op !== "register_document_revision") throw new Error("Missing document fixture");
  if (kind === "absent reference") delete data.payload.product.documentRevision;
  if (kind === "wrong digest") { data.payload.product.documentRevision!.digest = "c".repeat(64); operation.digest = "c".repeat(64); }
  if (kind === "different authored document") data.payload.product.sharedContent.document = { ...data.payload.product.sharedContent.document, derived: 13 };
  expect(() => compileCatalogPublication(data)).toThrow(kind === "absent reference" ? "document_reference_missing"
    : kind === "wrong digest" ? "catalog_publication_v3_document_digest_mismatch" : "catalog_publication_v3_document_invalid");
});

it("cycle1 pointer source mismatch precedes the next operation refusal", () => {
  const data = retainedPublicationInput();
  data.payload.product.documentRevision = { ...data.payload.product.documentRevision!, id: "40000000-0000-4000-8000-000000000002", revisionNo: 2 };
  data.payload.publication.operations = [{ op: "move_document_pointer", productSlug: "article", documentRevisionNo: 1 },
    { op: "set_primary_sku", productSlug: "article", skuCode: "MISSING" }];
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_document_source_mismatch");
});
it.each(["code", "id"])("cycle1 create_sku independently refuses a retained %s collision", kind => {
  const data = retainedPublicationInput(), sku = data.payload.skus[0];
  if (kind === "code") sku.id = "20000000-0000-4000-8000-000000000002";
  else { sku.code = "SECOND"; sku.netContent = { ...sku.netContent!, unscaled: "101" }; sku.options = { pack_size: { kind: "quantity", value: sku.netContent } }; }
  delete data.payload.product.primarySkuId;
  const facts = { ...data.payload.product.sharedContent.publicationSkus[0], skuCode: sku.code };
  data.payload.product.sharedContent.publicationSkus = [facts]; data.payload.product.sharedContent.requestedModes = [{ skuCode: sku.code, modes: [] }];
  data.payload.publication.operations = [{ op: "create_sku", productSlug: "article", documentRevisionNo: 1, skuId: sku.id, ...facts }];
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_sku_conflict");
});
it.each(["SKU id", "authored facts"])("cycle1 create_sku requires matching %s before later prefix guards", kind => {
  const data = input(), operation = data.payload.publication.operations.find(operation => operation.op === "create_sku")!;
  if (operation.op !== "create_sku") throw new Error("Missing SKU fixture");
  if (kind === "SKU id") operation.skuId = "20000000-0000-4000-8000-000000000002";
  else data.payload.product.sharedContent.publicationSkus = [];
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_operation_source_mismatch");
});

it.each(["scheme", "issuer", "value", "packagingLevel", "quantity"] as const)("cycle1 identifier source independently binds %s", field => {
  const data = input(), operation = data.payload.publication.operations.find(operation => operation.op === "create_identifier")!;
  if (operation.op !== "create_identifier") throw new Error("Missing identifier fixture");
  if (field === "scheme") { operation.scheme = "example:identifier"; operation.isPrimary = false; }
  if (field === "issuer") operation.issuer = "example:other";
  if (field === "value") operation.value = "4006381333931";
  if (field === "packagingLevel") {
    data.payload.skus[0].identifiers![0].packagingLevel = "case";
    data.payload.skus[0].identifiers!.push({ scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "unit" });
  }
  if (field === "quantity") {
    data.payload.skus[0].identifiers!.push({ scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "case", quantity: 3 });
    operation.value = "4006381333931"; operation.packagingLevel = "case"; operation.quantity = 2; operation.isPrimary = false;
  }
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_identifier_source_mismatch");
});
it("cycle1 the strict carrier rejects an invalid secondary GTIN before compilation", () => {
  const data = input(), identifier = { scheme: "gs1:gtin", issuer: "example", value: "5901234123458", packagingLevel: "unit" as const, quantity: 1 };
  data.payload.skus[0].identifiers!.push(identifier);
  data.payload.publication.operations.push({ op: "create_identifier", skuCode: "ARTICLE", ...identifier, isPrimary: false, label: null, sourceRef: null });
  expect(() => compileCatalogPublication(data)).toThrow("invalid GTIN");
});
it.each(["scheme", "packaging", "duplicate"])("cycle1 primary identifier independently refuses %s", kind => {
  const data = input(), original = data.payload.publication.operations.find(operation => operation.op === "create_identifier")!;
  if (original.op !== "create_identifier") throw new Error("Missing identifier fixture");
  original.isPrimary = kind === "duplicate";
  const identifier = { scheme: kind === "scheme" ? "example:identifier" : "gs1:gtin", issuer: "example", value: "4006381333931",
    packagingLevel: kind === "packaging" ? "case" as const : "unit" as const, quantity: kind === "packaging" ? 2 : 1 };
  data.payload.skus[0].identifiers!.push(identifier);
  data.payload.publication.operations.push({ op: "create_identifier", skuCode: "ARTICLE", ...identifier, isPrimary: true, label: null, sourceRef: null });
  expect(() => compileCatalogPublication(data)).toThrow(kind === "scheme" ? "catalog_publication_identifier_primary_invalid" : "second or non-unit primary identifier");
});
it("cycle1 identifier creation requires a SKU created by this operation list", () => {
  const data = retainedPublicationInput(), operation = input().payload.publication.operations.find(operation => operation.op === "create_identifier")!;
  data.payload.publication.operations = [operation];
  expect(() => compileCatalogPublication(data)).toThrow("identifier precedes or lacks SKU creation");
});

it("cycle1 the first primary identifier may follow a nonprimary identifier", () => {
  const data = input(), initial = data.payload.publication.operations.find(operation => operation.op === "create_identifier")!;
  if (initial.op !== "create_identifier") throw new Error("Missing identifier fixture"); initial.isPrimary = false;
  const identifier = { scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "unit" as const, quantity: 1 };
  data.payload.skus[0].identifiers!.push(identifier);
  data.payload.publication.operations.push({ op: "create_identifier", skuCode: "ARTICLE", ...identifier, isPrimary: true, label: null, sourceRef: null });
  expect(compileCatalogPublication(data).skus[0].identifiers.map(value => value.isPrimary)).toEqual([false, true]);
});
it("cycle1 the compiled primary must match the authored primary", () => {
  const data = input(), second = structuredClone(data.payload.skus[0]);
  second.id = "20000000-0000-4000-8000-000000000002"; second.code = "SECOND";
  second.identifiers = [{ scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "unit" }];
  data.payload.skus.push(second); data.payload.product.primarySkuId = second.id;
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_primary_foreign");
});
it("cycle1 a document does not permit activation before primary assignment", () => {
  const data = input();
  data.payload.publication.operations.splice(3, 0, { op: "set_product_status", productSlug: "article", status: "active" });
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_product_incomplete");
});

function publicationWithSecondary() {
  const data = retainedPublicationInput(), second = structuredClone(data.skus[0]);
  second.id = "20000000-0000-4000-8000-000000000002"; second.code = "SECOND";
  second.netContent = { ...second.netContent, unscaled: "101" }; second.options = { pack_size: { kind: "quantity", value: second.netContent } };
  second.identifiers[0].value = "4006381333931"; data.skus = [...data.skus, second];
  for (const sku of data.skus) { sku.grossMass = sku.netContent; sku.logisticsRef = "example:logistics"; sku.memberships = [{ offerVersion: "example:offer", admitted: true }]; }
  data.payload.skus = [{ ...data.payload.skus[0], id: second.id, code: second.code, netContent: second.netContent, options: second.options,
    grossMass: second.grossMass!, logisticsRef: second.logisticsRef!, identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "unit" }] }];
  delete data.payload.product.primarySkuId;
  data.payload.product.sharedContent.publicationSkus = [{ skuCode: second.code, title: second.title, minQuantity: second.minQuantity, isAddon: second.isAddon, facts: second.facts }];
  data.payload.product.sharedContent.requestedModes = [{ skuCode: second.code, modes: ["one_time"] }];
  data.payload.publication.operations = [];
  return data;
}
it.each([["colliding", "duplicate_combination"], ["distinct", "catalog_publication_v3_compile_sku_absent"]] as const)(
  "publication refuses %s SKU creation before a later primary operation", (mode, reason) => {
    const data = publicationWithSecondary(), draft = data.payload.skus[0], facts = data.payload.product.sharedContent.publicationSkus[0];
    data.skus.pop();
    if (mode === "colliding") { draft.netContent = data.skus[0].netContent; draft.options = data.skus[0].options; }
    data.payload.publication.operations = [
      { op: "create_sku", productSlug: "article", skuId: draft.id, documentRevisionNo: 1, ...facts },
      { op: "set_primary_sku", productSlug: "article", skuCode: "MISSING" },
    ];
    expect(() => compileCatalogPublication(data)).toThrow(reason);
  });

it.each(["duplicate code", "duplicate ID", "invalid facts", "invalid product", "authentic roster"] as const)(
  "publication compiler validates the complete retained roster: %s", mode => {
    const data = publicationWithSecondary(), [first, second] = data.skus;
    data.payload.publication.kind = "compensation";
    data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
    data.payload.skus = [];
    Object.assign(data.payload.product.sharedContent, { publicationSkus: [], requestedModes: [], offerMemberships: [] });
    if (mode === "duplicate code") { second.code = first.code; data.skus = [second, first]; }
    if (mode === "duplicate ID") second.id = first.id;
    if (mode === "invalid facts") Reflect.deleteProperty(second, "source");
    if (mode === "invalid product") data.product!.name = "";
    if (mode === "authentic roster") expect(compileCatalogPublication(data).skus.map(sku => sku.code)).toEqual([first.code, second.code]);
    else expect(() => compileCatalogPublication(data)).toThrow(mode === "invalid product" ? "catalog_publication_read_invalid" : "catalog_publication_sku_revision_invalid");
  });

it.each([
  ["retained GTIN", "catalog_publication_identifier_source_mismatch"],
  ["same padded GTIN", null],
  ["status without authored SKU", "catalog_publication_operation_source_missing"],
  ["eligibility without authored SKU", "catalog_publication_operation_source_missing"],
  ["membership without authored SKU", "catalog_publication_operation_source_missing"],
  ["metadata without authored SKU", "catalog_publication_operation_source_missing"],
  ["derived effect on new SKU", "catalog_publication_derived_source_mismatch"],
  ["omitted materialized derived effect", null],
  ["foreign owner on create", "catalog_publication_operation_source_mismatch"],
] as const)("publication binds each SKU effect to its applicable source: %s", (mode, reason) => {
  const creating = mode === "derived effect on new SKU";
  const data = creating ? input() : publicationWithSecondary();
  const sku = data.payload.skus[0];
  const code = sku.code!;
  if (mode === "retained GTIN" || mode === "same padded GTIN") {
    sku.identifiers![0].value = mode === "retained GTIN" ? "5901234123457" : "04006381333931";
    data.payload.publication.kind = "compensation";
    data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
  } else if (mode === "foreign owner on create") {
    data.skus.pop();
    const prior = structuredClone(data.record);
    prior.payload.skus[0].productId = "10000000-0000-4000-8000-000000000078";
    const { draftId, revision, commandKey, fingerprint } = prior;
    data.retainedSources = [prior];
    data.record = { ...data.record, revision: 2, commandKey: "draft:second" };
    const content = data.payload.product.sharedContent;
    const [facts] = content.publicationSkus;
    data.payload.skus = [];
    Object.assign(content, { publicationSkus: [], requestedModes: [], offerMemberships: [] });
    data.payload.publication.evidence.drafts = [{ draftId, revision, commandKey, fingerprint }];
    data.payload.publication.operations = [{ op: "create_sku", productSlug: "article", skuId: sku.id, documentRevisionNo: 1, ...facts }];
  } else {
    const derived = { op: "set_derived_sku_facts" as const, skuCode: code, documentRevisionNo: 1, netContent: sku.netContent!, facts: { derived: 12 } };
    if (creating) data.payload.publication.operations.push(derived);
    else {
      const content = data.payload.product.sharedContent;
      content.requestedModes = [{ skuCode: code, modes: [] }];
      content.offerMemberships = [{ skuCode: code, offerVersion: "example:offer", admitted: true }];
      const prior = structuredClone(data.record);
      data.retainedSources = [prior];
      data.record = { ...data.record, revision: 2, commandKey: "draft:second" };
      data.payload.skus = [];
      Object.assign(content, { publicationSkus: [], requestedModes: [], offerMemberships: [] });
      data.payload.publication.kind = "compensation";
      data.payload.publication.operations = mode.startsWith("status") ? [{ op: "set_sku_status", skuCode: code, status: "archived" }]
        : mode.startsWith("eligibility") ? [{ op: "set_eligibility", skuCode: code, sellableStandalone: false, sellableInSubscription: false }]
        : mode.startsWith("membership") ? [{ op: "set_offer_membership", skuCode: code, offerVersion: "example:offer", admitted: true }]
        : mode.startsWith("metadata") ? [{ op: "set_sku_metadata", skuCode: code, logisticsRef: "example:logistics" }] : [derived];
    }
  }
  if (reason) expect(() => compileCatalogPublication(data)).toThrow(reason);
  else expect(compileCatalogPublication(data).skus.find(row => row.code === code)?.facts).toEqual({ derived: 12 });
});

it.each(["current", "before"])("cycle1 eligibility refuses archived state at the %s boundary", kind => {
  const data = publicationWithSecondary(), second = data.skus[1];
  second.status = kind === "before" ? "archived" : "active";
  const enable = { op: "set_eligibility" as const, skuCode: "SECOND", sellableStandalone: true, sellableInSubscription: false };
  data.payload.publication.operations = kind === "before"
    ? [{ op: "set_sku_status", skuCode: "SECOND", status: "active" }, enable]
    : [{ op: "set_sku_status", skuCode: "SECOND", status: "archived" }, enable, { op: "set_sku_status", skuCode: "SECOND", status: "active" }];
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_sku_archived");
});
it("cycle1 an unrelated archived SKU does not prevent eligibility", () => {
  const data = publicationWithSecondary(), primary = data.skus[0]; data.skus[1].status = "archived";
  data.product!.status = "active"; primary.status = "active";
  data.payload.skus = [{ ...data.payload.skus[0], id: primary.id, code: primary.code, netContent: primary.netContent, options: primary.options,
    grossMass: primary.grossMass!, identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: "5901234123457", packagingLevel: "unit" }] }];
  data.payload.product.sharedContent.publicationSkus = [{ skuCode: primary.code, title: primary.title, minQuantity: primary.minQuantity, isAddon: primary.isAddon, facts: primary.facts }];
  data.payload.product.sharedContent.requestedModes = [{ skuCode: primary.code, modes: ["one_time"] }];
  data.payload.publication.operations = [{ op: "set_eligibility", skuCode: primary.code, sellableStandalone: true, sellableInSubscription: false }];
  const result = compileCatalogPublication(data);
  expect(result.skus[0].sellableStandalone).toBe(true); expect(result.skus[1].status).toBe("archived");
});
it.each(["standalone", "subscription", "primary", "allowed"])("cycle1 archive guard independently checks %s", kind => {
  const data = publicationWithSecondary(), second = data.skus[1]; second.status = "active";
  second.sellableStandalone = kind === "standalone"; second.sellableInSubscription = kind === "subscription";
  if (kind === "primary") data.payload.skus.push({ ...input().payload.skus[0], options: data.skus[0].options });
  data.payload.publication.operations = [{ op: "set_sku_status", skuCode: kind === "primary" ? "ARTICLE" : "SECOND", status: "archived" }];
  if (kind === "allowed") expect(compileCatalogPublication(data).skus[1].status).toBe("archived");
  else expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_archive_refused");
});

it.each(["missing", "off", "other SKU"])("cycle1 activation requires explicit eligibility on the same SKU: %s", kind => {
  const data = publicationWithSecondary();
  data.payload.publication.operations = [{ op: "set_sku_status", skuCode: "SECOND", status: "active" }];
  if (kind === "off") {
    data.payload.product.sharedContent.requestedModes = [{ skuCode: "SECOND", modes: [] }];
    data.payload.publication.operations.push({ op: "set_eligibility", skuCode: "SECOND", sellableStandalone: false, sellableInSubscription: false });
  }
  if (kind === "other SKU") {
    const primary = data.skus[0], authored = structuredClone(input().payload.skus[0]);
    authored.options = primary.options; authored.grossMass = primary.grossMass!; authored.logisticsRef = primary.logisticsRef!;
    data.payload.skus.push(authored);
    data.payload.product.sharedContent.requestedModes.push({ skuCode: "ARTICLE", modes: ["one_time"] });
    data.payload.publication.operations.push({ op: "set_eligibility", skuCode: "ARTICLE", sellableStandalone: true, sellableInSubscription: false });
  }
  expect(() => compileCatalogPublication(data)).toThrow("activation requires explicit enabling eligibility");
});
it("cycle1 an existing first offer membership is replaced rather than appended", () => {
  const data = publicationWithSecondary();
  data.payload.product.sharedContent.offerMemberships = [{ skuCode: "SECOND", offerVersion: "example:offer", admitted: false }];
  data.payload.publication.operations = [{ op: "set_offer_membership", skuCode: "SECOND", offerVersion: "example:offer", admitted: false }];
  const second = compileCatalogPublication(data).skus.find(sku => sku.code === "SECOND")!;
  expect(second.memberships).toEqual([{ offerVersion: "example:offer", admitted: false }]);
});

it("cycle1 a foreign retained document refuses before the next operation", () => {
  const data = retainedPublicationInput(); data.documents = structuredClone(data.documents);
  data.documents[0].reference.productId = "10000000-0000-4000-8000-000000000002";
  data.payload.publication.operations = [{ op: "move_document_pointer", productSlug: "article", documentRevisionNo: 1 },
    { op: "set_primary_sku", productSlug: "article", skuCode: "MISSING" }];
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_document_source_mismatch");
});
it("cycle1 an incomplete retained product refuses activation before final document matching", () => {
  const data = retainedPublicationInput(); data.product!.document = null;
  data.payload.publication.operations = [{ op: "set_product_status", productSlug: "article", status: "active" }];
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_product_incomplete");
});

it("cycle1 offer membership upserts keep their complete roster ordered", () => {
  const data = publicationWithSecondary();
  data.skus[1].memberships = [{ offerVersion: "example:m", admitted: true }, { offerVersion: "example:z", admitted: true }];
  data.payload.product.sharedContent.offerMemberships = [{ skuCode: "SECOND", offerVersion: "example:a", admitted: true }];
  data.payload.publication.operations = [{ op: "set_offer_membership", skuCode: "SECOND", offerVersion: "example:a", admitted: true }];
  const second = compileCatalogPublication(data).skus.find(sku => sku.code === "SECOND")!;
  expect(second.memberships.map(row => row.offerVersion)).toEqual(["example:a", "example:m", "example:z"]);
});
it.each(["net content", "document revision"])("cycle1 derived cache operations bind their %s", kind => {
  const data = retainedPublicationInput(); data.payload.publication.kind = "compensation";
  data.payload.publication.operations = [{ op: "set_derived_sku_facts", skuCode: "ARTICLE", documentRevisionNo: kind === "document revision" ? 2 : 1,
    netContent: { ...data.skus[0].netContent, unscaled: kind === "net content" ? "101" : "100" }, facts: data.skus[0].facts }];
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_derived_source_mismatch");
});

it.each(["omitted", "unmoved"])("cycle1 authored document reference is checked when %s", kind => {
  const data = retainedPublicationInput(); data.payload.publication.kind = "compensation";
  if (kind === "omitted") {
    delete data.payload.product.documentRevision;
    data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
    expect(() => compileCatalogPublication(data)).toThrow("document_reference_missing");
  } else {
    data.payload.product.sharedContent.document = { ...data.payload.product.sharedContent.document, revisionNo: 2 };
    const digest = createHash("sha256").update(canonicalCatalogDraftJson(data.payload.product.sharedContent.document)).digest("hex");
    const reference = { ...data.payload.product.documentRevision!, digest, id: "40000000-0000-4000-8000-000000000002", revisionNo: 2 };
    data.payload.product.documentRevision = reference;
    data.payload.publication.operations = [{ op: "register_document_revision", productSlug: "article", revisionId: reference.id, revisionNo: 2,
      documentRef: reference.documentRef, sourceRef: reference.sourceRef, canonicalText: canonicalCatalogDraftJson(data.payload.product.sharedContent.document), digest: reference.digest, provenance: { source: "current_draft" } }];
    expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_document_source_mismatch");
  }
});
it.each(["omitted", "different"])("cycle1 authored document content is checked when %s", kind => {
  const data = retainedPublicationInput(); data.payload.publication.kind = "compensation";
  data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
  if (kind === "omitted") { delete data.payload.product.sharedContent.document; expect(compileCatalogPublication(data).changed).toBe(false); }
  else { data.payload.product.sharedContent.document = { schemaVersion: 1, derived: 13 }; expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_document_source_mismatch"); }
});

it.each(["id", "net content", "options"])("cycle1 retained SKU identity binds its %s", kind => {
  const data = retainedPublicationInput(); data.payload.publication.kind = "compensation";
  data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
  const sku = data.payload.skus[0];
  if (kind === "id") { sku.id = "20000000-0000-4000-8000-000000000002"; delete data.payload.product.primarySkuId; }
  if (kind === "net content") sku.netContent = { ...sku.netContent!, unscaled: "101" };
  if (kind === "options") sku.options = { pack_size: { kind: "quantity", value: { ...sku.netContent!, unscaled: "101" } } };
  expect(() => compileCatalogPublication(data)).toThrow("sku_identity_change_requires_new_sku");
});
it("cycle1 the strict carrier rejects a foreign retained SKU parent", () => {
  const data = retainedPublicationInput(); data.payload.skus[0].productId = "10000000-0000-4000-8000-000000000002";
  expect(() => compileCatalogPublication(data)).toThrow("SKU must belong to product");
});

it("cycle1 unchanged physical facts do not call the identity classifier", () => {
  const data = retainedPublicationInput(); data.payload.publication.kind = "compensation";
  data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
  let calls = 0; data.rules = { ...rules, classifySkuChange: () => { calls++; return "inconclusive"; } };
  expect(compileCatalogPublication(data).changed).toBe(false); expect(calls).toBe(0);
});
it.each(["archived SKU", "absent identifier", "nonprimary GTIN", "foreign nonprimary identifier", "absent logistics", "absent membership", "declined membership"])(
  "cycle1 final activation readiness refuses %s", kind => {
    const data = publicationWithSecondary(), second = data.skus[1]; second.status = "active"; second.sellableStandalone = true;
    data.payload.publication.kind = "compensation";
    data.payload.publication.operations = [{ op: "set_eligibility", skuCode: second.code, sellableStandalone: true, sellableInSubscription: false }];
    if (kind === "archived SKU") second.status = "archived";
    if (kind === "absent identifier") second.identifiers = [];
    if (kind === "nonprimary GTIN") second.identifiers[0].isPrimary = false;
    if (kind === "foreign nonprimary identifier") { second.identifiers[0].scheme = "example:identifier"; second.identifiers[0].isPrimary = false; }
    if (kind === "absent logistics") { second.logisticsRef = null; delete data.payload.skus[0].logisticsRef; }
    if (kind === "absent membership") second.memberships = [];
    if (kind === "declined membership") second.memberships[0].admitted = false;
    const reason = kind === "archived SKU" ? "catalog_publication_v3_compile_sku_archived"
      : kind === "absent identifier" || kind === "foreign nonprimary identifier" ? "catalog_publication_identifier_source_mismatch"
        : "catalog_publication_v3_activation_readiness_failed";
    expect(() => compileCatalogPublication(data)).toThrow(reason);
  });

it.each(["primary", "document", "presentation"])("cycle1 final completeness independently requires %s", kind => {
  const data = kind === "document" ? retainedPublicationInput() : input();
  if (kind === "document") {
    data.skus = []; data.payload.skus = []; data.product!.document = null; Object.assign(data.payload.product.sharedContent, { publicationSkus: [], requestedModes: [], offerMemberships: [] });
    delete data.payload.product.primarySkuId; delete data.payload.product.documentRevision; delete data.payload.product.sharedContent.document;
    data.payload.publication.kind = "compensation";
    data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
  } else data.payload.publication.operations = data.payload.publication.operations.filter(operation => operation.op !== (kind === "primary" ? "set_primary_sku" : "set_product_presentation"));
  expect(() => compileCatalogPublication(data)).toThrow(kind === "document" ? "document_reference_missing" : "catalog_publication_v3_structural_readiness_failed");
});
it("cycle1 configured capacity includes its exact boundary", () => {
  const data = publicationWithSecondary(); data.capacity = 2; data.payload.publication.kind = "compensation";
  data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
  expect(compileCatalogPublication(data).skus).toHaveLength(2);
  data.capacity = 1; expect(() => compileCatalogPublication(data)).toThrow("product_capacity_exceeded");
});
function defaultCapacityInput() {
  const data = retainedPublicationInput(), base = data.skus[0];
  const row = (i: number) => {
    const sku = structuredClone(base), revision = 2 + Math.floor((i - 1) / 1000);
    sku.id = `20000000-0000-4000-8001-${String(i).padStart(12, "0")}`; sku.code = `SECOND${i}`;
    sku.netContent = { ...sku.netContent, unscaled: String(100 + i) }; sku.options = { pack_size: { kind: "quantity", value: sku.netContent } }; sku.identifiers = [];
    sku.source = { ...sku.source, revision, commandKey: `draft:${revision}`, fingerprint: revision.toString(16).padStart(64, "0") };
    return sku;
  };
  data.skus = [base, ...Array.from({ length: 49_999 }, (_, i) => row(i + 1))];
  data.record = { ...data.record, revision: 52, commandKey: "draft:52", fingerprint: "c".repeat(64) };
  data.payload.publication.kind = "compensation";
  data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
  return { data, next: row(50_000) };
}
describe.each([50_000, 50_001])("cycle1 default capacity boundary at %i SKUs", count => {
  let result: ReturnType<typeof compileCatalogPublication> | undefined, refusal: unknown;
  // The exact boundary compiles the full roster. Setup took 0.24 s and compilation
  // took 3.7–4.1 s on Node 24.21.0. Hosted shard 4 exhausted the default 10 s hook.
  beforeAll(() => {
    const { data, next } = defaultCapacityInput();
    if (count === 50_001) {
      data.payload.skus = [{ ...data.payload.skus[0], id: next.id, code: next.code, netContent: next.netContent, options: next.options,
        identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "unit" }] }];
      delete data.payload.product.primarySkuId;
      const facts = { skuCode: next.code, title: next.title, minQuantity: next.minQuantity, isAddon: next.isAddon, facts: next.facts };
      data.payload.product.sharedContent.publicationSkus = [facts]; data.payload.product.sharedContent.requestedModes = [{ skuCode: next.code, modes: [] }];
      data.payload.publication.operations = [{ op: "create_sku", productSlug: "article", skuId: next.id, documentRevisionNo: 1, ...facts },
        { op: "create_identifier", skuCode: next.code, scheme: "gs1:gtin", issuer: "example", value: "4006381333931",
          packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null }];
    }
    try { result = compileCatalogPublication(data); } catch (error) { refusal = error; }
  }, 30_000);
  it("retains the exact admission or refusal", () => {
    if (count === 50_000) { expect(refusal).toBeUndefined(); expect(result?.skus).toHaveLength(50_000); }
    else { expect(result).toBeUndefined(); expect(refusal).toMatchObject({ message: "product_capacity_exceeded" }); }
  });
});

it("retained identity lookup refuses a duplicate before classifying changes", () => {
  const data = publicationWithSecondary(); data.skus[1].id = data.skus[0].id; data.payload.skus[0].id = data.skus[0].id;
  data.payload.publication.kind = "compensation";
  data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
  let classified = false;
  data.rules = { ...rules, classifySkuChange: () => { classified = true; return "compatible"; } };
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_sku_revision_invalid");
  expect(classified).toBe(false);
});

it.each(["missing", "archived"])("cycle1 final primary refuses a %s retained SKU", kind => {
  const data = retainedPublicationInput(); data.payload.publication.kind = "compensation";
  data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
  if (kind === "missing") { data.skus = []; data.payload.skus = []; delete data.payload.product.primarySkuId; Object.assign(data.payload.product.sharedContent, { publicationSkus: [], requestedModes: [], offerMemberships: [] }); }
  else data.skus[0].status = "archived";
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_primary_foreign");
});
it("a scoped secondary SKU activation cannot leave the owning product in draft", () => {
  const data = publicationWithSecondary();
  data.payload.publication.operations = [{ op: "set_eligibility", skuCode: "SECOND", sellableStandalone: true, sellableInSubscription: false },
    { op: "set_sku_status", skuCode: "SECOND", status: "active" }];
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_activation_effect_missing");
});

it.each([
  ["draft", "draft", true, ["set_sku_status", "set_product_status"]],
  ["draft", "active", true, ["set_product_status"]],
  ["active", "draft", true, ["set_sku_status"]],
  ["active", "active", true, []],
  ["draft", "draft", false, []],
] as const)("CD-CAT-43 generates the donor promotion set for %s product, %s SKU, positive eligibility %s", (product, sku, enabling, expected) => {
  const data = publicationWithSecondary();
  const primary = data.skus.find(row => row.code === "ARTICLE")!;
  primary.status = "active"; primary.sellableStandalone = true;
  data.product!.status = product;
  const affected = data.skus.find(row => row.code === "SECOND")!;
  affected.status = sku;
  affected.sellableStandalone = !enabling;
  data.payload.product.sharedContent.requestedModes.find(row => row.skuCode === "SECOND")!.modes = enabling ? ["one_time"] : [];
  data.payload.publication.operations = [{ op: "set_eligibility", skuCode: "SECOND", sellableStandalone: enabling, sellableInSubscription: false }];
  if (expected.length) expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_activation_effect_missing");
  const payload = compileCatalogPublicationDraft(data.payload, data.payload.product.sharedContent.presentation, data);
  expect(payload.publication.operations.slice(1).map(op => op.op)).toEqual(expected);
  expect(compileCatalogPublication({ ...data, payload, record: { ...data.record, payload } }).skus.find(row => row.code === "SECOND"))
    .toMatchObject({ status: enabling ? "active" : sku, sellableStandalone: enabling });
});
it.each([true, false])("cycle1 changed=%s retains the matching product source and content", changed => {
  const data = retainedPublicationInput(), before = structuredClone(data.product!);
  data.record = { ...data.record, revision: 2, commandKey: "draft:second", fingerprint: "c".repeat(64) };
  data.payload.publication.kind = "compensation";
  if (changed) data.payload.product.sharedContent.presentation = { label: "Changed" };
  data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: data.payload.product.sharedContent.presentation }];
  const result = compileCatalogPublication(data);
  expect(result.changed).toBe(changed);
  expect(result.product.source).toEqual(changed ? { draftId: data.record.draftId, revision: 2, commandKey: "draft:second", fingerprint: "c".repeat(64) } : before.source);
  expect(result.product.content).toEqual(changed ? data.payload.product.sharedContent : before.content);
});

it("cycle1 gross comparison refuses nonmass net content before gross validation", () => {
  const net = input().payload.skus[0].netContent!;
  expect(() => assertCatalogPublicationGrossMass({ ...net, dimension: "volume", unit: "openlup:ml" }, null, definition)).toThrow("catalog_publication_mass_required_until_mc5");
});
it("cycle1 gross parsing errors retain their named refusal", () => {
  const net = input().payload.skus[0].netContent!;
  for (const gross of [{ ...net, unscaled: "0" }, { ...net, unscaled: "-1" }, { ...net, unit: "example:unknown" }, { ...net, scale: 13 }])
    expect(() => assertCatalogPublicationGrossMass(net, gross, definition)).toThrow("catalog_publication_gross_mass_invalid");
});
it.each([
  ["orphaned retained SKU", "catalog_publication_source_invalid", (data: ReturnType<typeof input>) => { data.skus = compileCatalogPublication(input()).skus; }],
  ["foreign retained SKU", "catalog_publication_scope_expansion", (data: ReturnType<typeof input>) => { Object.assign(data, retainedPublicationInput()); data.skus[0].productId = "10000000-0000-4000-8000-000000000002"; }],
  ["revision without product", "catalog_action_conflict", (data: ReturnType<typeof input>) => { data.payload.product.sharedContent.catalogAction = "revise"; }],
  ["creation over product", "catalog_action_conflict", (data: ReturnType<typeof input>) => { Object.assign(data, retainedPublicationInput()); data.payload.product.sharedContent.catalogAction = "create"; }],
  ["operation without product", "catalog_publication_v3_compile_product_absent", (data: ReturnType<typeof input>) => { data.payload.publication.operations = data.payload.publication.operations.filter(operation => operation.op !== "create_product"); }],
  ["pointer to missing document", "catalog_publication_v3_compile_document_absent", (data: ReturnType<typeof input>) => { Object.assign(data.payload.publication.operations.find(operation => operation.op === "move_document_pointer")!, { documentRevisionNo: 2 }); }],
  ["missing current document", "catalog_publication_v3_compile_document_absent", (data: ReturnType<typeof input>) => {
    Object.assign(data, retainedPublicationInput()); data.documents = [];
    data.payload.publication.operations = [{ op: "set_derived_sku_facts", skuCode: "ARTICLE", documentRevisionNo: 1, netContent: data.skus[0].netContent, facts: data.skus[0].facts }];
  }],
  ["immutable document provenance", "catalog_publication_v3_compile_document_conflict", (data: ReturnType<typeof input>) => {
    Object.assign(data, retainedPublicationInput()); data.record = { ...data.record, revision: 2, commandKey: "draft:second", fingerprint: "c".repeat(64) };
    data.payload.publication.operations = [input().payload.publication.operations.find(operation => operation.op === "register_document_revision")!];
  }],
  ["mismatched authored primary", "current_primary_mismatch", (data: ReturnType<typeof input>) => {
    Object.assign(data, publicationWithSecondary()); data.payload.product.primarySkuId = data.skus[1].id;
    data.payload.publication.operations = [{ op: "set_primary_sku", productSlug: "article", skuCode: "SECOND" }];
  }],
  ["archived new primary", "catalog_publication_v3_compile_sku_archived", (data: ReturnType<typeof input>) => {
    data.payload.publication.operations.splice(5, 0, { op: "set_sku_status", skuCode: "ARTICLE", status: "archived" });
  }],
  ["presentation source", "catalog_publication_presentation_source_mismatch", (data: ReturnType<typeof input>) => {
    Object.assign(data.payload.publication.operations.find(operation => operation.op === "set_product_presentation")!, { presentation: { different: true } });
  }],
  ["logistics source", "catalog_publication_logistics_source_mismatch", (data: ReturnType<typeof input>) => { data.payload.publication.operations.push({ op: "set_sku_metadata", skuCode: "ARTICLE", logisticsRef: "example:other" }); }],
  ["membership source", "catalog_publication_membership_source_mismatch", (data: ReturnType<typeof input>) => { data.payload.publication.operations.push({ op: "set_offer_membership", skuCode: "ARTICLE", offerVersion: "example:unclaimed", admitted: true }); }],
  ["created derived facts", "catalog_publication_v3_compile_derived_facts_mismatch", (data: ReturnType<typeof input>) => { data.rules = { ...rules, deriveSkuFacts: () => ({ derived: 13 }) }; }],
  ["explicit derived facts", "catalog_publication_v3_compile_derived_facts_mismatch", (data: ReturnType<typeof input>) => {
    Object.assign(data, retainedPublicationInput()); data.payload.publication.operations = [{ op: "set_derived_sku_facts", skuCode: "ARTICLE", documentRevisionNo: 1, netContent: data.skus[0].netContent, facts: { derived: 13 } }];
  }],
  ["installed validation issue", "catalog_publication_adopter_validation_failed", (data: ReturnType<typeof input>) => { data.rules = { ...rules, validateProduct: () => ["example:issue"] }; }],
] as const)("cycle1 named compiler refusal for %s", (_name, reason, change) => {
  const data = input(); change(data); expect(() => compileCatalogPublication(data)).toThrow(reason);
});

it("cycle1 a retained nonmass SKU keeps the named mass refusal", () => {
  const data = retainedPublicationInput(); data.payload.skus = []; delete data.payload.product.primarySkuId; Object.assign(data.payload.product.sharedContent, { publicationSkus: [], requestedModes: [], offerMemberships: [] });
  data.skus[0].netContent = { dimension: "volume", unit: "openlup:ml", unscaled: "100", scale: 0 };
  data.payload.publication.kind = "compensation"; data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_mass_required_until_mc5");
});
it.each([
  ["scope after orphaned source", "catalog_publication_source_invalid", () => { const data = input(); data.skus = compileCatalogPublication(input()).skus; data.skus[0].productId = "10000000-0000-4000-8000-000000000002"; return data; }],
  ["product identity after invalid source", "catalog_publication_source_invalid", () => { const data = retainedPublicationInput(); data.record.status = "abandoned"; data.product!.slug = "other"; return data; }],
  ["action after product identity", "catalog_publication_product_identity_conflict", () => { const data = retainedPublicationInput(); data.product!.slug = "other"; data.payload.product.sharedContent.catalogAction = "create"; return data; }],
  ["document content after reference", "catalog_publication_document_source_mismatch", () => { const data = retainedPublicationInput(); data.documents = []; data.payload.product.documentRevision = { ...data.payload.product.documentRevision!, id: "40000000-0000-4000-8000-000000000002" }; data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }]; return data; }],
  ["completeness after capacity", "product_capacity_exceeded", () => { const data = input(); data.capacity = 0; data.payload.publication.operations = data.payload.publication.operations.filter(operation => operation.op !== "set_primary_sku"); return data; }],
  ["active primary after nonarchived primary", "catalog_publication_v3_compile_primary_foreign", () => { const data = retainedPublicationInput(); data.skus[0].status = "archived"; data.payload.publication.operations = [{ op: "set_product_status", productSlug: "article", status: "active" }]; return data; }],
  ["operation conflict after scope", "catalog_publication_scope_expansion", () => { const data = input(); Object.assign(data.payload.publication.operations[0], { productSlug: "other", productId: "10000000-0000-4000-8000-000000000002" }); return data; }],
  ["mass after authored facts", "catalog_publication_operation_source_mismatch", () => { const data = input(); data.payload.skus[0].netContent = { dimension: "volume", unit: "openlup:ml", unscaled: "100", scale: 0 }; Object.assign(data.payload.publication.operations.find(operation => operation.op === "create_sku")!, { title: "Other" }); return data; }],
  ["document prefix after mass", "catalog_publication_mass_required_until_mc5", () => { const data = input(); data.payload.skus[0].netContent = { dimension: "volume", unit: "openlup:ml", unscaled: "100", scale: 0 }; Object.assign(data.payload.publication.operations.find(operation => operation.op === "create_sku")!, { documentRevisionNo: 2 }); return data; }],
  ["primary immutability after authored primary", "catalog_publication_v3_compile_primary_foreign", () => { const data = publicationWithSecondary(), primary = data.skus[0]; data.payload.skus.push({ ...input().payload.skus[0], options: primary.options }); data.payload.product.primarySkuId = primary.id; data.payload.publication.operations = [{ op: "set_primary_sku", productSlug: "article", skuCode: "SECOND" }]; return data; }],
  ["archive after authored primary", "current_primary_mismatch", () => { const data = publicationWithSecondary(); data.skus[1].status = "archived"; data.payload.product.primarySkuId = data.skus[1].id; data.payload.publication.operations = [{ op: "set_primary_sku", productSlug: "article", skuCode: "SECOND" }]; return data; }],
  ["derived facts after source", "catalog_publication_derived_source_mismatch", () => { const data = retainedPublicationInput(); data.payload.publication.operations = [{ op: "set_derived_sku_facts", skuCode: "ARTICLE", documentRevisionNo: 1, netContent: { ...data.skus[0].netContent, unscaled: "101" }, facts: { derived: 13 } }]; return data; }],
  ["mass after physical classification", "sku_identity_change_requires_new_sku", () => { const data = retainedPublicationInput(); data.payload.skus = []; delete data.payload.product.primarySkuId; Object.assign(data.payload.product.sharedContent, { publicationSkus: [], requestedModes: [], offerMemberships: [] }); data.skus[0].netContent = { dimension: "volume", unit: "openlup:ml", unscaled: "100", scale: 0 }; data.payload.product.attributes = { details: "Changed" }; data.rules = { ...rules, classifySkuChange: () => "inconclusive" }; data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }]; return data; }],
  ["activation after derived facts", "catalog_publication_v3_compile_derived_facts_mismatch", () => { const data = retainedPublicationInput(); data.skus[0].facts = { derived: 13 }; data.skus[0].sellableStandalone = true; data.skus[0].grossMass = data.skus[0].netContent; data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }]; return data; }],
] as const)("cycle1 refusal order keeps %s", (_name, reason, prepare) => {
  expect(() => compileCatalogPublication(prepare())).toThrow(reason);
});

it.each(["presentation", "physical facts", "exact copy"] as const)("publication compiler binds the immutable draft payload: %s", mode => {
  const data = input();
  data.record = { ...data.record, payload: structuredClone(data.payload) };
  if (mode === "presentation") {
    data.payload.product.sharedContent.presentation = { name: "Different authored intent" };
    const presentation = data.payload.publication.operations.find(operation => operation.op === "set_product_presentation")!;
    if (presentation.op === "set_product_presentation") presentation.presentation = data.payload.product.sharedContent.presentation;
  }
  if (mode === "physical facts") data.payload.skus[0].netContent = { ...data.payload.skus[0].netContent!, unscaled: "101" };
  if (mode === "exact copy") expect(compileCatalogPublication(data).skus[0].netContent).toEqual(data.record.payload.skus[0].netContent);
  else expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_source_mismatch");
});

it.each([false, true])("cycle1 retained roster order cannot manufacture a material change: reversed=%s", reversed => {
  const data = publicationWithSecondary();
  if (reversed) data.skus.reverse();
  data.payload.publication.kind = "release";
  data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_change_noop");
  data.payload.publication.kind = "compensation";
  const result = compileCatalogPublication(data);
  expect(result.changed).toBe(false);
  expect(result.skus.map(sku => sku.id)).toEqual(["20000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002"]);
});

it("keeps the legacy publication refusal for an unrecognized publisher", async () => {
  const target = createPostgresCatalogPublication({
    registry, rules, authorizeHuman: async () => ({ ok: true, userId: input().payload.product.id, role: "admin", isMachineActor: false }),
    transactions: { run: work => work({ async query(sql) {
      expect(sql).toBe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      return { rows: [] };
    } }) },
    readiness: async () => { throw new Error("Unexpected readiness call"); },
    verifyMedia: async () => { throw new Error("Unexpected media call"); },
  });
  const issuedByAnotherAuthority = createPostgresCatalogPublication({
    registry, rules, authorizeHuman: async () => ({ ok: true, userId: input().payload.product.id, role: "admin", isMachineActor: false }),
    transactions: { run: async () => { throw new Error("Unexpected transaction"); } },
    readiness: async () => { throw new Error("Unexpected readiness call"); },
    verifyMedia: async () => { throw new Error("Unexpected media call"); },
  });
  const capability = await issuedByAnotherAuthority.authorize(null);
  if (!capability) throw new Error("Missing test capability");
  expect(await target.publication.publish({ productId: input().payload.product.id, commandKey: "publish:1",
    candidateRef: `v1:${input().record.draftId}@1/unpublished`, candidateDigest: "a".repeat(64), expectedHead: null, changes: [] }, capability))
    .toEqual({ outcome: "unauthorized", reason: "publisher_not_authorized" });
});

it.each(["continuation", "terminal"] as const)("returns a full-fact page at the exact UTF-8 byte limit: %s", async mode => {
  const { product, skus, documents } = compileCatalogPublication(input());
  const [document] = documents;
  const head = { publicationId: "50000000-0000-4000-8000-000000000001", revision: 2, documentDigest: document.reference.digest };
  const { skuBytes, pageBytes } = CATALOG_PUBLICATION_LIMITS;
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const items = Array.from({ length: mode === "terminal" ? 4 : 5 }, (_, index) => {
    const suffix = String(index + 1).padStart(12, "0");
    const facts = { ...skus[0], id: `20000000-0000-4000-8000-${suffix}`, code: `ARTICLE-${suffix}`, facts: { padding: "" } };
    const reference = { skuId: facts.id, revisionId: `60000000-0000-4000-8000-${suffix}`, revision: 1, digest: "0".repeat(64) };
    return { reference, facts };
  });
  const nextCursor = mode === "terminal" ? null : Buffer.from(canonicalCatalogDraftJson({ schemaVersion: 1, kind: "facts", productId: product.id, highWater: head.revision, before: 4 })).toString("base64url");
  const expected = { outcome: "page", schemaVersion: 2, head, product, items: items.slice(0, 4), nextCursor };
  const setPadding = (item: typeof items[number], bytes: number) => {
    item.facts.facts.padding = "é".repeat(Math.floor(bytes / 2)) + "x".repeat(bytes % 2);
    item.reference.digest = digest(publicationJson(item.facts));
  };
  for (const item of items.slice(0, 3)) setPadding(item, skuBytes - Buffer.byteLength(publicationJson(item.facts)));
  setPadding(items[3], pageBytes - Buffer.byteLength(publicationJson(expected)));
  if (mode === "continuation") setPadding(items[4], 0);
  const canonicalState = publicationJson({ schemaVersion: 2, product, skus: items.map(({ reference }) => reference) });
  const stored = items.map(({ reference, facts }) => {
    const text = publicationJson(facts);
    return { id: reference.revisionId, sku_id: reference.skuId, revision: reference.revision, digest: reference.digest, bytes: Buffer.byteLength(text), full_facts: text, sku_code: facts.code, visible: true, superseded: false };
  });
  const ref = document.reference;
  const fetched: unknown[] = [];
  const target = createPostgresCatalogPublication({
    registry, rules, authorizeHuman: async () => ({ ok: false }),
    transactions: { run: work => work({ async query(sql, params) {
      if (sql.startsWith("SET TRANSACTION")) return { rows: [] };
      if (sql.startsWith("SELECT p.product_id,p.revision,p.canonical_state")) return { rows: [{ product_id: product.id, publication_id: head.publicationId,
        revision: head.revision, previous_id: "50000000-0000-4000-8000-000000000002", previous_revision: 1,
        canonical_state: canonicalState, digest: digest(canonicalState), document_id: ref.id, document_digest: ref.digest,
        revision_no: ref.revisionNo, schema_id: ref.schemaId, document_ref: ref.documentRef, source_ref: ref.sourceRef, canonical_text: document.canonicalText }] };
      const ids = params?.[1] as string[];
      if (sql.startsWith("SELECT r.id,r.sku_id,r.revision,r.digest,octet_length")) return { rows: stored.filter(row => ids.includes(row.id)) };
      if (sql.startsWith("SELECT id,full_facts")) {
        fetched.push(ids);
        return { rows: stored.filter(row => ids.includes(row.id)) };
      }
      throw new Error("Unexpected publication read");
    } }) },
    readiness: async () => { throw new Error("Unexpected readiness call"); },
    verifyMedia: async () => { throw new Error("Unexpected media call"); },
  });
  const first = await target.readbackV2(head);
  expect(first.outcome).toBe("page");
  if (first.outcome !== "page") throw new Error("Missing full-fact page");
  expect(Buffer.byteLength(publicationJson(first))).toBe(pageBytes);
  expect(first.items.map(item => item.reference)).toEqual(expected.items.map(item => item.reference));
  expect(first.nextCursor).toBe(nextCursor);
  if (mode === "terminal") expect(fetched).toEqual([stored.map(row => row.id)]);
  else {
    expect(await target.readbackV2(head, first.nextCursor)).toEqual({ ...expected, items: items.slice(4), nextCursor: null });
    expect(fetched).toEqual([stored.slice(0, 4).map(row => row.id), [stored[4].id]]);
  }
});

it.each([
  ["padded unit operation", "5901234123457", "05901234123457", "unit", "unit", "example", "new", null],
  ["short unit operation", "05901234123457", "5901234123457", "unit", "unit", "example", "new", null],
  ["padded case operation", "4006381333931", "04006381333931", "case", "case", "example", "new", null],
  ["different issuer", "5901234123457", "05901234123457", "unit", "unit", "other", "new", "catalog_publication_identifier_source_mismatch"],
  ["different pack", "4006381333931", "04006381333931", "unit", "case", "example", "new", "catalog_publication_identifier_source_mismatch"],
  ["different GTIN", "5901234123457", "04006381333931", "unit", "unit", "example", "new", "catalog_publication_identifier_source_mismatch"],
  ["retained SKU", "5901234123457", "05901234123457", "unit", "unit", "example", "retained", "identifier precedes or lacks SKU creation"],
] as const)("publication binds GTIN source by canonical digits: %s", (_case, sourceValue, value, sourcePack, packagingLevel, issuer, lifecycle, reason) => {
  const data = lifecycle === "retained" ? retainedPublicationInput() : input();
  const operation = { op: "create_identifier" as const, skuCode: "ARTICLE", scheme: "gs1:gtin", issuer, value, packagingLevel,
    quantity: packagingLevel === "unit" ? 1 : 2, isPrimary: packagingLevel === "unit", label: null, sourceRef: null };
  const identifiers = data.payload.skus[0].identifiers!;
  const source = { scheme: "gs1:gtin", issuer: "example", value: sourceValue, packagingLevel: sourcePack, quantity: sourcePack === "unit" ? 1 : 2 };
  if (packagingLevel === "case") {
    identifiers.push(source);
    data.payload.publication.operations.push(operation);
  } else {
    identifiers[0] = source;
    data.payload.publication.operations = lifecycle === "retained" ? [operation]
      : data.payload.publication.operations.map(effect => effect.op === "create_identifier" ? operation : effect);
  }
  if (reason) expect(() => compileCatalogPublication(data)).toThrow(reason);
  else expect(compileCatalogPublication(data).skus[0].identifiers).toContainEqual(expect.objectContaining({ value, packagingLevel, issuer }));
  expect(source.value).toBe(sourceValue);
});

it.each([
  ["absent release", "release", "authored", null, false, false, true],
  ["absent compensation with retained source", "compensation", "retained", null, false, false, false],
  ["explicit empty", "release", "authored", [], false, false, true],
  ["one mode", "release", "authored", ["one_time"], true, false, true],
  ["both modes", "compensation", "authored", ["one_time", "subscription"], true, true, true],
  ["unclaimed enable", "release", "authored", null, true, false, false],
  ["unclaimed subscription", "release", "authored", [], false, true, false],
  ["extra flag", "compensation", "retained", ["one_time"], true, true, false],
  ["withdrawal contradicts intent", "release", "authored", ["subscription"], false, false, false],
] as const)("publication matches eligibility against the authored modes: %s", (_case, kind, source, modes, standalone, subscription, accepted) => {
  const data = retainedPublicationInput(), sku = data.skus[0];
  sku.grossMass = sku.netContent;
  sku.logisticsRef = "example:logistics";
  sku.memberships = [{ offerVersion: "example:offer", admitted: true }];
  sku.sellableStandalone = !standalone;
  data.product!.status = "active"; sku.status = "active";
  data.payload.product.sharedContent.requestedModes = modes === null ? [] : [{ skuCode: sku.code, modes: [...modes] }];
  if (source === "retained") {
    data.retainedSources = [structuredClone(data.record)];
    data.record = { ...data.record, revision: 2 };
    data.payload.skus = [];
    delete data.payload.product.primarySkuId;
    data.payload.product.sharedContent.publicationSkus = [];
    data.payload.product.sharedContent.requestedModes = [];
  }
  data.payload.publication.kind = kind;
  data.payload.publication.operations = [{ op: "set_eligibility", skuCode: sku.code, sellableStandalone: standalone, sellableInSubscription: subscription }];
  if (accepted) expect(compileCatalogPublication(data).skus[0]).toMatchObject({ sellableStandalone: standalone, sellableInSubscription: subscription });
  else expect(() => compileCatalogPublication(data)).toThrow(source === "retained" ? "catalog_publication_operation_source_missing"
    : "catalog_publication_eligibility_source_mismatch");
});

it.each([
  ["create", "publicationSkus"],
  ["revise", "requestedModes"],
  ["compensation", "offerMemberships"],
  ["revise", "missing primary authoring"],
  ["revise", "current primary"],
  ["revise", "materialized secondary"],
  ["compensation", "materialized secondary"],
] as const)("publication binds %s authored intents to the submitted roster and current primary: %s", (kind, target) => {
  const data = kind === "create" ? input() : publicationWithSecondary();
  const product = data.payload.product, content = product.sharedContent;
  if (kind !== "create") {
    const authoredPrimary = input().payload.skus[0];
    data.payload.skus.push({ ...authoredPrimary, options: data.skus[0].options });
    content.presentation = { routePath: { en: "/revised" } };
    data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: content.presentation }];
  }
  if (kind === "compensation") data.payload.publication.kind = kind;
  if (target === "materialized secondary") {
    product.primarySkuId = data.skus[1].id;
    expect(() => compileCatalogPublication(data)).toThrow("current_primary_mismatch");
    return;
  }
  if (target === "current primary") product.primarySkuId = data.skus[0].id;
  if (target === "publicationSkus") content.publicationSkus.push({ ...content.publicationSkus[0], skuCode: "absent" });
  if (target === "offerMemberships") content.offerMemberships.push({ skuCode: "absent", offerVersion: "example:offer", admitted: false });
  if (target === "requestedModes") content.requestedModes.push({ skuCode: "absent", modes: [] });
  if (target === "offerMemberships" || target === "requestedModes" || target === "publicationSkus")
    expect(() => compileCatalogPublication(data)).toThrow("intent_sku_absent");
  else expect(compileCatalogPublication(data).product.primarySkuId).toBe(data.skus[0].id);
});

it.each([
  ["missing reference", "document_reference_missing"],
  ["wrong document slug", "catalog_publication_v3_document_invalid"],
  ["wrong document id", "catalog_publication_v3_document_invalid"],
  ["wrong document schema", "catalog_publication_v3_document_invalid"],
  ["wrong document revision", "catalog_publication_v3_document_invalid"],
  ["unused bad document", "catalog_publication_v3_document_digest_mismatch"],
  ["old prefix with equal derived facts", "catalog_publication_v3_compile_document_stale"],
  ["old prefix with colliding combination", "duplicate_combination"],
  ["derived cache bound to old prefix", "catalog_publication_derived_source_mismatch"],
  ["bare older move", "catalog_publication_v3_document_reference_stale"],
  ["matched older registration", null],
] as const)("publication binds the exact authored and installed document tuple: %s", (mode, reason) => {
  const data = mode.startsWith("old prefix") ? publicationWithSecondary() : retainedPublicationInput();
  const content = data.payload.product.sharedContent;
  const current = data.documents[0]!;
  const newerContent = { ...content.document, revisionNo: 2 };
  const canonicalText = canonicalCatalogDraftJson(newerContent);
  const newer = { ...current, canonicalText, reference: { ...current.reference, id: "40000000-0000-4000-8000-000000000002",
    revisionNo: 2, digest: createHash("sha256").update(canonicalText).digest("hex") } };
  data.payload.publication.kind = "compensation";
  data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: content.presentation }];
  if (mode === "missing reference") delete data.payload.product.documentRevision;
  else if (mode === "unused bad document") data.documents = [...data.documents, { ...newer, reference: { ...newer.reference, digest: "c".repeat(64) } }];
  else if (mode.startsWith("old prefix") || mode === "derived cache bound to old prefix") {
    content.document = newerContent; data.payload.product.documentRevision = newer.reference;
    const register = { op: "register_document_revision" as const, productSlug: "article", revisionId: newer.reference.id,
      revisionNo: 2, documentRef: newer.reference.documentRef, sourceRef: newer.reference.sourceRef, canonicalText,
      digest: newer.reference.digest, provenance: { source: "current_draft" as const } };
    if (mode === "derived cache bound to old prefix") {
      const sku = data.skus[0];
      data.payload.publication.operations = [
        { op: "set_derived_sku_facts", skuCode: sku.code, documentRevisionNo: 1, netContent: sku.netContent, facts: sku.facts },
        register, { op: "move_document_pointer", productSlug: "article", documentRevisionNo: 2 },
      ];
    } else {
      const secondary = data.skus.pop()!, sku = data.payload.skus[0];
      if (mode === "old prefix with colliding combination") {
        sku.netContent = data.skus[0].netContent;
        sku.options = data.skus[0].options;
      }
      data.payload.publication.operations = [
      { op: "create_sku", productSlug: "article", skuId: secondary.id, documentRevisionNo: 1, ...content.publicationSkus[0] },
      { op: "create_identifier", skuCode: sku.code!, scheme: "gs1:gtin", issuer: "example", value: "4006381333931",
        quantity: 1, packagingLevel: "unit", isPrimary: true, label: null, sourceRef: null },
      register, { op: "move_document_pointer", productSlug: "article", documentRevisionNo: 2 },
      ];
    }
  } else if (mode === "bare older move" || mode === "matched older registration") {
    data.documents = [...data.documents, newer];
    data.product!.document = newer.reference;
    data.payload.publication.operations = [{ op: "move_document_pointer", productSlug: "article", documentRevisionNo: 1 }];
    if (mode === "matched older registration")
      data.payload.publication.operations.unshift(input().payload.publication.operations.find(op => op.op === "register_document_revision")!);
  } else {
    const document = { ...content.document };
    if (mode === "wrong document slug") document.productSlug = "other";
    if (mode === "wrong document id") document.id = "example:other";
    if (mode === "wrong document schema") document.schemaVersion = 2;
    if (mode === "wrong document revision") document.revisionNo = 3;
    const canonicalText = canonicalCatalogDraftJson(document), digest = createHash("sha256").update(canonicalText).digest("hex");
    content.document = document;
    const tuple = { ...current, canonicalText, reference: { ...current.reference, digest } };
    data.documents = [tuple];
    data.product!.document = tuple.reference;
    data.payload.product.documentRevision = tuple.reference;
  }
  if (reason) expect(() => compileCatalogPublication(data)).toThrow(reason);
  else expect(compileCatalogPublication(data).product.document).toEqual(current.reference);
});

it.each([
  ["dark missing gross", false, "9999999", null, false, null],
  ["dark below gross", false, "9999999", "9999998", false, "catalog_publication_gross_below_net"],
  ["dark equal gross", false, "9999999", "9999999", false, null],
  ["dark above gross", false, "9999999", "10000000", false, null],
  ["dark equivalent kilograms", false, "9999999", "9999999", true, null],
  ["dark over category ceiling", false, "10000000", "10000000", false, "catalog_publication_authored_amounts_invalid"],
  ["enabled missing gross", true, "9999999", null, false, "catalog_publication_gross_mass_required"],
  ["enabled below gross", true, "9999999", "9999998", false, "catalog_publication_gross_below_net"],
  ["enabled equal gross", true, "9999999", "9999999", false, null],
  ["enabled over category ceiling", true, "10000000", "10000000", false, "catalog_publication_authored_amounts_invalid"],
] as const)("publication validates exact authored amounts for %s", (_name, enabled, net, gross, inKilograms, reason) => {
  const data = enabled ? publicationWithSecondary() : input(), sku = data.payload.skus[0];
  sku.netContent = { dimension: "mass", unit: inKilograms ? "openlup:kg" : "openlup:g", unscaled: net, scale: inKilograms ? 3 : 0 };
  if (gross !== null) sku.grossMass = { dimension: "mass", unit: "openlup:g", unscaled: gross, scale: 0 };
  else delete sku.grossMass;
  if (enabled) {
    sku.options = { pack_size: { kind: "quantity", value: sku.netContent } };
    Object.assign(data.skus[1], { netContent: sku.netContent, options: sku.options, grossMass: sku.grossMass ?? null, status: "active" });
    data.product!.status = "active";
    data.payload.publication.operations = [{ op: "set_eligibility", skuCode: sku.code!, sellableStandalone: true, sellableInSubscription: false }];
  }
  data.rules = { ...data.rules, validateSkuAmounts: amounts => BigInt(amounts.netGrams) <= 9_999_999n };
  if (reason) expect(() => compileCatalogPublication(data)).toThrow(reason);
  else expect(compileCatalogPublication(data).skus.find(value => value.id === sku.id)?.grossMass).toEqual(sku.grossMass ?? null);
});

it.each([
  ["complete structural plan", null],
  ["missing new SKU", "catalog_publication_sku_effect_missing"],
  ["missing unit identifier", "catalog_publication_identifier_effect_missing"],
  ["missing case identifier", "catalog_publication_identifier_effect_missing"],
  ["missing membership", "catalog_publication_membership_effect_missing"],
  ["missing logistics", "catalog_publication_metadata_effect_missing"],
  ["missing presentation", "catalog_publication_presentation_effect_missing"],
] as const)("publication reconciles the sealed structural and activation effects: %s", (mode, reason) => {
  const existing = mode === "missing presentation";
  const data = existing ? retainedPublicationInput() : input();
  const sku = data.payload.skus[0], skuCode = sku.code!, content = data.payload.product.sharedContent;
  if (mode === "missing new SKU") {
    data.payload.skus.push({ ...sku, id: "20000000-0000-4000-8000-000000000002", code: "NEW",
      identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "unit" }] });
  }
  if (mode === "missing unit identifier") data.payload.publication.operations = data.payload.publication.operations.filter(op => op.op !== "create_identifier");
  if (mode === "missing case identifier") sku.identifiers!.push({ scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "case", quantity: 6 });
  if (mode === "missing membership") content.offerMemberships.push({ skuCode, offerVersion: "example:offer", admitted: false });
  if (mode === "missing logistics") sku.logisticsRef = "example:logistics";
  if (mode === "missing presentation") {
    content.presentation = { routePath: { en: "/authored" } };
    sku.logisticsRef = "example:logistics";
    data.payload.publication.operations = [{ op: "set_sku_metadata", skuCode, logisticsRef: sku.logisticsRef }];
  }
  if (reason) expect(() => compileCatalogPublication(data)).toThrow(reason);
  else expect(compileCatalogPublication(data).skus).toMatchObject([{ code: skuCode, identifiers: [{ value: sku.identifiers![0].value }] }]);
});
