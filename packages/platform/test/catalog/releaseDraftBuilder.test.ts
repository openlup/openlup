import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { buildCatalogReleaseDraftV3, CatalogReleaseDraftError, catalogProductInputSchema,
  canonicalCatalogDraftJson, catalogInternalGtin, type CatalogProductInput, type CatalogProductSkuInput } from "../../src/catalog/index.js";

const gtin = { scheme: "gs1:gtin", issuer: "starter:example", value: "5901234123457", packagingLevel: "unit" } as const;
const internal = { ...gtin, issuer: "starter:internal", value: catalogInternalGtin(1) };
const alternate = { ...internal, value: catalogInternalGtin(2) };
const grams = { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 } as const;
const title = "Fictional item", skuCode = "STARTER-EXAMPLE", slug = "fictional-item";
const sku = { code: skuCode, title, options: {}, netContent: grams, identifiers: [gtin],
  sell: { oneTime: true, subscription: false } } satisfies CatalogProductSkuInput;
const input = { namespace: "starter", type: { key: "starter:item", version: 42 }, slug, name: title,
  presentation: { title }, skus: [sku] } satisfies CatalogProductInput;
const productId = "0788253f-c8b5-5cf9-a66c-e12655066a3b";
const skuId = "e6f0b7d8-87a9-5106-a485-f04ecd128391";
const revisionId = "de3a843b-ba96-524e-a32f-8bb9a436a67e";
const hash = (data: string) => createHash("sha256").update(data).digest("hex");

it("starter_example_golden", () => {
  const { release: { payload } } = buildCatalogReleaseDraftV3(input);
  const document = { schemaId: "starter:product@1", documentRef: "starter:product/fictional-item", productSlug: slug, revisionNo: 1, name: title };
  const canonicalText = '{"documentRef":"starter:product/fictional-item","name":"Fictional item","productSlug":"fictional-item","revisionNo":1,"schemaId":"starter:product@1"}';
  const digest = hash(canonicalText), sourceRef = "starter:catalogue-products";
  const publicationSku = { skuCode, title, minQuantity: 1, isAddon: false, facts: {} };
  const identifier = { ...gtin, quantity: 1 };
  expect(payload).toEqual({
    schemaVersion: 3,
    product: { id: productId, type: input.type, slug, dimensions: [], primarySkuId: skuId,
      documentRevision: { id: revisionId, productId, revisionNo: 1, schemaId: document.schemaId, documentRef: document.documentRef, sourceRef, digest },
      sharedContent: { schemaVersion: 1, catalogAction: "create", document, presentation: { title }, requestedModes: [],
        offerMemberships: [], publicationSkus: [publicationSku] } },
    skus: [{ id: skuId, productId, code: skuCode, options: {}, netContent: grams, identifiers: [identifier] }],
    publication: { kind: "release", evidence: {}, operations: [
      { op: "create_product", productId, productSlug: slug, name: title },
      { op: "register_document_revision", productSlug: slug, revisionId, revisionNo: 1, documentRef: document.documentRef,
        sourceRef, canonicalText, digest, provenance: { source: "current_draft" } },
      { op: "move_document_pointer", productSlug: slug, documentRevisionNo: 1 },
      { op: "create_sku", productSlug: slug, documentRevisionNo: 1, skuId, ...publicationSku },
      { op: "create_identifier", skuCode, ...identifier, isPrimary: true, label: null, sourceRef: null },
      { op: "set_primary_sku", productSlug: slug, skuCode },
      { op: "set_product_presentation", productSlug: slug, presentation: { title } },
    ] },
  });
});

it("equal_input_gives_byte_equal_output", () => {
  const first = buildCatalogReleaseDraftV3({ ...input, presentation: { title, details: { short: "A", long: "B" } } });
  const second = buildCatalogReleaseDraftV3({ ...input, presentation: { details: { long: "B", short: "A" }, title } });
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  for (const artifact of [first.release, first.activation]) expect(artifact.digest).toBe(hash(canonicalCatalogDraftJson(artifact.payload)));
  expect(first.release.digest).not.toBe(first.activation.digest);
});

it("ids_depend_only_on_namespace_slug_code", () => {
  const netContent = { dimension: "volume", unit: "example:ml", unscaled: "505", scale: 1 } as const;
  const result = buildCatalogReleaseDraftV3({ ...input, name: "Renamed", type: { ...input.type, version: 43 },
    document: { schemaId: "overridden", documentRef: "overridden", productSlug: "overridden", revisionNo: 9, name: "overridden", note: "kept" },
    attributes: { visible: true }, skus: [{ ...sku, title: "Alternate title", netContent, attributes: { visible: true } }] });
  const ids = (artifact: typeof result.release) => [artifact.payload.product.id, artifact.payload.product.documentRevision?.id, artifact.payload.skus[0]?.id];
  for (const [key, artifact] of Object.entries(result)) {
    expect(ids(artifact)).toEqual([productId, revisionId, skuId]);
    expect(artifact.payload.skus[0]).toMatchObject({ netContent, attributes: { visible: true } });
    expect(artifact.payload.skus[0]).not.toHaveProperty("grossMass");
    expect(artifact.payload.product).toMatchObject({ attributes: { visible: true }, sharedContent: { document: {
      schemaId: "starter:product@1", documentRef: "starter:product/fictional-item", productSlug: slug, revisionNo: 1, name: "Renamed", note: "kept",
    } } });
    expect(artifact.digest).not.toBe(buildCatalogReleaseDraftV3(input)[key as keyof typeof result].digest);
  }
  expect(ids(buildCatalogReleaseDraftV3({ ...input, namespace: "other" }).release)).not.toContain(productId);
  expect(ids(buildCatalogReleaseDraftV3({ ...input, slug: "new-item" }).release)).not.toContain(productId);
  expect(ids(buildCatalogReleaseDraftV3({ ...input, skus: [{ ...sku, code: "OTHER" }] }).release)).toEqual([productId, revisionId, expect.not.stringMatching(skuId)]);
});

const secondSku = { ...sku, code: "OTHER", identifiers: [internal] };
const two = { ...input, skus: [{ ...sku, primary: true }, secondSku] };
const withSku = (changes: Record<string, unknown>) => ({ ...input, skus: [{ ...sku, ...changes }] });
const withIdentifiers = (...identifiers: unknown[]) => withSku({ identifiers });
const caseIdentifier = { ...alternate, packagingLevel: "case", label: "Shipping case" } as const;
const nested = (depth: number) => Array.from({ length: depth }).reduce<unknown>((value) => [value], "leaf");
const fix = {
  version: "Set type.version to the installed version of the product type.",
  primarySku: "Mark exactly one SKU with primary: true.",
  missingGtin: "Add a valid unit GS1 GTIN for this SKU. If the product has no GS1 barcode, mint one with catalogInternalGtin using an unused store-local sequence.",
  primaryGtin: "Set isPrimary to true on one valid unit GS1 GTIN and clear it on all other identifiers of this SKU.",
  quantity: "Use quantity 1 for a unit identifier and supply the actual case quantity from 2 to 999999 for a case identifier.",
  gtin: "Enter a valid GTIN for this identifier.",
  duplicateGtin: "Remove the duplicate record or supply a distinct valid GTIN. Leading zeros and issuer changes do not distinguish GTINs.",
  mode: "Enable sell.oneTime, sell.subscription or both for this SKU.",
  code: "Give each SKU of the product a distinct code.",
  offer: "List exactly one offer version in offerVersions for this SKU, or omit offerVersions to use classic.",
  reference: "Shorten namespace or slug until every generated document reference is at most 240 characters.",
  bytes: "Shorten optional product data or reduce the number of SKUs until each draft is at most 1048576 bytes.",
  depth: "Reduce nesting in the named content until the generated draft fits the depth limit of 48.",
  json: "Use plain JSON data in the named field and remove unsupported keys or values.",
  shape: "Correct the field named by path to match catalogProductInputSchema.",
};

it.each([
  ["missing type version", { ...input, type: { key: input.type.key } }, "type.version", fix.version, input],
  ["multiple primary SKUs", { ...two, skus: [two.skus[0], { ...secondSku, primary: true }] }, "skus.1.primary", fix.primarySku, two],
  ["unmarked primary SKU", { ...two, skus: [sku, secondSku] }, "skus", fix.primarySku, two],
  ["missing unit GTIN", withIdentifiers(), "skus.0.identifiers", fix.missingGtin, withIdentifiers(internal)],
  ["ambiguous unit GTIN", withIdentifiers(gtin, internal), "skus.0.identifiers", fix.primaryGtin, withIdentifiers(gtin, { ...internal, isPrimary: true })],
  ["multiple primary GTINs", withIdentifiers({ ...gtin, isPrimary: true }, { ...internal, isPrimary: true }), "skus.0.identifiers.1.isPrimary", fix.primaryGtin, withIdentifiers({ ...gtin, isPrimary: true }, internal)],
  ["primary non-unit identifier", withIdentifiers(gtin, { ...caseIdentifier, quantity: 2, isPrimary: true }), "skus.0.identifiers.1.isPrimary", fix.primaryGtin, withIdentifiers({ ...gtin, isPrimary: true }, { ...caseIdentifier, quantity: 2 })],
  ["primary non-GTIN identifier", withIdentifiers(gtin, { ...internal, scheme: "starter:part", isPrimary: true }), "skus.0.identifiers.1.isPrimary", fix.primaryGtin, withIdentifiers({ ...gtin, isPrimary: true }, { ...internal, scheme: "starter:part" })],
  ["wrong unit quantity", withIdentifiers({ ...gtin, quantity: 2 }), "skus.0.identifiers.0.quantity", fix.quantity, input],
  ["missing case quantity", withIdentifiers(gtin, caseIdentifier), "skus.0.identifiers.1.quantity", fix.quantity, withIdentifiers(gtin, { ...caseIdentifier, quantity: 2 })],
  ["wrong case quantity", withIdentifiers(gtin, { ...caseIdentifier, quantity: 1 }), "skus.0.identifiers.1.quantity", fix.quantity, withIdentifiers(gtin, { ...caseIdentifier, quantity: 999_999 })],
  ["invalid GTIN", withIdentifiers({ ...gtin, value: "5901234123458" }), "skus.0.identifiers.0.value", fix.gtin, input],
  ["duplicate padded GTIN", { ...two, skus: [two.skus[0], { ...secondSku, identifiers: [{ ...gtin, issuer: internal.issuer, value: "0" + gtin.value }] }] }, "skus.1.identifiers.0.value", fix.duplicateGtin, two],
  ["no purchase mode", withSku({ sell: { oneTime: false, subscription: false } }), "skus.0.sell", fix.mode, input],
  ["duplicate SKU code", { ...two, skus: [two.skus[0], { ...secondSku, code: skuCode }] }, "skus.1.code", fix.code, two],
  ["empty offer versions", withSku({ offerVersions: [] }), "skus.0.offerVersions", fix.offer, input],
  ["multiple offer versions", withSku({ offerVersions: ["classic", "other"] }), "skus.0.offerVersions", fix.offer, input],
  ["long generated reference", { ...input, namespace: "a".repeat(240) }, "namespace", fix.reference, input],
  ["long generated document path", { ...input, namespace: "a".repeat(190), slug: "b".repeat(64) }, "slug", fix.reference, { ...input, namespace: "a".repeat(190) }],
  ["oversized artifact", { ...input, presentation: { title: "a".repeat(600_000) } }, "$", fix.bytes, input],
  ["deep document", { ...input, document: { nested: nested(50) } }, "document", fix.depth, input],
  ["deep artifact", { ...input, presentation: { nested: nested(46) } }, "$", fix.depth, input],
  ["invalid JSON", { ...input, document: { privateValue: "PRIVATE-VALUE\u0000" } }, "document", fix.json, input],
  ["invalid SKU shape", withSku({ logisticsRef: "" }), "skus.0.logisticsRef", fix.shape, input],
] as const)("refuses %s and accepts the correction", (_case, bad, path, remedy, repaired) => {
  expect.assertions(8);
  try {
    buildCatalogReleaseDraftV3(bad as CatalogProductInput);
  } catch (error) {
    expect(error).toMatchObject({ code: "release_draft_invalid", path });
    expect(Object.getPrototypeOf(error)).toBe(CatalogReleaseDraftError.prototype);
    expect(Reflect.ownKeys(error as object).filter(key => key !== "stack").sort()).toEqual(["code", "message", "name", "path"]);
    const [observed, ...remedyLines] = (error as Error).message.split("\n");
    expect(observed).toEqual(expect.stringMatching(/^Observed: .* \(\w+ \[redacted\]\)\.$/u));
    expect(observed?.startsWith(`Observed: ${path} (`)).toBe(true);
    expect(remedyLines).toEqual([
      "Cause: The product description does not produce a valid schema version 3 draft.",
      `Fix: ${remedy}`,
      "Recheck: Call buildCatalogReleaseDraftV3 again with the corrected description.",
    ]);
    expect((error as Error).message).not.toContain("PRIVATE-VALUE");
  }
  expect(() => buildCatalogReleaseDraftV3(repaired as CatalogProductInput)).not.toThrow();
});

it.each([0, 1, 10_000, 10_001])("checks the SKU count at %i", count => {
  const skus = Array.from({ length: count }, (_, index) => ({ ...sku, code: String(index), primary: index === 0,
    identifiers: [{ ...internal, value: catalogInternalGtin(index) }] }));
  expect(catalogProductInputSchema.safeParse({ ...input, skus }).success).toBe(count >= 1 && count <= 10_000);
});

it.each([0, 1, 2_147_483_647, 2_147_483_648])("checks minQuantity at %i", minQuantity => {
  const authored = { ...input, skus: [{ ...sku, minQuantity }] };
  if (minQuantity === 0 || minQuantity > 2_147_483_647)
    expect(() => buildCatalogReleaseDraftV3(authored)).toThrowError(expect.objectContaining({ path: "skus.0.minQuantity" }));
  else expect(buildCatalogReleaseDraftV3(authored).release.payload.product.sharedContent.publicationSkus[0]?.minQuantity).toBe(minQuantity);
});

it("admits exactly 1048576 canonical UTF-8 bytes and rejects the next byte", () => {
  const sizedInput = (option: string, presentation: Record<string, string>) => ({
    ...input, presentation, skus: [{ ...sku, options: { padding: { kind: "choice" as const, value: option } } }],
  });
  const bytes = (authored: CatalogProductInput) => Buffer.byteLength(canonicalCatalogDraftJson(buildCatalogReleaseDraftV3(authored).release.payload));
  const baseline = bytes(sizedInput("x", { a: "", b: "" }));
  const option = baseline % 2 === 0 ? "x" : "xx";
  const padding = Math.floor((1_048_576 - baseline) / 2);
  const presentation = { a: "é".repeat(Math.floor(padding / 2)), b: "x".repeat(padding % 2) };
  expect(bytes(sizedInput(option, presentation))).toBe(1_048_576);
  expect(() => buildCatalogReleaseDraftV3(sizedInput(option + "x", presentation)))
    .toThrowError(expect.objectContaining({ path: "$", message: expect.stringContaining(fix.bytes) }));
});

it("activation_is_fixed_revise_subset", () => {
  const grossMass = { ...grams, unscaled: "120" };
  const { release, activation } = buildCatalogReleaseDraftV3({ ...two, skus: [
    { ...two.skus[0]!, logisticsRef: "starter:fulfillment/a", grossMass,
      options: { size: { kind: "choice", value: "one" }, lined: { kind: "boolean", value: false } },
      identifiers: [{ ...gtin, isPrimary: true }, internal, { ...caseIdentifier, quantity: 2 }], minQuantity: 3, isAddon: true, facts: { sample: 1 } },
    { ...secondSku, offerVersions: ["example:member"], logisticsRef: null,
      identifiers: [{ ...internal, value: catalogInternalGtin(3) }], sell: { oneTime: false, subscription: true } },
    { ...secondSku, code: "BOTH", identifiers: [{ ...internal, value: catalogInternalGtin(4) }], sell: { oneTime: true, subscription: true } },
  ] });
  const expected = [
    { skuCode, offerVersion: "classic", admitted: true },
    { skuCode: "OTHER", offerVersion: "example:member", admitted: true },
    { skuCode: "BOTH", offerVersion: "classic", admitted: true },
  ];
  expect(activation.payload.publication).toEqual({ kind: "release", evidence: {}, operations: [
    { op: "set_product_status", productSlug: slug, status: "active" },
    { op: "set_sku_status", skuCode, status: "active" },
    { op: "set_sku_status", skuCode: "OTHER", status: "active" },
    { op: "set_sku_status", skuCode: "BOTH", status: "active" },
    { op: "set_eligibility", skuCode, sellableStandalone: true, sellableInSubscription: false },
    { op: "set_sku_metadata", skuCode, logisticsRef: "starter:fulfillment/a" },
    { op: "set_offer_membership", ...expected[0] },
    { op: "set_eligibility", skuCode: "OTHER", sellableStandalone: false, sellableInSubscription: true },
    { op: "set_offer_membership", ...expected[1] },
    { op: "set_eligibility", skuCode: "BOTH", sellableStandalone: true, sellableInSubscription: true },
    { op: "set_offer_membership", ...expected[2] },
  ] });
  expect(activation.payload.product).toEqual({ ...release.payload.product, dimensions: ["lined", "size"],
    sharedContent: { ...release.payload.product.sharedContent, catalogAction: "revise", offerMemberships: expected,
      requestedModes: [{ skuCode, modes: ["one_time"] }, { skuCode: "OTHER", modes: ["subscription"] }, { skuCode: "BOTH", modes: ["one_time", "subscription"] }] } });
  expect(release.payload.skus[0]).toMatchObject({ grossMass, identifiers: [{ ...gtin, quantity: 1 }, { ...internal, quantity: 1 },
    { scheme: caseIdentifier.scheme, issuer: caseIdentifier.issuer, value: caseIdentifier.value, packagingLevel: "case", quantity: 2 }] });
  expect(release.payload.skus[0]).not.toHaveProperty("logisticsRef");
  expect(activation.payload.skus).toEqual([{ ...release.payload.skus[0], logisticsRef: "starter:fulfillment/a" }, ...release.payload.skus.slice(1)]);
  expect(release.payload.publication.operations[3]).toMatchObject({ op: "create_sku", skuCode, title, minQuantity: 3, isAddon: true, facts: { sample: 1 } });
  expect(release.payload.publication.operations[6]).toMatchObject({ op: "create_identifier", quantity: 2, isPrimary: false, label: "Shipping case", sourceRef: null });
});
