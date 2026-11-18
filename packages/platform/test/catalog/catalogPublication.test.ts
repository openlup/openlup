import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { assertCatalogPublicationGrossMass, assertCatalogPublicationPreparation, compileCatalogPublication, publicationJson,
  catalogPublicationIntegralGrams, assertCatalogPublicationMassInputs } from "../../src/catalog/publicationValidation.js";
import { catalogDraftPayloadV3Schema } from "../../src/catalog/draftV3Schemas.js";
import { canonicalCatalogDraftJson } from "../../src/catalog/contracts/draft.js";

import { input, definition, rules } from "./fixtures/publicationInput.js";
it("W32_V5-0597_predicate_precedence_boundary", () => {
  const data = input();
  data.payload.publication.operations.splice(1, 0, { op: "set_product_status", productSlug: "article", status: "active" });
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_product_incomplete");
  data.payload.publication.operations.splice(1, 1);
  data.payload.publication.operations.push({ op: "set_product_status", productSlug: "article", status: "active" });
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_active_primary_required");
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
  data.retainedSources = [foreign]; data.payload.skus = []; delete data.payload.product.primarySkuId;
  data.payload.publication.operations = [{ op: "set_eligibility", skuCode: "ARTICLE", sellableStandalone: false, sellableInSubscription: false }];
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_operation_source_missing");
});

it.each(["declared", "retained", "current draft id", "current revision", "v2 exclusion", "absent SKU", "ambiguous"])(
  "cycle1 operation source selection preserves %s precedence", kind => {
    const data = retainedPublicationInput();
    const claim = (record: typeof data.record) => ({ draftId: record.draftId, revision: record.revision, commandKey: record.commandKey, fingerprint: record.fingerprint });
    const older = { ...structuredClone(data.record), payload: structuredClone(data.payload) }, selected = { ...structuredClone(data.record), payload: structuredClone(data.payload) };
    older.draftId = "30000000-0000-4000-8000-000000000002"; older.revision = kind === "current draft id" ? 3 : 1;
    selected.draftId = kind === "current revision" ? older.draftId : "30000000-0000-4000-8000-000000000003"; selected.revision = 2;
    selected.fingerprint = "c".repeat(64);
    selected.payload.product.sharedContent.requestedModes = [{ skuCode: "ARTICLE", modes: ["one_time"] }];
    data.record = { ...data.record, draftId: kind === "current revision" ? older.draftId : data.record.draftId, revision: 3 };
    data.payload.skus = []; delete data.payload.product.primarySkuId;
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
    if (kind === "absent SKU") expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_operation_source_missing");
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
    const data = input(), operation = data.payload.publication.operations.find(operation => operation.op === "register_document_revision")!;
    if (operation.op !== "register_document_revision") throw new Error("Missing document fixture");
    if (field === "revisionId") operation.revisionId = "40000000-0000-4000-8000-000000000002";
    if (field === "revisionNo") operation.revisionNo = 2;
    if (field === "documentRef") operation.documentRef = "example:other-document";
    if (field === "sourceRef") operation.sourceRef = "example:other-source";
    if (field === "digest") operation.digest = "c".repeat(64);
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
it.each(["absent reference", "wrong digest", "different authored document"])("cycle1 document verification preserves %s refusal", kind => {
  const data = input(), operation = data.payload.publication.operations.find(operation => operation.op === "register_document_revision")!;
  if (operation.op !== "register_document_revision") throw new Error("Missing document fixture");
  if (kind === "absent reference") delete data.payload.product.documentRevision;
  if (kind === "wrong digest") { data.payload.product.documentRevision!.digest = "c".repeat(64); operation.digest = "c".repeat(64); }
  if (kind === "different authored document") data.payload.product.sharedContent.document = { schemaVersion: 1, derived: 13 };
  expect(() => compileCatalogPublication(data)).toThrow(kind === "absent reference" ? "catalog_publication_document_source_mismatch" : "catalog_publication_v3_document_invalid");
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

it.each(["missing modes", "subscription not requested", "subscription omitted"])("cycle1 eligibility binds %s", kind => {
  const data = retainedPublicationInput();
  data.skus[0].grossMass = data.skus[0].netContent; data.skus[0].logisticsRef = "example:logistics";
  data.skus[0].memberships = [{ offerVersion: "example:offer", admitted: true }];
  data.payload.product.sharedContent.requestedModes = kind === "missing modes" ? [] : [{ skuCode: "ARTICLE", modes: kind === "subscription omitted" ? ["subscription"] : [] }];
  data.payload.product.sharedContent.presentation = { label: "Changed" };
  data.payload.publication.operations = [{ op: "set_eligibility", skuCode: "ARTICLE", sellableStandalone: false, sellableInSubscription: kind === "subscription not requested" },
    { op: "set_product_presentation", productSlug: "article", presentation: data.payload.product.sharedContent.presentation }];
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_eligibility_source_mismatch");
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
  data.payload.skus = [{ ...data.payload.skus[0], id: primary.id, code: primary.code, netContent: primary.netContent, options: primary.options,
    grossMass: primary.grossMass!, identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: "5901234123457", packagingLevel: "unit" }] }];
  data.payload.product.sharedContent.requestedModes = [{ skuCode: primary.code, modes: ["one_time"] }];
  data.payload.publication.operations = [{ op: "set_eligibility", skuCode: primary.code, sellableStandalone: true, sellableInSubscription: false }];
  const result = compileCatalogPublication(data);
  expect(result.skus[0].sellableStandalone).toBe(true); expect(result.skus[1].status).toBe("archived");
});
it.each(["standalone", "subscription", "primary", "allowed"])("cycle1 archive guard independently checks %s", kind => {
  const data = publicationWithSecondary(), second = data.skus[1]; second.status = "active";
  second.sellableStandalone = kind === "standalone"; second.sellableInSubscription = kind === "subscription";
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
    expect(compileCatalogPublication(data).changed).toBe(false);
  } else {
    const reference = { ...data.payload.product.documentRevision!, id: "40000000-0000-4000-8000-000000000002", revisionNo: 2 };
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
it.each(["archived SKU", "archived product", "absent identifier", "nonprimary GTIN", "foreign nonprimary identifier", "absent logistics", "absent membership", "declined membership"])(
  "cycle1 final activation readiness refuses %s", kind => {
    const data = publicationWithSecondary(), second = data.skus[1]; second.status = "active"; second.sellableStandalone = true;
    data.payload.publication.kind = "compensation";
    data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
    if (kind === "archived SKU") second.status = "archived";
    if (kind === "archived product") data.payload.publication.operations = [{ op: "set_product_status", productSlug: "article", status: "archived" }];
    if (kind === "absent identifier") second.identifiers = [];
    if (kind === "nonprimary GTIN") second.identifiers[0].isPrimary = false;
    if (kind === "foreign nonprimary identifier") { second.identifiers[0].scheme = "example:identifier"; second.identifiers[0].isPrimary = false; }
    if (kind === "absent logistics") second.logisticsRef = null;
    if (kind === "absent membership") second.memberships = [];
    if (kind === "declined membership") second.memberships[0].admitted = false;
    expect(() => compileCatalogPublication(data)).toThrow(kind.startsWith("archived") ? "catalog_publication_v3_compile_sku_archived" : "catalog_publication_v3_activation_readiness_failed");
  });

it.each(["primary", "document", "presentation"])("cycle1 final completeness independently requires %s", kind => {
  const data = kind === "document" ? retainedPublicationInput() : input();
  if (kind === "document") {
    data.skus = []; data.payload.skus = []; data.product!.document = null;
    delete data.payload.product.primarySkuId; delete data.payload.product.documentRevision; delete data.payload.product.sharedContent.document;
    data.payload.publication.kind = "compensation";
    data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
  } else data.payload.publication.operations = data.payload.publication.operations.filter(operation => operation.op !== (kind === "primary" ? "set_primary_sku" : "set_product_presentation"));
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_structural_readiness_failed");
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
  beforeAll(() => {
    const { data, next } = defaultCapacityInput();
    if (count === 50_001) {
      data.payload.skus = [{ ...data.payload.skus[0], id: next.id, code: next.code, netContent: next.netContent, options: next.options,
        identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "unit" }] }];
      delete data.payload.product.primarySkuId;
      const facts = { skuCode: next.code, title: next.title, minQuantity: next.minQuantity, isAddon: next.isAddon, facts: next.facts };
      data.payload.product.sharedContent.publicationSkus = [facts]; data.payload.product.sharedContent.requestedModes = [{ skuCode: next.code, modes: [] }];
      data.payload.publication.operations = [{ op: "create_sku", productSlug: "article", skuId: next.id, documentRevisionNo: 1, ...facts }];
    }
    try { result = compileCatalogPublication(data); } catch (error) { refusal = error; }
  });
  it("retains the exact admission or refusal", () => {
    if (count === 50_000) { expect(refusal).toBeUndefined(); expect(result?.skus).toHaveLength(50_000); }
    else { expect(result).toBeUndefined(); expect(refusal).toMatchObject({ message: "product_capacity_exceeded" }); }
  });
});

it("cycle1 retained identity lookup preserves the first matching input fact", () => {
  const data = publicationWithSecondary(); data.skus[1].id = data.skus[0].id; data.payload.skus[0].id = data.skus[0].id;
  data.payload.publication.kind = "compensation";
  data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
  let classified = false;
  data.rules = { ...rules, classifySkuChange: (before, after) => {
    classified = true; expect(before).toBe(data.skus[0]); expect(after.code).toBe("SECOND"); return "compatible";
  } };
  expect(compileCatalogPublication(data).changed).toBe(false); expect(classified).toBe(true);
});

it.each(["missing", "archived"])("cycle1 final primary refuses a %s retained SKU", kind => {
  const data = retainedPublicationInput(); data.payload.publication.kind = "compensation";
  data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }];
  if (kind === "missing") { data.skus = []; data.payload.skus = []; delete data.payload.product.primarySkuId; }
  else data.skus[0].status = "archived";
  expect(() => compileCatalogPublication(data)).toThrow("catalog_publication_v3_compile_primary_foreign");
});
it("cycle1 activating a secondary SKU does not activate the draft product", () => {
  const data = publicationWithSecondary();
  data.payload.publication.operations = [{ op: "set_eligibility", skuCode: "SECOND", sellableStandalone: true, sellableInSubscription: false },
    { op: "set_sku_status", skuCode: "SECOND", status: "active" }];
  const result = compileCatalogPublication(data);
  expect(result.product.status).toBe("draft");
  expect(result.skus.find(sku => sku.id === result.product.primarySkuId)?.status).toBe("draft");
  expect(result.skus.find(sku => sku.code === "SECOND")?.status).toBe("active");
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
  ["immutable primary", "catalog_publication_v3_compile_primary_immutable", (data: ReturnType<typeof input>) => {
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
  const data = retainedPublicationInput(); data.payload.skus = []; delete data.payload.product.primarySkuId;
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
  ["archive after primary immutability", "catalog_publication_v3_compile_primary_immutable", () => { const data = publicationWithSecondary(); data.skus[1].status = "archived"; data.payload.product.primarySkuId = data.skus[1].id; data.payload.publication.operations = [{ op: "set_primary_sku", productSlug: "article", skuCode: "SECOND" }]; return data; }],
  ["derived facts after source", "catalog_publication_derived_source_mismatch", () => { const data = retainedPublicationInput(); data.payload.publication.operations = [{ op: "set_derived_sku_facts", skuCode: "ARTICLE", documentRevisionNo: 1, netContent: { ...data.skus[0].netContent, unscaled: "101" }, facts: { derived: 13 } }]; return data; }],
  ["mass after physical classification", "sku_identity_change_requires_new_sku", () => { const data = retainedPublicationInput(); data.payload.skus = []; delete data.payload.product.primarySkuId; data.skus[0].netContent = { dimension: "volume", unit: "openlup:ml", unscaled: "100", scale: 0 }; data.payload.product.attributes = { details: "Changed" }; data.rules = { ...rules, classifySkuChange: () => "inconclusive" }; data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }]; return data; }],
  ["activation after derived facts", "catalog_publication_v3_compile_derived_facts_mismatch", () => { const data = retainedPublicationInput(); data.skus[0].facts = { derived: 13 }; data.skus[0].sellableStandalone = true; data.skus[0].grossMass = data.skus[0].netContent; data.payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: {} }]; return data; }],
] as const)("cycle1 refusal order keeps %s", (_name, reason, prepare) => {
  expect(() => compileCatalogPublication(prepare())).toThrow(reason);
});

it("cycle1 a created SKU uses the selected immutable source facts", () => {
  const data = input(); data.record = { ...data.record, payload: structuredClone(data.payload) };
  data.payload.skus[0].netContent = { ...data.payload.skus[0].netContent!, unscaled: "101" };
  expect(compileCatalogPublication(data).skus[0].netContent).toEqual(data.record.payload.skus[0].netContent);
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
