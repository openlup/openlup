import { z } from "../../lib/validation/zod.js";

import {
  catalogAllergenSlugSchema,
  catalogProductSlugSchema,
  catalogSpeciesSchema,
  skuSchema,
} from "../catalog/contracts.js";
import { paginationFields } from "../../lib/agent-domain/ruleResult.js";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";

/**
 * @agent-domain-reference
 * REFERENCE IMPLEMENTATION — the canonical agent-operable domain READ contracts.
 *
 * Admin/agent catalog READ contracts — the single source of truth the BFF
 * validates `req.query` against and the MCP read tool schemas are derived from.
 * Reads are draft-and-archived-inclusive admin views (service-role bypasses RLS),
 * so they expose the full lifecycle the storefront read port hides. Every read is
 * paginated (`...paginationFields`) and carries no `mode`/idempotency — a read is
 * a pure load. New domains derive their read contracts by spreading the same
 * generic `paginationFields` (see `mcp/PLAYBOOK.md`).
 */

const responseVersionField = {
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
} as const;

// ── list ─────────────────────────────────────────────────────────────────────
export const listCatalogProductsRequestSchema = z
  .object({
    status: z.enum(["draft", "active", "archived", "all"]).default("all"),
    species: catalogSpeciesSchema.optional(),
    petType: z.enum(["dog", "cat", "other"]).optional(),
    query: z.string().trim().min(1).max(80).optional(),
    ...paginationFields,
  })
  .strict();

export const catalogProductSummarySchema = z.object({
  slug: catalogProductSlugSchema,
  name: z.string(),
  status: z.string(),
  species: z.string().nullable(),
  skuCount: z.number().int().nonnegative(),
  hasActivePrice: z.boolean(),
});

export const listCatalogProductsResponseSchema = z.object({
  ...responseVersionField,
  products: z.array(catalogProductSummarySchema),
  total: z.number().int().nonnegative(),
});

// ── get (full admin detail) ────────────────────────────────────────────────
export const getCatalogProductRequestSchema = z
  .object({ slug: catalogProductSlugSchema })
  .strict();

export const catalogPriceEntrySchema = z.object({
  mode: z.string(),
  unitPriceMinor: z.number().int().nonnegative(),
  currency: z.string().nullable(),
  active: z.boolean(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
});

export const catalogSkuDetailSchema = z.object({
  sku: z.string(),
  status: z.string(),
  petType: z.string().nullable(),
  title: z.string().nullable(),
  netWeightGrams: z.number().int().nullable(),
  formatCode: z.string().nullable(),
  unitFormCode: z.string().nullable(),
  kcalPerUnit: z.number().nullable(),
  gtin: z.string().nullable(),
  priceEntries: z.array(catalogPriceEntrySchema),
});

export const catalogProductDetailSchema = z.object({
  slug: catalogProductSlugSchema,
  name: z.string(),
  status: z.string(),
  species: z.string().nullable(),
  allergens: z.array(catalogAllergenSlugSchema),
  marketingContent: z.record(z.string(), z.unknown()).nullable(),
  skus: z.array(catalogSkuDetailSchema),
  readyToPublish: z.boolean(),
  publishBlockers: z.array(z.string()),
});

export const getCatalogProductResponseSchema = z.object({
  ...responseVersionField,
  product: catalogProductDetailSchema,
});

// ── history (audit trail) ────────────────────────────────────────────────────
export const catalogHistoryRequestSchema = z
  .object({ slug: catalogProductSlugSchema, ...paginationFields })
  .strict();

export const catalogHistoryEventSchema = z.object({
  id: z.string(),
  action: z.string(),
  actorKind: z.string().nullable(),
  actorEmail: z.string().nullable(),
  source: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  oldValue: z.unknown().nullable(),
  newValue: z.unknown().nullable(),
  occurredAt: z.string(),
});

export const catalogHistoryResponseSchema = z.object({
  ...responseVersionField,
  events: z.array(catalogHistoryEventSchema),
  total: z.number().int().nonnegative(),
});

export type ListCatalogProductsRequest = z.infer<typeof listCatalogProductsRequestSchema>;
export type ListCatalogProductsResponse = z.infer<typeof listCatalogProductsResponseSchema>;
export type CatalogProductSummary = z.infer<typeof catalogProductSummarySchema>;
export type GetCatalogProductRequest = z.infer<typeof getCatalogProductRequestSchema>;
export type GetCatalogProductResponse = z.infer<typeof getCatalogProductResponseSchema>;
export type CatalogProductDetail = z.infer<typeof catalogProductDetailSchema>;
export type CatalogSkuDetail = z.infer<typeof catalogSkuDetailSchema>;
export type CatalogPriceEntry = z.infer<typeof catalogPriceEntrySchema>;
export type CatalogHistoryRequest = z.infer<typeof catalogHistoryRequestSchema>;
export type CatalogHistoryResponse = z.infer<typeof catalogHistoryResponseSchema>;
export type CatalogHistoryEvent = z.infer<typeof catalogHistoryEventSchema>;

// ── data port (server-side, lives here so server type-only files aren't needed) ──
/**
 * @agent-domain-reference
 * REFERENCE IMPLEMENTATION — the canonical agent-operable domain READ data port.
 *
 * Server-side READ access for the admin/agent catalog. Unlike the write port (one
 * SECURITY DEFINER RPC per op), reads are plain service-role SELECTs — the
 * service role bypasses RLS, exposing draft/archived rows the storefront read port
 * (the managed `catalogRead` adapter, active-only) deliberately hides. The port never
 * mutates and never re-implements rules.
 *
 * Note: The port `get()` throws `CatalogRpcError` from `adminCatalogDataPort.js`;
 * that runtime import stays in the adapter (supabaseAdminCatalogReadDataPort.ts),
 * keeping this file free of server runtime dependencies.
 */
export interface ListCatalogProductsResult {
  products: CatalogProductSummary[];
  total: number;
}

export interface CatalogHistoryResult {
  events: CatalogHistoryEvent[];
  total: number;
}

export interface AdminCatalogReadDataPort {
  list(input: ListCatalogProductsRequest): Promise<ListCatalogProductsResult>;
  /** Throws a NOT_FOUND `CatalogRpcError` (P0002 `catalog_product_not_found`) when missing. */
  get(slug: string): Promise<CatalogProductDetail>;
  history(input: CatalogHistoryRequest): Promise<CatalogHistoryResult>;
}
