import { z } from "../../lib/validation/zod.js";

import { catalogProductSlugSchema, skuSchema } from "../catalog/contracts.js";

import { COMMERCE_CONTRACT_VERSION } from "./types.js";
import { adminModeFields, idempotencyKeyField } from "../../lib/agent-domain/ruleResult.js";

/**
 * @agent-domain-reference
 * REFERENCE IMPLEMENTATION — the canonical agent-operable domain LIFECYCLE write
 * contracts. Extracted from `adminCatalogContracts.ts` to keep each file ≤300 LOC.
 *
 * Whole-product lifecycle transitions over the catalog write boundary:
 *   archive   — archive a product + all its SKUs (status -> archived). Agent-allowed.
 *   restore   — restore an archived product (+skus) -> draft. Agent-allowed (target
 *               draft makes nothing sellable).
 *   clone     — clone an existing product (any status) into a NEW draft (new slug +
 *               new sku). BFF-orchestrated through `admin_upsert_catalog_draft`; no
 *               new RPC. Agent-allowed.
 *   deactivate — unpublish (active -> draft). HUMAN-ONLY: carries a lifecycle marker
 *               so the MCP generator drops it; reachable only via its BFF route.
 *
 * Each carries the generic `mode` (commit | dry_run) + optional `idempotencyKey`, so
 * the same request can be dry-run validated or replayed safely.
 */

const adminFields = {
  ...adminModeFields,
  ...idempotencyKeyField,
};

const baseResponseFields = {
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  dryRun: z.boolean(),
  idempotent: z.boolean(),
};

// ── archive product (+ all SKUs) ─────────────────────────────────────────────
export const archiveCatalogProductRequestSchema = z
  .object({ ...adminFields, slug: catalogProductSlugSchema })
  .strict();

export const archiveCatalogProductResponseSchema = z.object({
  ...baseResponseFields,
  slug: catalogProductSlugSchema,
});

// ── restore product (archived -> draft) ──────────────────────────────────────
export const restoreCatalogProductRequestSchema = z
  .object({ ...adminFields, slug: catalogProductSlugSchema })
  .strict();

export const restoreCatalogProductResponseSchema = z.object({
  ...baseResponseFields,
  slug: catalogProductSlugSchema,
});

// ── clone draft (source -> NEW draft with new slug + new sku) ─────────────────
export const cloneCatalogDraftRequestSchema = z
  .object({
    ...adminFields,
    sourceSlug: catalogProductSlugSchema,
    slug: catalogProductSlugSchema,
    sku: skuSchema,
  })
  .strict();

export const cloneCatalogDraftResponseSchema = z.object({
  ...baseResponseFields,
  slug: catalogProductSlugSchema,
  productId: z.string().min(1),
});

// ── deactivate (unpublish, active -> draft) — HUMAN-ONLY ──────────────────────
export const deactivateCatalogProductRequestSchema = z
  .object({ ...adminFields, slug: catalogProductSlugSchema })
  .strict();

export const deactivateCatalogProductResponseSchema = z.object({
  ...baseResponseFields,
  slug: catalogProductSlugSchema,
});

export type ArchiveCatalogProductRequest = z.infer<typeof archiveCatalogProductRequestSchema>;
export type ArchiveCatalogProductResponse = z.infer<typeof archiveCatalogProductResponseSchema>;
export type RestoreCatalogProductRequest = z.infer<typeof restoreCatalogProductRequestSchema>;
export type RestoreCatalogProductResponse = z.infer<typeof restoreCatalogProductResponseSchema>;
export type CloneCatalogDraftRequest = z.infer<typeof cloneCatalogDraftRequestSchema>;
export type CloneCatalogDraftResponse = z.infer<typeof cloneCatalogDraftResponseSchema>;
export type DeactivateCatalogProductRequest = z.infer<typeof deactivateCatalogProductRequestSchema>;
export type DeactivateCatalogProductResponse = z.infer<
  typeof deactivateCatalogProductResponseSchema
>;
