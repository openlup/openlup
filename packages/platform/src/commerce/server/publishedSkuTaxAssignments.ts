import type { PgQueryExecutor } from "../../data/index.js";
import type { CommerceMoneyLimitsQueryExecutor } from "./commerceMoneyLimitsV2.js";

type SkuPair = Readonly<{ skuId: string; sku: string }>;
type AssignmentRequest = Readonly<{ expectedHeadDigest: string | null; skus: readonly SkuPair[] }>;
type AssignedSku = SkuPair & Readonly<{ classState: "assigned"; taxClassKey: string; assignmentRef: string }>;
type PublishedAssignments = Readonly<{ kind: "published"; revision: string; assignments: readonly AssignedSku[] }>;
type Refusal = Readonly<{ code: string; field: string; remedy: string }>;

const skusField = "/plan/skus";
const digestField = "/plan/expectedHeadDigest";
const selectionRemedy = "Supply the documented published SKU selection and its catalogue head digest, then repeat the read.";
const invalidSkus = { code: "tax_invalid_input", field: skusField, remedy: selectionRemedy };
const invalidDigest = { ...invalidSkus, field: digestField };
const classMissing = { code: "tax_class_missing", field: skusField,
  remedy: "Choose published merchandise whose product type declares an active tax class, or have the catalogue owner publish replacement merchandise with such a type, then request a fresh quote." };
const sqlRefusals: readonly Refusal[] = [
  invalidSkus, invalidDigest, classMissing,
  { code: "catalog_tax_assignment_evidence_invalid", field: skusField,
    remedy: "Have the catalogue owner reconcile the original selection and publication evidence, then repeat the read." },
  { code: "catalog_tax_assignment_head_changed", field: digestField,
    remedy: "Read the published selection again and request a fresh quote." },
  { code: "catalog_tax_assignment_unpublished", field: skusField,
    remedy: "Choose published merchandise or have the catalogue owner publish the intended SKU, then request a fresh quote." },
];

const refusals = new WeakMap<object, Refusal>();

class PublishedSkuTaxAssignmentRefusal extends Error {
  constructor(refusal: Refusal) {
    super(refusal.code);
    Object.assign(this, refusal);
    refusals.set(this, refusal);
  }
}

export function lookupPublishedSkuTaxAssignmentRefusal(cause: unknown): Refusal | undefined {
  return typeof cause === "object" && cause !== null ? refusals.get(cause) : undefined;
}

const uuidPattern = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const uuid = new RegExp(`^${uuidPattern}$`, "u");
const assignmentPattern = new RegExp(`^catalog-assignment:([0-9a-f]{64}):${uuidPattern}:([1-9][0-9]{0,9}):${uuidPattern}$`, "u");
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const isSkuCode = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
const isClassKey = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 120
  && !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value);

function isBoundAssignment(value: unknown, revision: string): value is string {
  if (typeof value !== "string" || value.length > 168) return false;
  const match = assignmentPattern.exec(value);
  return match !== null && match[1] === revision && Number(match[2]) <= 2_147_483_647;
}

function isPlainObject(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return;
  const fields = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !field?.enumerable || !("value" in field)) return;
    fields.set(key, field.value);
  }
  return Object.fromEntries(fields);
}

function dataValue(value: object, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field?.enumerable && "value" in field ? field.value : undefined;
}

function array(value: unknown, min: number, max: number): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return;
  const length = value.length;
  if (length < min || length > max || Reflect.ownKeys(value).length !== length + 1) return;
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const element = Object.getOwnPropertyDescriptor(value, String(i));
    if (!element?.enumerable || !("value" in element)) return;
    result.push(element.value);
  }
  return result;
}

function hasKeys(value: Record<string, unknown>, ...keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function snapshot(input: unknown): AssignmentRequest {
  if (!isPlainObject(input) || Reflect.ownKeys(input).some(key => key !== "expectedHeadDigest" && key !== "skus")) {
    throw new PublishedSkuTaxAssignmentRefusal(invalidSkus);
  }
  const expectedHeadDigest = dataValue(input, "expectedHeadDigest");
  if (expectedHeadDigest !== null && !isDigest(expectedHeadDigest)) throw new PublishedSkuTaxAssignmentRefusal(invalidDigest);

  const rows = array(dataValue(input, "skus"), 1, 50);
  if (!rows) throw new PublishedSkuTaxAssignmentRefusal(invalidSkus);
  const ids = new Set<string>();
  const codes = new Set<string>();
  const skus = rows.map(row => {
    const pair = record(row);
    if (!pair || !hasKeys(pair, "skuId", "sku")) throw new PublishedSkuTaxAssignmentRefusal(invalidSkus);
    const { skuId, sku } = pair;
    if (typeof skuId !== "string" || !uuid.test(skuId) || !isSkuCode(sku) || ids.has(skuId) || codes.has(sku)) {
      throw new PublishedSkuTaxAssignmentRefusal(invalidSkus);
    }
    ids.add(skuId);
    codes.add(sku);
    return { skuId, sku };
  });
  skus.sort((left, right) => left.skuId < right.skuId ? -1 : 1);
  return { expectedHeadDigest, skus };
}

function decode(value: unknown, { expectedHeadDigest, skus }: AssignmentRequest): PublishedAssignments | undefined {
  const reply = record(value);
  if (!reply) return;
  if (reply.kind === "refused" && hasKeys(reply, "kind", "code", "field", "remedy")) {
    const refusal = sqlRefusals.find(({ code, field, remedy }) => reply.code === code && reply.field === field && reply.remedy === remedy);
    if (refusal) throw new PublishedSkuTaxAssignmentRefusal(refusal);
    return;
  }
  if (reply.kind !== "published" || !hasKeys(reply, "kind", "revision", "assignments")) return;
  const { revision } = reply;
  if (!isDigest(revision) || (expectedHeadDigest !== null && expectedHeadDigest !== revision)) return;
  const rows = array(reply.assignments, skus.length, skus.length);
  if (!rows) return;

  const assignments: AssignedSku[] = [];
  let missing = false;
  for (const [index, row] of rows.entries()) {
    const assignment = record(row);
    if (!assignment || !hasKeys(assignment, "skuId", "sku", "classState", "taxClassKey", "assignmentRef")) return;
    const { skuId, sku } = skus[index]!;
    if (assignment.skuId !== skuId || assignment.sku !== sku) return;
    const { classState, taxClassKey, assignmentRef } = assignment;
    if (classState === "none" && taxClassKey === null && assignmentRef === null) {
      missing = true;
    } else if (classState === "assigned" && isClassKey(taxClassKey) && isBoundAssignment(assignmentRef, revision)) {
      assignments.push({ skuId, sku, classState, taxClassKey, assignmentRef });
    } else return;
  }
  if (missing) throw new PublishedSkuTaxAssignmentRefusal(classMissing);
  return { kind: "published", revision, assignments };
}

/** @experimental Resolve selected merchandise tax assignments from one verified catalogue head. */
export function readPublishedSkuTaxAssignments(db: Pick<CommerceMoneyLimitsQueryExecutor, "query">, input: AssignmentRequest): Promise<PublishedAssignments>;
export async function readPublishedSkuTaxAssignments(db: Pick<PgQueryExecutor, "query">, input: AssignmentRequest): Promise<PublishedAssignments> {
  const request = snapshot(input);
  const { rows } = await db.query("SELECT public.catalog_publication_tax_assignments($1::jsonb) AS result", [JSON.stringify(request)]);
  const published = rows.length === 1 ? decode(rows[0]?.result, request) : undefined;
  if (!published) throw new Error("Unreadable published SKU tax assignments");
  return published;
}
