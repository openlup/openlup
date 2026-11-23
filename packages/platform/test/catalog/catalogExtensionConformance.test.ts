import { describe, expect, it, vi } from "vitest";
import { validateCatalogSubscriptionProfile } from "@openlup/core/catalog";
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { runCatalogExtensionConformance } from "../../src/catalog/testing/index.js";
import { projectCatalogExtensionConformance } from "../../src/catalog/testing/catalogExtensionConformance.js";
import { catalogPackIssues, catalogPackManifest, installCatalogDefinitions, catalogProductTypeRefIssues, catalogDraftPayloadSchema, validateCatalogDraft, createCatalogProductTypeRegistry,
  validateCatalogAttributes, prepareCatalogAttributeProjection, validateCatalogCombinationChangesV2, canonicalizeCatalogCombinationV2, CatalogCombinationError,
  catalogDraftPayloadV2Schema, catalogDraftPayloadV3Schema, validateCatalogDraftV2, createCatalogDraftHandler, withCatalogPublicationRules, catalogVariantOptions } from "../../src/catalog/index.js";
import { artifact, input } from "./fixtures/publicationInput.js";
import { catalogDraftV3ValidationPayload } from "../../src/catalog/draftV3Schemas.js";
import { inspectCatalogPack } from "../../src/catalog/productTypeIssues.js";
import type { CatalogConformanceReport, CatalogRefusalFixture } from "../../src/catalog/testing/index.js";
import type { CatalogPackInput, CatalogProductTypeRef, AttributeDefinition, CatalogAttributeInput, CatalogAttributeReferenceResolution } from "../../src/catalog/index.js";

function pack(): CatalogPackInput {
  return { id: "stationery", namespace: "stationery", version: 1, openlupRange: "1.x", capabilities: {}, taxClasses: [{ key: "standard" }], types: [{
    key: "stationery:item", version: 1, units: [{ code: "stationery:each", dimension: "count", integral: true, factor: { canonicalUnit: "openlup:piece", unscaled: "1", scale: 0 } }],
    netContentUnits: ["stationery:each"], dimensions: [], taxClass: "standard", validateContent: () => [],
  }] };
}
const checkSubject = (value: unknown) => runCatalogExtensionConformance(JSON.stringify(value));
const errors = (report: CatalogConformanceReport) => report.findings.filter(finding => finding.severity === "error");
function check(value: CatalogPackInput) { return checkSubject({ packs: [{ pack: value }] }); }
const draft = () => ({ schemaVersion: 1 as const, product: { id: "00000000-0000-4000-8000-000000000001", type: { key: "stationery:item", version: 1 }, dimensions: [] }, skus: [] });
const project = (source: unknown) => {
  const projection = projectCatalogExtensionConformance(source);
  return projection.check(projection.subject);
};

describe("catalogue conformance findings", () => {
  const fixture = (name: string) => readFileSync(new URL(`../fixtures/catalogue-conformance/${name}.json`, import.meta.url), "utf8");
  const grams = { code: "openlup:g", dimension: "mass", integral: false } as const;
  const recheck = "npx --no -- openlup catalogue check --packs ./axis-mismatch.json --json";
  const typePath = "/packs/0/pack/types/0";
  const rangePath = "/packs/0/pack/openlupRange";
  const checkWithRecheck = (pack: CatalogPackInput) => checkSubject({ packs: [{ pack }], recheck });

  it("choice_dimension_with_boolean_attribute_refuses_axis_mismatch", async () => {
    const subject = { ...JSON.parse(fixture("axis-mismatch")), recheck };
    const type = subject.packs[0].pack.types[0];
    const path = `${typePath}/axes/0`;
    expect(await checkSubject(subject)).toMatchObject({ state: "violated", exitCode: 1, findings: [{
      code: "definition_axis_mismatch", severity: "error", path, recheck,
      observed: `${path}: dimension = {"key":"finish","kind":"choice","values":["matte","gloss"]}; attribute = {"kind":"boolean"}`,
      cause: "An axis must bind a dimension and a variant attribute that declare the same option.",
      fix: "Declare the option once with `catalogVariantOptions`, or make both declarations match.",
      recipe: "how-to/extend/catalogue-extension.md#add-axis",
    }] });
    Object.assign(type, catalogVariantOptions([{ key: "finish", kind: "boolean", labels: { en: "Finish" } }]));
    expect(await checkSubject(subject)).toMatchObject({ state: "satisfied", exitCode: 0, findings: [] });

    type.dimensions.push({ key: "extra", kind: "boolean" });
    type.axes.push({ key: "extra", attributeKey: "finish" });
    expect(await checkSubject(subject)).toMatchObject({ state: "violated", exitCode: 1, findings: [{
      code: "definition_duplicate_axis_attribute", severity: "error", path: `${typePath}/axes/1/attributeKey`, recheck,
      observed: `${typePath}/axes/1/attributeKey = "finish"`, cause: "One variant attribute can back one axis.",
      fix: "Remove the duplicate axis assignment.", recipe: "how-to/extend/catalogue-extension.md#add-axis",
    }] });
    type.axes.pop();
    expect(await checkSubject(subject)).toMatchObject({ state: "satisfied", exitCode: 0, findings: [] });
  });

  it("maps combination diagnostics to the supplied fixture values or their container", async () => {
    const entry = JSON.parse(fixture("axis-mismatch")).packs[0];
    const type = entry.pack.types[0];
    Object.assign(type, catalogVariantOptions([{ key: "finish", kind: "choice", values: [{ id: "matte" }], labels: {} }]));
    const input = { typed: true, axes: ["finish"], incoming: [], retained: [] };
    const row = (skuId: string, value: string) => ({ skuId, state: "active", optionValues: { finish: { kind: "choice", value } } });
    const cases = [
      [{ axes: ["finish", "uninstalled"], incoming: [row("one", "matte")] }, "axis_not_installed", "/axes/1", '"uninstalled"'],
      [{ axes: ["finish", "finish"], incoming: [row("one", "matte")] }, "duplicate_axis", "/axes", '["finish","finish"]'],
      [{ incoming: [row("one", "file:/synthetic/private")] }, "option_invalid", "/incoming/0/optionValues/finish", '{"kind":"choice","value":"<host path>"}'],
      [{ retained: [row("one", "gloss")] }, "option_invalid", "/retained/0/optionValues/finish", '{"kind":"choice","value":"gloss"}'],
      [{ incoming: [row("one", "gloss"), row("two", "matte")] }, "option_invalid", "/incoming", '[{"optionValues":{"finish":{"kind":"choice","value":"gloss"}}'],
      [{ incoming: [{ ...row("one", "matte"), optionValues: {} }, row("two", "matte")] }, "option_missing", "/incoming/0", '{"optionValues":{},"skuId":"one","state":"active"}'],
      [{ retained: [{ skuId: "one", state: "active", optionValues: null }] }, "option_missing", "/retained/0", '{"optionValues":null,"skuId":"one","state":"active"}'],
    ] as const;
    for (const [change, code, suffix, observed] of cases) {
      const path = `/packs/0/combinations/0/input${suffix}`;
      const report = await checkSubject({ packs: [{ ...entry, combinations: [{ type: { key: type.key, version: 1 }, input: { ...input, ...change } }] }], recheck });
      expect(report.exitCode).toBe(1);
      expect(errors(report)).toMatchObject([{ code, path, observed: expect.stringContaining(`${path} = ${observed}`), recheck }]);
      expect(errors(report)[0].observed).not.toContain("file:/synthetic/private");
      expect(Array.from(errors(report)[0].observed.slice(path.length + 3)).length).toBeLessThanOrEqual(160);
    }
  });

  it("reports a variant attribute without an axis and applies the feasible binding", async () => {
    const declaration = pack();
    const variant = catalogVariantOptions([{ key: "lined", kind: "boolean", labels: {} }]);
    const type = { ...declaration.types[0], ...variant, axes: [] };
    const path = `${typePath}/attributes/0/key`;
    expect(await checkWithRecheck({ ...declaration, types: [type] })).toMatchObject({ state: "satisfied", exitCode: 0,
      findings: expect.arrayContaining([expect.objectContaining({ code: "advisory_variant_attribute_without_axis", severity: "warning", path,
        observed: `${path} = "lined"`, recipe: "how-to/extend/catalogue-extension.md#add-attribute", recheck,
        fix: expect.stringContaining("an unused compatible dimension"), cause: expect.any(String),
      })]),
    });
    expect((await checkWithRecheck({ ...declaration, types: [{ ...type, axes: variant.axes }] })).findings.map(({ code }) => code))
      .not.toContain("advisory_variant_attribute_without_axis");

    const filled = catalogVariantOptions(Array.from({ length: 16 }, (_, i) => ({ key: `flag_${i}`, kind: "boolean", labels: {} })));
    const ineligible = { ...type, ...filled, attributes: [...variant.attributes, ...filled.attributes] };
    const report = await checkWithRecheck({ ...declaration, types: [ineligible] });
    expect(report).toMatchObject({ state: "satisfied", exitCode: 0, findings: expect.arrayContaining([
      expect.objectContaining({ code: "advisory_variant_attribute_without_axis", path, fix: expect.stringContaining("Otherwise keep it as a variant attribute.") }),
    ]) });
  });

  it("openlup_range_caret_zero_warns_exit_zero", async () => {
    const declaration = pack();
    const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const report = await checkWithRecheck({ ...declaration, openlupRange: "^0.1.0" });
    expect(report).toMatchObject({ state: "satisfied", exitCode: 0, findings: expect.arrayContaining([expect.objectContaining({
      code: "advisory_openlup_range_unsatisfied", severity: "warning", path: rangePath, recheck,
      observed: `${rangePath}: range = "^0.1.0"; Platform = ${version}`, cause: expect.any(String),
      fix: expect.stringContaining("include the reported Platform version"), recipe: "how-to/extend/catalogue-extension.md#set-the-platform-version-range",
    })]) });
    expect(report.boundary).toContain("Application and database runtime state");
    const unrecognised = await checkWithRecheck({ ...declaration, openlupRange: ">=1.0.0 <3.0.0" });
    expect(unrecognised).toMatchObject({ state: "satisfied", exitCode: 0, findings: expect.arrayContaining([expect.objectContaining({
      code: "advisory_openlup_range_unrecognised", severity: "warning", path: rangePath, recheck,
      observed: `${rangePath} = ">=1.0.0 <3.0.0"`, cause: expect.any(String), fix: "Use `1.x`.",
      recipe: "how-to/extend/catalogue-extension.md#set-the-platform-version-range",
    })]) });
    for (const openlupRange of ["1.x", "^1.0.0", ">=1.0.0 <2.0.0"]) {
      const repaired = await checkWithRecheck({ ...declaration, openlupRange });
      expect(repaired.exitCode).toBe(0);
      expect(repaired.findings.some(({ code }) => code.startsWith("advisory_openlup_range_"))).toBe(false);
    }
  });

  function publicationFixture() {
    const { payload } = input();
    const declaration = pack(), type = declaration.types[0]!;
    payload.product.type = { key: type.key, version: type.version };
    type.units = [grams];
    type.netContentUnits = [grams.code];
    return { pack: declaration, drafts: [payload] };
  }

  it("observed_reports_value_not_template", async () => {
    const report = await checkSubject({ packs: [{ pack: { ...pack(), "extra~/field": { z: 1, a: 2 } } }] });
    expect(report.findings[0]).toMatchObject({
      path: "/packs/0/pack/extra~0~1field",
      observed: '/packs/0/pack/extra~0~1field = {"a":2,"z":1}',
    });
  });

  it("non_mass_net_content_warns_and_exits_zero", async () => {
    const report = await runCatalogExtensionConformance(fixture("volume-net-content"));
    const path = "/packs/0/pack/types/0/netContentUnits";
    expect(report.exitCode).toBe(0);
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "advisory_net_content_not_publishable", severity: "warning", path, observed: `${path} = ["sample:ml"]`,
      cause: expect.stringContaining("`catalog_publication_mass_required_until_mc5`"),
    }));
  });

  it("qualifies the unit GTIN warning by the draft schema and SKU code", async () => {
    const entry = publicationFixture(), draft = entry.drafts[0]!, sku = draft.skus[0]!;
    const identifiers = sku.identifiers;
    delete sku.identifiers;
    const missingCode = structuredClone(draft);
    delete missingCode.skus[0]!.code;
    for (const fixture of [draft, missingCode, catalogDraftV3ValidationPayload(draft)]) {
      const report = await project({ packs: [{ ...entry, drafts: [fixture] }] });
      expect(report).toMatchObject({ state: "satisfied", exitCode: 0 });
      expect(report.findings).toContainEqual(expect.objectContaining({
        code: "advisory_unit_identifier_missing", severity: "warning",
        cause: "In a version 3 draft, Prepare reports `unit_trade_identifier_missing` when the SKU has a code but lacks a valid unit GTIN. "
          + "A SKU without a code reports `sku_code_missing` first. The legacy version 1 and 2 preview reports `publication_preparation_unavailable`.",
      }));
    }
    sku.identifiers = identifiers;
    expect(await project({ packs: [entry] })).toMatchObject({ state: "satisfied", exitCode: 0, findings: [] });
  });

  it("names the Prepare code for a legacy draft until the fixture uses v3", async () => {
    const entry = publicationFixture();
    const legacy = catalogDraftV3ValidationPayload(entry.drafts[0]!);
    expect(await project({ packs: [{ ...entry, drafts: [legacy] }] })).toMatchObject({ state: "satisfied", exitCode: 0, findings: [{
      code: "advisory_draft_version_not_publishable", severity: "warning",
      cause: expect.stringContaining("`publication_preparation_unavailable`"),
      fix: "Author offline pack fixtures as schema version 3, the newest draft schema this checker evaluates. Use the schema required by your publication workflow for saved drafts. "
        + "Schema version 3 fixtures require `product.sharedContent`. Check them with `npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue.ts` and a registered `validateContent`. "
        + "For an otherwise valid v3 fixture, inert `catalogue check` reports `conformance_owner_unavailable` and exits 2.",
    }] });
    expect(await project({ packs: [entry] })).toMatchObject({ state: "satisfied", exitCode: 0, findings: [] });
  });

  it.each([
    { name: "millilitre fixture without dimensions" },
    { name: "existing gram declaration", existingGram: true },
    { name: "volume net-content dimension", dimension: "volume" },
    { name: "factorless custom mass dimension", dimension: "mass" },
    { name: "v2 axis bound to an attribute", dimension: "volume", axis: true },
    { name: "v2 axis built with catalogVariantOptions", dimension: "volume", axis: true, helper: true },
  ])("applies the gram recipe to $name", async ({ existingGram, dimension, axis, helper }) => {
    const subject = JSON.parse(fixture("volume-net-content"));
    const { pack: { types: [type] }, drafts: [draft] } = subject.packs[0];
    const gram = { code: "openlup:g", dimension: "mass", integral: false,
      factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 0 } };
    if (existingGram) type.units.push(gram);
    if (dimension) {
      const unit = dimension === "mass" ? "sample:mass" : "sample:ml";
      if (dimension === "mass") {
        type.units = [{ code: unit, dimension, integral: false }];
        type.netContentUnits = [unit];
      }
      const value = { dimension, unit, unscaled: "100", scale: 0 };
      type.dimensions = [{ key: "size", kind: "quantity", dimension, units: [unit], role: "net_content" }];
      draft.product.dimensions = ["size"];
      draft.skus[0].options = { size: { kind: "quantity", value } };
      draft.skus[0].netContent = value;
      if (axis) {
        draft.schemaVersion = 2;
        if (helper) {
          const options = catalogVariantOptions([{ key: "size", kind: "quantity", dimension: "volume", units: [unit], role: "net_content", labels: {} }]);
          type.dimensions = options.dimensions;
          type.axes = options.axes;
          type.attributes.push(...options.attributes);
        } else {
          type.axes = [{ key: "size", attributeKey: "size" }];
          type.attributes.push({ key: "size", scope: "variant", valueType: { kind: "quantity", dimension, units: [unit] },
            required: false, cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true,
            displayOrder: 1, labels: {} });
        }
        draft.skus[0].attributes = { size: value };
      }
    }

    const before = await checkSubject(subject);
    expect(before.exitCode).toBe(0);
    const fix = before.findings.find(({ code }) => code === "advisory_net_content_not_publishable")?.fix;
    expect(fix).toContain('remove `role: "net_content"` from any dimension that has it');
    if (helper) {
      const guide = readFileSync(new URL("../../../core/docs/guide/how-to/extend/catalogue-extension.md", import.meta.url), "utf8");
      expect(guide.split("\n").find(line => line.startsWith("Make `units` contain exactly one"))).toBe(fix);
    }

    if (!type.units.some((unit: { code: string }) => unit.code === gram.code)) type.units.push(gram);
    if (!type.netContentUnits.includes(gram.code)) type.netContentUnits.push(gram.code);
    for (const sku of draft.skus) sku.netContent = { dimension: "mass", unit: gram.code, unscaled: "110", scale: 0 };
    for (const definition of type.dimensions) delete definition.role;

    const report = await checkSubject(subject);
    expect(report).toMatchObject({ state: "satisfied", exitCode: 0 });
    expect(report.findings.map(({ code }) => code)).not.toContain("advisory_net_content_not_publishable");
  });

  it("six_injected_errors_reported_in_one_pass", async () => {
    const { packs: [outer, items] } = JSON.parse(fixture("six-errors"));
    const packs = Array.from({ length: 11 }, () => ({ pack: { ...pack(), types: [] } }));
    packs[2] = outer;
    packs[10] = items;
    const sibling = { pack: { ...items.pack, types: [items.pack.types.pop()] }, drafts: [items.drafts.shift()] };
    packs.push(sibling);
    const report = await checkSubject({ packs });
    const at = "/packs/10";
    expect(report.exitCode).toBe(1);
    expect(errors(report).map(({ path, code }) => [path, code])).toEqual([
      ["/packs/2/pack/categories", "definition_unknown_field"],
      [`${at}/pack/types/0/subscriptionProfileRef`, "definition_unknown_profile_ref"],
      [`${at}/pack/types/0/taxClass`, "definition_unknown_tax_class"],
      [`${at}/pack/types/1/promotions`, "definition_unknown_field"],
      ["/packs/11/drafts/0/product/dimensions/1", "dimension_not_installed"],
      ["/packs/11/drafts/0/skus/0/options/choice", "option_value_invalid"],
    ]);
    expect(report.findings.filter(finding => finding.code === "advisory_fixtures_skipped_definition_invalid")).toMatchObject([
      { path: `${at}/pack`, severity: "warning", observed: expect.stringContaining(`${at}/pack = {"capabilities":{},"id":"items"`),
        cause: "Fixtures of a pack with definition findings are not evaluated." },
    ]);
  });

  it.each([
    { name: "unknown tax class", change: { taxClass: "missing" },
      finding: ["definition_unknown_tax_class", "/packs/0/pack/types/0/taxClass"] },
    { name: "null type", change: null, finding: ["definition_invalid_shape", "/packs/0/pack/types/0"] },
    { name: "own validateContent field", change: { validateContent: "untrusted" },
      finding: ["definition_unknown_field", "/packs/0/pack/types/0/validateContent"] },
  ])("skips trusted verification and callbacks for a pack with $name", async ({ change, finding }) => {
    const p = pack(), [type] = withCatalogPublicationRules(p, () => artifact).types;
    const validateContent = vi.fn(() => { throw new Error("Synthetic sibling failure"); });
    // The substituted binding would refuse even before the callback ran.
    const sibling = { ...type, validateContent };
    const invalid = change === null ? null : { ...p.types[0], key: "stationery:invalid", ...change };
    const base = draft();
    const drafts = [{ ...base, product: { ...base.product, sharedContent: { title: "Sample" } } }];
    const report = await project({ packs: [{ pack: { ...p, types: [invalid, sibling] }, drafts }] });
    expect(report).toMatchObject({ state: "violated", exitCode: 1 });
    expect(errors(report).map(({ code, path }) => [code, path])).toEqual([finding]);
    expect(report.findings.filter(({ code }) => code === "advisory_fixtures_skipped_definition_invalid")).toMatchObject([
      { path: "/packs/0/pack", severity: "warning" },
    ]);
    expect(validateContent).not.toHaveBeenCalled();
  });

  it("propagates a trusted validator throw in a valid pack even with a cross-pack duplicate", async () => {
    const p = pack(), [type] = p.types;
    const failure = new Error("Synthetic content failure");
    const validateContent = vi.fn(() => { throw failure; });
    const sibling = { ...type, key: "stationery:other", validateContent };
    const base = draft();
    const drafts = [{ ...base, product: { ...base.product, type: { key: sibling.key, version: 1 }, sharedContent: {} } }];
    const subject = { pack: { ...p, types: [type, sibling] }, drafts };
    await expect(project({ packs: [subject] })).rejects.toBe(failure);
    await expect(project({ packs: [{ pack: p }, subject] })).rejects.toBe(failure);
    expect(validateContent).toHaveBeenCalledTimes(2);
  });

  it("reports a cross-pack duplicate without skipping its fixture", async () => {
    const p = pack(), base = draft();
    p.types[0].validateContent = () => [{ code: "title_review", path: "title" }];
    const drafts = [{ ...base, product: { ...base.product, sharedContent: { title: "Sample" } } }];
    const report = await project({ packs: [{ pack: p }, { pack: p, drafts }] });
    expect(report.exitCode).toBe(1);
    expect(errors(report).map(({ code, path }) => [code, path])).toEqual([
      ["title_review", "/packs/1/drafts/0/product/sharedContent/title"],
      ["definition_duplicate_identity", "/packs/1/pack/types/0/key"],
    ]);
    expect(report.findings.map(({ code }) => code)).not.toContain("advisory_fixtures_skipped_definition_invalid");
  });

  it("runs an earlier pack's validator before a later pack's binding verification", async () => {
    const p = pack(), base = draft();
    const failure = new Error("Synthetic first-pack failure");
    const drafts = [{ ...base, product: { ...base.product, sharedContent: {} } }];
    const bound = withCatalogPublicationRules(p, () => artifact);
    const substituted = { ...bound, types: [{ ...bound.types[0], validateContent: () => [] }] };
    await expect(project({ packs: [{ pack: substituted }] })).rejects.toMatchObject({
      code: "catalog_publication_rules_binding_mismatch",
    });
    p.types[0].validateContent = () => { throw failure; };
    await expect(project({ packs: [{ pack: p, drafts }, { pack: substituted }] })).rejects.toBe(failure);
  });

  it("observes_the_original_value_when_a_trusted_validator_mutates_its_input", async () => {
    const p = pack(), base = draft();
    p.types[0].validateContent = content => {
      const value = content as { title: string };
      value.title = value.title.trim();
      return [{ code: "title_review", path: "title" }];
    };
    const drafts = [{ ...base, product: { ...base.product, sharedContent: { title: "  Sample  " } } }];
    const report = await project({ packs: [{ pack: p, drafts }] });
    expect(report.exitCode).toBe(1);
    expect(errors(report)).toMatchObject([{
      code: "title_review", path: "/packs/0/drafts/0/product/sharedContent/title",
      observed: '/packs/0/drafts/0/product/sharedContent/title = "  Sample  "',
    }]);
  });

  it.each([
    ["Loaded from file:///tmp/synthetic/source.mjs", "<host path>"],
    ["Loaded from </tmp/synthetic/source.mjs>", "<host path>"],
    ["Loaded from <file:sample>", "<host path>"],
    ["see /tmp/synthetic/source.mjs now", "<host path>"],
    ["/Users/a/x.mjs", "<host path>"],
    ["C:\\Program Files\\Catalogue\\pack.mjs", "<host path>"],
    ["C:\\pack.mjs", "<host path>"],
    ["\\\\host\\share\\pack.mjs", "<host path>"],
    ["/same", "<host path>"],
    ["https://example.com/a/b", "<host path>"],
    ["profile:x", "<host path>"],
    ["sample:ml", "sample:ml"],
    ["sample.ml", "sample.ml"],
  ])("redacts path-like trusted string values", async (input, expected) => {
    const report = await project({ packs: [{ pack: { ...pack(), extra: input } }] });
    expect(errors(report).map(({ observed }) => observed)).toEqual([
      "/packs/0/pack/extra = " + JSON.stringify(expected),
    ]);
  });

  it("trusted_observed_values_redact_host_paths", async () => {
    const paths = ["/tmp/synthetic/source.mjs", "file:///tmp/synthetic/source.mjs", "C:\\synthetic\\source.mjs", "\\\\host\\share\\source.mjs"];
    const report = await project({ packs: [{ pack: { ...pack(), direct: paths[0],
      nested: { "source</same>": paths.slice(1) } } }] });
    expect(report.exitCode).toBe(1);
    expect(paths.some(path => JSON.stringify(report).includes(JSON.stringify(path).slice(1, -1)))).toBe(false);
    expect(errors(report).map(({ observed }) => observed)).toEqual([
      '/packs/0/pack/direct = "<host path>"',
      '/packs/0/pack/nested = {"<host path>":["<host path>","<host path>","<host path>"]}',
    ]);
  });

  it("observed_truncation_keeps_code_points", async () => {
    const prefix = '"' + "a".repeat(157) + "😀👍";
    const report = await checkSubject({ packs: [{ pack: { ...pack(), extra: prefix.slice(1) + "🌿" } }] });
    expect(report.findings[0].observed).toBe(`/packs/0/pack/extra = ${prefix}`);
    expect(Array.from(prefix)).toHaveLength(160);
  });

  it("advisory_only_report_is_satisfied", async () => {
    const entry = publicationFixture();
    entry.pack.types[0]!.attributes = JSON.parse(fixture("volume-net-content")).packs[0].pack.types[0].attributes;
    const report = await project({ packs: [entry] });
    expect(report).toMatchObject({ state: "satisfied", exitCode: 0 });
    expect(report.findings).toMatchObject([{
      code: "advisory_filter_flags_unused", path: "/packs/0/pack/types/0/attributes/0/filterable",
      observed: "/packs/0/pack/types/0/attributes/0/filterable = true",
    }]);
    for (const finding of report.findings) {
      expect(finding.severity).toBe("warning");
      expect(Reflect.ownKeys(finding).sort()).toEqual([
        "cause", "code", "evidence", "fix", "fixture", "observed", "path", "recheck", "recipe", "severity",
      ]);
    }
  });

  it("v3_fixture_passes_with_trusted_content_and_needs_evidence_when_inert", async () => {
    const base = draft();
    const v3 = { ...base, schemaVersion: 3, product: { ...base.product, sharedContent: {
      schemaVersion: 1, catalogAction: "create", presentation: {}, offerMemberships: [], requestedModes: [], publicationSkus: [],
    } }, publication: { kind: "release", operations: [], evidence: {} } };
    const projection = projectCatalogExtensionConformance({ packs: [{ pack: pack(), drafts: [v3] }] });
    const trusted = await projection.check(projection.subject);
    expect(trusted).toMatchObject({ state: "satisfied", exitCode: 0 });
    expect(trusted.findings.map(({ code }) => code)).not.toContain("advisory_draft_version_not_publishable");
    const inert = await runCatalogExtensionConformance(projection.subject);
    expect(inert).toMatchObject({ state: "unavailable", exitCode: 2 });
    expect(errors(inert)).toMatchObject([{
      code: "conformance_owner_unavailable", path: "/packs/0/drafts/0/product/sharedContent",
    }]);
  });

  it("gtin_recipe_replaces_an_identifier_when_the_list_is_full", async () => {
    const subject = JSON.parse(fixture("volume-net-content"));
    const sku = subject.packs[0].drafts[0].skus[0];
    sku.identifiers = Array.from({ length: 32 }, (_, i) =>
      ({ scheme: "sample:label", issuer: "sample", value: String(i), packagingLevel: "unit" }));
    const before = await checkSubject(subject);
    expect(before.exitCode).toBe(0);
    expect(before.findings.find(({ code }) => code === "advisory_unit_identifier_missing")?.fix)
      .toBe("Add a valid unit GTIN to the SKU. A SKU holds at most 32 identifiers, so replace one when the list is full.");
    sku.identifiers[0] = { scheme: "gs1:gtin", issuer: "sample", value: "4006381333931", packagingLevel: "unit" };
    const report = await checkSubject(subject);
    expect(report).toMatchObject({ state: "satisfied", exitCode: 0 });
    expect(report.findings.map(({ code }) => code)).not.toContain("advisory_unit_identifier_missing");
  });

  it("unknown_required_check_still_unavailable", async () => {
    const report = await checkSubject({ packs: [{ pack: { ...pack(), types: [] } }], requiredChecks: ["unknown"] });
    expect(report).toMatchObject({ state: "unavailable", exitCode: 2, findings: [
      { code: "conformance_owner_unavailable", severity: "error", path: "/requiredChecks/0" },
    ] });
  });
});

describe("subscription profile pack conformance", () => {
  const ref = { key: "stationery:repeat", version: 1 };
  const profile = {
    ...ref, allowedCadences: [{ schemaVersion: 1, kind: "fixed_days", days: 28 }],
    policyRef: { key: "stationery:policy", version: 1 }, policyDigest: "a".repeat(64),
  };
  const optedIn = { ...pack(), types: [], subscriptionProfiles: [ref], subscriptionProfileDefinitions: [profile] };

  it.each([
    [{ canonicalUnit: "openlup:piece", unscaled: "01", scale: 0 }, "quantity_invalid"],
    [{ canonicalUnit: "openlup:piece", unscaled: "1" }, "quantity_invalid"],
    [{ canonicalUnit: "openlup:piece", unscaled: "15", scale: 1 }, "quantity_fractional_count"],
    [{ canonicalUnit: "openlup:ml", unscaled: "1", scale: 0 }, "quantity_cross_dimension"],
    [{ canonicalUnit: "openlup:piece", unscaled: "9".repeat(41), scale: 1 }, "quantity_overflow"],
    [{ canonicalUnit: "openlup:piece", unscaled: "1", scale: 13 }, "quantity_not_exactly_representable"],
  ])("preserves typed factor diagnostics with and without profiles", (factor, quantityCause) => {
    const type = pack().types[0]!;
    const types = [{ ...type, units: [{ ...type.units[0], factor }] }];
    const issue = { code: "definition_unit_factor_invalid", path: "/types/0/units/0/factor", quantityCause, fix: expect.any(String) };
    for (const declaration of [pack(), optedIn]) expect(inspectCatalogPack({ ...declaration, types }, true).issues).toEqual([issue]);
  });

  it("keeps factorless and unused legacy units on the existing manifest path", () => {
    const original = pack(), type = original.types[0]!;
    const definition = { ...type, units: [...type.units, { code: "stationery:unused", dimension: "volume" as const, integral: false },
      { code: "openlup:g", dimension: "mass" as const, integral: true }] };
    const legacy = { ...original, types: [{ ...definition, netContentUnits: ["openlup:g"] }] };
    const first = catalogPackManifest(legacy);
    expect(catalogPackIssues(legacy)).toEqual([]);
    expect(catalogPackManifest(legacy)).toEqual(first);
    const selected = { ...legacy, types: [{ ...definition, netContentUnits: ["stationery:unused"] }] };
    expect(inspectCatalogPack(selected, true).issues).toMatchObject([{ code: "definition_unit_factor_invalid", quantityCause: "quantity_unknown_unit" }]);
    expect(catalogPackManifest(legacy)).toEqual(first);
  });

  it("matches the legacy issue JSON generated at f8f436454", () => {
    const inputs = [
      { ...pack(), subscriptionProfiles: null },
      { ...pack(), types: [{ ...pack().types[0], subscriptionProfileRef: { ...ref, version: 0 } }] },
      { ...pack(), types: [{ ...pack().types[0], subscriptionProfileRef: { ...ref, extra: true } }], subscriptionProfiles: [ref] },
      pack(),
    ];
    const golden = readFileSync(new URL("./fixtures/legacyPackIssues.json", import.meta.url), "utf8");
    expect(JSON.stringify(inputs.map(catalogPackIssues)) + "\n").toBe(golden);
  });

  it("requires original evidence for profile integrity refusals", () => {
    const docs = readFileSync(new URL("../../../core/docs/guide/reference/refusal-codes.md", import.meta.url), "utf8");
    const remedies = Array.from(docs.matchAll(/^\| `catalog_profile_(?:install_(?:refuses_redefinition|manifest_mismatch)|receipt_(?:digest|identity)_mismatch)` \| (.+) \|$/gm), match => match[1]);
    expect(remedies).toEqual(Array(4).fill("Replay the original declaration bytes, digest and identity together."));
    expect(remedies.join(" ")).not.toMatch(/recalculate/i);
  });

  const replayFix = "Replay the original declaration bytes, digest and identity together. Issue a new version for an intentional change.";
  it.each(["catalog_definition_install_conflict", "catalog_type_install_refuses_redefinition"])("passes legacy %s through unchanged", async message => {
    const error = Object.assign(new Error(message), { code: "23505" });
    await expect(installCatalogDefinitions({ query: vi.fn().mockRejectedValue(error) }, { ...pack(), types: [] })).rejects.toBe(error);
    expect(error).toMatchObject({ code: "23505", message });
    expect(error).not.toHaveProperty("issue");
  });

  it.each([
    ["25000", "catalog_profile_install_requires_read_committed", "Retry in a READ COMMITTED transaction."],
    ["23505", "catalog_profile_install_refuses_redefinition", replayFix],
    ["22023", "catalog_profile_install_manifest_mismatch", replayFix],
    ["23505", "catalog_type_install_refuses_redefinition", replayFix],
    ["23505", "catalog_definition_install_conflict", replayFix],
  ] as const)("adds a root installer fix to SQLSTATE %s %s", async (code, message, fix) => {
    const error = Object.assign(new Error(message), { code });
    const query = vi.fn().mockRejectedValue(error);
    await expect(installCatalogDefinitions({ query }, optedIn as CatalogPackInput)).rejects.toBe(error);
    expect(error).toMatchObject({ code, message });
    expect(error).toHaveProperty("issue", { code: message, path: "", fix });
  });

  async function checkRefusal(input: unknown, issue: { code: string; path: string; fix: string }) {
    const pack = input as CatalogPackInput;
    const query = vi.fn();
    const refusal = { message: "invalid_catalog_pack", issue };
    expect(() => catalogPackManifest(pack)).toThrow(expect.objectContaining(refusal));
    await expect(installCatalogDefinitions({ query }, pack)).rejects.toMatchObject(refusal);
    expect(query).not.toHaveBeenCalled();
    const report = await check(pack);
    expect(report.exitCode).toBe(1);
    expect(report.findings).toContainEqual(expect.objectContaining({ ...issue, path: `/packs/0/pack${issue.path}` }));
    return report;
  }

  it.each([
    ["AL-2", { ...profile, policyDigest: "invalid" }, "/policyDigest", "Supply policyDigest as a 64-character lowercase SHA-256 hex digest."],
    ["AN-1", { ...profile, policyRef: { ...profile.policyRef, "extra~/field": 1 } }, "/policyRef/extra~0~1field", 'Remove the unexpected property "extra~/field".'],
    ["AN-2", { ...profile, allowedCadences: [{ ...profile.allowedCadences[0], schemaVersion: 2 }] }, "/allowedCadences/0/schemaVersion", "Use schemaVersion 1 for this cadence choice."],
  ] as const)("%s carries the exact Core issue through all three surfaces", async (_name, invalid, path, fix) => {
    const issue = { code: "definition_profile_invalid", path, fix };
    expect(validateCatalogSubscriptionProfile(invalid)).toEqual({ issue });
    await checkRefusal({ ...optedIn, subscriptionProfileDefinitions: [invalid] }, { ...issue, path: `/subscriptionProfileDefinitions/0${path}` });
  });

  it("reports malformed digest and another malformed field without supplying repair evidence", async () => {
    const invalid = { ...profile, policyDigest: "foreign evidence" };
    const issue = { code: "definition_profile_invalid", path: "/subscriptionProfileDefinitions/0/policyDigest",
      fix: "Supply policyDigest as a 64-character lowercase SHA-256 hex digest." };
    const input = { ...optedIn, subscriptionProfileDefinitions: [invalid, { ...profile, maxFixedDays: 0 }] };
    const report = await checkRefusal(input, issue);
    expect(report.findings.map(finding => finding.path)).toEqual([
      "/packs/0/pack/subscriptionProfileDefinitions/0/policyDigest",
      "/packs/0/pack/subscriptionProfileDefinitions/1/maxFixedDays",
    ]);
    expect(catalogPackIssues(input)[0]).toEqual(issue);
    expect(report.findings[0]).not.toHaveProperty("value");
    expect(report.findings[0].fix).not.toContain(invalid.policyDigest);
  });

  it.each([
    [{ subscriptionProfileDefinitions: null }, "definition_invalid_shape", "/subscriptionProfileDefinitions", "Supply subscriptionProfileDefinitions as an array."],
    [{ subscriptionProfiles: null }, "definition_invalid_shape", "/subscriptionProfiles", "Supply subscriptionProfiles as an array of key/version references."],
    [{ subscriptionProfiles: [] }, "definition_invalid_shape", "/subscriptionProfiles", "List at least one exact subscription profile key and version."],
    [{ subscriptionProfiles: [{ ...ref, version: 0 }] }, "definition_profile_ref_invalid", "/subscriptionProfiles/0/version", "Supply a lowercase namespaced key of at most 120 characters and a whole-number version from 1 to 2147483647."],
    [{ subscriptionProfiles: [ref, ref] }, "definition_duplicate_identity", "/subscriptionProfiles/1", "Remove this duplicate reference and keep one entry for the exact profile version."],
    [{ subscriptionProfileDefinitions: [profile, profile] }, "definition_duplicate_identity", "/subscriptionProfileDefinitions/1", "Remove this duplicate declaration and keep one declaration for the exact profile version."],
    [{ subscriptionProfiles: [{ ...ref, version: 2 }] }, "definition_unknown_profile_ref", "/subscriptionProfileDefinitions/0", "List this declaration's exact key and version in subscriptionProfiles."],
    [{ types: [{ ...pack().types[0], subscriptionProfileRef: { ...ref, version: 2 } }] }, "definition_unknown_profile_ref", "/types/0/subscriptionProfileRef", "List the intended exact profile reference or select an identity already listed in subscriptionProfiles."],
    [{ types: [{ ...pack().types[0], subscriptionProfileRef: { ...ref, "extra~/field": true } }] }, "definition_profile_ref_invalid", "/types/0/subscriptionProfileRef/extra~0~1field", 'Remove the unexpected property "extra~/field".'],
  ] as const)("rejects opted-in pack issue %j before SQL", async (overrides, code, path, fix) => {
    await checkRefusal({ ...optedIn, ...overrides }, { code, path, fix });
  });

  it("preserves membership issue order when other metadata fails", () => {
    const type = { ...pack().types[0], version: 0, subscriptionProfileRef: { ...ref, version: 2 } };
    const invalidRef = { ...pack().types[0], subscriptionProfileRef: { ...ref, version: 2, extra: true } };
    expect(catalogPackIssues({ ...optedIn, types: [type, invalidRef] }).map(({ code, path }) => [code, path])).toEqual([
      ["definition_version_invalid", "/types/0/version"],
      ["definition_profile_ref_invalid", "/types/1/subscriptionProfileRef/extra"],
      ["definition_unknown_profile_ref", "/types/0/subscriptionProfileRef"],
    ]);
  });

  it("C-1 refuses an oversized canonical opted-in pack with one split remedy", async () => {
    const days = Array.from({ length: 3660 }, (_, i) => ({ schemaVersion: 1, kind: "fixed_days", days: i + 1 } as const));
    const definitions = Array.from({ length: 8 }, (_, i) => ({ ...profile, version: i + 1, allowedCadences: days }));
    const { subscriptionProfileDefinitions: _definitions, ...legacy } = {
      ...optedIn, subscriptionProfiles: definitions.map(({ key, version }) => ({ key, version })),
    };
    expect(await check(legacy)).toMatchObject({ exitCode: 0 });
    expect(await check({ ...legacy, subscriptionProfileDefinitions: [] })).toMatchObject({ exitCode: 0 });
    await checkRefusal({ ...legacy, subscriptionProfileDefinitions: definitions }, {
      code: "draft_payload_too_large", path: "", fix: "Split the profile declarations across pack versions or packs.",
    });
  });
});

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
      expect(errors(report)).toEqual([expect.objectContaining({ code: "title_required", path: "/packs/0/drafts/0/product/sharedContent/title" })]);
    }
    for (const broken of [
      { ...v3, publication: { ...v3.publication, operations: [{ ...op, name: 7 }] } },
      { ...v3, skus: [{ ...v3.skus[0], priceOperations: [{ ...price, unitPriceMinor: "900" }] }] },
    ]) {
      const owner = catalogDraftPayloadV3Schema.safeParse(broken);
      expect(owner.success).toBe(false);
      if (owner.success) throw new Error("Invalid v3 admitted");
      const findings = errors(await project({ packs: [{ pack: p, drafts: [broken] }] }));
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
    expect(errors(report)).toEqual([expect.objectContaining({
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
    expect(errors(report)).toEqual([expect.objectContaining({ code: "conformance_owner_unavailable", path: "/requiredChecks/0" })]);
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
      expect(errors(await check(p)).map(({ code, path }) => ({ code, path }))).toEqual(catalogPackIssues(p).map(({ code, path }) => ({ code, path: `/packs/0/pack${path}` })).sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)));
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
      expect(errors(report).map(({ code, path }) => ({ code, path }))).toEqual(ownerIssues.map(issue => ({ ...issue, path: `/packs/0/quantities/0/type${issue.path}` })));
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
    expect(errors(await checkSubject({ packs: [{ pack: p, quantities: [{ type: typeRef, value: quantity }] }] }))[0].code).toBe("quantity_fractional_count");
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
      expect(errors(report).map(({ code, path }) => ({ code, path })), name).toEqual(issues.map(issue => ({ ...issue,
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
    expect(mixed.exitCode).toBe(1); expect(errors(mixed)).toHaveLength(2);
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
  it.each(["/same", "/~1same", "/a.b~1", "/same.part~end"])("reports the offending row for duplicate SKU ID %s", async skuId => {
    const p = pack(), type = { key: p.types[0].key, version: 1 };
    const input = { axes: [], typed: false, retained: [], incoming: [
      { skuId, state: "draft" }, { skuId, state: "withdrawn" },
    ] };
    const subject = { packs: [{ pack: p, combinations: [{ type, input }] }] };
    const text = JSON.stringify(subject), report = await runCatalogExtensionConformance(text);
    const path = "/packs/0/combinations/0/input/incoming/1/skuId";
    expect(report.exitCode).toBe(1);
    expect(errors(report)).toEqual([expect.objectContaining({
      code: "duplicate_sku_id",
      path,
      observed: `${path} = "<host path>"`,
      fix: "Remove the repeated SKU entry while preserving authoritative identity.",
    })]);
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
    const fixturePaths: Record<string, string> = {
      "retained duplicate": "retained/1/skuId", "identity change": "incoming/0/skuId",
      "duplicate SKU": "incoming/1/skuId", "duplicate equivalent option": "incoming/1/skuId",
      "duplicate axes": "axes", "missing axis": "axes/0", "missing option": "incoming/0", "unknown option": "incoming/0/optionValues/extra",
    };
    for (const [name, input] of cases) {
      let expected: { code: string; path: string }[] = [];
      try { const retained = input.retained.map(row => ({ ...row, identity: canonicalizeCatalogCombinationV2({ definition: p.types[0], axes: input.axes, options: row.optionValues }) }));
        validateCatalogCombinationChangesV2({ ...input, definition: p.types[0], retained }); }
      catch (error) { if (!(error instanceof CatalogCombinationError)) throw error; expected = [{ code: error.code, path: `/packs/0/combinations/0/input/${fixturePaths[name] ?? error.path.replaceAll(".", "/")}` }]; }
      const report = await checkSubject({ packs: [{ pack: p, combinations: [{ type, input }] }], requiredChecks: ["variant-combinations"] });
      expect(errors(report).map(({ code, path }) => ({ code, path })), name).toEqual(expected);
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
          expect(report.exitCode).toBe(1); expect(errors(report)).toEqual([expect.objectContaining({ code: "conformance_subject_invalid", path: `/packs/0/combinations/0/input/${name}/0` })]);
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
        expect(errors(direct), name).toEqual([expect.objectContaining({ code, path })]);
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

      const invalidType = { ...p.types[0], key: "stationery:invalid", taxClass: "absent" };
      const mixed = { ...valid.packs[0], pack: { ...p, types: [invalidType, ...p.types] } };
      writeFileSync(file, JSON.stringify({ packs: [mixed] }));
      const skipped = call(args, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`]);
      expect(skipped).toMatchObject({ state: "violated", exitCode: 1 });
      expect(skipped.findings.map(({ code, severity, path }: CatalogConformanceReport["findings"][number]) =>
        [code, severity, path])).toEqual([
        ["advisory_fixtures_skipped_definition_invalid", "warning", "/packs/0/pack"],
        ["definition_unknown_tax_class", "error", "/packs/0/pack/types/0/taxClass"],
        ["advisory_net_content_not_publishable", "warning", "/packs/0/pack/types/1/netContentUnits"],
      ]);

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
      for (const finding of report.findings) expect(finding).toMatchObject({ recheck: subject.recheck, fix: expect.any(String), recipe: expect.any(String), evidence: expect.any(Object) });
    } finally { rmSync(folder, { recursive: true, force: true }); }
  }, 30_000);
});
