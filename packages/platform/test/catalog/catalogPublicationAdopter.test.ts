import { createHash } from "node:crypto";
import { compileCatalogPublication } from "../../src/catalog/publicationValidation.js";
import { canonicalCatalogDraftJson } from "../../src/catalog/contracts/draft.js";
import { input } from "./fixtures/publicationInput.js";
import { expect, it } from "vitest";
import { catalogOfferMembershipSchema, catalogProductPresentationSchema, catalogSkuMetadataSchema } from "./fixtures/categoryMembership.js";
import { categoryDocument } from "./fixtures/categoryDocumentInput.js";
import { productDocumentV1Schema, productDocumentV2Schema, canonicalizeProductDocument } from "./fixtures/categoryDocument.js";

// Multiple mechanical sites share the complete installed category contract.
// Every alias executes the same boundary matrix; none is a distinct-guard count.
const witnesses = [
  "W04_V5-0671_predicate_precedence_boundary",
  "W04_V5-0672_predicate_precedence_boundary",
  "W04_V5-0673_predicate_precedence_boundary",
  "W04_V5-0674_predicate_precedence_boundary",
  "W04_V5-0675_predicate_precedence_boundary",
  "W04_V5-0676_predicate_precedence_boundary",
  "W04_V5-0677_predicate_precedence_boundary",
  "W04_V5-0678_predicate_precedence_boundary",
  "W04_V5-0679_predicate_precedence_boundary",
  "W04_V5-0680_predicate_precedence_boundary",
  "W04_V5-1804_predicate_precedence_boundary",
  "W04_V5-1805_predicate_precedence_boundary",
  "W04_V5-1806_predicate_precedence_boundary",
  "W04_V5-1807_predicate_precedence_boundary",
  "W04_V5-1808_predicate_precedence_boundary",
  "W04_V5-1809_predicate_precedence_boundary",
  "W05_V5-1810_predicate_precedence_boundary",
  "W05_V5-1811_predicate_precedence_boundary",
  "W05_V5-1812_predicate_precedence_boundary",
  "W05_V5-1813_predicate_precedence_boundary",
  "W05_V5-1814_predicate_precedence_boundary",
  "W05_V5-1815_predicate_precedence_boundary",
  "W05_V5-1816_predicate_precedence_boundary",
  "W05_V5-1817_predicate_precedence_boundary",
  "W05_V5-1818_predicate_precedence_boundary",
  "W05_V5-1819_predicate_precedence_boundary",
  "W05_V5-1820_predicate_precedence_boundary",
  "W05_V5-1821_predicate_precedence_boundary",
  "W05_V5-1822_predicate_precedence_boundary",
  "W05_V5-1823_predicate_precedence_boundary",
  "W06_V5-1824_predicate_precedence_boundary",
  "W06_V5-1825_predicate_precedence_boundary",
  "W06_V5-1826_predicate_precedence_boundary",
  "W06_V5-1827_predicate_precedence_boundary",
  "W06_V5-1828_predicate_precedence_boundary",
  "W06_V5-1829_predicate_precedence_boundary",
  "W06_V5-1830_predicate_precedence_boundary",
  "W06_V5-1831_predicate_precedence_boundary",
  "W06_V5-1832_predicate_precedence_boundary",
  "W06_V5-1833_predicate_precedence_boundary",
  "W06_V5-1834_predicate_precedence_boundary",
  "W06_V5-1835_predicate_precedence_boundary",
  "W06_V5-1836_predicate_precedence_boundary",
  "W06_V5-1837_predicate_precedence_boundary",
  "W06_V5-1838_predicate_precedence_boundary",
  "W06_V5-1839_predicate_precedence_boundary",
  "W06_V5-1840_predicate_precedence_boundary",
  "W06_V5-1841_predicate_precedence_boundary",
  "W06_V5-1842_predicate_precedence_boundary"
] as const;
it.each(witnesses)("%s", () => {
  const original = categoryDocument();
  expect(productDocumentV1Schema.safeParse(original).success).toBe(true);
  const invalid: unknown[] = [null, [], { ...original, extra: true }];
  const changed = (path: string, value: unknown) => {
    const copy = structuredClone(original) as unknown as Record<string, unknown>;
    const parts = path.split("."); let parent = copy;
    for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
    parent[parts.at(-1)!] = value; invalid.push(copy);
  };
  for (const [path, values] of [
    ["schemaVersion", ["unknown", 1]], ["id", ["", " "]], ["revisionNo", [0, -1, 1.5]], ["productSlug", ["", "Upper", "has space"]],
    ["names", [{ pl: "Only" }, { en: "Only" }, { pl: "", en: "Example" }, { pl: "a".repeat(1001), en: "Example" }]],
    ["facts.species", ["unknown"]], ["facts.lifeStage", ["unknown"]], ["facts.foodType", ["unknown"]],
    ["facts.madeIn", ["pl", "POL"]], ["facts.manufacturer", [null]], ["facts.approvalNumber", [""]],
    ["facts.allergenSlugs", [["a", "a"], ["Upper"]]], ["energy.unscaled", [0, -1, 1.5]], ["energy.scale", [1]], ["energy.unit", ["unknown"]],
    ["composition", [[], "wrong"]], ["composition.0.ordinal", [0, 1.5]], ["composition.0.ingredientKey", ["Upper"]],
    ["composition.0.declaredShare.unscaled", [-1, 10001]], ["composition.0.declaredShare.scale", [2]], ["composition.0.declaredShare.unit", ["unknown"]],
    ["composition.0.proteinBase", ["true"]], ["feedingGuide", [[]]], ["feedingGuide.0.band", [0]],
    ["feedingGuide.0.dogWeightKg", [{ min: 5, max: 1 }, { min: -1, max: 1 }]], ["feedingGuide.0.dailyFeedG", [{ min: 5, max: 1 }]],
    ["sources", [[]]], ["sources.0.kind", ["unknown"]], ["sources.0.sha256", ["A".repeat(64), "a"]],
    ["claims.0.sourceIds", [[], ["missing"], ["label_v1", "label_v1"]]], ["claims.0.statement", [{ en: "Only" }]],
    ["copy.ingredientCards.0.sourceIds", [["missing"]]], ["copy.ingredientCards.0.allergenSlugs", [["a", "a"]]],
    ["copy.ingredientCards.0.claimPill", ["unlocalized"]], ["copy.ingredientCards.0.role", [{ pl: "Only" }]],
    ["copy.ingredientCards.0.nameKey", ["unsafe:value", " catalog:product.valid"]],
    ["copy.faq.0.sourceIds", [["missing"]]], ["copy.faq.0.question", [{ pl: "Only" }]],
    ["copy.callouts.0.kind", ["unknown"]], ["copy.callouts.0.sourceIds", [["missing"]]], ["copy.callouts.0.title", [{ pl: "Only" }]],
  ] as [string, unknown[]][]) for (const value of values) changed(path, value);
  for (const path of ["composition", "feedingGuide", "sources", "claims", "copy.ingredientCards", "copy.faq", "copy.callouts"]) {
    const value = path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], original);
    changed(path, [...value as unknown[], ...value as unknown[]]);
  }
  const component = { parentIngredientKey: "missing", ordinal: 1, componentKey: "component", labels: { pl: "Part", en: "Part" }, declaredShare: null };
  changed("components", [component]);
  changed("additives", [{ ordinal: 1, additiveKey: "a", labels: { pl: "A", en: "A" }, quantity: { unscaled: 0, scale: 0, unit: "MG_PER_KG" } }]);
  for (const [path, limit, seed] of [
    ["composition", 100, original.composition[0]], ["components", 200, { ...component, parentIngredientKey: "ingredient_a" }],
    ["additives", 100, { ordinal: 1, additiveKey: "a", labels: { pl: "A", en: "A" }, quantity: { unscaled: 1, scale: 0, unit: "MG_PER_KG" } }],
    ["feedingGuide", 32, original.feedingGuide[0]], ["sources", 64, original.sources[0]], ["claims", 64, original.claims[0]],
    ["copy.ingredientCards", 64, original.copy.ingredientCards[0]], ["copy.faq", 64, original.copy.faq[0]], ["copy.callouts", 64, original.copy.callouts[0]],
  ] as [string, number, Record<string, unknown>][]) {
    const rows = Array.from({ length: limit + 1 }, (_, index) => ({ ...seed,
      ...(Object.hasOwn(seed, "ordinal") ? { ordinal: index + 1 } : {}), ...(Object.hasOwn(seed, "band") ? { band: index + 1 } : {}),
      ...(Object.hasOwn(seed, "key") ? { key: `item_${index}` } : {}), ...(Object.hasOwn(seed, "id") ? { id: index === 0 ? "label_v1" : `source_${index}` } : {}),
    }));
    const boundary = structuredClone(original) as unknown as Record<string, unknown>, parts = path.split(".");
    let parent = boundary; for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
    parent[parts.at(-1)!] = rows.slice(0, limit);
    expect(productDocumentV1Schema.safeParse(boundary).success, `${path} upper bound`).toBe(true);
    changed(path, rows);
  }
  for (const value of invalid) expect(productDocumentV1Schema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  // Components deliberately do not acquire ordinal uniqueness.
  const valid = { ...original, components: [component, { ...component, componentKey: "another" }].map(row => ({ ...row, parentIngredientKey: "ingredient_a" })) };
  expect(productDocumentV1Schema.safeParse(valid).success).toBe(true);
  const current = { ...original, schemaVersion: "example.product-document.v2", productSlug: "current-recipe" };
  expect(productDocumentV2Schema.safeParse(current).success).toBe(true);
  expect(productDocumentV2Schema.safeParse({ ...current, facts: { ...current.facts, species: "cat" } }).success).toBe(false);
  expect(productDocumentV2Schema.safeParse({ ...current, productSlug: "a".repeat(81) }).success).toBe(false);
  expect(productDocumentV2Schema.safeParse({ ...current, claims: [{ ...current.claims[0], sourceIds: ["missing"] }] }).success).toBe(false);
  const parsed = productDocumentV1Schema.parse(original);
  expect(parsed.copy.ingredientCards[0].claimPill).toBeNull();
  expect(canonicalizeProductDocument(parsed)).toBe(canonicalizeProductDocument(original));
});

it.each([
  "W09_V5-0421_predicate_precedence_boundary",
  "W09_V5-0422_predicate_precedence_boundary",
  "W09_V5-0423_predicate_precedence_boundary"
])("%s", () => {
  const member = { skuCode: "ARTICLE-ONE", offerVersion: "classic", admitted: true };
  expect(catalogOfferMembershipSchema.safeParse(member).success).toBe(true);
  for (const changed of [{ admitted: false }, { skuCode: "ARTICLE-NEW" }, { offerVersion: "unknown" }, { skuCode: "lower" }, { admitted: "true" }, { extra: true }])
    expect(catalogOfferMembershipSchema.safeParse({ ...member, ...changed }).success).toBe(false);
  expect(catalogOfferMembershipSchema.safeParse({ skuCode: "ARTICLE-NEW", offerVersion: "sized.v1", admitted: false }).success).toBe(true);
  const presentation = { routePath: { pl: "/psy/article", en: "/dogs/article" }, shortName: { pl: "Artykuł", en: "Article" }, advertisedWeightsG: [100, 200], mediaRef: "example:media", accent: "#abcdef" };
  expect(catalogProductPresentationSchema.safeParse(presentation).success).toBe(true);
  for (const changed of [{ advertisedWeightsG: [200, 100] }, { advertisedWeightsG: [100, 100] }, { advertisedWeightsG: [0] },
    { advertisedWeightsG: [1.5] }, { advertisedWeightsG: [10_000_000] }, { routePath: { pl: "/wrong/article", en: "/dogs/article" } },
    { shortName: { pl: "", en: "Article" } }, { accent: "red" }, { mediaRef: " ref " }, { extra: true }])
    expect(catalogProductPresentationSchema.safeParse({ ...presentation, ...changed }).success).toBe(false);
  expect(catalogSkuMetadataSchema.safeParse({ skuCode: "ARTICLE-ONE", logisticsRef: "example:logistics" }).success).toBe(true);
  for (const logisticsRef of [null, "", " ref ", "x".repeat(501)])
    expect(catalogSkuMetadataSchema.safeParse({ skuCode: "ARTICLE-ONE", logisticsRef }).success).toBe(false);
});

const analysisKeys = ["crudeProtein", "crudeFat", "moisture", "crudeAsh", "crudeFibre"] as const;
it.each([
  ["healthy", null],
  ["net ceiling", "catalog_publication_authored_amounts_invalid"],
  ["add-on", "catalog_publication_adopter_validation_failed"],
  ["net ceiling and add-on", "catalog_publication_authored_amounts_invalid"],
  ["additive scale", "catalog_publication_v3_document_invalid"],
  ...analysisKeys.map(key => [key, "catalog_publication_v3_document_invalid"] as const),
] as const)("ordered publication enforces the installed category predicate for %s", (mode, refusal) => {
  const fixture = categoryDocument(), source = input(), sku = source.payload.skus[0], product = source.payload.product;
  const document = { ...fixture, schemaVersion: "example.product-document.v2", productSlug: product.slug!, name: "Synthetic article",
    additives: [{ ordinal: 1, additiveKey: "a", labels: { pl: "A", en: "A" }, quantity: { unscaled: 1,
      scale: mode === "additive scale" ? 5 : 4, unit: "MG_PER_KG" } }],
    analyticsAsFed: { ...fixture.analyticsAsFed } as Partial<typeof fixture.analyticsAsFed> };
  if ((analysisKeys as readonly string[]).includes(mode)) delete document.analyticsAsFed[mode as typeof analysisKeys[number]];
  const addon = mode === "add-on" || mode === "net ceiling and add-on";
  const grams = mode.startsWith("net ceiling") ? "10000000" : "9999999";
  sku.netContent = { dimension: "mass", unit: "openlup:g", unscaled: grams, scale: 0 };
  product.sharedContent.publicationSkus[0].isAddon = addon;
  product.sharedContent.document = document;
  const canonicalText = canonicalCatalogDraftJson(document), digest = createHash("sha256").update(canonicalText).digest("hex");
  Object.assign(product.documentRevision!, { schemaId: document.schemaVersion, documentRef: document.id, digest });
  for (const op of source.payload.publication.operations) {
    if (op.op === "create_sku") op.isAddon = addon;
    if (op.op === "register_document_revision") Object.assign(op, { documentRef: document.id, canonicalText, digest });
  }
  source.rules = { ...source.rules,
    deriveSkuFacts: () => ({ derived: 12 }),
    identifyDocument: () => ({ schemaId: document.schemaVersion, documentRef: document.id, productSlug: document.productSlug, revisionNo: document.revisionNo }),
    canonicalizeDocument(value) {
      const { name: _name, ...category } = value as typeof document;
      productDocumentV2Schema.parse(category);
      return canonicalCatalogDraftJson(value);
    },
    validateSkuAmounts: ({ netGrams }) => BigInt(netGrams) <= 9_999_999n,
    validateProduct: (_product, skus) => skus.some(sku => sku.isAddon) ? ["package_unsupported"] : [],
  };
  if (refusal) expect(() => compileCatalogPublication(source)).toThrow(refusal);
  else expect(compileCatalogPublication(source).skus).toMatchObject([{ isAddon: false, netContent: sku.netContent }]);
});
