import { CatalogQuantityError, canonicalizeCatalogQuantity, convertCatalogQuantity } from "@openlup/core/catalog";
import {
  CATALOG_CONFORMANCE_RULES, catalogPackIssues, catalogProductTypeIssues, catalogProductTypeRefIssues,
  canonicalCatalogDraftJson, validateCatalogAttributes, prepareCatalogAttributeProjection, validateCatalogCombinationChangesV2, CatalogCombinationError,
  catalogDraftPayloadSchema, createCatalogProductTypeRegistry, validateCatalogDraft,
  type CatalogConformanceCode, type CatalogPackInput,
} from "../index.js";
import type { CatalogAttributeReferencePort } from "../attributeReferencePort.js";
import type { CatalogConformanceFinding, CatalogConformanceReport, CatalogConformanceSubject } from "./contracts.js";

const boundary = "Offline definitions, exact quantities, supplied v1 drafts, separate attribute validation/projection preparation and supplied V2 variant combination changes only. Supplied reference resolvers and retained combination facts are trusted fixture evidence, not proof of database state. Taxonomy, dated tax coverage, profile semantics and promotion grammar await their owners. Installed versions, existing database references, installed cadence, listing capacity, publication races and legal rate correctness are unobserved runtime facts. PASS grants no installation, migration, publication or activation authority. Trusted imported modules and callbacks are not sandboxed; the checker owns no database, network, seed or publish path.";
const command = "npx --no -- openlup catalogue check --packs ./owned/catalogue.ts --json";
const pointer = (parts: readonly PropertyKey[]): string => parts.map(part => `/${String(part).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
const object = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Calls existing owners only. Unexpected callback failures propagate to the CLI's sanitized failure path. */
export async function runCatalogExtensionConformance(subject: CatalogConformanceSubject): Promise<CatalogConformanceReport> {
  const findings: CatalogConformanceFinding[] = [];
  let unavailable = false;
  let violated = false;
  const recheck = object(subject) && typeof subject.recheck === "string" ? subject.recheck : command;
  function add(code: string, path: string, fixture = "", requiredEvidence = false): void {
    const rule = Object.hasOwn(CATALOG_CONFORMANCE_RULES, code) ? CATALOG_CONFORMANCE_RULES[code as CatalogConformanceCode] : CATALOG_CONFORMANCE_RULES.draft_payload_invalid;
    if (requiredEvidence) unavailable = true; else violated = true;
    findings.push({ code, severity: rule.severity, path, fixture, observed: `Owner check reported ${code}.`,
      cause: rule.rule, fix: rule.fix, recipe: rule.recipe, recheck,
      evidence: { declared: "Explicit subject and trusted fixtures", bound: "Offline owner validators only", checked: path,
        unknown: ["Installed and runtime state; see boundary"] } });
  }
  function finish(): CatalogConformanceReport {
    findings.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code) || compare(a.fixture, b.fixture));
    return { state: violated ? "violated" : unavailable ? "unavailable" : "satisfied", exitCode: violated ? 1 : unavailable ? 2 : 0, boundary, findings };
  }
  if (!object(subject) || !Array.isArray(subject.packs) || !subject.packs.length
    || (subject.recheck !== undefined && typeof subject.recheck !== "string")
    || Reflect.ownKeys(subject).some(key => typeof key !== "string" || !["packs", "requiredChecks", "recheck"].includes(key))
    || (subject.requiredChecks !== undefined && (!Array.isArray(subject.requiredChecks) || subject.requiredChecks.some(check => typeof check !== "string")))) {
    add("conformance_subject_invalid", ""); return finish();
  }
  for (const [index, check] of (subject.requiredChecks ?? []).entries()) {
    const field = check === "attribute-values" ? "attributes" : check === "variant-combinations" ? "combinations" : undefined;
    if (!field || !Array.from(subject.packs).every(entry => object(entry) && Array.isArray(entry[field]) && entry[field]!.length > 0))
      add("conformance_owner_unavailable", `/requiredChecks/${index}`, "", true);
  }
  const allTypes: unknown[] = [];
  const typePaths: string[] = [];
  for (const [index, rawEntry] of Array.from(subject.packs).entries()) {
    const entry: CatalogConformanceSubject["packs"][number] = rawEntry;
    const at = `/packs/${index}`;
    if (!object(entry) || Reflect.ownKeys(entry).some(key => typeof key !== "string" || !["pack", "drafts", "quantities", "attributes", "combinations", "refusals"].includes(key))
      || [entry.drafts, entry.quantities, entry.attributes, entry.combinations, entry.refusals].some(value => value !== undefined && !Array.isArray(value))) {
      add("conformance_subject_invalid", at); continue;
    }
    const issues = catalogPackIssues(entry.pack);
    issues.forEach(issue => add(issue.code, `${at}/pack${issue.path}`));
    if (issues.length) continue;
    const pack: CatalogPackInput = entry.pack;
    pack.types.forEach((type, i) => { allTypes.push(type); typePaths.push(`${at}/pack/types/${i}`); });
    const registry = createCatalogProductTypeRegistry(pack.types);
    Array.from(entry.drafts ?? []).forEach((draft, i) => {
      const path = `${at}/drafts/${i}`;
      const parsed = catalogDraftPayloadSchema.safeParse(draft);
      if (!parsed.success) {
        parsed.error.issues.forEach(issue => add("draft_input_invalid", `${path}${pointer(issue.path)}`)); return;
      }
      const validation = validateCatalogDraft(parsed.data, registry);
      // Draft readiness is not publication readiness. Missing runtime facts stay in boundary.
      if (!validation.valid) validation.issues.forEach(issue => add(issue.code, `${path}${pointer(issue.path.split("."))}`));
    });
    Array.from(entry.quantities ?? []).forEach((fixture, i) => {
      const path = `${at}/quantities/${i}`;
      if (!object(fixture) || !object(fixture.value)
        || Reflect.ownKeys(fixture).some(key => typeof key !== "string" || !["type", "value", "targetUnit"].includes(key))) {
        add("conformance_subject_invalid", path); return;
      }
      const referenceIssues = catalogProductTypeRefIssues(fixture.type);
      referenceIssues.forEach(issue => add(issue.code, `${path}/type${issue.path}`));
      if (referenceIssues.length) return;
      const type = registry.resolve(fixture.type);
      if (!type) { add("type_not_installed", `${path}/type`); return; }
      // Units without factors remain valid legacy definitions; exact conversion needs explicit factors.
      if (type.units.some(unit => !unit.factor)) { add("conformance_owner_unavailable", path, "", true); return; }
      const units = type.units.map(unit => ({ ...unit, factor: unit.factor! }));
      try {
        if (fixture.targetUnit === undefined) canonicalizeCatalogQuantity(fixture.value, units);
        else convertCatalogQuantity(fixture.value, fixture.targetUnit, units);
      } catch (error) {
        if (!(error instanceof CatalogQuantityError)) throw error;
        add(error.code, `${path}/value`);
      }
    });
    for (const field of ["attributes", "combinations"] as const) {
      for (const [i, fixture] of (entry[field] ?? []).entries()) {
        const path = `${at}/${field}/${i}`;
        const allowed = field === "attributes" ? ["type", "input", "publicationRevision", "references"] : ["type", "input"];
        if (!object(fixture) || Reflect.ownKeys(fixture).some(key => typeof key !== "string" || !allowed.includes(key))) {
          add("conformance_subject_invalid", path); continue;
        }
        const referenceIssues = catalogProductTypeRefIssues(fixture.type);
        referenceIssues.forEach(issue => add(issue.code, `${path}/type${issue.path}`));
        if (referenceIssues.length) continue;
        const definition = registry.resolve(fixture.type);
        if (!definition) { add("type_not_installed", `${path}/type`); continue; }
        if (field === "attributes") {
          const value = fixture as NonNullable<typeof entry.attributes>[number];
          if (value.references !== undefined && (!object(value.references) || typeof value.references.resolve !== "function")) {
            add("conformance_subject_invalid", `${path}/references`); continue;
          }
          let referenceInput = value.input;
          try { referenceInput = JSON.parse(canonicalCatalogDraftJson(referenceInput)); }
          catch { /* The attribute owner reports invalid canonical input with its own code/path. */ }
          let resolved: Awaited<ReturnType<CatalogAttributeReferencePort["resolve"]>> = [];
          const references: CatalogAttributeReferencePort | undefined = value.references && {
            resolve: async batch => {
              resolved = await value.references!.resolve(batch);
              return resolved;
            },
          };
          const validation = await validateCatalogAttributes(definition, referenceInput, references);
          const prepared = prepareCatalogAttributeProjection(validation, value.publicationRevision);
          if (!prepared.prepared) prepared.issues.forEach(issue => {
            let requiredEvidence = false;
            if (issue.code === "attribute_reference_unresolved") {
              const target = issue.path.split("/").slice(1).reduce<unknown>((node, key) =>
                node !== null && typeof node === "object" ? (node as Record<string, unknown>)[key.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined, referenceInput);
              const reference = target as { namespace?: string; id?: string } | undefined;
              const matches = Array.isArray(resolved) ? resolved.filter(item => item && reference
                && item.namespace === reference.namespace && item.id === reference.id) : [];
              requiredEvidence = matches.length !== 1 || !["dangling", "private"].includes(matches[0].status);
            }
            add(issue.code, `${path}${issue.code === "attribute_publication_revision_invalid" ? "" : "/input"}${issue.path}`, "", requiredEvidence);
          });
        } else {
          const value = fixture as NonNullable<typeof entry.combinations>[number];
          const input = value.input;
          if (!object(input) || Reflect.ownKeys(input).some(key => typeof key !== "string" || !["axes", "typed", "retained", "incoming", "capacity"].includes(key))
            || !Array.isArray(input.axes) || input.axes.some(key => typeof key !== "string") || typeof input.typed !== "boolean"
            || !Array.isArray(input.retained) || !Array.isArray(input.incoming)) {
            add("conformance_subject_invalid", `${path}/input`); continue;
          }
          // Explicit owner fields preserve non-enumerable/inherited properties;
          // nested option values and retained facts go to the owner unchanged.
          const { axes, typed, retained, incoming, capacity } = input;
          try { validateCatalogCombinationChangesV2({ definition, axes, typed, retained, incoming, capacity }); }
          catch (error) {
            if (!(error instanceof CatalogCombinationError) && !(error instanceof CatalogQuantityError)) throw error;
            add(error.code, `${path}/input${error instanceof CatalogCombinationError ? pointer(error.path.split(".")) : ""}`);
          }
        }
      }
    }
    for (const [capability, supported] of Object.entries(pack.capabilities)) {
      if (supported) continue;
      const fixtures = entry.refusals?.filter(fixture => object(fixture) && fixture.capability === capability) ?? [];
      if (!fixtures.length) add("conformance_refusal_fixture_missing", `${at}/pack/capabilities/${capability.replaceAll("~", "~0").replaceAll("/", "~1")}`);
    }
    Array.from(entry.refusals ?? []).forEach((fixture, i) => {
      const path = `${at}/refusals/${i}`;
      if (!object(fixture) || typeof fixture.name !== "string" || !fixture.name || typeof fixture.expectedCode !== "string" || !fixture.expectedCode
        || typeof fixture.capability !== "string" || !Object.hasOwn(pack.capabilities, fixture.capability)
        || pack.capabilities[fixture.capability] !== false || typeof fixture.run !== "function" || typeof fixture.assertZeroEffects !== "function") {
        add("conformance_refusal_fixture_invalid", path); return;
      }
      const result = fixture.run();
      const zeroEffects = fixture.assertZeroEffects();
      if (!object(result) || result.code !== fixture.expectedCode || zeroEffects !== true) add("conformance_refusal_fixture_mismatch", path, fixture.name);
    });
  }
  catalogProductTypeIssues(allTypes).filter(issue => issue.code === "definition_duplicate_identity").forEach(issue => {
    const [, index, ...rest] = issue.path.split("/");
    const path = `${typePaths[Number(index)]}/${rest.join("/")}`;
    if (!findings.some(finding => finding.code === issue.code && finding.path === path)) add(issue.code, path);
  });
  return finish();
}
