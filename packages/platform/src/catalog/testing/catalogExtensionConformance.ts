import { CatalogQuantityError, canonicalizeCatalogQuantity, convertCatalogQuantity, type CatalogQuantityUnit } from "@openlup/core/catalog";
import {
  CATALOG_CONFORMANCE_RULES, catalogPackIssues, catalogProductTypeIssues, catalogProductTypeRefIssues,
  canonicalCatalogDraftJson, validateCatalogAttributes, prepareCatalogAttributeProjection, validateCatalogCombinationChangesV2, CatalogCombinationError,
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

/** Materialize executable-envelope fields on their original receivers, then retain
 * only frozen data and explicit callable handles. JSON leaves keep owner admission.
 */
function snapshotSubject(subject: CatalogConformanceSubject): CatalogConformanceSubject {
  const seen = new WeakMap<object, unknown>();
  const jsonSeen = new WeakMap<object, unknown>();
  function capture(value: unknown, path: readonly PropertyKey[], receiver?: object): unknown {
    const leaf = path[path.length - 1];
    if (typeof value === "function") {
      const callback = value;
      const originalReceiver = ["resolve", "run", "assertZeroEffects"].includes(String(leaf));
      return Object.freeze(function(this: unknown, ...args: unknown[]) {
        const result = Reflect.apply(callback, originalReceiver ? receiver : this, args);
        return ["validateContent", "run", "assertZeroEffects"].includes(String(leaf))
          ? capture(result, [...path, "result"]) : result;
      });
    }
    if (value === null || typeof value !== "object") return value;
    if ((path[2] === "attributes" && leaf === "input") || (path[2] === "drafts" && leaf === "sharedContent")) {
      if (jsonSeen.has(value)) return jsonSeen.get(value);
      let json: unknown;
      try { json = freezeData(JSON.parse(canonicalCatalogDraftJson(value))); }
      catch { json = NaN; } // The owner retains its canonical-input refusal and path.
      jsonSeen.set(value, json); return json;
    }
    if (seen.has(value)) return seen.get(value);
    if (value instanceof Uint8Array) {
      const bytes: number[] = []; seen.set(value, bytes);
      const length = value.length;
      if (!Number.isSafeInteger(length) || length < 0) throw new TypeError("snapshot_array_length");
      for (let i = 0; i < length; i++) bytes.push(value[i]);
      return Object.freeze(bytes);
    }
    if (Array.isArray(value)) {
      const items: unknown[] = []; seen.set(value, items);
      const length = value.length;
      if (!Number.isSafeInteger(length) || length < 0) throw new TypeError("snapshot_array_length");
      for (let i = 0; i < length; i++) items.push(capture(value[i], [...path, i], value));
      return Object.freeze(items);
    }
    if (path[path.length - 1] === "references") {
      let resolve: unknown;
      try { resolve = capture(Reflect.get(value, "resolve", value), [...path, "resolve"], value); }
      catch { resolve = Object.freeze(async () => Object.freeze([])); }
      const port = Object.freeze({ resolve }); seen.set(value, port); return port;
    }
    const data: Record<PropertyKey, unknown> = {}; seen.set(value, data);
    const keys = new Set(Reflect.ownKeys(value));
    const declared = path.length === 0 ? ["packs", "requiredChecks", "recheck"] : undefined;
    if (declared) {
      for (const key of declared) if (Reflect.has(value, key)) keys.add(key);
    } else if (!["options", "optionValues"].includes(String(leaf))) {
      // Schema records may expose declared fields through prototype getters.
      // Dictionary keys retain own-property semantics instead.
      const prototypes = new Set<object>();
      for (let prototype = Object.getPrototypeOf(value); prototype && prototype !== Object.prototype && !prototypes.has(prototype); prototype = Object.getPrototypeOf(prototype)) {
        prototypes.add(prototype);
        for (const key of Reflect.ownKeys(prototype)) if (key !== "constructor") keys.add(key);
      }
    }
    for (const key of keys) {
      let child: unknown;
      try { child = capture(Reflect.get(value, key, value), [...path, key], value); }
      catch (error) {
        if (path.length) throw error;
        child = NaN; // Preserve other readable root fields, including recheck.
      }
      Object.defineProperty(data, key, { value: child, enumerable: Object.getOwnPropertyDescriptor(value, key)?.enumerable ?? false });
    }
    return Object.freeze(data);
  }
  return freezeData(capture(subject, []) as CatalogConformanceSubject);
}
function freezeData<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) freezeData(Object.getOwnPropertyDescriptor(value, key)?.value, seen);
    Object.freeze(value);
  }
  return value;
}
function snapshotReferenceAnswers(value: unknown): Awaited<ReturnType<CatalogAttributeReferencePort["resolve"]>> {
  const unavailable = Object.freeze([]);
  try {
    if (!Array.isArray(value)) return unavailable;
    const answers: Awaited<ReturnType<CatalogAttributeReferencePort["resolve"]>>[number][] = [];
    const captured = new WeakMap<object, typeof answers[number]>();
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0) return unavailable;
    for (let i = 0; i < length; i++) {
      const answer = value[i];
      if (!answer || (typeof answer !== "object" && typeof answer !== "function")) return unavailable;
      let snapshot = captured.get(answer);
      if (!snapshot) {
        const { namespace, id, status } = answer;
        if (typeof namespace !== "string" || typeof id !== "string" || !["resolved", "dangling", "private", "unavailable"].includes(status)) return unavailable;
        snapshot = Object.freeze({ namespace, id, status }); captured.set(answer, snapshot);
      }
      answers.push(snapshot); // Preserve multiplicity: aliased duplicates must still refuse.
    }
    return Object.freeze(answers);
  } catch { return unavailable; } // An unreadable batch cannot establish a unique resolution.
}

/** Calls existing owners only. Unexpected callback failures propagate to the CLI's sanitized failure path. */
export async function runCatalogExtensionConformance(subject: CatalogConformanceSubject): Promise<CatalogConformanceReport> {
  const findings: CatalogConformanceFinding[] = [];
  let unavailable = false;
  let violated = false;
  let capturedSubject: CatalogConformanceSubject | undefined;
  try { capturedSubject = snapshotSubject(subject); } catch { /* Unreadable subject input refuses deterministically. */ }
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
      const validation = validateCatalogDraft(parsed.data, registry);
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
          const references: CatalogAttributeReferencePort | undefined = referenceOwner && {
            resolve: async batch => {
              try { resolved = snapshotReferenceAnswers(await resolveReferences!.call(referenceOwner, batch)); }
              catch { resolved = Object.freeze([]); }
              return resolved;
            },
          };
          const validation = await validateCatalogAttributes(definition, referenceInput, references);
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
          // The immutable snapshot stores bytes as frozen number arrays. The owner
          // requires typed byte carriers; create private views from captured data.
          const ownerRetained = retained.map(({ skuId, state, optionValues, identity }) => Object.freeze({
            skuId, state, optionValues, identity: identity && Object.freeze({
              version: identity.version,
              canonicalOptionBytes: Uint8Array.from(identity.canonicalOptionBytes),
              combinationDigest: Uint8Array.from(identity.combinationDigest),
            }),
          }));
          try { validateCatalogCombinationChangesV2({ definition, axes, typed, retained: ownerRetained, incoming, capacity }); }
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
      const result = run.call(fixture);
      const zeroEffects = assertZeroEffects.call(fixture);
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
