import { canonicalizeCatalogQuantity, convertCatalogQuantity, type CatalogQuantityUnit } from "@openlup/core/catalog";
import {
  CATALOG_CONFORMANCE_RULES, catalogPackIssues, catalogProductTypeIssues, catalogProductTypeRefIssues,
  validateCatalogAttributes, prepareCatalogAttributeProjection, canonicalizeCatalogCombinationV2,
  validateCatalogCombinationChangesV2, CatalogCombinationError,
  catalogDraftPayloadSchema, createCatalogProductTypeRegistry, validateCatalogDraft,
  type CatalogConformanceCode, type CatalogPackInput,
} from "../index.js";
import { canonicalCatalogPublicationJson } from "../contracts/draft.js";
import { catalogDraftPayloadV2Schema } from "../draftV2Schemas.js";
import { validateCatalogDraftV2 } from "../draftV2Validation.js";
import { catalogDraftPayloadV3Schema } from "../draftV3Schemas.js";
import { catalogDraftPayloadV4Schema, catalogLifecycleValidationPayload } from "../lifecycleV2.js";
import { catalogDraftPayloadV5Schema, catalogSuccessorValidationPayload } from "../successorPublication.js";
import { catalogConformanceProfileOwners } from "./conformanceProfiles.js";
import type { CatalogConformanceFinding, CatalogConformanceReport, CatalogConformanceSource, CatalogConformanceSubject } from "./contracts.js";

const boundary = "Offline definitions, exact quantities, draft admission, attribute projection, V2 combinations and package-supported subscription profiles. Reference evidence and retained options are fixture observations. Taxonomy, tax application and promotions are unavailable. Installation, database references, installed cadence, persisted identity/history, price execution, publication and legal rate correctness require separate evidence. PASS grants no installation, migration, publication or activation authority. No database, network, seed or publish path is supplied.";
const command = "npx --no -- openlup catalogue check --packs ./owned/catalogue.json --json";
const pointer = (parts: readonly PropertyKey[]): string => parts.map(part => `/${String(part).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value: unknown, keys: readonly string[]): boolean => object(value) && Object.keys(value).every(key => keys.includes(key));
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const referenceKey = (namespace: string, id: string): string => JSON.stringify([namespace, id]);

// Deliberate input throws: Core catalog/quantities.ts:15, variantCombination.ts:22,
// contracts/draft.ts:40-67 and productTypeSchemas.ts:10. Operational failures are excluded.
const OWNER_INPUT_CODES = new Set([
  "quantity_invalid", "quantity_cross_dimension", "quantity_fractional_count", "quantity_unknown_unit",
  "quantity_overflow", "quantity_not_exactly_representable",
  "axis_not_installed", "duplicate_axis", "option_not_selected", "option_missing", "option_invalid",
  "unit_factor_missing", "sku_identity_change_requires_new_sku", "duplicate_combination",
  "duplicate_sku_id", "sku_payload_limit", "product_capacity_exceeded", "product_capacity_invalid",
  "draft_json_invalid", "draft_json_depth", "draft_payload_too_large", "invalid_catalog_type_definition",
]);

/** Parse JSON text without a reviver; non-string arguments are refused without inspection. Syntax errors reject.
 * @experimental
 */
export async function runCatalogExtensionConformance(jsonText: string): Promise<CatalogConformanceReport> {
  return checkSubject(jsonText);
}

/** Project explicitly trusted application source. Callback authority is local to the returned
 * check and bound to the exact subject bytes. The JSON-only API never executes source.
 * @experimental
 */
export function projectCatalogExtensionConformance(source: CatalogConformanceSource): {
  subject: string; check: (jsonText: string) => Promise<CatalogConformanceReport>;
} {
  const owners = source.packs.map(({ pack, profilePolicies }) => ({
    validators: pack.types.map(({ validateContent }) => {
      if (typeof validateContent !== "function") throw new TypeError("Missing trusted content validator");
      return validateContent;
    }),
    policies: profilePolicies?.map(policy => policy.kind === "host_policy" ? policy.validate : undefined) ?? [],
  }));
  const subject = canonicalCatalogPublicationJson({
    ...source,
    packs: source.packs.map(({ pack, profilePolicies, ...entry }) => ({ ...entry, pack: { ...pack,
      types: pack.types.map(({ validateContent: _validateContent, ...type }) => type),
    }, ...(profilePolicies ? { profilePolicies: profilePolicies.map(policy => {
      if (policy.kind !== "host_policy") return policy;
      const { validate, ...fields } = policy;
      if (typeof validate !== "function") throw new TypeError("Missing trusted subscription policy validator");
      return fields;
    }) } : {}),
    })),
  });
  return {
    subject,
    async check(jsonText) {
      if (subject !== jsonText) throw new TypeError("Projected subject bytes differ");
      return checkSubject(jsonText, owners);
    },
  };
}

type TrustedOwners = {
  validators: readonly CatalogPackInput["types"][number]["validateContent"][];
  policies: Parameters<typeof catalogConformanceProfileOwners>[3];
};

async function checkSubject(jsonText: string, owners?: readonly TrustedOwners[]): Promise<CatalogConformanceReport> {
  const findings: CatalogConformanceFinding[] = [];
  let unavailable = false, violated = false, recheck = command;
  function add(code: string, path: string, fixture = "", requiredEvidence = false): void {
    const rule = Object.hasOwn(CATALOG_CONFORMANCE_RULES, code) ? CATALOG_CONFORMANCE_RULES[code as CatalogConformanceCode] : CATALOG_CONFORMANCE_RULES.draft_payload_invalid;
    if (requiredEvidence) unavailable = true; else violated = true;
    findings.push({ code, severity: rule.severity, path, fixture, observed: `Owner check reported ${code}.`,
      cause: rule.rule, fix: rule.fix, recipe: rule.recipe, recheck,
      evidence: { declared: "JSON fixture observations", bound: "Offline owner validators only", checked: path,
        unknown: ["Installed and runtime state; see boundary"] } });
  }
  // Only shared owner calls enter this boundary; parsing, checker logic and CLI I/O remain outside.
  async function owner<T>(path: string, work: () => T | Promise<T>): Promise<T | undefined> {
    try { return await work(); }
    catch (error) {
      if (error instanceof SyntaxError) throw error;
      const named = error instanceof Error ? "code" in error && typeof error.code === "string" ? error.code : error.message : "";
      if (!OWNER_INPUT_CODES.has(named)) throw error;
      add(named, `${path}${error instanceof CatalogCombinationError ? pointer(error.path.split(".")) : ""}`);
      return undefined;
    }
  }
  function quantityShape(value: unknown, path: string): boolean {
    if (!closed(value, ["dimension", "unit", "unscaled", "scale"])) { add("quantity_invalid", path); return false; }
    const fields = value as Record<string, unknown>;
    let valid = true;
    for (const key of ["dimension", "unit", "unscaled", "scale"] as const) {
      if (key === "scale" ? !Number.isInteger(fields[key]) : typeof fields[key] !== "string") {
        add("quantity_invalid", `${path}/${key}`); valid = false;
      }
    }
    return valid;
  }
  function finish(): CatalogConformanceReport {
    findings.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code) || compare(a.fixture, b.fixture));
    const content = owners ? "Trusted projection executes registered validators on the checked bytes."
      : "Application content validation requires the trusted projection command.";
    return { state: violated ? "violated" : unavailable ? "unavailable" : "satisfied", exitCode: violated ? 1 : unavailable ? 2 : 0,
      boundary: `${boundary} ${content}`, findings };
  }
  if (typeof jsonText !== "string") { add("conformance_subject_invalid", ""); return finish(); }
  let parsed: unknown;
  try { parsed = JSON.parse(jsonText); }
  catch (error) {
    if (error instanceof SyntaxError) Object.defineProperty(error, Symbol.for("openlup.catalogue.json.parse"), { value: true });
    throw error;
  }
  if (!object(parsed) || !closed(parsed, ["packs", "requiredChecks", "recheck"])
    || !Array.isArray(parsed.packs) || !parsed.packs.length
    || (Object.hasOwn(parsed, "recheck") && typeof parsed.recheck !== "string")
    || (Object.hasOwn(parsed, "requiredChecks") && (!Array.isArray(parsed.requiredChecks) || parsed.requiredChecks.some(check => typeof check !== "string")))) {
    add("conformance_subject_invalid", ""); return finish();
  }
  const subject = parsed as unknown as CatalogConformanceSubject;
  if (typeof subject.recheck === "string") recheck = subject.recheck;
  const coverage = new Map(["attribute-values", "variant-combinations", "quantities", "draft-content", "profiles", "owner-refusals"].map(check => [check, true]));
  const requireCheck = (check: string) => subject.requiredChecks?.includes(check) === true;
  const cover = (check: string, present: boolean) => { if (!present) coverage.set(check, false); };
  const allTypes: unknown[] = [], typePaths: string[] = [];
  for (const [index, entry] of subject.packs.entries()) {
    const at = `/packs/${index}`;
    if (!closed(entry, ["pack", "drafts", "quantities", "attributes", "combinations", "refusals", "profileChecks", "profilePolicies"])
      || [entry.drafts, entry.quantities, entry.attributes, entry.combinations, entry.refusals, entry.profileChecks, entry.profilePolicies]
        .some(value => value !== undefined && !Array.isArray(value))) {
      add("conformance_subject_invalid", at);
      for (const key of coverage.keys()) cover(key, false);
      continue;
    }
    const { drafts, quantities, attributes, combinations, refusals } = entry;
    cover("attribute-values", !!attributes?.length);
    cover("variant-combinations", !!combinations?.length);
    cover("quantities", !!quantities?.length);
    // JSON never supplies executable code or evidence that a validator ran.
    let executableField = false;
    const pack = object(entry.pack) && Array.isArray(entry.pack.types) ? { ...entry.pack, types: entry.pack.types.map((type, i) => {
      if (!object(type)) return type;
      if (Object.hasOwn(type, "validateContent")) {
        add("definition_unknown_field", `${at}/pack/types/${i}/validateContent`); executableField = true;
      }
      return { ...type, validateContent: owners?.[index]?.validators[i] ?? (() => [{ code: "conformance_owner_unavailable", path: "" }]) };
    }) } as CatalogPackInput : entry.pack as CatalogPackInput;
    if (executableField) continue;
    const issues = await owner(`${at}/pack`, () => catalogPackIssues(pack));
    if (!issues) continue;
    issues.forEach(issue => add(issue.code, `${at}/pack${issue.path}`));
    if (issues.length) continue;
    pack.types.forEach((type, i) => { allTypes.push(type); typePaths.push(`${at}/pack/types/${i}`); });
    const registry = await owner(`${at}/pack/types`, () => createCatalogProductTypeRegistry(pack.types));
    if (!registry) continue;
    let currentDraftSeen = false;
    for (const [i, draft] of (drafts ?? []).entries()) {
      const path = `${at}/drafts/${i}`;
      const version = object(draft) ? draft.schemaVersion : undefined;
      const schema = version === 5 ? catalogDraftPayloadV5Schema : version === 4 ? catalogDraftPayloadV4Schema
        : version === 3 ? catalogDraftPayloadV3Schema : version === 2 ? catalogDraftPayloadV2Schema : catalogDraftPayloadSchema;
      const parse = () => schema.safeParse(draft);
      const admitted = schema === catalogDraftPayloadSchema ? await owner(path, parse) : parse();
      if (!admitted) continue;
      if (!admitted.success) { admitted.error.issues.forEach(issue => add("draft_input_invalid", `${path}${pointer(issue.path)}`)); continue; }
      const payload = admitted.data;
      currentDraftSeen ||= payload.schemaVersion >= 3;
      if (requireCheck("draft-content") && "publication" in payload) {
        if (!payload.publication.operations.length) add("conformance_owner_unavailable", `${path}/publication/operations`, "", true);
        if (!payload.product.documentRevision && payload.publication.operations.some(operation => operation.op === "register_document_revision")) {
          add("conformance_owner_unavailable", `${path}/product/documentRevision`, "", true);
        }
      }
      const validate = () => payload.schemaVersion === 1 ? validateCatalogDraft(payload, registry)
        : validateCatalogDraftV2(payload.schemaVersion === 2 ? payload : catalogLifecycleValidationPayload(
          payload.schemaVersion === 5 ? catalogSuccessorValidationPayload(payload) : payload), registry);
      const validation = payload.schemaVersion === 1 && !owners ? await owner(path, validate) : await validate();
      if (!validation) continue;
      const draftIssues = !validation.valid ? validation.issues
        : requireCheck("draft-content") && payload.schemaVersion >= 3 ? validation.readiness.publication.issues : [];
      for (const issue of draftIssues) {
        const suffix = issue.path.startsWith("/") ? issue.path : pointer(issue.path.split("."));
        add(issue.code, path + suffix, "", issue.code === "conformance_owner_unavailable" || issue.code === "attribute_reference_unresolved");
      }
    }
    cover("draft-content", currentDraftSeen);
    const profiles = catalogConformanceProfileOwners(pack, entry.profilePolicies ?? [],
      (code, path, unavailable) => add(code, at + path, "", unavailable), owners?.[index]?.policies);
    if (requireCheck("profiles") || entry.profileChecks?.length || entry.profilePolicies?.length) profiles.check(entry.profileChecks ?? []);
    cover("profiles", !!entry.profileChecks?.length);
    for (const [i, fixture] of (quantities ?? []).entries()) {
      const path = `${at}/quantities/${i}`;
      if (!closed(fixture, ["type", "value", "targetUnit"])) { add("conformance_subject_invalid", path); continue; }
      if (!quantityShape(fixture.value, `${path}/value`)) continue;
      if (fixture.targetUnit !== undefined && typeof fixture.targetUnit !== "string") { add("quantity_invalid", `${path}/targetUnit`); continue; }
      const issues = await owner(`${path}/type`, () => catalogProductTypeRefIssues(fixture.type));
      if (!issues) continue;
      issues.forEach(issue => add(issue.code, `${path}/type${issue.path}`));
      if (issues.length) continue;
      const definition = await owner(`${path}/type`, () => registry.resolve(fixture.type) ?? null);
      if (definition === undefined) continue;
      if (!definition) { add("type_not_installed", `${path}/type`); continue; }
      if (definition.units.some(unit => !unit.factor)) { add("conformance_owner_unavailable", path, "", true); continue; }
      const units = definition.units as readonly CatalogQuantityUnit[];
      await owner(`${path}/value`, () => fixture.targetUnit === undefined
        ? canonicalizeCatalogQuantity(fixture.value, units) : convertCatalogQuantity(fixture.value, fixture.targetUnit, units));
    }
    for (const field of ["attributes", "combinations"] as const) {
      for (const [i, fixture] of (field === "attributes" ? attributes ?? [] : combinations ?? []).entries()) {
        const path = `${at}/${field}/${i}`;
        if (!closed(fixture, field === "attributes" ? ["type", "input", "publicationRevision", "references"] : ["type", "input"])) {
          add("conformance_subject_invalid", path); continue;
        }
        const issues = await owner(`${path}/type`, () => catalogProductTypeRefIssues(fixture.type));
        if (!issues) continue;
        issues.forEach(issue => add(issue.code, `${path}/type${issue.path}`));
        if (issues.length) continue;
        const definition = await owner(`${path}/type`, () => registry.resolve(fixture.type) ?? null);
        if (definition === undefined) continue;
        if (!definition) { add("type_not_installed", `${path}/type`); continue; }
        if (field === "attributes") {
          const value = fixture as NonNullable<typeof attributes>[number];
          const evidence = value.references === undefined ? [] : value.references;
          if (!Array.isArray(evidence) || evidence.some(row => !closed(row, ["namespace", "id", "status"])
            || typeof row.namespace !== "string" || typeof row.id !== "string"
            || !["resolved", "dangling", "private", "unavailable"].includes(row.status))) {
            add("conformance_subject_invalid", `${path}/references`); continue;
          }
          const statuses = new Map<string, string[]>();
          for (const row of evidence) {
            const key = referenceKey(row.namespace, row.id);
            statuses.set(key, [...statuses.get(key) ?? [], row.status]);
          }
          const validation = await owner(`${path}/input`, () => validateCatalogAttributes(definition, value.input, { resolve: async () => evidence }));
          if (!validation) continue;
          const prepared = await owner(`${path}/input`, () => prepareCatalogAttributeProjection(validation, value.publicationRevision));
          if (!prepared) continue;
          if (!prepared.prepared) prepared.issues.forEach(issue => {
            let requiredEvidence = false;
            if (issue.code === "attribute_reference_unresolved") {
              const target = issue.path.split("/").slice(1).reduce<unknown>((node, key) => {
                const ownKey = key.replaceAll("~1", "/").replaceAll("~0", "~");
                return node !== null && typeof node === "object" && Object.hasOwn(node, ownKey) ? (node as Record<string, unknown>)[ownKey] : undefined;
              }, value.input);
              const matches = object(target) && typeof target.namespace === "string" && typeof target.id === "string"
                ? statuses.get(referenceKey(target.namespace, target.id)) ?? [] : [];
              requiredEvidence = matches.length !== 1 || !["dangling", "private"].includes(matches[0]);
            }
            add(issue.code, `${path}${issue.code === "attribute_publication_revision_invalid" ? "" : "/input"}${issue.path}`, "", requiredEvidence);
          });
        } else {
          const input = (fixture as NonNullable<typeof combinations>[number]).input;
          if (!closed(input, ["axes", "typed", "retained", "incoming", "capacity"])
            || !Array.isArray(input.axes) || input.axes.some(key => typeof key !== "string") || typeof input.typed !== "boolean"
            || !Array.isArray(input.retained) || !Array.isArray(input.incoming)) {
            add("conformance_subject_invalid", `${path}/input`); continue;
          }
          let invalid = false;
          for (const name of ["retained", "incoming"] as const) for (const [j, row] of input[name].entries()) {
            if (!closed(row, ["skuId", "state", "optionValues"]) || !Object.hasOwn(row, "skuId") || typeof row.skuId !== "string" || !row.skuId
              || !Object.hasOwn(row, "state") || !["draft", "active", "withdrawn"].includes(row.state)
              || (name === "retained" && !Object.hasOwn(row, "optionValues"))
              || (Object.hasOwn(row, "optionValues") && row.optionValues !== null && !object(row.optionValues))) {
              add("conformance_subject_invalid", `${path}/input/${name}/${j}`); invalid = true;
            }
          }
          if (invalid) continue;
          await owner(`${path}/input`, () => {
            const retained = input.retained.map(row => ({ ...row, identity: row.optionValues === null ? null
              : canonicalizeCatalogCombinationV2({ definition, axes: input.axes, options: row.optionValues }) }));
            return validateCatalogCombinationChangesV2({ ...input, definition, retained });
          });
        }
      }
    }
    const witnessed = new Set<string>();
    for (const [i, fixture] of (refusals ?? []).entries()) {
      const path = `${at}/refusals/${i}`;
      if (object(fixture) && typeof fixture.capability === "string") witnessed.add(fixture.capability);
      if (!closed(fixture, ["name", "capability", "expectedCode", "observedCode", "zeroEffects"])
        || typeof fixture.name !== "string" || !fixture.name || typeof fixture.expectedCode !== "string" || !fixture.expectedCode
        || typeof fixture.observedCode !== "string" || !fixture.observedCode || typeof fixture.zeroEffects !== "boolean"
        || typeof fixture.capability !== "string" || !Object.hasOwn(pack.capabilities, fixture.capability) || pack.capabilities[fixture.capability] !== false) {
        add("conformance_refusal_fixture_invalid", path); continue;
      }
      if (fixture.observedCode !== fixture.expectedCode || !fixture.zeroEffects) {
        add("conformance_refusal_fixture_mismatch", path, fixture.name); continue;
      }
      if (requireCheck("owner-refusals")) {
        const observed = profiles.observeRefusal(fixture.capability);
        if (!observed) add("conformance_owner_unavailable", path, fixture.name, true);
        else if (observed.code !== fixture.expectedCode || !observed.zeroEffects) add("conformance_refusal_fixture_mismatch", path, fixture.name);
      }
    }
    for (const [capability, supported] of Object.entries(pack.capabilities)) if (!supported && !witnessed.has(capability))
      add("conformance_refusal_fixture_missing", `${at}/pack/capabilities${pointer([capability])}`);
    cover("owner-refusals", !!refusals?.length);
  }
  for (const [index, check] of (subject.requiredChecks ?? []).entries())
    if (coverage.get(check) !== true)
      add("conformance_owner_unavailable", `/requiredChecks/${index}`, "", true);
  const typeIssues = await owner("/packs", () => catalogProductTypeIssues(allTypes));
  typeIssues?.filter(issue => issue.code === "definition_duplicate_identity").forEach(issue => {
    const [, index, ...rest] = issue.path.split("/");
    const path = `${typePaths[Number(index)]}/${rest.join("/")}`;
    if (!findings.some(finding => finding.code === issue.code && finding.path === path)) add(issue.code, path);
  });
  return finish();
}
