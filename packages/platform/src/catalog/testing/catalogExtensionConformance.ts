import { CatalogQuantityError, canonicalizeCatalogQuantity, convertCatalogQuantity, type CatalogQuantityUnit } from "@openlup/core/catalog";
import {
  CATALOG_CONFORMANCE_RULES, catalogPackIssues, catalogProductTypeIssues, catalogProductTypeRefIssues,
  validateCatalogAttributes, prepareCatalogAttributeProjection, validateCatalogCombinationChangesV2, CatalogCombinationError,
  catalogDraftPayloadSchema, createCatalogProductTypeRegistry, validateCatalogDraft,
  type CatalogConformanceCode,
} from "../index.js";
import type { CatalogAttributeReferencePort } from "../attributeReferencePort.js";
import type { CatalogConformanceFinding, CatalogConformanceReport, CatalogConformanceSubject } from "./contracts.js";

const boundary = "Offline definitions, exact quantities, supplied v1 drafts, separate attribute validation/projection preparation and supplied V2 variant combination changes only. Supplied reference resolvers and retained combination facts are trusted fixture evidence, not proof of database state. Taxonomy, dated tax coverage, profile semantics and promotion grammar await their owners. Installed versions, existing database references, installed cadence, listing capacity, publication races and legal rate correctness are unobserved runtime facts. PASS grants no installation, migration, publication or activation authority. Trusted imported modules and callbacks are not sandboxed; the checker owns no database, network, seed or publish path.";
const command = "npx --no -- openlup catalogue check --packs ./owned/catalogue.ts --json";
const pointer = (parts: readonly PropertyKey[]): string => parts.map(part => `/${String(part).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
const object = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

const plainDataErrors = new WeakSet<object>();
class PlainDataError extends Error {
  constructor(readonly path: string) { super("conformance_input_not_plain_data"); plainDataErrors.add(this); }
  static is(value: unknown): value is PlainDataError {
    return value !== null && typeof value === "object" && plainDataErrors.has(value);
  }
}

/** One identity cache and descriptor walk, shared by subject data and callback results. */
function plainDataSnapshot() {
  const seen = new WeakMap<object, unknown>();
  const active = new WeakSet<object>();
  function capture(value: unknown, path: string): unknown {
    try {
      if (value === null || typeof value === "string" || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))) return value;
      // Only the existing executable fixture slots accept opaque callable handles.
      if (typeof value === "function" && /^\/packs\/\d+\/(?:pack\/types\/\d+\/validateContent|attributes\/\d+\/references\/resolve|refusals\/\d+\/(?:run|assertZeroEffects))$/u.test(path)) {
        const callback = value;
        return Object.freeze(function(this: unknown, ...args: unknown[]) {
          const result = Reflect.apply(callback, this, args);
          if (!path.endsWith("/resolve")) return capture(result, `${path}/result`);
          // The native promise transport is opaque; do not assimilate arbitrary
          // thenables before their data descriptors have been checked.
          try { return Promise.prototype.then.call(result, (answer: unknown) => capture(answer, `${path}/result`)); }
          catch { return capture(result, `${path}/result`); }
        });
      }
      if (typeof value !== "object") throw new PlainDataError(path);
      if (active.has(value)) throw new PlainDataError(path);
      if (seen.has(value)) return seen.get(value);
      const prototype = Object.getPrototypeOf(value);
      const array = Array.isArray(value);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
        throw new PlainDataError(path);
      const descriptors = new Map<string, PropertyDescriptor>();
      for (const key of Reflect.ownKeys(value)) {
        const at = `${path}${pointer([key])}`;
        if (typeof key !== "string") throw new PlainDataError(at);
        let descriptor: PropertyDescriptor | undefined;
        try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
        catch { throw new PlainDataError(at); }
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new PlainDataError(at);
        descriptors.set(key, descriptor);
      }
      const data = array ? [] : Object.create(prototype);
      if (array) {
        const length = descriptors.get("length")?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > 4_294_967_295) throw new PlainDataError(`${path}/length`);
        for (const key of descriptors.keys()) {
          const index = Number(key);
          if (String(index) === key && Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && index >= length)
            throw new PlainDataError(`${path}/${key}`);
        }
        for (let i = 0; i < length; i++) if (!descriptors.has(String(i))) throw new PlainDataError(`${path}/${i}`);
        data.length = length;
      }
      seen.set(value, data); active.add(value);
      for (const [key, descriptor] of descriptors) {
        if (array && key === "length") continue;
        Object.defineProperty(data, key, { value: capture(descriptor.value, `${path}${pointer([key])}`), enumerable: descriptor.enumerable });
      }
      active.delete(value);
      return Object.freeze(data);
    } catch (error) {
      if (PlainDataError.is(error)) throw error;
      throw new PlainDataError(path);
    }
  }
  return capture;
}

/** Calls existing owners only. Unexpected callback failures propagate to the CLI's sanitized failure path. */
export async function runCatalogExtensionConformance(subject: CatalogConformanceSubject): Promise<CatalogConformanceReport> {
  const findings: CatalogConformanceFinding[] = [];
  let unavailable = false;
  let violated = false;
  const snapshot = plainDataSnapshot();
  let capturedSubject: CatalogConformanceSubject | undefined;
  let inputError: PlainDataError | undefined;
  try { capturedSubject = snapshot(subject, "") as CatalogConformanceSubject; }
  catch (error) { if (!(PlainDataError.is(error))) throw error; inputError = error; }
  const validSubject = object(capturedSubject);
  const { packs, requiredChecks, recheck: requestedRecheck } = validSubject ? capturedSubject! : {} as Partial<CatalogConformanceSubject>;
  const recheck = typeof requestedRecheck === "string" ? requestedRecheck : command;
  const checks: readonly string[] | undefined = Array.isArray(requiredChecks) ? Array.from(requiredChecks) : undefined;
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
  if (inputError) { add("conformance_input_not_plain_data", inputError.path); return finish(); }
  if (!validSubject || !Array.isArray(packs) || !packs.length
    || (requestedRecheck !== undefined && typeof requestedRecheck !== "string")
    || Reflect.ownKeys(capturedSubject!).some(key => typeof key !== "string" || !["packs", "requiredChecks", "recheck"].includes(key))
    || (requiredChecks !== undefined && (!checks || checks.some(check => typeof check !== "string")))) {
    add("conformance_subject_invalid", ""); return finish();
  }
  let attributesAvailable = true, combinationsAvailable = true;
  const allTypes: unknown[] = [];
  const typePaths: string[] = [];
  for (const [index, rawEntry] of Array.from(packs).entries()) {
    const entry: CatalogConformanceSubject["packs"][number] = rawEntry;
    const at = `/packs/${index}`;
    if (!object(entry)) { add("conformance_subject_invalid", at); attributesAvailable = combinationsAvailable = false; continue; }
    const { pack, drafts, quantities, attributes, combinations, refusals } = entry;
    attributesAvailable &&= Array.isArray(attributes) && attributes.length > 0;
    combinationsAvailable &&= Array.isArray(combinations) && combinations.length > 0;
    if (Reflect.ownKeys(entry).some(key => typeof key !== "string" || !["pack", "drafts", "quantities", "attributes", "combinations", "refusals"].includes(key))
      || [drafts, quantities, attributes, combinations, refusals].some(value => value !== undefined && !Array.isArray(value))) {
      add("conformance_subject_invalid", at); continue;
    }
    const issues = catalogPackIssues(pack);
    issues.forEach(issue => add(issue.code, `${at}/pack${issue.path}`));
    if (issues.length) continue;
    const types = pack.types;
    const capabilities = new Map(Object.entries(pack.capabilities));
    types.forEach((type, i) => { allTypes.push(type); typePaths.push(`${at}/pack/types/${i}`); });
    const registry = createCatalogProductTypeRegistry(types);
    Array.from(drafts ?? []).forEach((draft, i) => {
      const path = `${at}/drafts/${i}`;
      const parsed = catalogDraftPayloadSchema.safeParse(draft);
      if (!parsed.success) {
        parsed.error.issues.forEach(issue => add("draft_input_invalid", `${path}${pointer(issue.path)}`)); return;
      }
      let validation: ReturnType<typeof validateCatalogDraft>;
      try { validation = validateCatalogDraft(parsed.data, registry); }
      catch (error) {
        if (!(PlainDataError.is(error))) throw error;
        add("conformance_input_not_plain_data", error.path); return;
      }
      // Draft readiness is not publication readiness. Missing runtime facts stay in boundary.
      if (!validation.valid) validation.issues.forEach(issue => add(issue.code, `${path}${pointer(issue.path.split("."))}`));
    });
    Array.from(quantities ?? []).forEach((fixture, i) => {
      const path = `${at}/quantities/${i}`;
      if (!object(fixture)) { add("conformance_subject_invalid", path); return; }
      const { type: requestedType, value: quantity, targetUnit } = fixture;
      if (!object(quantity) || Reflect.ownKeys(fixture).some(key => typeof key !== "string" || !["type", "value", "targetUnit"].includes(key))) {
        add("conformance_subject_invalid", path); return;
      }
      const referenceIssues = catalogProductTypeRefIssues(requestedType);
      referenceIssues.forEach(issue => add(issue.code, `${path}/type${issue.path}`));
      if (referenceIssues.length) return;
      const type = registry.resolve(requestedType);
      if (!type) { add("type_not_installed", `${path}/type`); return; }
      // Units without factors remain valid legacy definitions; exact conversion needs explicit factors.
      if (type.units.some(unit => !unit.factor)) { add("conformance_owner_unavailable", path, "", true); return; }
      const units = type.units as readonly CatalogQuantityUnit[];
      try {
        if (targetUnit === undefined) canonicalizeCatalogQuantity(quantity, units);
        else convertCatalogQuantity(quantity, targetUnit, units);
      } catch (error) {
        if (!(error instanceof CatalogQuantityError)) throw error;
        add(error.code, `${path}/value`);
      }
    });
    for (const field of ["attributes", "combinations"] as const) {
      for (const [i, fixture] of (field === "attributes" ? attributes ?? [] : combinations ?? []).entries()) {
        const path = `${at}/${field}/${i}`;
        const allowed = field === "attributes" ? ["type", "input", "publicationRevision", "references"] : ["type", "input"];
        if (!object(fixture) || Reflect.ownKeys(fixture).some(key => typeof key !== "string" || !allowed.includes(key))) {
          add("conformance_subject_invalid", path); continue;
        }
        const requestedType = fixture.type;
        const referenceIssues = catalogProductTypeRefIssues(requestedType);
        referenceIssues.forEach(issue => add(issue.code, `${path}/type${issue.path}`));
        if (referenceIssues.length) continue;
        const definition = registry.resolve(requestedType);
        if (!definition) { add("type_not_installed", `${path}/type`); continue; }
        if (field === "attributes") {
          const value = fixture as NonNullable<typeof entry.attributes>[number];
          const { input: suppliedInput, references: referenceOwner, publicationRevision } = value;
          const resolveReferences = referenceOwner?.resolve;
          if (referenceOwner !== undefined && (!object(referenceOwner) || typeof resolveReferences !== "function")) {
            add("conformance_subject_invalid", `${path}/references`); continue;
          }
          const referenceInput = suppliedInput;
          let resolved: Awaited<ReturnType<CatalogAttributeReferencePort["resolve"]>> = Object.freeze([]);
          let resolverInputError = false;
          const references: CatalogAttributeReferencePort | undefined = referenceOwner && {
            resolve: async batch => {
              try { resolved = await resolveReferences!.call(referenceOwner, batch); }
              catch (error) {
                if (PlainDataError.is(error)) { add("conformance_input_not_plain_data", error.path); resolverInputError = true; }
                resolved = Object.freeze([]);
              }
              return resolved;
            },
          };
          const validation = await validateCatalogAttributes(definition, referenceInput, references);
          if (resolverInputError) continue;
          const prepared = prepareCatalogAttributeProjection(validation, publicationRevision);
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
          if (!object(input)) { add("conformance_subject_invalid", `${path}/input`); continue; }
          const { axes, typed, retained, incoming, capacity } = input;
          if (Reflect.ownKeys(input).some(key => typeof key !== "string" || !["axes", "typed", "retained", "incoming", "capacity"].includes(key))
            || !Array.isArray(axes) || axes.some(key => typeof key !== "string") || typeof typed !== "boolean"
            || !Array.isArray(retained) || !Array.isArray(incoming)) {
            add("conformance_subject_invalid", `${path}/input`); continue;
          }
          try { validateCatalogCombinationChangesV2({ definition, axes, typed, retained, incoming, capacity }); }
          catch (error) {
            if (!(error instanceof CatalogCombinationError) && !(error instanceof CatalogQuantityError)) throw error;
            add(error.code, `${path}/input${error instanceof CatalogCombinationError ? pointer(error.path.split(".")) : ""}`);
          }
        }
      }
    }
    const witnessedCapabilities = new Set<string>();
    Array.from(refusals ?? []).forEach((fixture, i) => {
      const path = `${at}/refusals/${i}`;
      if (!object(fixture)) { add("conformance_refusal_fixture_invalid", path); return; }
      const { name, capability, expectedCode, run, assertZeroEffects } = fixture;
      witnessedCapabilities.add(capability);
      if (typeof name !== "string" || !name || typeof expectedCode !== "string" || !expectedCode
        || typeof capability !== "string" || !capabilities.has(capability)
        || capabilities.get(capability) !== false || typeof run !== "function" || typeof assertZeroEffects !== "function") {
        add("conformance_refusal_fixture_invalid", path); return;
      }
      let result: ReturnType<typeof run>, zeroEffects: boolean;
      try { result = run.call(fixture); zeroEffects = assertZeroEffects.call(fixture); }
      catch (error) {
        if (!(PlainDataError.is(error))) throw error;
        add("conformance_input_not_plain_data", error.path); return;
      }
      if (!object(result) || result.code !== expectedCode || zeroEffects !== true) add("conformance_refusal_fixture_mismatch", path, name);
    });
    for (const [capability, supported] of capabilities) if (!supported && !witnessedCapabilities.has(capability))
      add("conformance_refusal_fixture_missing", `${at}/pack/capabilities/${capability.replaceAll("~", "~0").replaceAll("/", "~1")}`);
  }
  for (const [index, check] of (checks ?? []).entries()) {
    if (!(check === "attribute-values" ? attributesAvailable : check === "variant-combinations" ? combinationsAvailable : false))
      add("conformance_owner_unavailable", `/requiredChecks/${index}`, "", true);
  }
  catalogProductTypeIssues(allTypes).filter(issue => issue.code === "definition_duplicate_identity").forEach(issue => {
    const [, index, ...rest] = issue.path.split("/");
    const path = `${typePaths[Number(index)]}/${rest.join("/")}`;
    if (!findings.some(finding => finding.code === issue.code && finding.path === path)) add(issue.code, path);
  });
  return finish();
}
