import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { runCatalogExtensionConformance } from "../../src/catalog/testing/index.js";
import { projectCatalogExtensionConformance } from "../../src/catalog/testing/catalogExtensionConformance.js";
import { catalogPackIssues, catalogProductTypeRefIssues, catalogDraftPayloadSchema, validateCatalogDraft, createCatalogProductTypeRegistry,
  validateCatalogAttributes, prepareCatalogAttributeProjection, validateCatalogCombinationChangesV2, canonicalizeCatalogCombinationV2, CatalogCombinationError,
  catalogDraftPayloadV2Schema, catalogDraftPayloadV3Schema, validateCatalogDraftV2, createCatalogDraftHandler, withCatalogPublicationRules } from "../../src/catalog/index.js";
import { artifact } from "./fixtures/publicationInput.js";
import { catalogDraftV3ValidationPayload } from "../../src/catalog/draftV3Schemas.js";
import type { CatalogRefusalFixture } from "../../src/catalog/testing/index.js";
import type { CatalogPackInput, CatalogProductTypeRef, AttributeDefinition, CatalogAttributeInput, CatalogAttributeReferenceResolution } from "../../src/catalog/index.js";

function pack(): CatalogPackInput {
  return { id: "stationery", namespace: "stationery", version: 1, openlupRange: "^0.44.0", capabilities: {}, taxClasses: [{ key: "standard" }], types: [{
    key: "stationery:item", version: 1, units: [{ code: "stationery:each", dimension: "count", integral: true, factor: { canonicalUnit: "openlup:piece", unscaled: "1", scale: 0 } }],
    netContentUnits: ["stationery:each"], dimensions: [], taxClass: "standard", validateContent: () => [],
  }] };
}
const checkSubject = (value: unknown) => runCatalogExtensionConformance(JSON.stringify(value));
function check(value: CatalogPackInput) { return checkSubject({ packs: [{ pack: value }] }); }
const draft = () => ({ schemaVersion: 1 as const, product: { id: "00000000-0000-4000-8000-000000000001", type: { key: "stationery:item", version: 1 }, dimensions: [] }, skus: [] });
const project = (source: unknown) => {
  const projection = projectCatalogExtensionConformance(source);
  return projection.check(projection.subject);
};

describe("trusted catalogue projection", () => {
  it("compares v2 and v3 draft admission and validation to their owners", async () => {
    const p = pack(), base = draft();
    p.types[0].validateContent = () => [{ code: "title_required", path: "title" }];
    const registry = createCatalogProductTypeRegistry(p.types);
    const skuId = "00000000-0000-4000-8000-000000000002";
    const price = { schemaVersion: 1, commandKey: "price:one", variantId: skuId, priceListId: skuId,
      mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 900, expected: { entryId: null, unitPriceMinor: null } };
    const v2 = { ...base, schemaVersion: 2, product: { ...base.product, sharedContent: { title: "" } },
      skus: [{ id: skuId, productId: base.product.id, options: {}, priceOperations: [price] }] };
    const op = { op: "create_product", productId: base.product.id, productSlug: "notebook", name: "Notebook" };
    const v3 = { ...v2, schemaVersion: 3, product: { ...base.product, sharedContent: { schemaVersion: 1, catalogAction: "create",
      presentation: {}, offerMemberships: [], requestedModes: [], publicationSkus: [] } },
      publication: { kind: "release", evidence: {}, operations: [op] } };
    const validDrafts = [catalogDraftPayloadV2Schema.parse(v2), catalogDraftPayloadV3Schema.parse(v3)];
    for (const input of validDrafts) {
      const owner = await validateCatalogDraftV2(input.schemaVersion === 2 ? input : catalogDraftV3ValidationPayload(input), registry);
      expect(owner).toEqual({ valid: false, issues: [{ code: "title_required", path: "product.sharedContent.title" }] });
      const report = await project({ packs: [{ pack: p, drafts: [input] }] });
      expect(report.exitCode).toBe(1);
      expect(report.findings).toEqual([expect.objectContaining({ code: "title_required", path: "/packs/0/drafts/0/product/sharedContent/title" })]);
    }
    for (const broken of [
      { ...v3, publication: { ...v3.publication, operations: [{ ...op, name: 7 }] } },
      { ...v3, skus: [{ ...v3.skus[0], priceOperations: [{ ...price, unitPriceMinor: "900" }] }] },
    ]) {
      const owner = catalogDraftPayloadV3Schema.safeParse(broken);
      expect(owner.success).toBe(false);
      if (owner.success) throw new Error("Invalid v3 admitted");
      const findings = (await project({ packs: [{ pack: p, drafts: [broken] }] })).findings;
      expect(findings.map(({ code, path }) => ({ code, path }))).toEqual(owner.error.issues.map(issue =>
        ({ code: "draft_input_invalid", path: "/packs/0/drafts/0/" + issue.path.join("/") })).sort((a, b) => a.path.localeCompare(b.path)));
    }
  });

  it("keeps the application remedy when a content rule reuses a reference code", async () => {
    const code = "attribute_reference_unresolved";
    const rules = Buffer.from(artifact + `
module.exports.validateContent = content => content.presentation.label === "Invalid label"
  ? [{ code: "${code}", path: "presentation.label" }] : [];
`);
    const bound = withCatalogPublicationRules(pack(), () => rules);
    const base = draft();
    const subject = { ...base, product: { ...base.product, sharedContent: { presentation: { label: "Invalid label" } } } };
    const report = await project({ packs: [{ pack: bound, drafts: [subject] }] });
    const path = "/packs/0/drafts/0/product/sharedContent/presentation/label";
    expect(report.exitCode).toBe(1);
    expect(report.findings).toEqual([expect.objectContaining({
      code, path, fix: `Fix the rule violation ${code} reported by validateContent at ${path}.`,
      recipe: "how-to/extend/catalogue-extension.md#new-vertical",
    })]);
  });

  it("requires executed content per pack and keeps the draft cap per draft", async () => {
    const p = pack(), base = draft();
    const callback = vi.fn(() => []);
    p.types[0].validateContent = callback;
    const requiredChecks = ["draft-content"];
    for (const drafts of [[], [base]]) {
      expect((await project({ packs: [{ pack: p, drafts }], requiredChecks })).exitCode).toBe(2);
    }
    expect(callback).not.toHaveBeenCalled();
    const large = { ...base, product: { ...base.product, sharedContent: "x".repeat(600_000) } };
    expect(catalogDraftPayloadSchema.safeParse(large).success).toBe(true);
    const projected = projectCatalogExtensionConformance({ packs: [{ pack: p, drafts: [large, large] }], requiredChecks });
    expect(Buffer.byteLength(projected.subject)).toBeGreaterThan(1_048_576);
    expect((await projected.check(projected.subject)).exitCode).toBe(0);
    expect(callback).toHaveBeenCalledTimes(2);
    await expect(projected.check(projected.subject + " ")).rejects.toThrow("bytes differ");
    const second = { ...p, namespace: "example", types: [{ ...p.types[0], key: "example:item" }] };
    expect((await project({ packs: [{ pack: p, drafts: [large] }, { pack: second }], requiredChecks })).exitCode).toBe(2);
    expect((await runCatalogExtensionConformance(projected.subject)).exitCode).toBe(2);
  });

  it("refuses non-JSON values without coercion or invoking accessors", () => {
    const getter = vi.fn(() => 0), cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const values = [undefined, NaN, Infinity, -0, 1n, Symbol(), () => [], new Date(0),
      Array(1), Object.assign([0], { extra: true }), { [Symbol()]: 1 }, cycle,
      Object.defineProperty({}, "hidden", { value: 0 }),
      Object.defineProperty({}, "getter", { enumerable: true, get: getter }),
      { packs: { 0: { pack: { types: [{ validateContent: () => [] }] } } } }];
    for (const value of values) expect(() => projectCatalogExtensionConformance({ packs: [], value })).toThrow();
    expect(() => projectCatalogExtensionConformance(values.at(-1))).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it("requires independently executed refusal evidence and measures zero draft apply calls", async () => {
    const p = pack(), base = draft(), payload = { ...base, product: { ...base.product, sharedContent: {} } };
    const issue = { code: "title_required", path: "product.sharedContent.title" };
    p.types[0].validateContent = () => [{ code: issue.code, path: "title" }];
    p.capabilities = { recurring: false };
    const fixture = { name: "local refusal", capability: "recurring", expectedCode: issue.code, observedCode: issue.code, zeroEffects: true };
    const report = await project({ packs: [{ pack: p, refusals: [fixture] }], requiredChecks: ["owner-refusals"] });
    expect(report.exitCode).toBe(2);
    expect(report.findings).toEqual([expect.objectContaining({ code: "conformance_owner_unavailable", path: "/requiredChecks/0" })]);
    const apply = vi.fn();
    const handler = createCatalogDraftHandler({ registry: createCatalogProductTypeRegistry(p.types),
      store: { get: async () => null, list: async () => ({ items: [], nextCursor: null }), apply },
      authorizeOperator: async () => ({ actorId: "operator:proof" }) });
    expect(await handler.execute({ schemaVersion: 1, action: "create", draftId: base.product.id,
      commandKey: "refused", expectedRevision: 0, payload }, {})).toEqual({
      outcome: "validation_issue", reason: "draft_payload_invalid", issues: [issue],
    });
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("offline catalogue conformance", () => {
  it.each([
    { name: "camelCase", key: "recycledCover",
      remedy: /start with a lowercase letter, then use only lowercase letters, digits, underscores or hyphens.*recycled_cover/u },
    { name: "overlong", key: "a".repeat(65), remedy: /1–64 characters/u },
    { name: "reserved", key: "constructor", remedy: /reserved names __proto__, constructor and prototype/u },
  ])("explains how to fix a $name attribute key", async ({ key, remedy }) => {
    const p = pack();
    const attribute: AttributeDefinition = { key, scope: "product", valueType: { kind: "boolean" },
      required: false, cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} };
    p.types[0].attributes = [attribute];

    const report = await check(p);
    expect(report.exitCode).toBe(1);
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "definition_attribute_invalid",
      path: "/packs/0/pack/types/0/attributes/0/key",
      fix: expect.stringMatching(remedy),
    }));

    p.types[0].attributes = [{ ...attribute, key: "recycled_cover" }];
    expect((await check(p)).exitCode).toBe(0);
  });
  it.each([
    { name: "required locale missing from the declared locales",
      valueType: { kind: "localized_text" as const, maxLength: 100, locales: ["en"], requiredLocales: ["pl"] },
      correction: { kind: "localized_text" as const, maxLength: 100, locales: ["en", "pl"], requiredLocales: ["pl"] },
      field: "requiredLocales", remedy: /^Correct the attribute definition at the reported path to match the attribute grammar\b/u },
    { name: "text attribute with inverted bounds",
      valueType: { kind: "text" as const, minLength: 10, maxLength: 3 },
      correction: { kind: "text" as const, minLength: 10, maxLength: 10 },
      field: "maxLength", remedy: /attribute kind, cardinality or bounds/u },
  ])("explains how to fix a $name", async ({ valueType, correction, field, remedy }) => {
    const p = pack();
    const attribute: AttributeDefinition = { key: "description", scope: "product", valueType,
      required: false, cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} };
    p.types[0].attributes = [attribute];

    const report = await check(p);
    expect(report.exitCode).toBe(1);
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "definition_attribute_invalid",
      path: `/packs/0/pack/types/0/attributes/0/valueType/${field}`,
      fix: expect.stringMatching(remedy),
    }));

    p.types[0].attributes = [{ ...attribute, valueType: correction }];
    expect((await check(p)).exitCode).toBe(0);
  });
  it("conformance_reuses_row_validators", async () => {
    const cases: [string, (p: CatalogPackInput) => void][] = [
      ["definition_duplicate_identity", p => { p.types = [...p.types, p.types[0]]; }],
      ["definition_unknown_tax_class", p => { p.types[0].taxClass = "absent"; }],
      ["definition_unknown_profile_ref", p => { p.types[0].subscriptionProfileRef = { key: "stationery:monthly", version: 1 }; }],
      ["definition_unknown_net_content_unit", p => { p.types[0].netContentUnits = ["stationery:absent"]; }],
      ["definition_dimension_invalid", p => { p.types[0].dimensions = Array.from({ length: 17 }, (_, i) => ({ key: `axis${i}`, kind: "boolean" })); }],
      ["definition_facetable_not_filterable", p => { p.types[0].attributes = [{ key: "finish", scope: "variant", valueType: { kind: "boolean" }, required: false, cardinality: { min: 0, max: 1 }, filterable: false, facetable: true, public: true, displayOrder: 0, labels: {} }]; }],
      ["definition_unknown_axis_attribute", p => { p.types[0].dimensions = [{ key: "finish", kind: "boolean" }]; p.types[0].axes = [{ key: "finish", attributeKey: "absent" }]; }],
      ["definition_dimension_invalid", p => { p.types[0].dimensions = [{ key: "finish", kind: "choice", values: Array.from({ length: 1001 }, (_, i) => String(i)) }]; }],
      ["definition_unit_factor_invalid", p => { p.types[0].units[0].factor = { canonicalUnit: "openlup:g", unscaled: "1", scale: 0 }; }],
    ];
    for (const [code, mutate] of cases) {
      const p = pack(); mutate(p);
      expect(catalogPackIssues(p).some(issue => issue.code === code)).toBe(true);
      expect((await check(p)).findings.map(({ code, path }) => ({ code, path }))).toEqual(catalogPackIssues(p).map(issue => ({ ...issue, path: `/packs/0/pack${issue.path}` })).sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)));
    }
    const p = pack();
    const d = draft(); d.product.type.key = "stationery:absent";
    const owner = validateCatalogDraft(d, createCatalogProductTypeRegistry(p.types));
    expect(owner.valid).toBe(false);
    expect((await checkSubject({ packs: [{ pack: p, drafts: [d] }] })).findings[0].code).toBe("type_not_installed");
    const huge = { ...draft(), skus: Array(10001).fill({}) };
    expect(catalogDraftPayloadSchema.safeParse(huge).success).toBe(false);
    expect((await checkSubject({ packs: [{ pack: p, drafts: [huge] }] })).findings.some(f => f.code === "draft_input_invalid")).toBe(true);
    const oversized = { ...draft(), product: { ...draft().product, sharedContent: "x".repeat(1_048_576) } };
    expect(catalogDraftPayloadSchema.safeParse(oversized).success).toBe(false);
    expect((await checkSubject({ packs: [{ pack: p, drafts: [oversized] }] })).findings[0].code).toBe("draft_input_invalid");
    const typeRef = { key: p.types[0].key, version: p.types[0].version };
    const validQuantity = { dimension: "count" as const, unit: "stationery:each", unscaled: "1", scale: 0 };
    const malformedReferences: [unknown, string][] = [
      [{ ...typeRef, version: "1" }, "definition_version_invalid"],
      [{ ...typeRef, version: 0 }, "definition_version_invalid"],
      [{ ...typeRef, version: 1.5 }, "definition_version_invalid"],
      [{ ...typeRef, version: 2_147_483_648 }, "definition_version_invalid"],
      [{ ...typeRef, key: "item" }, "definition_key_invalid"],
      [{ ...typeRef, extra: true }, "definition_unknown_field"],
      [null, "definition_invalid_shape"],
    ];
    for (const [reference, code] of malformedReferences) {
      const ownerIssues = catalogProductTypeRefIssues(reference);
      expect(ownerIssues.some(issue => issue.code === code)).toBe(true);
      const report = (await checkSubject({ packs: [{ pack: p, quantities: [{ type: reference as CatalogProductTypeRef, value: validQuantity }] }] }));
      expect(report.exitCode).toBe(1);
      expect(report.findings.map(({ code, path }) => ({ code, path }))).toEqual(ownerIssues.map(issue => ({ ...issue, path: `/packs/0/quantities/0/type${issue.path}` })));
    }
    expect((await checkSubject({ packs: [{ pack: p, quantities: [{ type: typeRef, value: validQuantity }] }] })).exitCode).toBe(0);
    // Other subject identifiers already enter strict owners before lookup.
    const malformedDraft = { ...draft(), product: { ...draft().product, type: { ...typeRef, version: "1" } } };
    expect(catalogDraftPayloadSchema.safeParse(malformedDraft).success).toBe(false);
    expect((await checkSubject({ packs: [{ pack: p, drafts: [malformedDraft] }] })).findings[0].code).toBe("draft_input_invalid");
    for (const version of [0, -1, 1.5, 2_147_483_648]) {
      const invalidPack = { ...p, version };
      expect(catalogPackIssues(invalidPack)).toContainEqual({ code: "definition_version_invalid", path: "/version" });
      const report = (await check(invalidPack));
      expect(report.exitCode).toBe(1); expect(report.findings[0].code).toBe("definition_version_invalid");
    }
    const quantity = { dimension: "count" as const, unit: "stationery:each", unscaled: "15", scale: 1 };
    expect((await checkSubject({ packs: [{ pack: p, quantities: [{ type: typeRef, value: quantity }] }] })).findings[0].code).toBe("quantity_fractional_count");
    expect((await checkSubject({ packs: [{ pack: p }], requiredChecks: ["taxonomy", "tax-coverage", "profiles", "attribute-values", "variant-combinations"] })).exitCode).toBe(2);
  });
  it("conformance_reuses_row_validators S3b attributes and reference evidence", async () => {
    const p = pack(), id = draft().product.id, type = { key: p.types[0].key, version: 1 };
    const base: AttributeDefinition = { key: "flag", scope: "product", valueType: { kind: "boolean" }, required: false,
      cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} };
    p.types[0].attributes = [base, { ...base, key: "text", valueType: { kind: "text", maxLength: 4096 } },
      { ...base, key: "localized", valueType: { kind: "localized_text", maxLength: 2048, locales: ["en"], requiredLocales: ["en"] } },
      { ...base, key: "required", required: true },
      { ...base, key: "reference", valueType: { kind: "reference", allowlist: ["stationery:related"] } },
      { ...base, key: "list", valueType: { kind: "list", item: { kind: "reference", allowlist: ["stationery:related"] }, min: 0, max: 2 } }];
    const ref = { namespace: "stationery:related", id: "owned" };
    const inputs: [string, CatalogAttributeInput, string?][] = [
      ["scope", { skus: [{ id, attributes: { flag: false } }] }],
      ["unknown key", { productAttributes: { "unknown/~": true }, skus: [{ id }] }],
      ["required value", { skus: [{ id }] }],
      ["required locale", { productAttributes: { required: false, localized: {} }, skus: [{ id }] }],
      ["text 2048 bytes", { productAttributes: { required: true, text: "é".repeat(1024) }, skus: [{ id }] }],
      ["text overflow", { productAttributes: { text: "é".repeat(1025) }, skus: [{ id }] }],
      ["localized byte overflow", { productAttributes: { localized: { en: "é".repeat(1024) } }, skus: [{ id }] }],
      ["storage overflow", { productAttributes: { items: Array(180000).fill(true) }, skus: [{ id }] }],
      ["storage boundary", { productAttributes: { items: "x".repeat(1_048_560) }, skus: [{ id }] }],
      ["revision", { productAttributes: { required: false, flag: false }, skus: [{ id }] }, "0"],
    ];
    const compareOwner = async (name: string, input: CatalogAttributeInput, publicationRevision = "7", references?: CatalogAttributeReferenceResolution[], exitCode?: number) => {
      const prepared = prepareCatalogAttributeProjection(await validateCatalogAttributes(p.types[0], input, { resolve: async () => references ?? [] }), publicationRevision);
      const report = await checkSubject({ packs: [{ pack: p, attributes: [{ type, input, publicationRevision, references }] }] });
      const issues = prepared.prepared ? [] : prepared.issues;
      expect(report.findings.map(({ code, path }) => ({ code, path })), name).toEqual(issues.map(issue => ({ ...issue,
        path: `/packs/0/attributes/0${issue.code === "attribute_publication_revision_invalid" ? "" : "/input"}${issue.path}` })).sort((a,b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)));
      if (exitCode !== undefined) expect(report.exitCode, name).toBe(exitCode);
      return prepared;
    };
    for (const [name, input, revision] of inputs) await compareOwner(name, input, revision);
    const referenceCases: [string, CatalogAttributeReferenceResolution[] | undefined, number][] = [
      ["absent", undefined, 2], ["omitted", [], 2], ["duplicate", [0, 1].map(() => ({ ...ref, status: "private" })), 2],
      ...(["resolved", "dangling", "private", "unavailable"] as const).map(status => [status, [{ ...ref, status }], status === "resolved" ? 0 : status === "unavailable" ? 2 : 1] as [string, CatalogAttributeReferenceResolution[], number]),
    ];
    for (const [name, references, exit] of referenceCases) for (const key of ["reference", "list"]) {
      await compareOwner(`${name} ${key}`, { productAttributes: { required: false, [key]: key === "list" ? [ref] : ref }, skus: [{ id }] }, "7", references, exit);
    }
    const mixed = await checkSubject({ packs: [{ pack: p, attributes: [{ type, publicationRevision: "7",
      input: { productAttributes: { required: true, reference: ref, list: [{ ...ref, id: "other" }] }, skus: [{ id }] }, references: [{ ...ref, status: "private" }] }] }] });
    expect(mixed.exitCode).toBe(1); expect(mixed.findings).toHaveLength(2);
    expect(mixed.findings).toContainEqual(expect.objectContaining({
      code: "attribute_reference_unresolved", path: "/packs/0/attributes/0/input/productAttributes/reference",
      fix: "Resolve the allowlisted batch and remove dangling, private or unavailable references.",
      recipe: "how-to/extend/catalogue-extension.md#add-attribute",
    }));
    const prepared = await compareOwner("projection exactness", { productAttributes: { required: false, text: "é", localized: { en: "Name" } }, skus: [{ id }] }, "7", [], 0);
    expect(prepared).toMatchObject({ prepared: true, rows: expect.arrayContaining([expect.objectContaining({ text_value: "é", publication_revision: "7", sku_id: id }), expect.objectContaining({ text_value: '{"en":"Name"}' })]) });
    const original = p.types[0].attributes;
    p.types[0].attributes = [{ ...base, key: "items", cardinality: { min: 0, max: 180000 }, valueType: { kind: "list", item: { kind: "boolean" }, min: 0, max: 180000 } }];
    for (const count of [174760, 174761]) {
      const prepared = await compareOwner("storage adjacent boundary " + count, { productAttributes: { items: Array(count).fill(true) }, skus: [{ id }] }, "7", [], count === 174760 ? 0 : 1);
      expect(prepared.prepared).toBe(count === 174760);
    }
    p.types[0].attributes = original;
    for (const bytes of [2047, 2048, 2049]) for (const key of ["text", "localized"]) {
      const value = key === "text" ? "x".repeat(bytes) : { en: "x".repeat(bytes - 9) };
      await compareOwner("projection adjacent boundary " + key + bytes, { productAttributes: { required: false, [key]: value }, skus: [{ id }] }, "7", [], bytes <= 2048 ? 0 : 1);
    }
    p.types[0].attributes = [{ ...base, key: "quantity", valueType: { kind: "quantity", dimension: "mass", units: ["openlup:g", "openlup:kg"] } }];
    p.types[0].units = ["g", "kg"].map((unit, i) => ({ code: `openlup:${unit}`, dimension: "mass", integral: false, factor: { canonicalUnit: "openlup:g", unscaled: i ? "1000" : "1", scale: 0 } }));
    p.types[0].netContentUnits = ["openlup:g"];
    for (const [unit, unscaled] of [["openlup:g", "1000"], ["openlup:kg", "1"]]) {
      const prepared = await compareOwner("equivalent quantities", { productAttributes: { quantity: { dimension: "mass", unit, unscaled, scale: 0 } }, skus: [{ id }] }, "7", [], 0);
      expect(prepared).toMatchObject({ prepared: true, rows: [expect.objectContaining({ canonical_unit: "openlup:g", canonical_value: "1000" })] });
    }
  });
  it("conformance_reuses_row_validators S4 combinations", async () => {
    const p = pack(), type = { key: p.types[0].key, version: 1 };
    p.types[0].units = ["g", "kg"].map((unit, i) => ({ code: `openlup:${unit}`, dimension: "mass", integral: false, factor: { canonicalUnit: "openlup:g", unscaled: i ? "1000" : "1", scale: 0 } }));
    p.types[0].netContentUnits = ["openlup:g"];
    p.types[0].attributes = [{ key: "size", scope: "variant", valueType: { kind: "quantity", dimension: "mass", units: ["openlup:g", "openlup:kg"] }, required: false, cardinality: { min: 0, max: 1 }, filterable: true, facetable: true, public: true, displayOrder: 0, labels: {} }];
    p.types[0].dimensions = [{ key: "size", kind: "quantity", dimension: "mass", units: ["openlup:g", "openlup:kg"] }];
    p.types[0].axes = [{ key: "size", attributeKey: "size" }];
    const options = (unit = "openlup:g", unscaled = "1000") => ({ size: { kind: "quantity" as const, value: { dimension: "mass" as const, unit, unscaled, scale: 0 } } });
    const row = { skuId: "one", state: "active" as const, optionValues: options() };
    const base = { typed: true, axes: ["size"], retained: [] as (typeof row)[], incoming: [row] };
    const cases = [
      ["equivalent", { ...base, retained: [row], incoming: [{ ...row, optionValues: options("openlup:kg", "1") }] }],
      ["retained omission", { ...base, retained: [row], incoming: [{ skuId: "one", state: "active" as const }] }],
      ["retained duplicate", { ...base, retained: [row, row] }],
      ["identity change", { ...base, retained: [row], incoming: [{ ...row, optionValues: options("openlup:g", "2000") }] }],
      ["duplicate axes", { ...base, axes: ["size", "size"] }],
      ["missing axis", { ...base, axes: ["absent"] }],
      ["missing option", { ...base, incoming: [{ ...row, optionValues: {} }] }],
      ["unknown option", { ...base, incoming: [{ ...row, optionValues: { ...options(), extra: { kind: "boolean" as const, value: true } } }] }],
      ["duplicate SKU", { ...base, incoming: [row, row] }],
      ["duplicate equivalent option", { ...base, incoming: [row, { ...row, skuId: "two", optionValues: options("openlup:kg", "1") }] }],
      ["capacity", { ...base, capacity: 1, retained: [{ ...row, skuId: "two", state: "withdrawn" as const }] }],
      ["invalid capacity", { ...base, capacity: 0 }],
      ["payload", { ...base, incoming: Array(10001).fill(row) }],
    ] as const;
    for (const [name, input] of cases) {
      let expected: { code: string; path: string }[] = [];
      try { const retained = input.retained.map(row => ({ ...row, identity: canonicalizeCatalogCombinationV2({ definition: p.types[0], axes: input.axes, options: row.optionValues }) }));
        validateCatalogCombinationChangesV2({ ...input, definition: p.types[0], retained }); }
      catch (error) { if (!(error instanceof CatalogCombinationError)) throw error; expected = [{ code: error.code, path: `/packs/0/combinations/0/input/${error.path.replaceAll(".", "/")}` }]; }
      const report = await checkSubject({ packs: [{ pack: p, combinations: [{ type, input }] }], requiredChecks: ["variant-combinations"] });
      expect(report.findings.map(({ code, path }) => ({ code, path })), name).toEqual(expected);
      expect(report.exitCode, name).toBe(expected.length ? 1 : 0);
    }
  });
  it("conformance_requires_refusal_fixture", async () => {
    const p = pack(); p.capabilities = { recurring: false };
    expect((await check(p)).findings[0].code).toBe("conformance_refusal_fixture_missing");
    const fixture: CatalogRefusalFixture = { name: "unsupported", capability: "recurring", expectedCode: "owner_unsupported", observedCode: "owner_unsupported", zeroEffects: true };
    for (const [value, code] of [[fixture, ""], [{ ...fixture, observedCode: "other" }, "conformance_refusal_fixture_mismatch"],
      [{ ...fixture, zeroEffects: false }, "conformance_refusal_fixture_mismatch"], [{ ...fixture, zeroEffects: "true" }, "conformance_refusal_fixture_invalid"], [null, "conformance_refusal_fixture_invalid"], [{ ...fixture, extra: true }, "conformance_refusal_fixture_invalid"]] as const) {
      const report = await checkSubject({ packs: [{ pack: p, refusals: [value] }] });
      expect(report.exitCode).toBe(code ? 1 : 0);
      if (code) expect(report.findings.some(f => f.code === code)).toBe(true);
    }
  });
  it("conformance_does_not_publish_or_seed", async () => {
    const report = await checkSubject({ packs: [{ pack: pack() }] });
    expect(report.exitCode).toBe(0);
    const folder = new URL("../../src/catalog/testing/", import.meta.url);
    for (const name of readdirSync(folder)) expect(readFileSync(new URL(name, folder), "utf8")).not.toMatch(/from ["'](?:node:|pg["'])|\.query\(/u);
    expect(report.boundary).toContain("No database, network, seed or publish path");
    const p = pack(), d = draft();
    const content = { ...d, product: { ...d.product, sharedContent: {} } };
    const unavailable = await checkSubject({ packs: [{ pack: p, drafts: [content] }] });
    expect(unavailable.exitCode).toBe(2); expect(unavailable.findings[0]).toMatchObject({ code: "conformance_owner_unavailable", path: "/packs/0/drafts/0/product/sharedContent" });
    const supplied = JSON.parse(JSON.stringify({ packs: [{ pack: p }] })); supplied.packs[0].pack.types[0].validateContent = "callback";
    expect((await checkSubject(supplied)).findings).toEqual([expect.objectContaining({ code: "definition_unknown_field", path: "/packs/0/pack/types/0/validateContent" })]);
  });
  it("non_string_direct_input_is_not_inspected_or_assimilated", async () => {
    const inspect = vi.fn(() => { throw Error("must not inspect"); });
    const promise = Promise.resolve(true); Object.defineProperty(promise, "constructor", { get: inspect });
    const species = Promise.resolve(true); Object.defineProperty(species, "constructor", { value: Object.defineProperty({}, Symbol.species, { get: inspect }) });
    const values = [promise, species, new Proxy({}, { get: inspect, ownKeys: inspect, getPrototypeOf: inspect }), Object("{}"), Object.defineProperty({}, "packs", { get: inspect }), () => true, new Uint8Array(), new (class {})()];
    const cycle: Record<string, unknown> = {}; cycle.self = cycle; values.push(cycle);
    for (const value of values) {
      const report = await runCatalogExtensionConformance(value as unknown as string);
      expect(report.exitCode).toBe(1); expect(report.findings).toEqual([expect.objectContaining({ code: "conformance_subject_invalid", path: "" })]);
    }
    expect(inspect).not.toHaveBeenCalled();
  });
  // Local ~2.9 s; worst observed CI 10.17 s; 30 s gives about 3x CI headroom for actual CLI invocations.
  it("catalogue_check_cli_reports_stable_codes_and_exit", async () => {
    const folder = mkdtempSync(join(tmpdir(), "catalogue-cli-"));
    const bin = fileURLToPath(new URL("../../src/lifecycle/openlup.mjs", import.meta.url)), file = join(folder, "catalogue.json");
    const call = (args: string[], nodeArgs: string[] = []) => {
      const result = spawnSync(process.execPath, [...nodeArgs, bin, ...args, "--json"], { encoding: "utf8" });
      expect(result.stderr).not.toMatch(/SENSITIVE_CRYPTO_FAILURE|ERR_OSSL_EVP_UNSUPPORTED|SENSITIVE_HASH_SYNTAX|draft_json_invalid|combination_identity_integrity_failed/u);
      const report = JSON.parse(result.stdout); expect(report.formatVersion).toBe(1); expect(report.exitCode).toBe(result.status);
      expect(result.stdout.trim().split("\n")).toHaveLength(1); return report;
    };
    const args = ["catalogue", "check", "--packs", file];
    try {
      for (const [subject, exit] of [[{ packs: [{ pack: pack() }] }, 0], [{ packs: [{ pack: pack() }], requiredChecks: ["taxonomy", "tax-coverage", "profiles", "promotions", "publication"] }, 2], [{ packs: [] }, 1]] as const) {
        writeFileSync(file, JSON.stringify(subject)); const report = call(args); expect(report.exitCode).toBe(exit); expect(call(args)).toEqual(report);
      }
      expect(call(["verify", "--packs", file]).exitCode).toBe(64);
      expect(call(["upgrade", "plan", "--packs", file]).exitCode).toBe(64);
      for (const flag of ["--app", "--root", "--from", "--to", "--schema-version"]) expect(call([...args, flag, "unused"]).exitCode).toBe(64);
      const source = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(folder, "effect"))}, "effect"); export default {packs:[]}; // SENSITIVE_LOAD_DETAIL`;
      writeFileSync(file, source);
      await expect(runCatalogExtensionConformance(source)).rejects.toBeInstanceOf(SyntaxError);
      const refused = call(args); expect(refused.exitCode).toBe(64); expect(JSON.stringify(refused)).not.toContain("SENSITIVE_LOAD_DETAIL");
      expect(readdirSync(folder)).toEqual(["catalogue.json"]);
      expect(call(["catalogue", "check", "--packs", join(folder, "absent")]).exitCode).toBe(74);
      const p = pack(), type = { key: p.types[0].key, version: 1 };
      for (const name of ["incoming", "retained"]) for (const row of [{}, null, { skuId: "one", state: "active", optionValues: [] }, { skuId: "one", state: "active", optionValues: null, identity: {} }]) {
        const subject = { packs: [{ pack: p, combinations: [{ type, input: { axes: [], typed: true, retained: [], incoming: [], [name]: [row] } }] }] };
        const text = JSON.stringify(subject); writeFileSync(file, text);
        for (const report of [await runCatalogExtensionConformance(text), call(args)]) {
          expect(report.exitCode).toBe(1); expect(report.findings).toEqual([expect.objectContaining({ code: "conformance_subject_invalid", path: `/packs/0/combinations/0/input/${name}/0` })]);
        }
      }
      const quantity = { dimension: "count", unit: "stationery:each", unscaled: "1", scale: 0 };
      const refusals: [string, unknown, string, string, (() => unknown)?][] = [];
      for (const [name, value, field] of [
        ["dimension toString null", { ...quantity, dimension: { toString: null } }, "dimension"],
        ["dimension toString number", { ...quantity, dimension: { toString: 1 } }, "dimension"],
        ["dimension array", { ...quantity, dimension: [] }, "dimension"],
        ["unit object", { ...quantity, unit: {} }, "unit"],
        ["unscaled object", { ...quantity, unscaled: {} }, "unscaled"],
        ["scale object", { ...quantity, scale: {} }, "scale"],
        ["scale fractional", { ...quantity, scale: 0.5 }, "scale"],
        ["quantity extra field", { ...quantity, extra: true }, ""],
        ["quantity array", [], ""],
      ] as const) refusals.push([name, { packs: [{ pack: p, quantities: [{ type, value }] }] }, "quantity_invalid", `/packs/0/quantities/0/value${field ? "/" + field : ""}`]);
      refusals.push(["target unit object", { packs: [{ pack: p, quantities: [{ type, value: quantity, targetUnit: {} }] }] }, "quantity_invalid", "/packs/0/quantities/0/targetUnit"]);
      for (const [name, id, retained] of [["NUL choice ID", "\u0000", false], ["unpaired surrogate ID", "\ud800", false], ["owner exception on retained input never becomes 74", "\u0000", true]] as const) {
        const invalidPack = pack(), definition = invalidPack.types[0];
        definition.dimensions = [{ key: "choice", kind: "choice", values: [id] }];
        definition.attributes = [{ key: "choice", scope: "variant", valueType: { kind: "enum", values: [{ id }] }, required: false,
          cardinality: { min: 0, max: 1 }, filterable: true, facetable: true, public: true, displayOrder: 0, labels: {} }];
        definition.axes = [{ key: "choice", attributeKey: "choice" }];
        const options = { choice: { kind: "choice" as const, value: id } };
        expect(catalogPackIssues(invalidPack), name).toEqual([]); // Existing owner inconsistency, not checker policy.
        const throws = () => canonicalizeCatalogCombinationV2({ definition, axes: ["choice"], options });
        const row = { skuId: "one", state: "active", optionValues: options };
        refusals.push([name, { packs: [{ pack: invalidPack, combinations: [{ type, input: { typed: true, axes: ["choice"], incoming: retained ? [] : [row], retained: retained ? [row] : [] } }] }] },
          "draft_json_invalid", "/packs/0/combinations/0/input", throws]);
      }
      refusals.push(["allowlisted owner quantity input code", { packs: [{ pack: p, quantities: [{ type, value: { ...quantity, scale: -1 } }] }] }, "quantity_invalid", "/packs/0/quantities/0/value"]);
      for (const [name, data, code, path, throws] of refusals) {
        if (throws) expect(throws, name).toThrow("draft_json_invalid");
        const recheck = "npx --no -- openlup " + [...args, "--json"].join(" ");
        const text = JSON.stringify({ ...data as object, recheck }); writeFileSync(file, text);
        const direct = await runCatalogExtensionConformance(text);
        const { formatVersion, command, ...cli } = call(args);
        expect(formatVersion).toBe(1); expect(command).toBe("catalogue check");
        expect(cli, name).toEqual(direct); expect(direct.exitCode, name).toBe(1);
        expect(direct.findings, name).toEqual([expect.objectContaining({ code, path })]);
      }
      const valid = { packs: [{ pack: p, combinations: [{ type, input: { typed: true, axes: [], retained: [], incoming: [{ skuId: "one", state: "active", optionValues: {} }] } }] }] };
      const validText = JSON.stringify(valid); writeFileSync(file, validText);
      expect((await runCatalogExtensionConformance(validText)).exitCode).toBe(0);
      expect(call(args).exitCode).toBe(0);
      const fault = Object.assign(new Error("SENSITIVE_CRYPTO_FAILURE"), { code: "ERR_OSSL_EVP_UNSUPPORTED" });
      const originalHash = crypto.createHash;
      let rejection: unknown;
      try {
        crypto.createHash = (() => { throw fault; }) as typeof crypto.createHash;
        syncBuiltinESMExports();
        try { await runCatalogExtensionConformance(validText); } catch (error) { rejection = error; }
      } finally { crypto.createHash = originalHash; syncBuiltinESMExports(); }
      expect(rejection).toBe(fault); // Operational exceptions retain their exact identity.
      const preload = 'import crypto from "node:crypto"; import {syncBuiltinESMExports} from "node:module"; crypto.createHash = () => { throw Object.assign(new Error("SENSITIVE_CRYPTO_FAILURE"), {code:"ERR_OSSL_EVP_UNSUPPORTED"}); }; syncBuiltinESMExports();';
      const operational = call(args, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`]);
      expect(operational.exitCode).toBe(74);
      expect(operational.findings).toEqual([expect.objectContaining({ code: "OPENLUP_E_CLI_FAILURE" })]);
      expect(JSON.stringify(operational)).not.toMatch(/SENSITIVE_CRYPTO_FAILURE|ERR_OSSL_EVP_UNSUPPORTED/u);
      const collisionPack = pack(), definition = collisionPack.types[0];
      definition.dimensions = [{ key: "flag", kind: "boolean" }];
      definition.attributes = [{ key: "flag", scope: "variant", valueType: { kind: "boolean" }, required: false,
        cardinality: { min: 0, max: 1 }, filterable: true, facetable: true, public: true, displayOrder: 0, labels: {} }];
      definition.axes = [{ key: "flag", attributeKey: "flag" }];
      const collisionText = JSON.stringify({ packs: [{ pack: collisionPack, combinations: [{ type, input: { typed: true, axes: ["flag"], retained: [],
        incoming: [true, false].map((value, index) => ({ skuId: `sku${index}`, state: "active", optionValues: { flag: { kind: "boolean", value } } })) } }] }] });
      writeFileSync(file, collisionText);
      expect((await runCatalogExtensionConformance(collisionText)).exitCode).toBe(0);
      expect(call(args).exitCode).toBe(0);
      rejection = undefined;
      try {
        crypto.createHash = (...args) => { const hash = originalHash(...args); Object.defineProperty(hash, "digest", { value: () => Buffer.alloc(32) }); return hash; };
        syncBuiltinESMExports();
        try { await runCatalogExtensionConformance(collisionText); } catch (error) { rejection = error; }
      } finally { crypto.createHash = originalHash; syncBuiltinESMExports(); }
      expect(rejection).toBeInstanceOf(CatalogCombinationError);
      expect(rejection).toMatchObject({ code: "combination_identity_integrity_failed" });
      const collisionPreload = 'import crypto from "node:crypto"; import {syncBuiltinESMExports} from "node:module"; const original = crypto.createHash; crypto.createHash = (...args) => { const hash = original(...args); Object.defineProperty(hash,"digest",{value:()=>Buffer.alloc(32)}); return hash; }; syncBuiltinESMExports();';
      const collision = call(args, ["--import", `data:text/javascript,${encodeURIComponent(collisionPreload)}`]);
      expect(collision.exitCode).toBe(74);
      expect(collision.findings).toEqual([expect.objectContaining({ code: "OPENLUP_E_CLI_FAILURE" })]);
      expect(JSON.stringify(collision)).not.toContain("combination_identity_integrity_failed");
      writeFileSync(file, validText);
      const syntaxFault = new SyntaxError("draft_json_invalid");
      rejection = undefined;
      try {
        crypto.createHash = (() => { throw syntaxFault; }) as typeof crypto.createHash;
        syncBuiltinESMExports();
        try { await runCatalogExtensionConformance(validText); } catch (error) { rejection = error; }
      } finally { crypto.createHash = originalHash; syncBuiltinESMExports(); }
      expect(rejection).toBe(syntaxFault);
      expect(Object.hasOwn(syntaxFault, Symbol.for("openlup.catalogue.json.parse"))).toBe(false);
      const syntaxPreload = 'import crypto from "node:crypto"; import {syncBuiltinESMExports} from "node:module"; crypto.createHash = () => { throw new SyntaxError("draft_json_invalid"); }; syncBuiltinESMExports();';
      const operationalSyntax = call(args, ["--import", `data:text/javascript,${encodeURIComponent(syntaxPreload)}`]);
      expect(operationalSyntax.exitCode).toBe(74);
      expect(operationalSyntax.findings).toEqual([expect.objectContaining({ code: "OPENLUP_E_CLI_FAILURE" })]);
      expect(JSON.stringify(operationalSyntax)).not.toContain("draft_json_invalid");
      const subject = { packs: [{ pack: p }], recheck: "identical command" }; p.types = [...p.types, p.types[0]];
      const report = await checkSubject(subject); expect(report).toEqual(await checkSubject(subject));
      for (const finding of report.findings) expect(finding).toMatchObject({ recheck: subject.recheck, severity: "error", fix: expect.any(String), recipe: expect.any(String), evidence: expect.any(Object) });
    } finally { rmSync(folder, { recursive: true, force: true }); }
  }, 30_000);
});
