import { z } from "../../../src/catalog/validation.js";
import { isValidGtin } from "../../../src/catalog/foundationSchemas.js";

const textSchema = z.string().min(1).max(1_000).refine((value) => value.trim().length > 0, "text must not be blank");
const keySchema = z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9_]*$/);
/** Opaque UI lookup reference. Kept separate from structural document keys. */
export const productDocumentPresentationKeySchema = z.string().min(1).max(240)
  .regex(/^catalog:product\.[A-Za-z][A-Za-z0-9_]*$/u)
  .refine((value) => value.trim() === value, "presentation key must not have surrounding whitespace");
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const localizedTextSchema = z.object({ pl: textSchema, en: textSchema }).strict();
const sourceIdSchema = z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9_:-]*$/);
const fractionSchema = z.object({
  unscaled: z.number().int().min(0).max(10_000),
  scale: z.literal(4),
  unit: z.literal("FRACTION"),
}).strict();
const closedRangeSchema = z.object({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() })
  .strict()
  .refine((range) => range.max >= range.min, { path: ["max"], message: "range max must not be lower than min" });
const sourceRefsSchema = z.array(sourceIdSchema).min(1).max(16).superRefine((ids, context) => {
  if (new Set(ids).size !== ids.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "source IDs must be unique" });
});
const allergenSlugsSchema = z.array(keySchema).max(64).superRefine((slugs, context) => {
  if (new Set(slugs).size !== slugs.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "allergen slugs must be unique" });
});
const copyItemSchema = z.object({
  ordinal: z.number().int().positive(),
  key: keySchema,
  title: localizedTextSchema,
  role: localizedTextSchema,
  body: localizedTextSchema,
  claimPill: localizedTextSchema.nullable().optional().transform((claimPill) => claimPill ?? null),
  allergenSlugs: allergenSlugsSchema,
  nameKey: productDocumentPresentationKeySchema.optional(),
  roleKey: productDocumentPresentationKeySchema.optional(),
  bodyKey: productDocumentPresentationKeySchema.optional(),
  claimPillKey: productDocumentPresentationKeySchema.optional(),
  sourceIds: sourceRefsSchema,
}).strict();
const calloutSchema = z.discriminatedUnion("kind", [
  z.object({
    ordinal: z.number().int().positive(),
    key: keySchema,
    kind: z.literal("statement"),
    statement: localizedTextSchema,
    sourceIds: sourceRefsSchema,
  }).strict(),
  z.object({
    ordinal: z.number().int().positive(),
    key: keySchema,
    kind: z.literal("panel"),
    label: localizedTextSchema,
    title: localizedTextSchema,
    body: localizedTextSchema,
    sourceIds: sourceRefsSchema,
  }).strict(),
]);
const sourceSchema = z.object({
  id: sourceIdSchema,
  kind: z.enum(["workbook", "label", "manufacturer", "regulatory", "asset", "repository_content", "owner_approval"]),
  ref: textSchema,
  sha256: sha256DigestSchema.nullable().optional().transform((digest) => digest ?? null),
}).strict();

export const productDocumentV1Schema = z.object({
  schemaVersion: z.literal("example.product-document.v1"),
  id: textSchema,
  productSlug: keySchema,
  revisionNo: z.number().int().positive(),
  names: localizedTextSchema,
  facts: z.object({
    species: z.enum(["dog", "cat"]),
    lifeStage: z.enum(["adult", "junior", "senior", "all_life_stages"]),
    foodType: z.enum(["complete", "complementary"]),
    manufacturer: localizedTextSchema,
    madeIn: z.string().regex(/^[A-Z]{2}$/u),
    approvalNumber: textSchema,
    allergenSlugs: allergenSlugsSchema,
  }).strict(),
  energy: z.object({ unscaled: z.number().int().positive(), scale: z.literal(0), unit: z.literal("KCAL_PER_100G") }).strict(),
  composition: z.array(z.object({
    ordinal: z.number().int().positive(),
    ingredientKey: keySchema,
    labels: localizedTextSchema,
    declaredShare: fractionSchema,
    proteinBase: z.boolean(),
  }).strict()).min(1).max(100),
  components: z.array(z.object({
    parentIngredientKey: keySchema,
    ordinal: z.number().int().positive(),
    componentKey: keySchema,
    labels: localizedTextSchema,
    declaredShare: fractionSchema.nullable(),
  }).strict()).max(200),
  analyticsAsFed: z.object({
    crudeProtein: fractionSchema,
    crudeFat: fractionSchema,
    moisture: fractionSchema,
    crudeAsh: fractionSchema,
    crudeFibre: fractionSchema,
  }).strict(),
  additives: z.array(z.object({
    ordinal: z.number().int().positive(),
    additiveKey: keySchema,
    labels: localizedTextSchema,
    quantity: z.object({
      unscaled: z.number().int().positive(),
      scale: z.number().int().min(0).max(4),
      unit: z.enum(["IU_PER_KG", "MG_PER_KG"]),
    }).strict(),
  }).strict()).max(100),
  feedingGuide: z.array(z.object({
    band: z.number().int().positive(),
    dogWeightKg: closedRangeSchema,
    dailyFeedG: closedRangeSchema,
  }).strict()).min(1).max(32),
  sources: z.array(sourceSchema).min(1).max(64),
  claims: z.array(z.object({
    ordinal: z.number().int().positive(),
    key: keySchema,
    statement: localizedTextSchema,
    sourceIds: sourceRefsSchema,
  }).strict()).max(64),
  copy: z.object({
    lineName: localizedTextSchema,
    subtitle: localizedTextSchema,
    tagline: localizedTextSchema,
    description: localizedTextSchema,
    ingredientNarrative: localizedTextSchema,
    servingNote: localizedTextSchema,
    storage: localizedTextSchema,
    ingredientCards: z.array(copyItemSchema).max(64),
    faq: z.array(z.object({
      ordinal: z.number().int().positive(),
      key: keySchema,
      question: localizedTextSchema,
      answer: localizedTextSchema,
      sourceIds: sourceRefsSchema,
    }).strict()).max(64),
    callouts: z.array(calloutSchema).max(64),
  }).strict(),
}).strict().superRefine((document, context) => {
  assertUniqueNumbers(document.composition.map((entry) => entry.ordinal), "composition", context);
  assertUniqueNumbers(document.additives.map((entry) => entry.ordinal), "additives", context);
  assertUniqueNumbers(document.feedingGuide.map((entry) => entry.band), "feedingGuide", context);
  assertUniqueNumbers(document.claims.map((entry) => entry.ordinal), "claims", context);
  assertUniqueNumbers(document.copy.ingredientCards.map((entry) => entry.ordinal), "copy.ingredientCards", context);
  assertUniqueNumbers(document.copy.faq.map((entry) => entry.ordinal), "copy.faq", context);
  assertUniqueNumbers(document.copy.callouts.map((entry) => entry.ordinal), "copy.callouts", context);
  assertUniqueKeys(document.sources.map((entry) => entry.id), "sources", context);
  assertUniqueKeys(document.claims.map((entry) => entry.key), "claims", context);
  assertUniqueKeys(document.copy.ingredientCards.map((entry) => entry.key), "copy.ingredientCards", context);
  assertUniqueKeys(document.copy.faq.map((entry) => entry.key), "copy.faq", context);
  assertUniqueKeys(document.copy.callouts.map((entry) => entry.key), "copy.callouts", context);
  const ingredients = new Set(document.composition.map((entry) => entry.ingredientKey));
  for (const [index, component] of document.components.entries()) {
    if (!ingredients.has(component.parentIngredientKey)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["components", index, "parentIngredientKey"], message: "component parent must exist in composition" });
    }
  }
  const sources = new Set(document.sources.map((source) => source.id));
  document.claims.forEach((claim, index) => assertKnownSources(claim.sourceIds, sources, ["claims", index, "sourceIds"], context));
  document.copy.ingredientCards.forEach((card, index) => assertKnownSources(card.sourceIds, sources, ["copy", "ingredientCards", index, "sourceIds"], context));
  document.copy.faq.forEach((entry, index) => assertKnownSources(entry.sourceIds, sources, ["copy", "faq", index, "sourceIds"], context));
  document.copy.callouts.forEach((entry, index) => assertKnownSources(entry.sourceIds, sources, ["copy", "callouts", index, "sourceIds"], context));
});

export const assetManifestV1Schema = z.object({
  schemaVersion: z.literal("example.asset-manifest.v1"),
  id: textSchema,
  skuRef: textSchema,
  revisionNo: z.number().int().positive(),
  productDocumentRevisionRef: textSchema.nullable().optional().transform((reference) => reference ?? null),
  productDocumentDigest: sha256DigestSchema.nullable().optional().transform((digest) => digest ?? null),
  labelIdentifier: z.object({
    kind: z.literal("gtin"),
    value: z.string().refine(isValidGtin, "label identifier must be a valid GTIN-8/12/13/14"),
  }).strict(),
  entries: z.array(z.object({
    assetRef: textSchema,
    locale: z.enum(["pl", "en"]),
    view: z.enum(["front", "left", "right", "hero", "gallery", "promo"]),
    ordinal: z.number().int().positive(),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    sha256: sha256DigestSchema,
    altText: textSchema,
  }).strict()).min(1).max(32),
}).strict().superRefine((manifest, context) => {
  if ((manifest.productDocumentRevisionRef === null) !== (manifest.productDocumentDigest === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["productDocumentRevisionRef"], message: "document revision ref and digest must be present together" });
  }
  const placements = new Set<string>();
  const assetRefs = new Set<string>();
  manifest.entries.forEach((asset, index) => {
    const placement = `${asset.locale}\u0000${asset.view}\u0000${asset.ordinal}`;
    if (placements.has(placement)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", index], message: "locale/view/ordinal placements must be unique" });
    placements.add(placement);
    if (assetRefs.has(asset.assetRef)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", index, "assetRef"], message: "asset references must be unique" });
    assetRefs.add(asset.assetRef);
  });
});

export type ProductDocumentV1 = z.infer<typeof productDocumentV1Schema>;
export type AssetManifestV1 = z.infer<typeof assetManifestV1Schema>;
export type ProductDocumentMappingLeafV1 = { field: string; itemKey: string | null; locale: "pl" | "en"; value: string };

/** The one closed list of localized ProductDocument leaves eligible for W2d mappings. */
export function productDocumentMappingLeaves(value: unknown): ProductDocumentMappingLeafV1[] {
  const document = productDocumentV1Schema.parse(value); const leaves: ProductDocumentMappingLeafV1[] = [];
  for (const locale of ["pl", "en"] as const) {
    leaves.push(
      { field: "names", itemKey: null, locale, value: document.names[locale] },
      { field: "facts.manufacturer", itemKey: null, locale, value: document.facts.manufacturer[locale] },
      { field: "facts.madeIn", itemKey: null, locale, value: document.facts.madeIn },
      { field: "facts.approvalNumber", itemKey: null, locale, value: document.facts.approvalNumber },
    );
    for (const field of ["lineName", "subtitle", "tagline", "description", "ingredientNarrative", "servingNote", "storage"] as const) {
      leaves.push({ field: `copy.${field}`, itemKey: null, locale, value: document.copy[field][locale] });
    }
    document.claims.forEach((item) => leaves.push({ field: "claims.statement", itemKey: item.key, locale, value: item.statement[locale] }));
    document.copy.ingredientCards.forEach((item) => { for (const field of ["title", "role", "body"] as const) leaves.push({ field: `copy.ingredientCards.${field}`, itemKey: item.key, locale, value: item[field][locale] }); if (item.claimPill) leaves.push({ field: "copy.ingredientCards.claimPill", itemKey: item.key, locale, value: item.claimPill[locale] }); });
    document.copy.faq.forEach((item) => { leaves.push({ field: "copy.faq.question", itemKey: item.key, locale, value: item.question[locale] }, { field: "copy.faq.answer", itemKey: item.key, locale, value: item.answer[locale] }); });
    document.copy.callouts.forEach((item) => { if (item.kind === "statement") leaves.push({ field: "copy.callouts.statement", itemKey: item.key, locale, value: item.statement[locale] }); else for (const field of ["label", "title", "body"] as const) leaves.push({ field: `copy.callouts.${field}`, itemKey: item.key, locale, value: item[field][locale] }); });
  } return leaves;
}

/** Stable JSON with lexicographically sorted object keys and explicitly encoded UTF-8 bytes. */
export function canonicalizeProductDocument(value: unknown): string {
  return canonicalJson(parseOverlayDocument(value));
}

export async function digestProductDocument(value: unknown): Promise<string> {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable");
  const bytes = new TextEncoder().encode(canonicalizeProductDocument(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Rejects a payload/digest mismatch before a future persistence boundary can write it. */
export async function assertProductDocumentDigest(value: unknown, expectedDigest: string): Promise<void> {
  const expected = sha256DigestSchema.parse(expectedDigest);
  const actual = await digestProductDocument(value);
  if (actual !== expected) throw new Error("product document digest does not match canonical UTF-8 payload");
}

function assertUniqueNumbers(values: number[], name: string, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} ordinals must be unique` });
  }
}

function assertUniqueKeys(values: string[], name: string, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} keys must be unique` });
  }
}

function assertKnownSources(sourceIds: string[], knownSources: Set<string>, path: PropertyKey[], context: z.RefinementCtx): void {
  if (sourceIds.some((sourceId) => !knownSources.has(sourceId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: "source IDs must reference document sources" });
  }
}

function parseOverlayDocument(value: unknown): ProductDocumentV1 | AssetManifestV1 {
  const product = productDocumentV1Schema.safeParse(value);
  return product.success ? product.data : assetManifestV1Schema.parse(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError("canonical JSON accepts only JSON values");
}

// Installed category v2 compatibility validation; seal the original v2 value.
export const productDocumentV2Schema = z.object({ ...productDocumentV1Schema.shape,
  schemaVersion: z.literal("example.product-document.v2"), productSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/u),
}).strict().superRefine((document, context) => {
  if (document.facts.species !== "dog") context.addIssue({ code: "custom", path: ["facts", "species"], message: "current category supports dog food only" });
  const checked = productDocumentV1Schema.safeParse({ ...document, schemaVersion: "example.product-document.v1", productSlug: "validation_recipe" });
  if (!checked.success) for (const issue of checked.error.issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
});
