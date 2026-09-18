import { z } from "../../lib/validation/zod.js";

import {
  catalogAllergenSlugSchema,
  catalogCurrencySchema,
  catalogPackagingUnitSchema,
  catalogProductSlugSchema,
  catalogSpeciesSchema,
  skuSchema,
} from "../catalog/contracts.js";

import { COMMERCE_CONTRACT_VERSION } from "./types.js";
import { adminModeFields, idempotencyKeyField } from "../../lib/agent-domain/ruleResult.js";

/**
 * @agent-domain-reference
 * REFERENCE IMPLEMENTATION — the canonical agent-operable domain write contracts.
 * New domains derive their request contracts by spreading the same generic
 * `adminModeFields` + `idempotencyKeyField` (see `mcp/PLAYBOOK.md`, Wave 5).
 *
 * Admin/agent catalog WRITE contracts — the single source of truth that
 * the BFF validates against and the MCP tool schemas will be derived from
 * (Wave 5). ADD is structural/sellable params only (name, SKU, weight, kcal,
 * allergens, species); marketing prose/images stay code/static by slug. Writes
 * are draft-only for agents; activation is a separate, human-gated op.
 *
 * Every mutation carries `mode` (commit | dry_run) and an optional
 * `idempotencyKey`, so the same request can be validated (dry-run) or replayed
 * safely. The RPC short-circuits a replayed key and rolls back a dry-run.
 */

/** Re-exported from the generic kit for back-compat; the canonical mode field. */
export const catalogWriteModeSchema = adminModeFields.mode;

const adminFields = {
  ...adminModeFields,
  ...idempotencyKeyField,
};

const baseResponseFields = {
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  dryRun: z.boolean(),
  idempotent: z.boolean(),
};

// ── create draft product ────────────────────────────────────────────────────
export const createCatalogDraftPayloadSchema = z
  .object({
    slug: catalogProductSlugSchema,
    name: z.string().trim().min(1).max(120),
    species: catalogSpeciesSchema,
    unit: catalogPackagingUnitSchema,
    sku: skuSchema,
    netWeightGrams: z.number().int().positive(),
    kcalPerUnit: z.number().int().positive(),
    allergens: z.array(catalogAllergenSlugSchema).max(20).default([]),
  })
  .strict();

export const createCatalogDraftRequestSchema = z
  .object({ ...adminFields, product: createCatalogDraftPayloadSchema })
  .strict();

export const createCatalogDraftResponseSchema = z.object({
  ...baseResponseFields,
  slug: catalogProductSlugSchema,
  productId: z.string().min(1),
});

// ── update draft product (structural fields only) ────────────────────────────
export const updateCatalogDraftPayloadSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    netWeightGrams: z.number().int().positive().optional(),
    kcalPerUnit: z.number().int().positive().optional(),
    allergens: z.array(catalogAllergenSlugSchema).max(20).optional(),
  })
  .strict()
  .refine((u) => Object.values(u).some((v) => v !== undefined), {
    message: "At least one field is required",
  });

export const updateCatalogDraftRequestSchema = z
  .object({ ...adminFields, slug: catalogProductSlugSchema, updates: updateCatalogDraftPayloadSchema })
  .strict();

export const updateCatalogDraftResponseSchema = z.object({
  ...baseResponseFields,
  slug: catalogProductSlugSchema,
});

// ── set price (append-only) ──────────────────────────────────────────────────
export const setCatalogPriceRequestSchema = z
  .object({
    ...adminFields,
    sku: skuSchema,
    price: z
      .object({
        mode: z.enum(["one_time", "subscription"]),
        unitPriceMinor: z.number().int().nonnegative(),
        currency: catalogCurrencySchema,
      })
      .strict(),
  })
  .strict();

export const setCatalogPriceResponseSchema = z.object({
  ...baseResponseFields,
  sku: skuSchema,
});

// ── archive (never hard-delete) ──────────────────────────────────────────────
export const archiveCatalogSkuRequestSchema = z
  .object({ ...adminFields, sku: skuSchema })
  .strict();

export const archiveCatalogSkuResponseSchema = z.object({
  ...baseResponseFields,
  sku: skuSchema,
});

// ── activate (separate, human-gated) ─────────────────────────────────────────
export const activateCatalogProductRequestSchema = z
  .object({ ...adminFields, slug: catalogProductSlugSchema })
  .strict();

export const activateCatalogProductResponseSchema = z.object({
  ...baseResponseFields,
  slug: catalogProductSlugSchema,
});

export type CreateCatalogDraftRequest = z.infer<typeof createCatalogDraftRequestSchema>;
export type CreateCatalogDraftResponse = z.infer<typeof createCatalogDraftResponseSchema>;
export type UpdateCatalogDraftRequest = z.infer<typeof updateCatalogDraftRequestSchema>;
export type UpdateCatalogDraftResponse = z.infer<typeof updateCatalogDraftResponseSchema>;
export type SetCatalogPriceRequest = z.infer<typeof setCatalogPriceRequestSchema>;
export type SetCatalogPriceResponse = z.infer<typeof setCatalogPriceResponseSchema>;
export type ArchiveCatalogSkuRequest = z.infer<typeof archiveCatalogSkuRequestSchema>;
export type ArchiveCatalogSkuResponse = z.infer<typeof archiveCatalogSkuResponseSchema>;
export type ActivateCatalogProductRequest = z.infer<typeof activateCatalogProductRequestSchema>;
export type ActivateCatalogProductResponse = z.infer<typeof activateCatalogProductResponseSchema>;
