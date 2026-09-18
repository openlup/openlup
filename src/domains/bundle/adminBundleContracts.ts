import { skuSchema, slugSchema } from "@openlup/core/catalog";

import { z } from "../../lib/validation/zod.js";
import { adminModeFields, idempotencyKeyField } from "../../lib/agent-domain/ruleResult.js";
import { COMMERCE_CONTRACT_VERSION } from "../commerce/types.js";

/**
 * Admin/agent bundle WRITE contracts — the single source of truth the BFF
 * validates against and the MCP tool schemas are derived from.
 *
 * A bundle is a bill of materials over existing catalogue units, sold under one
 * operator-set target price. Composition and price are separate operations
 * because they are separate decisions: the set can change while the price stands,
 * and the price can move without the set changing.
 *
 * Every mutation carries `mode` (commit | dry_run) and an optional
 * `idempotencyKey`, so the same request can be validated without writing or
 * replayed safely. The write routine short-circuits a replayed key and rolls back
 * a dry run.
 */

/**
 * The operator-facing bundle identifier. An OPEN validated string reusing the
 * shared slug format — never a `z.enum`, which would make every new bundle a code
 * change (the catalog slug post-mortem).
 */
export const bundleCodeSchema = slugSchema;

/**
 * Currency is stated as an open ISO 4217 alphabetic code. The stored price row
 * carries no currency of its own — it inherits the referenced price list's — so
 * this is the operator's statement of WHICH list to write into, not a second
 * authority on the amount's meaning.
 */
export const bundleCurrencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Currency must be a three-letter ISO 4217 code");

/**
 * The opaque `{kind, version, data}` envelope the platform stores and never
 * interprets. Only its outer shape is contracted; the payload belongs to the
 * adopter's `CompositionRulesPort`.
 */
export const bundleCompositionConstraintSchema = z
  .object({
    kind: z.string().trim().min(1).max(80),
    version: z.number().int().nonnegative(),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/** Only the exploded mode has a runtime; the stored column admits more on purpose. */
export const bundleFulfillmentModeSchema = z.enum(["virtual", "kitted"]);

/** Which purchase mode a target price applies to. */
export const bundlePriceModeSchema = z.enum(["one_time", "subscription", "any"]);

const adminFields = {
  ...adminModeFields,
  ...idempotencyKeyField,
};

const baseResponseFields = {
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  dryRun: z.boolean(),
  idempotent: z.boolean(),
};

// ── create draft bundle ──────────────────────────────────────────────────────
export const createBundleDraftPayloadSchema = z
  .object({
    code: bundleCodeSchema,
    title: z.string().trim().min(1).max(160),
    fulfillmentMode: bundleFulfillmentModeSchema.default("virtual"),
    compositionConstraint: bundleCompositionConstraintSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const createBundleDraftRequestSchema = z
  .object({ ...adminFields, bundle: createBundleDraftPayloadSchema })
  .strict();

export const createBundleDraftResponseSchema = z.object({
  ...baseResponseFields,
  code: bundleCodeSchema,
  bundleId: z.string().min(1),
});

// ── update draft bundle (structural fields only) ─────────────────────────────
export const updateBundleDraftPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    fulfillmentMode: bundleFulfillmentModeSchema.optional(),
    compositionConstraint: bundleCompositionConstraintSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((updates) => Object.values(updates).some((value) => value !== undefined), {
    message: "At least one field is required",
  });

export const updateBundleDraftRequestSchema = z
  .object({ ...adminFields, code: bundleCodeSchema, updates: updateBundleDraftPayloadSchema })
  .strict();

export const updateBundleDraftResponseSchema = z.object({
  ...baseResponseFields,
  code: bundleCodeSchema,
});

// ── set composition (WHOLE-SET atomic replace) ───────────────────────────────
export const bundleComponentSchema = z
  .object({
    sku: skuSchema,
    quantity: z.number().int().positive().max(999),
    isAddon: z.boolean().default(false),
    sortOrder: z.number().int().nonnegative().max(999).default(0),
  })
  .strict();

/**
 * The composition is replaced as a WHOLE SET, never patched entry by entry. A
 * partial edit would leave the bill of materials in a state no single request
 * described, and every rule that reads it (at least one component, at least one
 * non-add-on, no unit twice) is a property of the set rather than of any entry.
 */
export const setBundleCompositionRequestSchema = z
  .object({
    ...adminFields,
    code: bundleCodeSchema,
    components: z.array(bundleComponentSchema).max(100),
  })
  .strict();

export const setBundleCompositionResponseSchema = z.object({
  ...baseResponseFields,
  code: bundleCodeSchema,
  componentCount: z.number().int().nonnegative(),
});

// ── set target price (append-only) ───────────────────────────────────────────
export const setBundleTargetPriceRequestSchema = z
  .object({
    ...adminFields,
    code: bundleCodeSchema,
    price: z
      .object({
        mode: bundlePriceModeSchema,
        targetPriceMinor: z.number().int().nonnegative(),
        currency: bundleCurrencySchema,
        amountKind: z.enum(["gross", "net"]).default("gross"),
      })
      .strict(),
  })
  .strict();

export const setBundleTargetPriceResponseSchema = z.object({
  ...baseResponseFields,
  code: bundleCodeSchema,
});

export type CreateBundleDraftRequest = z.infer<typeof createBundleDraftRequestSchema>;
export type CreateBundleDraftResponse = z.infer<typeof createBundleDraftResponseSchema>;
export type UpdateBundleDraftRequest = z.infer<typeof updateBundleDraftRequestSchema>;
export type UpdateBundleDraftResponse = z.infer<typeof updateBundleDraftResponseSchema>;
export type BundleComponent = z.infer<typeof bundleComponentSchema>;
export type SetBundleCompositionRequest = z.infer<typeof setBundleCompositionRequestSchema>;
export type SetBundleCompositionResponse = z.infer<typeof setBundleCompositionResponseSchema>;
export type SetBundleTargetPriceRequest = z.infer<typeof setBundleTargetPriceRequestSchema>;
export type SetBundleTargetPriceResponse = z.infer<typeof setBundleTargetPriceResponseSchema>;
