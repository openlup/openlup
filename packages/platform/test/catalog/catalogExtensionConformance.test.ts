import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runCatalogExtensionConformance } from "../../src/catalog/testing/index.js";
import { catalogPackIssues, catalogProductTypeRefIssues, catalogDraftPayloadSchema, validateCatalogDraft, createCatalogProductTypeRegistry,
  validateCatalogAttributes, prepareCatalogAttributeProjection, validateCatalogCombinationChangesV2, canonicalizeCatalogCombinationV2, CatalogCombinationError } from "../../src/catalog/index.js";
import type { CatalogConformanceSubject, CatalogRefusalFixture } from "../../src/catalog/testing/index.js";
import type { CatalogAttributeInput, CatalogAttributeReferencePort, AttributeDefinition, CatalogPackInput, CatalogProductTypeRef } from "../../src/catalog/index.js";

function pack(): CatalogPackInput {
  return { id: "stationery", namespace: "stationery", version: 1, openlupRange: "^0.44.0", capabilities: {}, taxClasses: [{ key: "standard" }], types: [{
    key: "stationery:item", version: 1, units: [{ code: "stationery:each", dimension: "count", integral: true, factor: { canonicalUnit: "openlup:piece", unscaled: "1", scale: 0 } }],
    netContentUnits: ["stationery:each"], dimensions: [], taxClass: "standard", validateContent: () => [],
  }] };
}
async function check(value: CatalogPackInput) { return (await runCatalogExtensionConformance({ packs: [{ pack: value }] })); }
const draft = () => ({ schemaVersion: 1 as const, product: { id: "00000000-0000-4000-8000-000000000001", type: { key: "stationery:item", version: 1 }, dimensions: [] }, skus: [] });

describe("offline catalogue conformance", () => {
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
    expect((await runCatalogExtensionConformance({ packs: [{ pack: p, drafts: [d] }] })).findings[0].code).toBe("type_not_installed");
    const huge = { ...draft(), skus: Array(10001).fill({}) };
    expect(catalogDraftPayloadSchema.safeParse(huge).success).toBe(false);
    expect((await runCatalogExtensionConformance({ packs: [{ pack: p, drafts: [huge] }] })).findings.some(f => f.code === "draft_input_invalid")).toBe(true);
    const reserved = pack(); reserved.types[0].validateContent = () => [{ code: "conformance_owner_unavailable", path: "title" }];
    const content = { ...draft(), product: { ...draft().product, sharedContent: {} } };
    expect((await runCatalogExtensionConformance({ packs: [{ pack: reserved, drafts: [content] }] })).exitCode).toBe(1);
    const oversized = { ...draft(), product: { ...draft().product, sharedContent: "x".repeat(1_048_576) } };
    expect(catalogDraftPayloadSchema.safeParse(oversized).success).toBe(false);
    expect((await runCatalogExtensionConformance({ packs: [{ pack: p, drafts: [oversized] }] })).findings[0].code).toBe("draft_input_invalid");
    const typeRef = { key: p.types[0].key, version: p.types[0].version };
    const validQuantity = { dimension: "count" as const, unit: "stationery:each", unscaled: "1", scale: 0 };
    const malformedReferences: [unknown, string][] = [
      [{ ...typeRef, version: "1" }, "definition_version_invalid"],
      [{ ...typeRef, version: Object(1) }, "definition_version_invalid"],
      [{ ...typeRef, version: 0 }, "definition_version_invalid"],
      [{ ...typeRef, version: 1.5 }, "definition_version_invalid"],
      [{ ...typeRef, version: 2_147_483_648 }, "definition_version_invalid"],
      [{ ...typeRef, key: "item" }, "definition_key_invalid"],
      [{ ...typeRef, key: Object(typeRef.key) }, "definition_key_invalid"],
      [{ ...typeRef, extra: true }, "definition_unknown_field"],
      [null, "definition_invalid_shape"],
    ];
    for (const [reference, code] of malformedReferences) {
      const ownerIssues = catalogProductTypeRefIssues(reference);
      expect(ownerIssues.some(issue => issue.code === code)).toBe(true);
      const report = (await runCatalogExtensionConformance({ packs: [{ pack: p, quantities: [{ type: reference as CatalogProductTypeRef, value: validQuantity }] }] }));
      expect(report.exitCode).toBe(1);
      expect(report.findings.map(({ code, path }) => ({ code, path }))).toEqual(ownerIssues.map(issue => ({ ...issue, path: `/packs/0/quantities/0/type${issue.path}` })));
    }
    expect((await runCatalogExtensionConformance({ packs: [{ pack: p, quantities: [{ type: typeRef, value: validQuantity }] }] })).exitCode).toBe(0);
    // Other subject identifiers already enter strict owners before lookup.
    const malformedDraft = { ...draft(), product: { ...draft().product, type: { ...typeRef, version: "1" } } };
    expect(catalogDraftPayloadSchema.safeParse(malformedDraft).success).toBe(false);
    expect((await runCatalogExtensionConformance({ packs: [{ pack: p, drafts: [malformedDraft] }] })).findings[0].code).toBe("draft_input_invalid");
    for (const version of [0, -1, 1.5, 2_147_483_648]) {
      const invalidPack = { ...p, version };
      expect(catalogPackIssues(invalidPack)).toContainEqual({ code: "definition_version_invalid", path: "/version" });
      const report = (await check(invalidPack));
      expect(report.exitCode).toBe(1); expect(report.findings[0].code).toBe("definition_version_invalid");
    }
    const quantity = { dimension: "count" as const, unit: "stationery:each", unscaled: "15", scale: 1 };
    expect((await runCatalogExtensionConformance({ packs: [{ pack: p, quantities: [{ type: typeRef, value: quantity }] }] })).findings[0].code).toBe("quantity_fractional_count");
    const baseAttribute: AttributeDefinition = { key: "flag", scope: "product", valueType: { kind: "boolean" },
      required: false, cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} };
    const ap = pack();
    ap.types[0].attributes = [baseAttribute,
      { ...baseAttribute, key: "text", valueType: { kind: "text", maxLength: 4096 } },
      { ...baseAttribute, key: "reference", valueType: { kind: "reference", allowlist: ["stationery:related"] } }];
    const id = draft().product.id;
    const attributes: [string, CatalogAttributeInput, CatalogAttributeReferencePort?][] = [
      ["attribute_unknown_key", { productAttributes: { "unknown/~key": true }, skus: [{ id }] }],
      ["attribute_scope_conflict", { skus: [{ id, attributes: { flag: true } }] }],
      ["attribute_value_invalid", { productAttributes: { flag: "true" }, skus: [{ id }] }],
      ["attribute_projection_text_too_large", { productAttributes: { text: "é".repeat(1025) }, skus: [{ id }] }],
      ["attribute_storage_too_large", { productAttributes: { items: Array(180000).fill(true) }, skus: [{ id }] }],
      ["attribute_reference_unresolved", { productAttributes: { reference: { namespace: "stationery:related", id: "absent" } }, skus: [{ id }] }],
    ];
    for (const [code, input, references] of attributes) {
      const owner = prepareCatalogAttributeProjection(await validateCatalogAttributes(ap.types[0], input, references), "7");
      expect(owner.prepared, code).toBe(false);
      if (owner.prepared) throw Error("expected owner refusal");
      expect(owner.issues.some(issue => issue.code === code), code).toBe(true);
      const report = await runCatalogExtensionConformance({ packs: [{ pack: ap, attributes: [{ type: typeRef, input, references, publicationRevision: "7" }] }] });
      expect(report.exitCode).toBe(code === "attribute_reference_unresolved" ? 2 : 1);
      expect(report.findings.map(({ code, path }) => ({ code, path }))).toEqual(owner.issues.map(issue => ({ ...issue, path: `/packs/0/attributes/0/input${issue.path}` })).sort((a,b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)));
    }
    const referenceFixture = { type: typeRef, input: { productAttributes: { reference: { namespace: "stationery:related", id: "owned" } }, skus: [{ id }] },
      publicationRevision: "7", references: { resolve: async () => [{ namespace: "stationery:related", id: "owned", status: "resolved" as const }] } };
    const referenceReport = await runCatalogExtensionConformance({ packs: [{ pack: ap, attributes: [referenceFixture] }] });
    expect(referenceReport.exitCode).toBe(0);
    expect(await runCatalogExtensionConformance({ packs: [{ pack: ap, attributes: [referenceFixture] }] })).toEqual(referenceReport);
    const referenceCases: [string, CatalogAttributeReferencePort | undefined, 0 | 1 | 2][] = [
      ["absent", undefined, 2],
      ["unavailable", { resolve: async refs => refs.map(ref => ({ ...ref, status: "unavailable" })) }, 2],
      ["rejected", { resolve: async () => { throw Error("offline evidence unavailable"); } }, 2],
      ["omitted", { resolve: async () => [] }, 2],
      ["ambiguous", { resolve: async refs => [0, 1].map(() => ({ ...refs[0], status: "private" })) }, 2],
      ["dangling", { resolve: async refs => refs.map(ref => ({ ...ref, status: "dangling" })) }, 1],
      ["private", { resolve: async refs => refs.map(ref => ({ ...ref, status: "private" })) }, 1],
      ["resolved", referenceFixture.references, 0],
    ];
    for (const [name, references, exitCode] of referenceCases) {
      const fixture = { ...referenceFixture, references };
      const owner = prepareCatalogAttributeProjection(await validateCatalogAttributes(ap.types[0], fixture.input, references), "7");
      const report = await runCatalogExtensionConformance({ packs: [{ pack: ap, attributes: [fixture] }] });
      expect(report.exitCode, name).toBe(exitCode);
      expect(report.state, name).toBe(exitCode === 0 ? "satisfied" : exitCode === 1 ? "violated" : "unavailable");
      if (owner.prepared) expect(report.findings).toEqual([]);
      else {
        expect(owner.issues).toEqual([{ code: "attribute_reference_unresolved", path: "/productAttributes/reference" }]);
        expect(report.findings).toEqual([expect.objectContaining({ code: "attribute_reference_unresolved", path: "/packs/0/attributes/0/input/productAttributes/reference" })]);
      }
    }
    const referenceData = () => ({ reference: { namespace: "stationery:related", id: "owned" } });
    const snapshotCases: [string, CatalogAttributeInput, string, string][] = [
      ["non-enumerable own field", Object.defineProperty({ skus: [{ id }] }, "productAttributes", { value: referenceData() }), "attribute_reference_unresolved", "/productAttributes/reference"],
      ["null prototype", Object.assign(Object.create(null), { skus: [{ id }], productAttributes: referenceData() }), "attribute_reference_unresolved", "/productAttributes/reference"],
      ["getter rejected", Object.defineProperty({ skus: [{ id }] }, "productAttributes", { get: referenceData }), "attribute_values_invalid", ""],
      ["inherited field rejected", Object.assign(Object.create({ productAttributes: referenceData() }), { skus: [{ id }] }), "attribute_values_invalid", ""],
      ["symbol rejected", { skus: [{ id }], productAttributes: referenceData(), [Symbol("hidden")]: true }, "attribute_values_invalid", ""],
    ];
    for (const [name, input, code, path] of snapshotCases) {
      const references: CatalogAttributeReferencePort = { resolve: async refs => refs.map(ref => ({ ...ref, status: "private" })) };
      const owner = await validateCatalogAttributes(ap.types[0], input, references);
      expect(owner, name).toMatchObject({ valid: false, issues: [{ code, path }] });
      const report = await runCatalogExtensionConformance({ packs: [{ pack: ap, attributes: [{ type: typeRef, input, references, publicationRevision: "7" }] }] });
      expect(report.state, name).toBe("violated"); expect(report.exitCode, name).toBe(1);
      expect(report.findings).toEqual([expect.objectContaining({ code, path: `/packs/0/attributes/0/input${path}` })]);
    }
    const mixedPack = pack();
    mixedPack.types[0].attributes = ["private", "unknown"].map(key => ({ ...baseAttribute, key, valueType: { kind: "reference", allowlist: ["stationery:related"] } }));
    const mixedInput = { productAttributes: { private: { namespace: "stationery:related", id: "private" }, unknown: { namespace: "stationery:related", id: "unknown" } }, skus: [{ id }] };
    const mixed = await runCatalogExtensionConformance({ packs: [{ pack: mixedPack, attributes: [{ type: typeRef, input: mixedInput, publicationRevision: "7",
      references: { resolve: async refs => refs.map(ref => ({ ...ref, status: ref.id === "private" ? "private" : "unavailable" })) } }] }] });
    expect(mixed.exitCode).toBe(1); // A proven violation retains precedence over unavailable evidence.
    expect(mixed.findings.map(({ code, path }) => ({ code, path }))).toEqual(["private", "unknown"].map(key => ({ code: "attribute_reference_unresolved", path: `/packs/0/attributes/0/input/productAttributes/${key}` })));
    const complete = { productAttributes: { flag: false }, skus: [{ id }] };
    const prepared = prepareCatalogAttributeProjection(await validateCatalogAttributes(ap.types[0], complete), "7");
    expect(prepared).toMatchObject({ prepared: true, rows: [{ bool_value: false, publication_revision: "7", sku_id: id }] });
    expect((await runCatalogExtensionConformance({ packs: [{ pack: ap, attributes: [{ type: typeRef, input: complete, publicationRevision: "7" }] }], requiredChecks: ["attribute-values"] })).exitCode).toBe(0);
    expect((await runCatalogExtensionConformance({ packs: [{ pack: ap, attributes: [{ type: typeRef, input: complete, publicationRevision: "0" }] }] })).findings).toContainEqual(expect.objectContaining({ code: "attribute_publication_revision_invalid", path: "/packs/0/attributes/0/publicationRevision" }));
    const missing = pack(); missing.types[0].attributes = [{ ...baseAttribute, required: true }];
    expect((await runCatalogExtensionConformance({ packs: [{ pack: missing, attributes: [{ type: typeRef, input: { skus: [{ id }] }, publicationRevision: "7" }] }] })).findings[0].code).toBe("attribute_required_missing");
    const cp = pack();
    cp.types[0].units = [
      { code: "openlup:g", dimension: "mass", integral: false, factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 0 } },
      { code: "openlup:kg", dimension: "mass", integral: false, factor: { canonicalUnit: "openlup:g", unscaled: "1000", scale: 0 } }];
    cp.types[0].netContentUnits = ["openlup:g"];
    cp.types[0].attributes = [{ ...baseAttribute, key: "size", scope: "variant", valueType: { kind: "quantity", dimension: "mass", units: ["openlup:g", "openlup:kg"] } }];
    cp.types[0].dimensions = [{ key: "size", kind: "quantity", dimension: "mass", units: ["openlup:g", "openlup:kg"] }];
    cp.types[0].axes = [{ key: "size", attributeKey: "size" }];
    const options = (unit = "openlup:g", unscaled = "1000") => ({ size: { kind: "quantity" as const, value: { dimension: "mass" as const, unit, unscaled, scale: 0 } } });
    const combination: Omit<Parameters<typeof validateCatalogCombinationChangesV2>[0], "definition"> = { typed: true, axes: ["size"], retained: [], incoming: [{ skuId: id, state: "active" as const, optionValues: options() }] };
    const combinationCases: [string, typeof combination, string][] = [
      ["axis_not_installed", { ...combination, axes: ["absent"] }, "/axes/absent"],
      ["duplicate_axis", { ...combination, axes: ["size", "size"] }, "/axes/size"],
      ["option_missing", { ...combination, incoming: [{ ...combination.incoming[0], optionValues: {} }] }, "/options/size"],
      ["duplicate_sku_id", { ...combination, incoming: [combination.incoming[0], combination.incoming[0]] }, `/${id}`],
      ["duplicate_combination", { ...combination, incoming: [...combination.incoming, { skuId: "other", state: "active", optionValues: options("openlup:kg", "1") }] }, "/other"],
    ];
    for (const [code, input, expectedPath] of combinationCases) {
      let owner: CatalogCombinationError | undefined;
      try { validateCatalogCombinationChangesV2({ ...input, definition: cp.types[0] }); }
      catch (error) { if (!(error instanceof CatalogCombinationError)) throw error; owner = error; }
      expect(owner?.code).toBe(code);
      expect(`/${owner!.path.replaceAll(".", "/")}`).toBe(expectedPath);
      const report = await runCatalogExtensionConformance({ packs: [{ pack: cp, combinations: [{ type: typeRef, input }] }] });
      expect(report.exitCode).toBe(1);
      expect(report.findings).toEqual([expect.objectContaining({ code, path: `/packs/0/combinations/0/input${expectedPath}`, recipe: "how-to/extend/catalogue-extension.md#add-axis" })]);
    }
    const hiddenCapacity = Object.defineProperty({ ...combination }, "capacity", { value: 0, enumerable: false });
    expect(() => validateCatalogCombinationChangesV2(Object.assign(Object.create(hiddenCapacity), { definition: cp.types[0] }))).toThrow("product_capacity_invalid");
    const hiddenReport = await runCatalogExtensionConformance({ packs: [{ pack: cp, combinations: [{ type: typeRef, input: hiddenCapacity }] }] });
    expect(hiddenReport.exitCode).toBe(1);
    expect(hiddenReport.findings).toEqual([expect.objectContaining({ code: "product_capacity_invalid", path: "/packs/0/combinations/0/input/capacity" })]);
    const hiddenUnknown = Object.defineProperty({ packs: [{ pack: p }] }, "notAdmitted", { value: true });
    expect((await runCatalogExtensionConformance(hiddenUnknown)).findings).toEqual([expect.objectContaining({ code: "conformance_subject_invalid", path: "" })]);
    const projectionFixtures = [options().size.value, options("openlup:kg", "1").size.value].map(value => ({
      type: typeRef, input: { skus: [{ id, attributes: { size: value } }] }, publicationRevision: "7" }));
    for (const fixture of projectionFixtures) {
      const rows = prepareCatalogAttributeProjection(await validateCatalogAttributes(cp.types[0], fixture.input), "7");
      expect(rows).toMatchObject({ prepared: true, rows: [{ canonical_unit: "openlup:g", canonical_value: "1000" }] });
    }
    expect((await runCatalogExtensionConformance({ packs: [{ pack: cp, attributes: projectionFixtures }] })).exitCode).toBe(0);
    const firstIdentity = canonicalizeCatalogCombinationV2({ definition: cp.types[0], axes: ["size"], options: options() });
    expect(canonicalizeCatalogCombinationV2({ definition: cp.types[0], axes: ["size"], options: options("openlup:kg", "1") })).toEqual(firstIdentity);
    expect((await runCatalogExtensionConformance({ packs: [{ pack: cp, combinations: [{ type: typeRef, input: combination }] }], requiredChecks: ["variant-combinations"] })).exitCode).toBe(0);
    for (const check of ["taxonomy", "tax-coverage", "profiles", "promotions"]) {
      expect((await runCatalogExtensionConformance({ packs: [{ pack: cp }], requiredChecks: [check] })).exitCode).toBe(2);
    }
    expect((await runCatalogExtensionConformance({ packs: [{ pack: p }], requiredChecks: ["taxonomy", "tax-coverage", "profiles", "attribute-values", "variant-combinations"] })).exitCode).toBe(2);
  });
  it("conformance_requires_refusal_fixture", async () => {
    const p = pack(); p.capabilities = { recurring: false };
    expect((await check(p)).findings[0].code).toBe("conformance_refusal_fixture_missing");
    const fixture: CatalogRefusalFixture = { name: "unsupported", capability: "recurring", expectedCode: "owner_unsupported", run: () => ({ code: "owner_unsupported" }), assertZeroEffects: () => true };
    const run = async () => (await runCatalogExtensionConformance({ packs: [{ pack: p, refusals: [fixture] }] }));
    expect((await run()).exitCode).toBe(0);
    const malformedRun = vi.fn(() => ({ code: "owner_unsupported" }));
    const malformed = { ...fixture, capability: Object("recurring") as string, run: malformedRun };
    const malformedReport = (await runCatalogExtensionConformance({ packs: [{ pack: p, refusals: [fixture, malformed] }] }));
    expect(malformedReport.exitCode).toBe(1);
    expect(malformedReport.findings).toContainEqual(expect.objectContaining({ code: "conformance_refusal_fixture_invalid", path: "/packs/0/refusals/1" }));
    expect(malformedRun).not.toHaveBeenCalled();
    fixture.run = () => ({ code: "other" }); expect((await run()).exitCode).toBe(1);
    fixture.run = () => ({ code: "owner_unsupported" }); fixture.assertZeroEffects = () => false; expect((await run()).exitCode).toBe(1);
    expect((await runCatalogExtensionConformance({ packs: [] })).exitCode).toBe(1);
    expect((await runCatalogExtensionConformance({ packs: Array(1) })).exitCode).toBe(1);
  });
  it("conformance_links_variant_combination_owner_codes", async () => {
    const p = pack();
    p.types[0].validateContent = () => {
      try { canonicalizeCatalogCombinationV2({ definition: p.types[0], axes: ["absent"], options: {} }); }
      catch (error) {
        if (!(error instanceof CatalogCombinationError)) throw error;
        return [{ code: error.code, path: error.path }];
      }
      return [];
    };
    const d = { ...draft(), product: { ...draft().product, sharedContent: {} } };
    const report = (await runCatalogExtensionConformance({ packs: [{ pack: p, drafts: [d] }] }));
    expect(report.exitCode).toBe(1);
    expect(report.findings).toEqual([expect.objectContaining({ code: "axis_not_installed",
      path: "/packs/0/drafts/0/product/sharedContent/axes/absent", recipe: "how-to/extend/catalogue-extension.md#add-axis" })]);
    expect((await runCatalogExtensionConformance({ packs: [{ pack: p }], requiredChecks: ["variant-combinations"] })).exitCode).toBe(2);
  });
  it("conformance_does_not_publish_or_seed", async () => {
    const p = pack(); p.capabilities = { publish: false };
    const publish = vi.fn(), seed = vi.fn();
    const report = (await runCatalogExtensionConformance({ packs: [{ pack: p, refusals: [{ name: "refused", capability: "publish", expectedCode: "publish_unsupported", run: () => ({ code: "publish_unsupported" }), assertZeroEffects: () => publish.mock.calls.length === 0 && seed.mock.calls.length === 0 }] }] }));
    expect(report.exitCode).toBe(0); expect(publish).not.toHaveBeenCalled(); expect(seed).not.toHaveBeenCalled();
    const folder = new URL("../../src/catalog/testing/", import.meta.url);
    for (const name of readdirSync(folder)) expect(readFileSync(new URL(name, folder), "utf8")).not.toMatch(/from ["'](?:node:|pg["'])|\.query\(/u);
    expect(report.boundary).toContain("not sandboxed");
  });
  it("catalogue_check_cli_reports_stable_codes_and_exit", async () => {
    const p = pack(); p.types = [...p.types, p.types[0]];
    const input: CatalogConformanceSubject = { packs: [{ pack: p }], recheck: "identical command" };
    const folder = mkdtempSync(join(tmpdir(), "catalogue-cli-"));
    const bin = fileURLToPath(new URL("../../src/lifecycle/openlup.mjs", import.meta.url));
    const module = join(folder, "catalogue.ts");
    const call = (args: string[]) => {
      const result = spawnSync(process.execPath, [bin, ...args, "--json"], { encoding: "utf8" });
      const report = JSON.parse(result.stdout);
      expect(report.formatVersion).toBe(1); expect(report.exitCode).toBe(result.status);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      return report;
    };
    try {
      const p = pack();
      const source = `const pack = ${JSON.stringify(p)}; pack.types[0].validateContent = () => []; export default {packs:[{pack}]};`;
      writeFileSync(module, source);
      expect(call(["catalogue", "check", "--packs", module]).exitCode).toBe(0);
      writeFileSync(module, source.replace("{packs:[{pack}]}", '{packs:[{pack}],requiredChecks:["taxonomy"]}'));
      expect(call(["catalogue", "check", "--packs", module]).exitCode).toBe(2);
      writeFileSync(module, "export default {packs:[]};");
      expect(call(["catalogue", "check", "--packs", module]).exitCode).toBe(1);
      expect(call(["verify", "--packs", module]).exitCode).toBe(64);
      writeFileSync(module, 'throw Error("SENSITIVE_LOAD_DETAIL");');
      const failed = call(["catalogue", "check", "--packs", module]);
      expect(failed.exitCode).toBe(74); expect(JSON.stringify(failed)).not.toContain("SENSITIVE_LOAD_DETAIL");
    } finally { rmSync(folder, { recursive: true, force: true }); }
    const a = (await runCatalogExtensionConformance(input)), b = (await runCatalogExtensionConformance(input));
    expect(a).toEqual(b); expect(a.exitCode).toBe(1);
    for (const finding of a.findings) {
      expect(finding.recheck).toBe(input.recheck);
      for (const key of ["code", "observed", "cause", "fix", "recipe", "path", "severity", "evidence"]) expect(finding).toHaveProperty(key);
    }
  });
});
