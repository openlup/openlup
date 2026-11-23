import { CATALOG_QUANTITY_UNITS, CatalogQuantityError, canonicalizeCatalogQuantity, convertCatalogQuantity, type CatalogQuantityUnit } from "@openlup/core/catalog";
import { readCatalogCheckerPackageVersion } from "../catalogConformance.js";
import {
  CATALOG_CONFORMANCE_RULES, catalogProductTypeRefIssues,
  validateCatalogAttributes, prepareCatalogAttributeProjection, canonicalizeCatalogCombinationV2,
  validateCatalogCombinationChangesV2, CatalogCombinationError,
  catalogDraftPayloadSchema, catalogDraftPayloadV2Schema, catalogDraftPayloadV3Schema,
  createCatalogProductTypeRegistry,
  type CatalogConformanceCode, type CatalogDefinitionIssue, type CatalogPackInput,
} from "../index.js";
import { prepareCatalogPackManifest } from "../catalogPackManifest.js";
import { inspectCatalogPack } from "../productTypeIssues.js";
import { validateDraftFacts } from "../draftFacts.js";
import { validateDraftAttributes } from "../attributeValues.js";
import { isValidGtin } from "../foundationSchemas.js";
import { combinationFindingPointer as pointer, skuIdPathErrors, validateDraftCombinations } from "../combinationOptions.js";
import { verifyCatalogRulesAtInstall } from "../publicationRules.js";
import { renderPublicationIssue, type Issue } from "../publicationError.js";
import type { CatalogConformanceFinding, CatalogConformanceReport, CatalogConformanceSubject } from "./contracts.js";

const boundary = "Offline definitions, subscription profile declarations, exact quantities, supplied v1–v3 drafts, attribute validation/projection preparation and V2 combination fixtures. Draft admission checks operation and price shape. Reference evidence, retained options and refusal records are fixture observations. The pack range compares the checker’s @openlup/platform package version. Application and database runtime state, including installed definitions and database references, remain unobserved. Category graphs, tax intervals, cadence execution, promotion grammar, price execution and publication require other evidence. Listing capacity, publication races and legal rate correctness remain unobserved. PASS grants no installation, migration, publication or activation authority. No database, network, seed or publish path is supplied by the checker.";
const platformVersion = readCatalogCheckerPackageVersion();
const command = "npx --no -- openlup catalogue check --packs ./owned/catalogue.json --json";
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value: unknown, keys: readonly string[]): boolean => object(value) && Object.keys(value).every(key => keys.includes(key));
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const referenceKey = (namespace: string, id: string): string => JSON.stringify([namespace, id]);

function atPointer(subject: unknown, path: string): unknown {
  return path ? path.slice(1).split("/").reduce<unknown>((node, token) => {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    return node !== null && typeof node === "object" && Object.hasOwn(node, key) ? (node as Record<string, unknown>)[key] : undefined;
  }, subject) : subject;
}

function previewValue(value: unknown, remaining: number, preserveRootOrder = false): string {
  // Serialize only the prefix so deeply nested invalid input can still produce a finding.
  let preview = "";
  function json(input: unknown): string {
    if (typeof input !== "string") return JSON.stringify(input);
    const safe = /[\\/]|file:/iu.test(input) ? "<host path>" : input;
    return JSON.stringify(safe.slice(0, remaining * 2));
  }
  function append(text: string): void {
    const points = Array.from(text).slice(0, remaining);
    preview += points.join("");
    remaining -= points.length;
  }
  function write(value: unknown, preserveOrder = false): void {
    if (value === null || typeof value !== "object") { append(json(value)); return; }
    const array = Array.isArray(value), keys = Object.keys(value);
    if (!array && !preserveOrder) keys.sort(compare);
    append(array ? "[" : "{");
    for (const [index, key] of keys.entries()) {
      if (!remaining) break;
      if (index) append(",");
      if (!array) append(`${json(key)}:`);
      if (remaining) write((value as Record<string, unknown>)[key]);
    }
    append(array ? "]" : "}");
  }
  write(value, preserveRootOrder);
  return preview;
}

function observedAt(subject: unknown, path: string): string {
  const value = atPointer(subject, path), label = path || "/";
  return value === undefined ? `${label} is absent` : `${label} = ${previewValue(value, 160)}`;
}

function axisMismatchPreview(subject: unknown, path: string): string {
  const axis = atPointer(subject, path) as { key: string; attributeKey: string };
  const definition = atPointer(subject, path.slice(0, path.lastIndexOf("/axes/"))) as CatalogPackInput["types"][number];
  // Definition admission emits this issue only after it finds both sides.
  const dimension = definition.dimensions.find(({ key }) => key === axis.key)!;
  const { key, kind } = dimension;
  const dimensionFields = kind === "choice" ? { kind, values: dimension.values, key }
    : kind === "quantity" ? { kind, dimension: dimension.dimension, units: dimension.units, key }
    : { kind, key };
  const { valueType } = definition.attributes!.find(({ key }) => key === axis.attributeKey)!;
  const attributeFields = valueType.kind === "enum" ? { kind: valueType.kind, values: valueType.values.map(({ id }) => id) }
    : valueType.kind === "quantity" ? { kind: valueType.kind, dimension: valueType.dimension, units: valueType.units }
    : { kind: valueType.kind };
  return `dimension = ${previewValue(dimensionFields, 68, true)}; attribute = ${previewValue(attributeFields, 66, true)}`;
}

const semverNumber = "(0|[1-9][0-9]*)";
const semverTriplet = `${semverNumber}\\.${semverNumber}\\.${semverNumber}`;
const majorRange = new RegExp(`^${semverNumber}\\.x$`, "u");
const caretRange = new RegExp(`^\\^${semverTriplet}$`, "u");
const nextMajorRange = new RegExp(`^>=${semverTriplet} <${semverNumber}\\.0\\.0$`, "u");
const installedVersion = new RegExp(`^${semverTriplet}(?:\\+[0-9A-Za-z.-]+)?$`, "u").exec(platformVersion);

function satisfiesPlatformRange(range: string): boolean | undefined {
  const major = majorRange.exec(range);
  if (major) return installedVersion?.[1] === major[1];
  const caret = caretRange.exec(range);
  const interval = caret ? null : nextMajorRange.exec(range);
  const lower = caret ?? interval;
  if (!lower || (interval && BigInt(interval[1]) + 1n !== BigInt(interval[4]))) return undefined;
  if (!installedVersion || installedVersion[1] !== lower[1]) return false;
  const [, majorVersion, minor, patch] = lower;
  const installedMinor = BigInt(installedVersion[2]);
  const minimumMinor = BigInt(minor);
  if (caret && majorVersion === "0") {
    if (installedMinor !== minimumMinor) return false;
    if (minor === "0") return installedVersion[3] === patch;
  }
  return installedMinor > minimumMinor || (installedMinor === minimumMinor && BigInt(installedVersion[3]) >= BigInt(patch));
}

type CombinationFixtureInput = NonNullable<CatalogConformanceSubject["packs"][number]["combinations"]>[number]["input"];

function combinationOptionPointer(input: CombinationFixtureInput, key: string | undefined, retainedIndex: number | undefined,
  missing = false): string {
  const field = retainedIndex === undefined ? "incoming" : "retained";
  const hasKey = (row: CombinationFixtureInput[typeof field][number]) =>
    key !== undefined && !!row.optionValues && Object.hasOwn(row.optionValues, key);
  const candidates = input[field].flatMap((row, index) => hasKey(row) ? [index] : []);
  if (missing) {
    const index = retainedIndex ?? input.incoming.findIndex(row => row.optionValues && !hasKey(row));
    return index >= 0 ? pointer([field, index]) : pointer([field]);
  }
  const other = field === "incoming" ? "retained" : "incoming";
  if (key !== undefined && candidates.length === 1 && !input[other].some(hasKey))
    return pointer([field, candidates[0], "optionValues", key]);
  return pointer(retainedIndex === undefined ? [field] : [field, retainedIndex]);
}

// Core quantity errors have no option path. On refusal, replay only the selected
// quantity options through the same owner, in its row and key order.
function combinationQuantityPointer(input: CombinationFixtureInput, definition: CatalogPackInput["types"][number],
  error: CatalogQuantityError, retainedIndex: number | undefined): string {
  const rows = retainedIndex === undefined ? input.incoming : [input.retained[retainedIndex]];
  const keys = [...input.axes].sort(compare);
  for (const { optionValues } of rows) for (const key of keys) {
    const value = optionValues?.[key];
    if (value?.kind !== "quantity") continue;
    try {
      canonicalizeCatalogCombinationV2({ definition, axes: [key], options: { [key]: value } });
    } catch (probe) {
      if (probe instanceof CatalogQuantityError && probe.code === error.code)
        return combinationOptionPointer(input, key, retainedIndex);
      // Diagnostic replay preserves the original refusal if a probe fails for another reason.
    }
  }
  return retainedIndex === undefined && rows.length === 1 ? "/incoming/0" : combinationOptionPointer(input, undefined, retainedIndex);
}

function combinationFixturePointer(input: CombinationFixtureInput, error: CatalogCombinationError, retainedIndex: number | undefined): string {
  if (!skuIdPathErrors.has(error)) {
    if (error.path.startsWith("axes.")) {
      const key = error.path.slice("axes.".length);
      const index = input.axes.indexOf(key);
      return index >= 0 && index === input.axes.lastIndexOf(key) ? pointer(["axes", index]) : "/axes";
    }
    if (error.path.startsWith("options.") || error.path === "options") {
      const key = error.path.startsWith("options.") ? error.path.slice("options.".length) : undefined;
      return combinationOptionPointer(input, key, retainedIndex, error.code === "option_missing");
    }
    return pointer(error.path.split("."));
  }
  const duplicate = error.code === "duplicate_sku_id";
  // The owner checks retained duplicates first and uses the incoming row for an updated SKU.
  const fields = duplicate ? ["retained", "incoming"] as const : ["incoming", "retained"] as const;
  for (const field of fields) {
    const rows = input[field];
    const first = rows.findIndex(row => row.skuId === error.path);
    if (first < 0) continue;
    const index = duplicate ? rows.findIndex((row, i) => i > first && row.skuId === error.path) : first;
    if (index >= 0) return pointer(error.code === "option_missing" ? [field, index] : [field, index, "skuId"]);
  }
  return "";
}

type Validator = CatalogPackInput["types"][number]["validateContent"];

/** Tool-internal source projection. Keep executable bindings scoped to the exact subject.
 * @internal
 */
export function projectCatalogExtensionConformance(source: unknown): {
  subject: string; check: (jsonText: string) => Promise<CatalogConformanceReport>;
} {
  if (!object(source)) throw new TypeError("Missing catalogue registration");
  const validators = new Map<string, Validator>();
  const ancestors = new Set<object>();
  function encode(value: unknown, path: readonly (string | number)[]): string {
    if (value === null || typeof value === "string" || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0))) return JSON.stringify(value);
    const array = Array.isArray(value);
    if (typeof value !== "object" || ancestors.has(value)
      || !(array ? Object.getPrototypeOf(value) === Array.prototype
        : [Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw new TypeError("Invalid catalogue JSON value");
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (!path.length && !Object.hasOwn(descriptors, "packs")) throw new TypeError("Missing catalogue registration");
    const keys = Reflect.ownKeys(descriptors).filter(key => !array || key !== "length");
    if (array && (keys.length !== descriptors.length?.value || keys.some((key, index) => key !== String(index))))
      throw new TypeError("Invalid catalogue array");
    const fields: string[] = [];
    for (const key of array ? keys : keys.sort((a, b) => compare(String(a), String(b)))) {
      if (typeof key !== "string") throw new TypeError("Invalid catalogue property");
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid catalogue property");
      const child = [...path, array ? Number(key) : key];
      if (typeof descriptor.value === "function" && key === "validateContent" && path.length === 5
        && path[0] === "packs" && typeof path[1] === "number" && path[2] === "pack"
        && path[3] === "types" && typeof path[4] === "number") validators.set(pointer(child), descriptor.value);
      else {
        const encoded = encode(descriptor.value, child);
        fields.push(array ? encoded : `${JSON.stringify(key)}:${encoded}`);
      }
    }
    ancestors.delete(value);
    return array ? `[${fields.join(",")}]` : `{${fields.join(",")}}`;
  }
  const subject = encode(source, []);
  return { subject, async check(jsonText) {
    if (jsonText !== subject) throw new TypeError("Projected subject bytes differ");
    return checkSubject(jsonText, validators);
  } };
}

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

async function checkSubject(jsonText: string, validators?: ReadonlyMap<string, Validator>): Promise<CatalogConformanceReport> {
  const findings: CatalogConformanceFinding[] = [];
  let unavailable = false, violated = false, recheck = command;
  let parsed: unknown, observedSubject: unknown;
  function add(issue: string | Issue | CatalogDefinitionIssue, path: string, fixture = "", requiredEvidence = false, preview?: string): void {
    const code = typeof issue === "string" ? issue : issue.code;
    const adopterIssue = typeof issue !== "string" && "kind" in issue && issue.kind === "adopterRule" ? issue : undefined;
    const rule = !adopterIssue && Object.hasOwn(CATALOG_CONFORMANCE_RULES, code)
      ? CATALOG_CONFORMANCE_RULES[code as CatalogConformanceCode] : CATALOG_CONFORMANCE_RULES.draft_payload_invalid;
    const fix = adopterIssue ? renderPublicationIssue({ ...adopterIssue, path }).message
      : (typeof issue !== "string" && "fix" in issue ? issue.fix : undefined) ?? rule.fix;
    if (rule.severity === "error") {
      if (requiredEvidence) unavailable = true; else violated = true;
    }
    findings.push({ code, severity: rule.severity, path, fixture,
      observed: preview === undefined ? observedAt(observedSubject, path) : `${path}: ${preview}`,
      cause: rule.rule, fix, recipe: rule.recipe, recheck,
      evidence: { declared: "JSON fixture observations", bound: validators ? "Offline owners and registered content validators" : "Offline owner validators only", checked: path,
        unknown: ["Installed and runtime state; see boundary"] } });
  }
  function advise(code: Extract<CatalogConformanceCode, `advisory_${string}`>, path: string, preview?: string): void {
    add(code, path, "", false, preview);
  }
  // Only shared owner calls enter this boundary; parsing, checker logic and CLI I/O remain outside.
  async function owner<T>(path: string, work: () => T | Promise<T>,
    combinationPath = (error: CatalogCombinationError) => pointer(error.path.split(".")),
    quantityPath?: (error: CatalogQuantityError) => string): Promise<T | undefined> {
    try { return await work(); }
    catch (error) {
      if (error instanceof SyntaxError) throw error;
      const named = error instanceof Error ? "code" in error && typeof error.code === "string" ? error.code : error.message : "";
      if (!OWNER_INPUT_CODES.has(named)) throw error;
      const suffix = error instanceof CatalogCombinationError ? combinationPath(error)
        : error instanceof CatalogQuantityError ? quantityPath?.(error) ?? "" : "";
      add(named, path + suffix);
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
    const packIndex = (path: string) => Number(/^\/packs\/(\d+)(?:\/|$)/u.exec(path)?.[1] ?? Number.MAX_SAFE_INTEGER);
    findings.sort((a, b) => packIndex(a.path) - packIndex(b.path) || compare(a.path, b.path) || compare(a.code, b.code));
    const content = validators ? "Trusted source runs registered content validators."
      : "Application content validation requires trusted projection.";
    return { state: violated ? "violated" : unavailable ? "unavailable" : "satisfied", exitCode: violated ? 1 : unavailable ? 2 : 0,
      boundary: `${boundary} ${content}`, findings };
  }
  if (typeof jsonText !== "string") { add("conformance_subject_invalid", ""); return finish(); }
  try {
    parsed = JSON.parse(jsonText);
    observedSubject = JSON.parse(jsonText);
  }
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
  let attributesAvailable = true, combinationsAvailable = true, packsWithContent = 0;
  const typeIdentities = new Set<string>();
  const ready: { index: number; pack: CatalogPackInput; types: CatalogPackInput["types"] }[] = [];
  for (const [index, entry] of subject.packs.entries()) {
    const at = `/packs/${index}`;
    if (!closed(entry, ["pack", "drafts", "quantities", "attributes", "combinations", "refusals"])
      || [entry.drafts, entry.quantities, entry.attributes, entry.combinations, entry.refusals].some(value => value !== undefined && !Array.isArray(value))) {
      add("conformance_subject_invalid", at); attributesAvailable = combinationsAvailable = false; continue;
    }
    attributesAvailable &&= !!entry.attributes?.length;
    combinationsAvailable &&= !!entry.combinations?.length;
    const reportSkippedFixtures = () => {
      if ([entry.drafts, entry.quantities, entry.attributes, entry.combinations, entry.refusals].some(fixtures => fixtures?.length))
        advise("advisory_fixtures_skipped_definition_invalid", at + "/pack");
    };
    // Only this internal callback enters owner definitions. JSON never supplies executable code.
    const invalid = new Set<number>();
    const pack = object(entry.pack) && Array.isArray(entry.pack.types) ? { ...entry.pack, types: entry.pack.types.map((type, i) => {
      if (!object(type)) return type;
      if (Object.hasOwn(type, "validateContent")) {
        add("definition_unknown_field", `${at}/pack/types/${i}/validateContent`);
        invalid.add(i);
      }
      const callback = validators?.get(`${at}/pack/types/${i}/validateContent`);
      return { ...type, validateContent: validators && !invalid.has(i) ? callback : () => [] };
    }) } as CatalogPackInput : entry.pack as CatalogPackInput;
    const inspected = await owner(`${at}/pack`, () => inspectCatalogPack(pack));
    if (!inspected) { reportSkippedFixtures(); continue; }
    const { issues, profiles } = inspected;
    if (typeof pack?.openlupRange === "string") {
      const path = `${at}/pack/openlupRange`;
      const satisfied = satisfiesPlatformRange(pack.openlupRange);
      if (satisfied === undefined) advise("advisory_openlup_range_unrecognised", path);
      else if (!satisfied) {
        const installed = `; Platform = ${platformVersion}`;
        advise("advisory_openlup_range_unsatisfied", path, `range = ${previewValue(pack.openlupRange, 160 - 8 - installed.length)}${installed}`);
      }
    }
    let packInvalid = false;
    for (const issue of issues) {
      const path = `${at}/pack${issue.path}`;
      add(issue, path, "", false, issue.code === "definition_axis_mismatch" ? axisMismatchPreview(observedSubject, path) : undefined);
      const typeIndex = /^\/types\/(\d+)(?:\/|$)/u.exec(issue.path)?.[1];
      if (typeIndex === undefined) packInvalid = true;
      else invalid.add(Number(typeIndex));
    }
    if (packInvalid) { reportSkippedFixtures(); continue; }
    let definitionsRefused = invalid.size > 0;
    if (!definitionsRefused && profiles !== undefined) {
      const prepared = await owner(`${at}/pack`, () => prepareCatalogPackManifest(pack, profiles));
      definitionsRefused = !prepared || "issue" in prepared;
      if (prepared && "issue" in prepared) add(prepared.issue, `${at}/pack${prepared.issue.path}`);
    }
    const types = pack.types.filter((type, i) => {
      const path = `${at}/pack/types/${i}`;
      if (!object(type) || typeof type.key !== "string" || typeof type.version !== "number") return false;
      const identity = referenceKey(type.key, String(type.version));
      if (invalid.has(i)) return false;
      if (typeIdentities.has(identity)) add("definition_duplicate_identity", `${path}/key`);
      typeIdentities.add(identity);
      if (!type.units.some(unit => type.netContentUnits.includes(unit.code) && unit.dimension === "mass"
        && (unit.factor?.canonicalUnit === "openlup:g" || CATALOG_QUANTITY_UNITS.some(builtIn => builtIn.code === unit.code && builtIn.dimension === "mass"))))
        advise("advisory_net_content_not_publishable", `${path}/netContentUnits`);
      const boundAttributes = type.axes && new Set(type.axes.map(axis => axis.attributeKey));
      type.attributes?.forEach((attribute, j) => {
        if (attribute.filterable || attribute.facetable)
          advise("advisory_filter_flags_unused", `${path}/attributes/${j}/${attribute.filterable ? "filterable" : "facetable"}`);
        if (attribute.scope === "variant" && boundAttributes && !boundAttributes.has(attribute.key))
          advise("advisory_variant_attribute_without_axis", `${path}/attributes/${j}/key`);
      });
      return true;
    });
    if (definitionsRefused) { reportSkippedFixtures(); continue; }
    ready.push({ index, pack, types });
  }
  for (const { index, pack, types } of ready) {
    const at = `/packs/${index}`, { drafts, quantities, attributes, combinations, refusals } = subject.packs[index];
    if (validators) verifyCatalogRulesAtInstall(pack);
    const registry = await owner(`${at}/pack/types`, () => createCatalogProductTypeRegistry(types));
    if (!registry) continue;
    let contentChecked = false;
    for (const [i, draft] of (drafts ?? []).entries()) {
      const path = `${at}/drafts/${i}`, version = object(draft) ? draft.schemaVersion : undefined;
      const schema = version === 3 ? catalogDraftPayloadV3Schema : version === 2 ? catalogDraftPayloadV2Schema : catalogDraftPayloadSchema;
      const admitted = await owner(path, () => schema.safeParse(draft));
      if (!admitted) continue;
      if (!admitted.success) { admitted.error.issues.forEach(issue => add("draft_input_invalid", `${path}${pointer(issue.path)}`)); continue; }
      const payload = admitted.data;
      if (payload.schemaVersion === 1 || payload.schemaVersion === 2)
        advise("advisory_draft_version_not_publishable", `${path}/schemaVersion`);
      payload.skus.forEach((sku, j) => {
        if (!sku.identifiers?.some(identifier => identifier.scheme === "gs1:gtin"
          && identifier.packagingLevel === "unit" && isValidGtin(identifier.value)))
          advise("advisory_unit_identifier_missing", `${path}/skus/${j}/identifiers`);
      });
      const definition = registry.resolve(payload.product.type);
      const validation = validateDraftFacts(payload, { resolve: () => definition && { ...definition, validateContent: content => {
        if (!validators) {
          add("conformance_owner_unavailable", `${path}/product/sharedContent`, "", true);
          return [];
        }
        const result = definition.validateContent(content);
        const then = (result as unknown as PromiseLike<unknown> | undefined)?.then;
        if (typeof then === "function") {
          void then.call(result, undefined, () => undefined);
          throw new TypeError("Catalogue validateContent must return synchronously");
        }
        contentChecked = true;
        return result;
      } } }, true);
      if (!validation.valid) for (const issue of validation.issues) add(issue, path + issue.path);
      if (payload.schemaVersion === 1 || !definition) continue;

      const attributeIssues = await owner(path, () => validateDraftAttributes(definition, payload));
      for (const issue of attributeIssues ?? [])
        add(issue.code, path + issue.path, "", issue.code === "attribute_reference_unresolved");
      await owner(path, () => validateDraftCombinations(definition, payload, (code, suffix) => {
        throw new CatalogCombinationError(code, suffix);
      }, true), error => error.path);
    }
    if (contentChecked) packsWithContent++;
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
              const target = atPointer(value.input, issue.path);
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
          let retainedIndex: number | undefined;
          await owner(`${path}/input`, () => {
            const retained = input.retained.map((row, index) => {
              retainedIndex = index;
              return { ...row, identity: row.optionValues === null ? null
                : canonicalizeCatalogCombinationV2({ definition, axes: input.axes, options: row.optionValues }) };
            });
            retainedIndex = undefined;
            return validateCatalogCombinationChangesV2({ ...input, definition, retained });
          }, error => combinationFixturePointer(input, error, retainedIndex),
          error => combinationQuantityPointer(input, definition, error, retainedIndex));
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
    if (!(check === "attribute-values" ? attributesAvailable : check === "variant-combinations" ? combinationsAvailable
      : check === "draft-content" && packsWithContent === subject.packs.length))
      add("conformance_owner_unavailable", `/requiredChecks/${index}`, "", true);
  return finish();
}
