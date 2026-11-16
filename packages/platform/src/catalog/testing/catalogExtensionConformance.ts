import { CatalogQuantityError, canonicalizeCatalogQuantity, convertCatalogQuantity, type CatalogQuantityUnit } from "@openlup/core/catalog";
import {
  CATALOG_CONFORMANCE_RULES, catalogPackIssues, catalogProductTypeIssues, catalogProductTypeRefIssues,
  validateCatalogAttributes, prepareCatalogAttributeProjection, canonicalizeCatalogCombinationV2,
  validateCatalogCombinationChangesV2, CatalogCombinationError,
  catalogDraftPayloadSchema, createCatalogProductTypeRegistry, validateCatalogDraft,
  type CatalogConformanceCode, type CatalogPackInput,
} from "../index.js";
import type { CatalogConformanceFinding, CatalogConformanceReport, CatalogConformanceSubject } from "./contracts.js";

const boundary = "Offline JSON definitions, exact quantities, supplied v1 drafts, attribute validation/projection preparation and V2 combination fixtures only. Reference evidence and retained options are fixture observations; PASS does not validate persisted identity bytes or history. Application content validation, category graphs, tax intervals, cadence, promotion grammar and publication require unavailable owner evidence. Installed versions, database references, installed cadence, listing capacity, publication races and legal rate correctness remain unobserved. PASS grants no installation, migration, publication or activation authority. No database, network, seed or publish path is supplied.";
const command = "npx --no -- openlup catalogue check --packs ./owned/catalogue.json --json";
const pointer = (parts: readonly PropertyKey[]): string => parts.map(part => `/${String(part).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value: unknown, keys: readonly string[]): boolean => object(value) && Object.keys(value).every(key => keys.includes(key));
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const referenceKey = (namespace: string, id: string): string => JSON.stringify([namespace, id]);

/** Parse JSON text without a reviver; non-string arguments are refused without inspection. Syntax errors reject. */
export async function runCatalogExtensionConformance(jsonText: string): Promise<CatalogConformanceReport> {
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
  function finish(): CatalogConformanceReport {
    findings.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code) || compare(a.fixture, b.fixture));
    return { state: violated ? "violated" : unavailable ? "unavailable" : "satisfied", exitCode: violated ? 1 : unavailable ? 2 : 0, boundary, findings };
  }
  if (typeof jsonText !== "string") { add("conformance_subject_invalid", ""); return finish(); }
  const parsed: unknown = JSON.parse(jsonText);
  if (!object(parsed) || !closed(parsed, ["packs", "requiredChecks", "recheck"])
    || !Array.isArray(parsed.packs) || !parsed.packs.length
    || (Object.hasOwn(parsed, "recheck") && typeof parsed.recheck !== "string")
    || (Object.hasOwn(parsed, "requiredChecks") && (!Array.isArray(parsed.requiredChecks) || parsed.requiredChecks.some(check => typeof check !== "string")))) {
    add("conformance_subject_invalid", ""); return finish();
  }
  const subject = parsed as unknown as CatalogConformanceSubject;
  if (typeof subject.recheck === "string") recheck = subject.recheck;
  let attributesAvailable = true, combinationsAvailable = true;
  const allTypes: unknown[] = [], typePaths: string[] = [];
  for (const [index, entry] of subject.packs.entries()) {
    const at = `/packs/${index}`;
    if (!closed(entry, ["pack", "drafts", "quantities", "attributes", "combinations", "refusals"])
      || [entry.drafts, entry.quantities, entry.attributes, entry.combinations, entry.refusals].some(value => value !== undefined && !Array.isArray(value))) {
      add("conformance_subject_invalid", at); attributesAvailable = combinationsAvailable = false; continue;
    }
    const { drafts, quantities, attributes, combinations, refusals } = entry;
    attributesAvailable &&= !!attributes?.length;
    combinationsAvailable &&= !!combinations?.length;
    // Only this internal callback enters owner definitions. JSON never supplies executable code.
    let executableField = false;
    const pack = object(entry.pack) && Array.isArray(entry.pack.types) ? { ...entry.pack, types: entry.pack.types.map((type, i) => {
      if (!object(type)) return type;
      if (Object.hasOwn(type, "validateContent")) {
        add("definition_unknown_field", `${at}/pack/types/${i}/validateContent`); executableField = true;
      }
      return { ...type, validateContent: () => [{ code: "conformance_owner_unavailable", path: "" }] };
    }) } as CatalogPackInput : entry.pack as CatalogPackInput;
    if (executableField) continue;
    const issues = catalogPackIssues(pack);
    issues.forEach(issue => add(issue.code, `${at}/pack${issue.path}`));
    if (issues.length) continue;
    pack.types.forEach((type, i) => { allTypes.push(type); typePaths.push(`${at}/pack/types/${i}`); });
    const registry = createCatalogProductTypeRegistry(pack.types);
    for (const [i, draft] of (drafts ?? []).entries()) {
      const path = `${at}/drafts/${i}`, admitted = catalogDraftPayloadSchema.safeParse(draft);
      if (!admitted.success) { admitted.error.issues.forEach(issue => add("draft_input_invalid", `${path}${pointer(issue.path)}`)); continue; }
      const validation = validateCatalogDraft(admitted.data, registry);
      if (!validation.valid) validation.issues.forEach(issue => add(issue.code, `${path}${pointer(issue.path.split("."))}`, "", issue.code === "conformance_owner_unavailable"));
    }
    for (const [i, fixture] of (quantities ?? []).entries()) {
      const path = `${at}/quantities/${i}`;
      if (!closed(fixture, ["type", "value", "targetUnit"]) || !object(fixture.value)) { add("conformance_subject_invalid", path); continue; }
      const issues = catalogProductTypeRefIssues(fixture.type);
      issues.forEach(issue => add(issue.code, `${path}/type${issue.path}`));
      if (issues.length) continue;
      const definition = registry.resolve(fixture.type);
      if (!definition) { add("type_not_installed", `${path}/type`); continue; }
      if (definition.units.some(unit => !unit.factor)) { add("conformance_owner_unavailable", path, "", true); continue; }
      const units = definition.units as readonly CatalogQuantityUnit[];
      try {
        if (fixture.targetUnit === undefined) canonicalizeCatalogQuantity(fixture.value, units);
        else convertCatalogQuantity(fixture.value, fixture.targetUnit, units);
      } catch (error) {
        if (!(error instanceof CatalogQuantityError)) throw error;
        add(error.code, `${path}/value`);
      }
    }
    for (const field of ["attributes", "combinations"] as const) {
      for (const [i, fixture] of (field === "attributes" ? attributes ?? [] : combinations ?? []).entries()) {
        const path = `${at}/${field}/${i}`;
        if (!closed(fixture, field === "attributes" ? ["type", "input", "publicationRevision", "references"] : ["type", "input"])) {
          add("conformance_subject_invalid", path); continue;
        }
        const issues = catalogProductTypeRefIssues(fixture.type);
        issues.forEach(issue => add(issue.code, `${path}/type${issue.path}`));
        if (issues.length) continue;
        const definition = registry.resolve(fixture.type);
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
          const validation = await validateCatalogAttributes(definition, value.input, { resolve: async () => evidence });
          const prepared = prepareCatalogAttributeProjection(validation, value.publicationRevision);
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
          try {
            const retained = input.retained.map(row => ({ ...row, identity: row.optionValues === null ? null
              : canonicalizeCatalogCombinationV2({ definition, axes: input.axes, options: row.optionValues }) }));
            validateCatalogCombinationChangesV2({ ...input, definition, retained });
          } catch (error) {
            if (!(error instanceof CatalogCombinationError) && !(error instanceof CatalogQuantityError)) throw error;
            add(error.code, `${path}/input${error instanceof CatalogCombinationError ? pointer(error.path.split(".")) : ""}`);
          }
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
      if (fixture.observedCode !== fixture.expectedCode || !fixture.zeroEffects) add("conformance_refusal_fixture_mismatch", path, fixture.name);
    }
    for (const [capability, supported] of Object.entries(pack.capabilities)) if (!supported && !witnessed.has(capability))
      add("conformance_refusal_fixture_missing", `${at}/pack/capabilities${pointer([capability])}`);
  }
  for (const [index, check] of (subject.requiredChecks ?? []).entries())
    if (!(check === "attribute-values" ? attributesAvailable : check === "variant-combinations" ? combinationsAvailable : false))
      add("conformance_owner_unavailable", `/requiredChecks/${index}`, "", true);
  catalogProductTypeIssues(allTypes).filter(issue => issue.code === "definition_duplicate_identity").forEach(issue => {
    const [, index, ...rest] = issue.path.split("/");
    const path = `${typePaths[Number(index)]}/${rest.join("/")}`;
    if (!findings.some(finding => finding.code === issue.code && finding.path === path)) add(issue.code, path);
  });
  return finish();
}
