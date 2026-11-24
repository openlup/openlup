import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CATALOG_QUANTITY_UNITS } from "@openlup/core/catalog";
import { expect, it } from "vitest";
import { CATALOG_CONFORMANCE_RULES } from "../../src/catalog/catalogConformance.js";
import { CATALOG_DRAFT_MAX_BYTES, CATALOG_DRAFT_MAX_PAGE } from "../../src/catalog/contracts/draft.js";
import { CATALOG_MAX_AXES } from "../../src/catalog/productTypeIssues.js";
import { publicationRefusals, type PlatformCode } from "../../src/catalog/publicationError.js";
import { buildCatalogReleaseDraftV3, catalogInternalGtin, type CatalogProductInput } from "../../src/catalog/index.js";
import { describeReleaseDraftRefusal } from "../../src/catalog/releaseDraftBuilder.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const manifest = JSON.parse(read("../../package.json"));
const bin = fileURLToPath(new URL("../../" + manifest.bin.openlup, import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });

type Code = { code: string; family: string; severity: string; cause?: string; fix: string; fixVariants?: { when: string; fix: string }[] };
function report() {
  const result = run("catalogue", "schema", "--json");
  expect(result.status, result.stdout).toBe(0);
  const parsed = JSON.parse(result.stdout);
  return { ...parsed, codes: parsed.codes as Code[] };
}

it("catalogue_schema_json_is_deterministic", () => {
  const help = run("--help");
  expect(help.status).toBe(0);
  const usage = "openlup catalogue schema [--json]";
  expect(help.stdout.split("\n")).toContain(usage);
  const command = usage.split(" ").slice(1, -1);
  const text = run(...command);
  expect(text.status).toBe(0);
  expect(text.stdout).toMatch(/Name[^\n]*\n[\s\S]*productType[\s\S]*productInput[\s\S]*draftV3[\s\S]*Use --json for the full grammar/u);
  const recipe = read("../../../core/docs/guide/how-to/extend/catalogue-extension.md")
    .match(/^## Discover the grammar\n[\s\S]*?```sh\n(openlup [^\n]+)\n```/mu)?.[1];
  expect(recipe).toBe("openlup catalogue schema --json");
  const first = run(...command, "--json");
  const second = run(...recipe!.split(" ").slice(1));
  for (const result of [first, second]) {
    expect(result.status, result.stdout).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^\{[^\n]*\}\n$/u);
    expect(JSON.parse(result.stdout)).toMatchObject({
      formatVersion: 1, command: "catalogue schema", state: "satisfied", exitCode: 0,
      platformVersion: manifest.version,
    });
  }
  expect(Buffer.from(second.stdout, "utf8")).toEqual(Buffer.from(first.stdout, "utf8"));
});

it("schema_json_matches_committed_snapshot", () => {
  const { jsonSchemas, builtInUnits, draft, limits, caps } = report();
  expect({ jsonSchemas, builtInUnits }).toEqual(JSON.parse(read("./catalogue-schema.snapshot.json")));
  expect(builtInUnits).toEqual(CATALOG_QUANTITY_UNITS);
  expect(JSON.stringify(jsonSchemas.productType)).toContain("Use scale 0 for whole numbers; there is no integer kind.");
  expect(draft).toEqual({ storedSchemaVersions: [1, 2, 3], publishableSchemaVersion: 3 });
  expect(limits).toEqual([
    { name: "CATALOG_DRAFT_MAX_BYTES", value: CATALOG_DRAFT_MAX_BYTES, appliesTo: expect.any(String) },
    { name: "CATALOG_DRAFT_MAX_PAGE", value: CATALOG_DRAFT_MAX_PAGE, appliesTo: expect.any(String) },
    { name: "CATALOG_MAX_AXES", value: CATALOG_MAX_AXES, appliesTo: expect.any(String) },
  ]);
  const settings = JSON.parse(read("../../settings-catalog.json")) as {
    entries: { domain: string; kind: string; key: string; goal: string; runtime: { reason: string } }[];
  };
  expect(caps).toEqual(settings.entries.filter(({ domain, kind }) => domain === "catalog" && kind === "cap")
    .map(({ key, goal, runtime }) => ({ key, goal, reason: runtime.reason })));
});

const g1a: readonly PlatformCode[] = [
  "catalog_publication_gtin_conflict", "catalog_publication_tax_class_unavailable", "option_missing",
  "unit_trade_identifier_missing", "type_not_installed", "publication_preparation_unavailable", "price_validation_unavailable",
  "catalog_publication_mass_required_until_mc5", "catalog_publication_integral_grams_required",
  "catalog_publication_net_content_invalid", "catalog_publication_gross_mass_required",
  "catalog_publication_gross_mass_invalid", "catalog_publication_gross_below_net",
  "catalog_publication_v3_activation_readiness_failed", "catalog_publication_v3_active_primary_required",
  "catalog_publication_price_key_reused", "catalog_publication_price_changed", "catalog_publication_price_unavailable",
  "catalog_publication_price_readiness", "catalog_publication_sku_price_not_ready", "catalog_publication_sku_price_shape_invalid",
  "price_list_not_active", "price_list_not_found", "command_key_reused", "command_fingerprint_invalid", "command_invalid",
  "operator_mismatch", "command_in_progress", "sku_not_found", "sku_archived", "base_price_ambiguous",
];

it("schema_codes_cover_dictionaries", () => {
  const { codes } = report();
  expect(new Set(codes.map(({ code }) => code))).toEqual(new Set([
    ...Object.keys(CATALOG_CONFORMANCE_RULES), ...Object.keys(publicationRefusals), "release_draft_invalid",
  ]));
  const required = (code: string, fix: string) => {
    const matches = codes.filter(row => row.code === code && row.fix === fix);
    expect(matches, code).toHaveLength(1);
    return matches[0]!;
  };
  for (const [code, owner] of Object.entries(CATALOG_CONFORMANCE_RULES)) {
    expect(required(code, owner.fix)).toMatchObject({ cause: owner.rule, severity: owner.severity });
  }
  for (const [code, owner] of Object.entries(publicationRefusals)) {
    if ("rule" in owner) continue;
    const fix = "fix" in owner ? owner.fix : owner[1];
    const cause = "fix" in owner ? ("cause" in owner ? owner.cause : undefined) : owner.at(2);
    const row = required(code, fix);
    expect(row.severity, code).toBe("error");
    if (cause === undefined) expect(row, code).not.toHaveProperty("cause");
    else expect(row.cause, code).toBe(cause);
  }
  for (const code of g1a) expect(codes.find(row => row.code === code)?.cause, code).toMatch(/[^\s].*\.$/u);
  expect(codes).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "price_list_not_active",
      cause: "The price operation names an ineligible list, or the SKU readiness check found no eligible list. An eligible price list is active, matches the settlement region and currency, and is within its validity window." }),
    expect.objectContaining({ code: "catalog_publication_gtin_conflict",
      cause: "This GTIN is already assigned in the store, either to another SKU or to this SKU under a different issuer." }),
    expect.objectContaining({ code: "catalog_publication_sku_price_not_ready",
      cause: "The SKU fails the effective price list's readiness checks. There must be exactly one active, effective one-time entry at minimum quantity 1, and its gross amount must be positive. With no D2C subscription pricing policy history, there must be exactly one active, effective subscription entry, with a positive gross amount at minimum quantity 1. With policy history, exactly one valid policy revision must be effective and derive a positive price, and there must be no active, effective explicit subscription entry." }),
  ]));
  expect(required("duplicate_sku_id", "Remove the repeated SKU entry while preserving authoritative identity.").family).toBe("definition");
  expect(required("duplicate_sku_id", "Use a distinct identifier for each SKU.").family).toBe("draft");
  expect(codes.find(({ code }) => code === "catalog_publication_sku_price_not_ready")?.family).toBe("price");
  expect(codes.find(({ code }) => code === "catalog_publication_tax_class_unavailable")?.family).toBe("publication");
  expect(codes.find(({ code }) => code === "advisory_unit_identifier_missing")?.family).toBe("advisory");
  const owner = describeReleaseDraftRefusal();
  const { code, cause } = owner;
  const builder = codes.filter(row => row.code === code);
  expect(builder).toEqual([{ ...owner, family: "draft", severity: "error" }]);
  expect(builder[0]!.fixVariants).toHaveLength(17);
  const unit = (sequence: number) => ({ scheme: "gs1:gtin", issuer: "example:internal", packagingLevel: "unit", value: catalogInternalGtin(sequence) } as const);
  const product = (identifiers: CatalogProductInput["skus"][number]["identifiers"]): CatalogProductInput => ({
    namespace: "example", type: { key: "example:item", version: 1 }, slug: "item", name: "Item", presentation: {},
    skus: [{ code: "ITEM", title: "Item", options: {}, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 },
      identifiers, sell: { oneTime: true, subscription: false } }],
  });
  const cases = [
    { input: product([]), path: "skus.0.identifiers",
      when: "The refusal points to skus.N.identifiers and the SKU has no unit GS1 GTIN after its supplied identifier records pass validation." },
    { input: product([unit(1), unit(2)]), path: "skus.0.identifiers",
      when: "The SKU has multiple valid unit GS1 GTINs and none is marked primary, or isPrimary marks multiple identifiers or an identifier other than a unit GS1 GTIN" },
    { input: product([{ ...unit(1), value: "5901234123458" }]), path: "skus.0.identifiers.0.value",
      when: "The refusal points to skus.N.identifiers.M.value and the named GS1 identifier has a supported plain JSON string value that fails GTIN format or checksum validation.",
      fix: "Enter a valid GTIN for this identifier." },
    { input: { ...product([unit(1)]), namespace: "a".repeat(222), slug: "a" }, path: "namespace",
      when: "A generated schemaId or sourceRef exceeds 240 characters and the refusal points to namespace, or a generated documentRef exceeds 240 characters and the refusal points to slug." },
  ];
  for (const { input, path, when, fix } of cases) {
    const matching = builder[0]!.fixVariants!.filter(variant => variant.when === when);
    expect(matching).toHaveLength(1);
    if (fix !== undefined) expect(matching[0]!.fix).toBe(fix);
    expect(() => buildCatalogReleaseDraftV3(input)).toThrow(expect.objectContaining({
      code, path,
      message: expect.stringContaining(`\nCause: ${cause}\nFix: ${matching[0]!.fix}\n`),
    }));
  }
});

it.each([
  { args: ["catalogue", "schema", "--packs", "redacted-marker"], observed: "Rejected --packs syntax" },
  { args: ["catalogue", "schema", "--trusted-packs=redacted-marker", "--json"], observed: "Rejected --trusted-packs syntax" },
  { args: ["catalogue", "schema", "--app", "redacted-marker"], observed: "Rejected --app syntax" },
  { args: ["catalogue", "schema", "--app"], observed: "Rejected --app syntax" },
  { args: ["catalogue", "schema", "--redacted-marker"], observed: "Rejected an unsupported option" },
  { args: ["catalogue", "schema", "--help"], observed: "Rejected an unsupported option" },
  { args: ["catalogue", "schema", "--json=redacted-marker"], observed: "Rejected --json syntax" },
  { args: ["catalogue", "schema", "--json", "--json"], observed: "Rejected --json syntax" },
  { args: ["catalogue", "schema", "--json", "redacted-marker"], observed: "Rejected an extra positional argument" },
  { args: ["catalogue", "schema", "redacted-marker"], observed: "Rejected an extra positional argument" },
  { args: ["catalogue", "--help", "schema"], observed: "Rejected an unsupported option" },
  { args: ["catalogue", "--packs", "./owned/catalogue.json", "schema"], observed: "Rejected --packs syntax" },
  { args: ["catalogue", "--trusted-packs", "./owned/catalogue.ts", "schema"], observed: "Rejected --trusted-packs syntax" },
  { args: ["catalogue", "--app=./owned/application.mjs", "schema"], observed: "Rejected --app syntax" },
  { args: ["catalogue", "--json=redacted-marker", "schema"], observed: "Rejected --json syntax" },
  { args: ["--json", "catalogue", "schema"], observed: "Rejected --json syntax" },
])("schema_refuses_pack_flags_with_64 $observed $args", ({ args, observed }) => {
  const result = run(...args);
  expect(result.status).toBe(64);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain("redacted-marker");
  const finding = args.includes("--json")
    ? JSON.parse(result.stdout).findings[0]
    : Object.fromEntries(result.stdout.split("\n").slice(0, 5).map(line => {
      const match = /^(\w+): (.*)$/u.exec(line);
      return match ? [match[1]!.toLowerCase(), match[2]] : ["code", line];
    }));
  expect(finding).toMatchObject({
    code: "OPENLUP_E_CLI_INPUT", observed: expect.stringContaining(observed),
    cause: "catalogue schema takes only --json.",
    fix: "Run the command without other flags or arguments.",
    recheck: "openlup catalogue schema --json",
  });
  expect(finding.observed).not.toMatch(/redacted-marker|\.\/owned\//u);
  expect(run(...finding.recheck.split(" ").slice(1)).status).toBe(0);
});

it("treats recognized option values as values when identifying the schema command", () => {
  const result = run("catalogue", "--packs", "schema", "--help", "--json");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).command).toBe("help");
});
