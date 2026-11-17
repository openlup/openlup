import { z } from "zod";

/** The largest amount a price row holds: the database integer maximum. */
export const CATALOG_PRICE_SETUP_MAX_MINOR = 2_147_483_647;

const id = z.guid().refine((value) => value === value.toLowerCase(), "UUID must be lowercase");
const commandKey = z.string().min(1).max(240).refine((value) => value.trim() === value, "command key must be trimmed");
const amount = z.number().int().min(0).max(CATALOG_PRICE_SETUP_MAX_MINOR);
const positiveAmount = z.number().int().min(1).max(CATALOG_PRICE_SETUP_MAX_MINOR);
const code = z.string().min(1).max(160).regex(/^[a-z][a-z0-9_]*$/u);
const timestamp = z.string().datetime({ offset: true });

export const catalogPriceSetupReasonsSchema = z.array(code).max(32);
const readinessSchema = z.object({ ready: z.boolean(), reasons: catalogPriceSetupReasonsSchema }).strict();
const entrySchema = z.object({ entryId: id, unitPriceMinor: amount, validFrom: timestamp }).strict();

/** The base the caller saw: none yet, or one effective row and its amount. */
export const catalogPriceSetupExpectedSchema = z.union([
  z.object({ entryId: z.null(), unitPriceMinor: z.null() }).strict(),
  z.object({ entryId: id, unitPriceMinor: amount }).strict(),
]);

/** One exact-SKU base price: gross, one-time, minimum quantity one, never a subscription price. */
export const catalogPriceSetupCommandSchema = z.object({
  schemaVersion: z.literal(1),
  commandKey,
  variantId: id,
  priceListId: id,
  mode: z.literal("one_time"),
  minQty: z.literal(1),
  amountKind: z.literal("gross"),
  unitPriceMinor: positiveAmount,
  expected: catalogPriceSetupExpectedSchema,
}).strict();

export const catalogPriceSetupPreviewQuerySchema = z.object({
  variantId: id, priceListId: id, unitPriceMinor: positiveAmount.optional(),
}).strict();

export const catalogPriceSetupSubscriptionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("derived"), revisionId: id, discountBps: z.number().int().min(0).max(10_000),
    roundingQuantumMinor: positiveAmount, derivedUnitPriceMinor: amount.nullable(),
  }).strict(),
  z.object({ kind: z.literal("stored"), unitPriceMinor: amount }).strict(),
  z.object({ kind: z.literal("unresolved"), reason: code }).strict(),
]);

export const catalogPriceSetupPreviewSchema = z.object({
  outcome: z.literal("preview"),
  variantId: id,
  priceListId: id,
  inGate: z.boolean(),
  current: entrySchema.nullable(),
  currentCount: z.number().int().min(0),
  subscription: catalogPriceSetupSubscriptionSchema,
  readiness: readinessSchema,
  proposed: z.object({ unitPriceMinor: positiveAmount, readiness: readinessSchema }).strict().optional(),
}).strict();

export const catalogPriceSetupReceiptSchema = z.object({
  commandKey, variantId: id, priceListId: id, actorId: id,
  previous: entrySchema.nullable(), current: entrySchema,
}).strict();

export const catalogPriceSetupRefusalSchema = z.object({
  outcome: z.enum(["conflict", "validation_issue", "unauthorized", "dependency_unavailable"]),
  reason: code,
  reasons: catalogPriceSetupReasonsSchema.optional(),
}).strict();

export const catalogPriceSetupPreviewResultSchema = z.union([
  catalogPriceSetupPreviewSchema, catalogPriceSetupRefusalSchema,
]);

export const catalogPriceSetupApplyResultSchema = z.union([
  z.object({ outcome: z.enum(["committed", "replayed"]), receipt: catalogPriceSetupReceiptSchema }).strict(),
  catalogPriceSetupRefusalSchema,
]);

export type CatalogPriceSetupCommand = z.infer<typeof catalogPriceSetupCommandSchema>;
export type CatalogPriceSetupPreviewQuery = z.infer<typeof catalogPriceSetupPreviewQuerySchema>;
export type CatalogPriceSetupPreview = z.infer<typeof catalogPriceSetupPreviewSchema>;
export type CatalogPriceSetupReceipt = z.infer<typeof catalogPriceSetupReceiptSchema>;
export type CatalogPriceSetupRefusal = z.infer<typeof catalogPriceSetupRefusalSchema>;
export type CatalogPriceSetupApplyResult = z.infer<typeof catalogPriceSetupApplyResultSchema>;

/**
 * The exact bytes the command routine fingerprints: a valid command as JSON with sorted
 * keys. Every field is bounded by the schema, so the text stays far below the 4096 bytes
 * the database routine accepts. Throws on anything the schema refuses.
 */
export function canonicalCatalogPriceSetupCommand(input: unknown): string {
  return JSON.stringify(sortKeys(catalogPriceSetupCommandSchema.parse(input)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
}
