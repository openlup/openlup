import { createHash } from "node:crypto";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import type { CatalogAttributeValue } from "./contracts/draftV2.js";
import type { CatalogDraftPayloadV3, CatalogDraftPublicationOperationV3, CatalogDraftSharedContentV3,
  CatalogPublicationFacts } from "./contracts/draftV3.js";
import type { CatalogOptionValue, CatalogProductTypeRef, CatalogQuantity } from "./contracts/productTypes.js";
import { catalogDraftProductV2Schema, catalogDraftSkuV2Schema } from "./draftV2Schemas.js";
import { catalogDraftPayloadV3Schema } from "./draftV3Schemas.js";
import { isValidGtin } from "./foundationSchemas.js";
import { z } from "./validation.js";

/** An authored SKU and its intended sales eligibility.
 * @experimental
 */
export interface CatalogProductSkuInput {
  code: string;
  title: string;
  options: Readonly<Record<string, CatalogOptionValue>>;
  netContent: CatalogQuantity;
  identifiers: readonly {
    scheme: string; issuer: string; value: string; packagingLevel: "unit" | "case";
    quantity?: number; isPrimary?: boolean; label?: string | null;
  }[];
  sell: { oneTime: boolean; subscription: boolean };
  primary?: boolean;
  grossMass?: CatalogQuantity;
  attributes?: Readonly<Record<string, CatalogAttributeValue>>;
  facts?: CatalogPublicationFacts;
  minQuantity?: number;
  isAddon?: boolean;
  offerVersions?: readonly string[];
  logisticsRef?: string | null;
}

/** An application-owned product pinned to an installed type.
 * @experimental
 */
export interface CatalogProductInput {
  namespace: string;
  type: CatalogProductTypeRef;
  slug: string;
  name: string;
  presentation: CatalogPublicationFacts;
  skus: readonly CatalogProductSkuInput[];
  document?: CatalogPublicationFacts;
  attributes?: Readonly<Record<string, CatalogAttributeValue>>;
}

const { code, options, netContent, identifiers, grossMass, attributes: skuAttributes, logisticsRef } = catalogDraftSkuV2Schema.shape;
const text = z.string().min(1).max(500).refine(value => value.trim() === value);
const facts = z.record(z.string(), z.json());
const skuInput = z.strictObject({
  code: code.unwrap(), title: text, options, netContent: netContent.unwrap(),
  identifiers: z.array(identifiers.unwrap().element.extend({
    quantity: z.number().int().min(1).max(999_999).optional(),
    isPrimary: z.boolean().optional(), label: text.nullish(),
  })).max(32),
  sell: z.strictObject({ oneTime: z.boolean(), subscription: z.boolean() }),
  primary: z.boolean().optional(), grossMass, attributes: skuAttributes, facts: facts.optional(),
  minQuantity: z.number().int().min(1).max(2_147_483_647).optional(), isAddon: z.boolean().optional(),
  offerVersions: z.array(logisticsRef.unwrap()).length(1).optional(), logisticsRef: logisticsRef.nullable(),
});

/** The structural schema for the authored product description.
 * @experimental
 */
export const catalogProductInputSchema: z.ZodType<CatalogProductInput> = z.strictObject({
  namespace: z.string().regex(/^[a-z][a-z0-9.-]*$/u),
  type: catalogDraftProductV2Schema.shape.type,
  slug: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/u), name: text,
  presentation: facts, skus: z.array(skuInput).min(1).max(10_000),
  document: facts.optional(), attributes: catalogDraftProductV2Schema.shape.attributes,
});

const fixes = {
  version: "Set type.version to the installed version of the product type.",
  primarySku: "Mark exactly one SKU with primary: true.",
  missingGtin: "Add a valid unit GS1 GTIN for this SKU. If the product has no GS1 barcode, mint one with catalogInternalGtin using an unused store-local sequence.",
  primaryGtin: "Set isPrimary to true on one valid unit GS1 GTIN and clear it on all other identifiers of this SKU.",
  quantity: "Use quantity 1 for a unit identifier and supply the actual case quantity from 2 to 999999 for a case identifier.",
  gtin: "Enter a valid GTIN for this identifier.",
  duplicateGtin: "Remove the duplicate record or supply a distinct valid GTIN. Leading zeros and issuer changes do not distinguish GTINs.",
  mode: "Enable sell.oneTime, sell.subscription or both for this SKU.",
  code: "Give each SKU of the product a distinct code.",
  offer: "List exactly one offer version in offerVersions for this SKU, or omit offerVersions to use classic.",
  reference: "Shorten namespace or slug until every generated document reference is at most 240 characters.",
  bytes: "Shorten optional product data or reduce the number of SKUs until each draft is at most 1048576 bytes.",
  depth: "Reduce nesting in the named content until the generated draft fits the depth limit of 48.",
  json: "Use plain JSON data in the named field and remove unsupported keys or values.",
  shape: "Correct the field named by path to match catalogProductInputSchema.",
};

/** An actionable refusal pointing to the authored field.
 * @experimental
 */
export class CatalogReleaseDraftError extends Error {
  readonly code = "release_draft_invalid";
  constructor(readonly path: string, message: string) {
    super(message);
    this.name = "CatalogReleaseDraftError";
  }
}

function refuse(path: string, fix: keyof typeof fixes, value: unknown): never {
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  throw new CatalogReleaseDraftError(path, [
    `Observed: ${path} (${kind} [redacted]).`,
    "Cause: The product description does not produce a valid schema version 3 draft.",
    `Fix: ${fixes[fix]}`,
    "Recheck: Call buildCatalogReleaseDraftV3 again with the corrected description.",
  ].join("\n"));
}

const inputPath = (path: readonly PropertyKey[]) =>
  path.map(key => /^[A-Za-z0-9_:-]{1,64}$/u.test(String(key)) ? String(key) : "[key]").join(".") || "$";

function sourceValue(value: unknown, path: readonly PropertyKey[]): unknown {
  for (const key of path) value = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  return value;
}

const invalidText = (value: string) => value.includes("\u0000") || /[\uD800-\uDFFF]/u.test(value);

// Catch data that a recursive schema could lose or fail to traverse before copying it.
function checkPlainData(value: unknown, path: string[] = [], ancestors = new Set<object>()): void {
  const document = path[0] === "document";
  if (path.length > (document ? 49 : 48)) refuse(document ? "document" : "$", "depth", value);
  const invalid = () => refuse(document ? "document" : inputPath(path), "json", value);
  if (typeof value === "string" && invalidText(value)) invalid();
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) invalid();
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") invalid();
  if (value === undefined && (document && path.length > 1 || path[0] === "presentation" && path.length > 1
    || path[0] === "skus" && path[2] === "facts" && path.length > 3)) invalid();
  if (value === null || typeof value !== "object") return;
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (ancestors.has(value) || (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)) invalid();
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) invalid();
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string" || invalidText(key) || ["__proto__", "constructor", "prototype"].includes(key))
      invalid();
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (!property.enumerable || !("value" in property) || array && (!/^(?:0|[1-9][0-9]*)$/u.test(String(key)) || Number(key) >= value.length))
      invalid();
    checkPlainData(property.value, [...path, String(key)], ancestors);
  }
  ancestors.delete(value);
}

function parseProduct(input: unknown): CatalogProductInput {
  checkPlainData(input);
  try { return catalogProductInputSchema.parse(input); }
  catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    const issue = error.issues[0]!;
    const fields = issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]!] : issue.path;
    const path = inputPath(fields), value = sourceValue(input, fields);
    if (path === "type.version" && value === undefined) refuse(path, "version", value);
    if (/^skus\.\d+\.identifiers\.\d+\.quantity$/u.test(path)) refuse(path, "quantity", value);
    if (/^skus\.\d+\.identifiers\.\d+\.value$/u.test(path) && sourceValue(input, [...issue.path.slice(0, -1), "scheme"]) === "gs1:gtin"
      && typeof value === "string") refuse(path, "gtin", value);
    if (/^skus\.\d+\.offerVersions$/u.test(path) && Array.isArray(value) && value.length !== 1) refuse(path, "offer", value);
    refuse(path, "shape", value);
  }
}

function canonical(value: unknown, path: string): string {
  try { return canonicalCatalogDraftJson(value); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error.message === "draft_payload_too_large") refuse(path, "bytes", value);
    if (error.message === "draft_json_depth") refuse(path, "depth", value);
    refuse(path, "json", value);
  }
}

function buildIdentifiers(sku: CatalogProductSkuInput, path: string, seen: Set<string>) {
  const candidates: number[] = [];
  let explicitPrimary: number | undefined;
  const identifiers = sku.identifiers.map(({ scheme, issuer, value, packagingLevel, quantity }, index) => {
    const recordPath = `${path}.${index}`;
    const count = quantity ?? (packagingLevel === "unit" ? 1 : 0);
    if (packagingLevel === "unit" ? count !== 1 : count < 2) refuse(`${recordPath}.quantity`, "quantity", quantity);
    if (scheme === "gs1:gtin") {
      if (!isValidGtin(value)) refuse(`${recordPath}.value`, "gtin", value);
      const normalized = value.padStart(14, "0");
      if (seen.has(normalized)) refuse(`${recordPath}.value`, "duplicateGtin", value);
      seen.add(normalized);
      if (packagingLevel === "unit") candidates.push(index);
    }
    if (sku.identifiers[index]!.isPrimary) {
      if (scheme !== "gs1:gtin" || packagingLevel !== "unit" || explicitPrimary !== undefined)
        refuse(`${recordPath}.isPrimary`, "primaryGtin", true);
      explicitPrimary = index;
    }
    return { scheme, issuer, value, packagingLevel, quantity: count };
  });
  if (candidates.length === 0) refuse(path, "missingGtin", identifiers);
  if (explicitPrimary === undefined && candidates.length !== 1) refuse(path, "primaryGtin", identifiers);
  return { identifiers, primary: explicitPrimary ?? candidates[0] };
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function artifact(payload: CatalogDraftPayloadV3) {
  const canonicalText = canonical(payload, "$");
  // Authored leaves use the payload schemas or their operation bounds up front.
  // Cross-field and aggregate checks here address the assembled artifact.
  const checked = catalogDraftPayloadV3Schema.safeParse(JSON.parse(canonicalText));
  if (!checked.success) refuse("$", "shape", payload);
  return { payload: checked.data, digest: hash(canonicalText) };
}

/** Compile a draft release and its fixed follow-up activation.
 * @experimental
 */
export function buildCatalogReleaseDraftV3(input: CatalogProductInput): {
  release: { payload: CatalogDraftPayloadV3; digest: string };
  activation: { payload: CatalogDraftPayloadV3; digest: string };
} {
  const { namespace, type, slug, name, presentation, attributes, document: extraDocument, skus } = parseProduct(input);
  function id(label: string) {
    const hex = hash(`openlup-catalogue-v1:${namespace}:${label}`);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
  const schemaId = `${namespace}:product@1`, documentRef = `${namespace}:product/${slug}`, sourceRef = `${namespace}:catalogue-products`;
  if (schemaId.length > 240 || sourceRef.length > 240) refuse("namespace", "reference", namespace);
  if (documentRef.length > 240) refuse("slug", "reference", slug);
  const productId = id(`product:${slug}`), revisionId = id(`revision:${slug}:1`);
  const document = { ...extraDocument, schemaId, documentRef, productSlug: slug, revisionNo: 1, name };
  const canonicalText = canonical(document, "document"), digest = hash(canonicalText);
  const documentRevision = { id: revisionId, productId, revisionNo: 1, schemaId, documentRef, sourceRef, digest };

  const dimensions = new Set<string>(), codes = new Set<string>(), gtins = new Set<string>();
  let primarySku: number | undefined;
  const releaseOperations: CatalogDraftPublicationOperationV3[] = [
    { op: "create_product", productId, productSlug: slug, name },
    { op: "register_document_revision", productSlug: slug, revisionId, revisionNo: 1, documentRef, sourceRef,
      canonicalText, digest, provenance: { source: "current_draft" } },
    { op: "move_document_pointer", productSlug: slug, documentRevisionNo: 1 },
  ];
  const publicationSkus: CatalogDraftSharedContentV3["publicationSkus"] = [];
  const releaseSkus = skus.map((sku, index) => {
    const path = `skus.${index}`;
    const { code: skuCode, title, minQuantity = 1, isAddon = false, facts = {}, options, netContent, grossMass, attributes, sell } = sku;
    if (codes.has(skuCode)) refuse(`${path}.code`, "code", skuCode);
    codes.add(skuCode);
    if (sku.primary) {
      if (primarySku !== undefined) refuse(`${path}.primary`, "primarySku", sku.primary);
      primarySku = index;
    }
    for (const key of Object.keys(options)) dimensions.add(key);
    if (dimensions.size > 16) refuse(`${path}.options`, "shape", options);
    const { identifiers, primary } = buildIdentifiers(sku, `${path}.identifiers`, gtins);
    if (!sell.oneTime && !sell.subscription) refuse(`${path}.sell`, "mode", sell);

    const skuId = id(`sku:${slug}:${skuCode}`);
    const authoredSku = { skuCode, title, minQuantity, isAddon, facts };
    publicationSkus.push(authoredSku);
    releaseOperations.push({ op: "create_sku", skuId, productSlug: slug, documentRevisionNo: 1, ...authoredSku });
    identifiers.forEach((identifier, index) => releaseOperations.push({ op: "create_identifier", skuCode, ...identifier,
      isPrimary: index === primary, label: sku.identifiers[index]!.label ?? null, sourceRef: null }));
    return { id: skuId, productId, code: skuCode, options, netContent, identifiers,
      ...(grossMass === undefined ? {} : { grossMass }), ...(attributes === undefined ? {} : { attributes }) };
  });
  if (primarySku === undefined && skus.length > 1) refuse("skus", "primarySku", skus);
  const primary = releaseSkus[primarySku ?? 0]!;
  releaseOperations.push({ op: "set_primary_sku", productSlug: slug, skuCode: primary.code },
    { op: "set_product_presentation", productSlug: slug, presentation });
  const sharedContent: CatalogDraftSharedContentV3 = { schemaVersion: 1, catalogAction: "create", document, presentation,
    requestedModes: [], offerMemberships: [], publicationSkus };
  const product = { id: productId, type, slug, primarySkuId: primary.id, dimensions: [...dimensions].sort(),
    documentRevision, sharedContent, ...(attributes === undefined ? {} : { attributes }) };
  const release = artifact({ schemaVersion: 3, product, skus: releaseSkus,
    publication: { kind: "release", operations: releaseOperations, evidence: {} } });

  const activationOperations: CatalogDraftPublicationOperationV3[] = [
    { op: "set_product_status", productSlug: slug, status: "active" },
    ...skus.map(({ code }) => ({ op: "set_sku_status", skuCode: code, status: "active" } as const)),
  ];
  const requestedModes: CatalogDraftSharedContentV3["requestedModes"] = [];
  const offerMemberships: CatalogDraftSharedContentV3["offerMemberships"] = [];
  const activationSkus = skus.map(({ code: skuCode, sell, logisticsRef, offerVersions }, index) => {
    const modes: CatalogDraftSharedContentV3["requestedModes"][number]["modes"] = [];
    if (sell.oneTime) modes.push("one_time");
    if (sell.subscription) modes.push("subscription");
    requestedModes.push({ skuCode, modes });
    const membership = { skuCode, offerVersion: offerVersions?.[0] ?? "classic", admitted: true };
    offerMemberships.push(membership);
    activationOperations.push({ op: "set_eligibility", skuCode, sellableStandalone: sell.oneTime, sellableInSubscription: sell.subscription });
    if (logisticsRef != null) activationOperations.push({ op: "set_sku_metadata", skuCode, logisticsRef });
    activationOperations.push({ op: "set_offer_membership", ...membership });
    const sku = releaseSkus[index]!;
    return logisticsRef == null ? sku : { ...sku, logisticsRef };
  });
  const activation = artifact({ schemaVersion: 3,
    product: { ...product, sharedContent: { ...sharedContent, catalogAction: "revise", requestedModes, offerMemberships } },
    skus: activationSkus, publication: { kind: "release", operations: activationOperations, evidence: {} } });
  return { release, activation };
}
