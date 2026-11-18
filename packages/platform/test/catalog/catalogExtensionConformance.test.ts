import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { projectCatalogExtensionConformance, runCatalogExtensionConformance } from "../../src/catalog/testing/index.js";
import { catalogPackIssues, catalogProductTypeRefIssues, catalogDraftPayloadSchema, validateCatalogDraft, createCatalogProductTypeRegistry,
  validateCatalogAttributes, prepareCatalogAttributeProjection, validateCatalogCombinationChangesV2, canonicalizeCatalogCombinationV2, CatalogCombinationError } from "../../src/catalog/index.js";
import type { CatalogRefusalFixture } from "../../src/catalog/testing/index.js";
import type { CatalogPackInput, CatalogProductTypeRef, AttributeDefinition, CatalogAttributeInput, CatalogAttributeReferenceResolution } from "../../src/catalog/index.js";
import { input as publicationFixture } from "./fixtures/publicationInput.js";

function pack(): CatalogPackInput {
  return { id: "stationery", namespace: "stationery", version: 1, openlupRange: "^0.44.0", capabilities: {}, taxClasses: [{ key: "standard" }], types: [{
    key: "stationery:item", version: 1, units: [{ code: "stationery:each", dimension: "count", integral: true, factor: { canonicalUnit: "openlup:piece", unscaled: "1", scale: 0 } }],
    netContentUnits: ["stationery:each"], dimensions: [], taxClass: "standard", validateContent: () => [],
  }] };
}
const checkSubject = (value: unknown) => runCatalogExtensionConformance(JSON.stringify(value));
function check(value: CatalogPackInput) { return checkSubject({ packs: [{ pack: value }] }); }
const draft = () => ({ schemaVersion: 1 as const, product: { id: "00000000-0000-4000-8000-000000000001", type: { key: "stationery:item", version: 1 }, dimensions: [] }, skus: [] });

const profileRef = { key: "example:delivery", version: 1 };
const samplePack = {
  id: "example", namespace: "example", version: 1, openlupRange: "^0.44.0",
  capabilities: { prepaid: false }, taxClasses: [],
  subscriptionProfiles: [profileRef],
  subscriptionProfileDefinitions: [{
    ...profileRef, allowedCadenceDays: [28, 120], quantities: { minBaseUnits: 1, maxBaseUnits: 4, maxUnitsPerLine: 4, maxBaseLines: 2 },
    addons: { allowedTypeRefs: [], maxLines: 0, maxUnits: 0 }, swapGroupKeys: [],
    consumption: { kind: "fixed_units" }, prepaid: "unsupported",
  }],
  types: [{ ...publicationFixture().definition, subscriptionProfileRef: profileRef,
    validateContent(content: unknown) {
      if (content && typeof content === "object" && "document" in content && content.document
        && typeof content.document === "object" && "derived" in content.document && typeof content.document.derived === "number") return [];
      return [{ code: "value_required", path: "document.derived" }];
    },
  }],
} satisfies CatalogPackInput;

function transportEntry() {
  const { payload } = publicationFixture();
  const type = payload.product.type, id = payload.skus[0].id;
  return {
    pack: samplePack,
    drafts: [3, 4, 5].map(schemaVersion => ({ ...structuredClone(payload), schemaVersion })),
    attributes: [{ type, input: { skus: [{ id }] }, publicationRevision: "1" }],
    combinations: [{ type, input: { axes: [], typed: true, retained: [], incoming: [] } }],
    profileChecks: [{ cadenceDays: 120, lines: [{ id, type, quantity: 1 }] }],
    refusals: [{ name: "prepaid", capability: "prepaid", expectedCode: "prepaid_unsupported", observedCode: "prepaid_unsupported", zeroEffects: true }],
  };
}

it("catalogue_transport_matrix RP2-D-002 canonicalizes object key order and binds exact bytes", async () => {
  const { drafts: _drafts, ...entry } = transportEntry();
  const source = { packs: [entry], requiredChecks: ["profiles"] };
  const reordered = { requiredChecks: source.requiredChecks, packs: [{ ...entry, pack: {
    ...entry.pack, types: [{ ...entry.pack.types[0], labels: { en: "Notebook", fr: "Carnet" } }],
  } }] };
  const reverseLabels = { ...reordered, packs: [{ ...reordered.packs[0], pack: {
    ...reordered.packs[0].pack, types: [{ ...reordered.packs[0].pack.types[0], labels: { fr: "Carnet", en: "Notebook" } }],
  } }] };
  const projected = projectCatalogExtensionConformance(reordered);
  expect(projectCatalogExtensionConformance(reverseLabels).subject).toBe(projected.subject);
  await expect(projected.check(projected.subject + " ")).rejects.toThrow("Projected subject bytes differ");
});

describe("catalogue_required_owner_matrix", () => {
  it.each([
    ["exact count", "count", "stationery:each", "1", 0, undefined, undefined],
    ["exact mass", "mass", "stationery:gram", "9", 0, "stationery:triplet", undefined],
    ["unknown unit", "count", "stationery:missing", "1", 0, undefined, "quantity_unknown_unit"],
    ["fractional count", "count", "stationery:each", "1", 1, undefined, "quantity_fractional_count"],
    ["cross dimension", "count", "stationery:each", "1", 0, "stationery:gram", "quantity_cross_dimension"],
    ["inexact conversion", "mass", "stationery:gram", "1", 0, "stationery:triplet", "quantity_not_exactly_representable"],
    ["overflow", "count", "stationery:each", "1".repeat(41), 0, undefined, "quantity_overflow"],
  ] as const)("RP2-D-004 %s", async (_name, dimension, unit, unscaled, scale, targetUnit, code) => {
    const input = pack(), type = { key: input.types[0].key, version: 1 };
    input.types[0].units = [...input.types[0].units,
      { code: "stationery:gram", dimension: "mass", integral: false, factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 0 } },
      { code: "stationery:triplet", dimension: "mass", integral: false, factor: { canonicalUnit: "openlup:g", unscaled: "3", scale: 0 } },
    ];
    const result = await checkSubject({ packs: [{ pack: input, quantities: [{ type, value: { dimension, unit, unscaled, scale }, targetUnit }] }] });
    expect(result.exitCode).toBe(code ? 1 : 0);
    expect(result.findings.map(finding => [finding.code, finding.path])).toEqual(code ? [[code, "/packs/0/quantities/0/value"]] : []);
  });

  it("RP2-D-004 duplicate crosses pack boundary and violations precede unavailable", async () => {
    const input = pack();
    const result = await checkSubject({ packs: [{ pack: input }, { pack: { ...input, id: "second" } }], requiredChecks: ["taxonomy"] });
    expect(result.exitCode).toBe(1);
    expect(result.findings).toMatchObject([
      { code: "definition_duplicate_identity", path: "/packs/1/pack/types/0/key" },
      { code: "conformance_owner_unavailable", path: "/requiredChecks/0" },
    ]);
  });

  it.each([
    ["attribute-values", "attributes"], ["variant-combinations", "combinations"],
  ] as const)("RP2-D-005 %s must cover each pack", async (check, field) => {
    const { drafts: _drafts, ...entry } = transportEntry();
    entry[field] = [];
    const result = await checkSubject({ packs: [entry], requiredChecks: [check] });
    expect(result).toMatchObject({ exitCode: 2, findings: [{ code: "conformance_owner_unavailable", path: "/requiredChecks/0" }] });
  });

  it.each([3, 4, 5] as const)("RP2-D-006 v%s validates the actual content on the exact transported input", async version => {
    const input = transportEntry(), selected = input.drafts[version - 3];
    const validateContent = vi.fn(samplePack.types[0].validateContent);
    const actual = { ...input, drafts: [selected], pack: { ...input.pack, types: [{ ...samplePack.types[0], validateContent }] } };
    const source = { packs: [actual], requiredChecks: ["draft-content"] };
    const projection = projectCatalogExtensionConformance(source);
    expect(await projection.check(projection.subject)).toMatchObject({ exitCode: 0, findings: [] });
    expect(validateContent).toHaveBeenCalledExactlyOnceWith(selected.product.sharedContent);
    await expect(projection.check(projection.subject + " ")).rejects.toThrow("Projected subject bytes differ");
    expect(await runCatalogExtensionConformance(projection.subject)).toMatchObject({ exitCode: 2, findings: [
      { code: "conformance_owner_unavailable", path: "/packs/0/drafts/0/product/sharedContent" },
    ] });
    selected.product.sharedContent = { ...selected.product.sharedContent, document: {} };
    const invalid = projectCatalogExtensionConformance(source);
    expect(await invalid.check(invalid.subject)).toMatchObject({ exitCode: 1, findings: [
      { code: "value_required", path: "/packs/0/drafts/0/product/sharedContent/document/derived" },
    ] });
  });

  it.each([3, 4, 5] as const)("RP2-D-006 v%s rejects missing or out-of-bounds applicable facts", async version => {
    const entry = transportEntry(), base = entry.drafts[version - 3];
    const { documentRevision: _revision, ...noReference } = base.product;
    const cases = [
      ["reference", { ...base, product: noReference }, 2, "conformance_owner_unavailable", "/product/documentRevision"],
      ["operation", { ...base, publication: { ...base.publication, operations: [] } }, 2, "conformance_owner_unavailable", "/publication/operations"],
      ["operation field", { ...base, publication: { ...base.publication, operations: [{ op: "create_product" }] } }, 1, "draft_input_invalid", "/publication/operations/0/productId"],
      ["SKU ceiling", { ...base, skus: Array(10001).fill(base.skus[0]) }, 1, "draft_input_invalid", "/skus"],
      ["canonical bytes", { ...base, product: { ...base.product, sharedContent: { ...base.product.sharedContent,
        document: { title: "x".repeat(1_048_576) } } } }, 1, "draft_input_invalid", ""],
    ] as const;
    for (const [name, fixture, exitCode, code, path] of cases) {
      const projected = projectCatalogExtensionConformance({ packs: [{ ...entry, drafts: [fixture] }], requiredChecks: ["draft-content"] });
      const result = await projected.check(projected.subject);
      expect(result.exitCode, name).toBe(exitCode);
      expect(result.findings, name).toContainEqual(expect.objectContaining({ code, path: "/packs/0/drafts/0" + path }));
    }
  });

  it.each(["taxonomy", "tax-application", "promotions"] as const)("RP2-D-009 %s is unavailable", async owner => {
    const result = await checkSubject({ packs: [{ pack: pack() }], requiredChecks: [owner] });
    expect(result).toMatchObject({ exitCode: 2, findings: [{ code: "conformance_owner_unavailable", path: "/requiredChecks/0" }] });
  });

  it.each([
    { name: "bound 120", cadence: 120, definitions: true, consumption: { kind: "fixed_units" } },
    { name: "bound 121", cadence: 121, definitions: true, consumption: { kind: "fixed_units" },
      code: "profile_cadence_exceeds_platform_bound", path: "/pack/subscriptionProfileDefinitions/0/allowedCadenceDays/0" },
    { name: "exact declaration missing", cadence: 120, definitions: false, consumption: { kind: "fixed_units" },
      code: "profile_missing", path: "/pack/subscriptionProfiles/0" },
    { name: "pinned policy missing", cadence: 120, definitions: true, consumption: { kind: "host_policy",
      policyRef: { key: "stationery:policy", version: 1, digest: "a".repeat(64) }, demandScope: { kind: "per_line" } },
      code: "policy_binding_missing", path: "/pack/subscriptionProfiles/0" },
  ] as const)("RP2-D-007 $name", async ({ cadence, definitions, consumption, ...wanted }) => {
    const { drafts: _drafts, ...entry } = transportEntry();
    const subject = { ...entry, pack: { ...entry.pack, subscriptionProfileDefinitions: definitions
      ? [{ ...samplePack.subscriptionProfileDefinitions[0], allowedCadenceDays: [cadence], consumption }] : [] } };
    const result = await checkSubject({ packs: [subject], requiredChecks: ["profiles"] });
    if ("code" in wanted) {
      expect(result.exitCode).toBe(1);
      expect(result.findings).toContainEqual(expect.objectContaining({ code: wanted.code, path: "/packs/0" + wanted.path }));
    } else expect(result).toMatchObject({ exitCode: 0, findings: [] });
  });

  it("RP2-D-007 pooled exact coverage uses the installed demand owner and its arithmetic limit", async () => {
    const { drafts: _drafts, ...entry } = transportEntry();
    const ref = { key: "stationery:coverage", version: 1, digest: "b".repeat(64) };
    const input = { ...entry, pack: { ...entry.pack, subscriptionProfileDefinitions: [{ ...entry.pack.subscriptionProfileDefinitions[0],
      consumption: { kind: "units_per_day", demandUnit: "openlup:piece", policyRef: ref, demandScope: { kind: "pooled", poolKey: "stationery:pool" } } }] },
      profilePolicies: [{ kind: "units_per_day", ref, coverage: "exact" }],
      profileChecks: [{ cadenceDays: 120, lines: ["first", "second"].map(id => ({ ...entry.profileChecks[0].lines[0], id,
        demand: { contentPerUnit: { dimension: "count", unit: "openlup:piece", unscaled: "60", scale: 0 },
          perDay: { dimension: "count", unit: "openlup:piece", unscaled: "1", scale: 0 } },
      })) }] };
    const check = () => checkSubject({ packs: [input], requiredChecks: ["profiles"] });
    expect((await check()).exitCode).toBe(0);
    input.profileChecks[0].lines[1].demand.contentPerUnit.unscaled = "9007199254740991";
    expect(await check()).toMatchObject({ exitCode: 1, findings: [
      { code: "demand_arithmetic_unsafe", path: "/packs/0/profileChecks/0/lines/1/demand" },
    ] });
  });

  it("RP2-D-007 a pinned host policy runs only with trusted evidence", async () => {
    const { drafts: _drafts, ...entry } = transportEntry();
    const ref = { key: "stationery:policy", version: 1, digest: "a".repeat(64) };
    const validate = vi.fn(() => undefined);
    const source = projectCatalogExtensionConformance({ packs: [{ ...entry, pack: { ...entry.pack,
      subscriptionProfileDefinitions: [{ ...entry.pack.subscriptionProfileDefinitions[0],
        consumption: { kind: "host_policy", policyRef: ref, demandScope: { kind: "per_line" } } }] },
      profilePolicies: [{ kind: "host_policy", ref, validate }],
    }], requiredChecks: ["profiles"] });
    expect(await runCatalogExtensionConformance(source.subject)).toMatchObject({ exitCode: 2 });
    expect(validate).not.toHaveBeenCalled();
    expect(await source.check(source.subject)).toMatchObject({ exitCode: 0 });
    expect(validate).toHaveBeenCalledTimes(1);
  });
});

describe("catalogue_refusal_observation_matrix", () => {
  it.each([
    { name: "owner observed", capability: "prepaid", code: "prepaid_unsupported", expectedExit: 0 },
    { name: "forged matching code", capability: "prepaid", code: "forged", expectedExit: 1, finding: "conformance_refusal_fixture_mismatch" },
    { name: "unavailable owner", capability: "taxonomy", code: "forged", expectedExit: 2, finding: "conformance_owner_unavailable" },
  ])("RP2-D-008 $name", async ({ capability, code, expectedExit, finding }) => {
    const { drafts: _drafts, ...entry } = transportEntry();
    const subject = { packs: [{ ...entry, pack: { ...entry.pack, capabilities: { [capability]: false } },
      refusals: [{ name: "fixture", capability, expectedCode: code, observedCode: code, zeroEffects: true }] }], requiredChecks: ["owner-refusals"] };
    const report = await checkSubject(subject);
    expect(report.exitCode).toBe(expectedExit);
    if (finding) expect(report.findings).toMatchObject([{ code: finding, path: "/packs/0/refusals/0", fixture: "fixture" }]);
  });
});

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
