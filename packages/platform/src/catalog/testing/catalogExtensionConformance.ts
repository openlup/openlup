import { CatalogQuantityError, canonicalizeCatalogQuantity, convertCatalogQuantity } from "@openlup/core/catalog";
import {
  CATALOG_CONFORMANCE_RULES, catalogPackIssues, catalogProductTypeIssues, catalogProductTypeRefIssues,
  catalogDraftPayloadSchema, createCatalogProductTypeRegistry, validateCatalogDraft,
  type CatalogConformanceCode, type CatalogPackInput,
} from "../index.js";
import type { CatalogConformanceFinding, CatalogConformanceReport, CatalogConformanceSubject } from "./contracts.js";

const boundary = "Offline definitions, exact quantities and supplied v1 draft validation only. Attribute-value/projection checker integration is pending; the separate attribute owner is available unbound. Canonical cross-unit variant combinations await their owner. Taxonomy, dated tax coverage, profile semantics and promotion grammar await their owners. Installed versions, existing database references, installed cadence, listing capacity, publication races and legal rate correctness are unobserved runtime facts. PASS grants no installation, migration, publication or activation authority. Trusted imported modules and callbacks are not sandboxed; the checker owns no database, network, seed or publish path.";
const command = "npx --no -- openlup catalogue check --packs ./owned/catalogue.ts --json";
const pointer = (parts: readonly PropertyKey[]): string => parts.map(part => `/${String(part).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
const object = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Calls existing owners only. Unexpected callback failures propagate to the CLI's sanitized failure path. */
export function runCatalogExtensionConformance(subject: CatalogConformanceSubject): CatalogConformanceReport {
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
    || Object.keys(subject).some(key => !["packs", "requiredChecks", "recheck"].includes(key))
    || (subject.requiredChecks !== undefined && (!Array.isArray(subject.requiredChecks) || subject.requiredChecks.some(check => typeof check !== "string")))) {
    add("conformance_subject_invalid", ""); return finish();
  }
  for (const [index] of (subject.requiredChecks ?? []).entries()) {
    add("conformance_owner_unavailable", `/requiredChecks/${index}`, "", true);
  }
  const allTypes: unknown[] = [];
  const typePaths: string[] = [];
  Array.from(subject.packs).forEach((entry: CatalogConformanceSubject["packs"][number], index: number) => {
    const at = `/packs/${index}`;
    if (!object(entry) || Object.keys(entry).some(key => !["pack", "drafts", "quantities", "refusals"].includes(key))
      || [entry.drafts, entry.quantities, entry.refusals].some(value => value !== undefined && !Array.isArray(value))) {
      add("conformance_subject_invalid", at); return;
    }
    const issues = catalogPackIssues(entry.pack);
    issues.forEach(issue => add(issue.code, `${at}/pack${issue.path}`));
    if (issues.length) return;
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
        || Object.keys(fixture).some(key => !["type", "value", "targetUnit"].includes(key))) {
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
  });
  catalogProductTypeIssues(allTypes).filter(issue => issue.code === "definition_duplicate_identity").forEach(issue => {
    const [, index, ...rest] = issue.path.split("/");
    const path = `${typePaths[Number(index)]}/${rest.join("/")}`;
    if (!findings.some(finding => finding.code === issue.code && finding.path === path)) add(issue.code, path);
  });
  return finish();
}
