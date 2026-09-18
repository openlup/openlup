import { skuSchema } from "@openlup/core/catalog";

import { z } from "../../lib/validation/zod.js";
import { paginationFields } from "../../lib/agent-domain/ruleResult.js";
import { COMMERCE_CONTRACT_VERSION } from "../commerce/types.js";
import { bundleCodeSchema, bundleCurrencySchema, bundlePriceModeSchema } from "./adminBundleContracts.js";

/**
 * Admin/agent bundle READ contracts — the single source of truth the BFF validates
 * `req.query` against and the MCP read tool schemas are derived from.
 *
 * Reads are lifecycle-inclusive admin views: a draft and an archived bundle are
 * both visible here, which is exactly what the public sellable feed
 * (`sellableBundleContracts.ts`) must never show. Every read is paginated through
 * the shared generic `paginationFields` and carries no `mode`/idempotency — a read
 * is a pure load.
 *
 * The currency regex is NOT restated here: `bundleCurrencySchema` from the write
 * contracts is the one statement of what an ISO 4217 alphabetic code is, and both
 * halves of the domain refer to it.
 */

const responseVersionField = {
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
} as const;

// ── list ─────────────────────────────────────────────────────────────────────
export const listBundlesRequestSchema = z
  .object({
    status: z.enum(["draft", "active", "archived", "all"]).default("all"),
    query: z.string().trim().min(1).max(80).optional(),
    ...paginationFields,
  })
  .strict();

export const bundleSummarySchema = z.object({
  code: bundleCodeSchema,
  title: z.string(),
  status: z.string(),
  fulfillmentMode: z.string(),
  componentCount: z.number().int().nonnegative(),
  hasActiveTargetPrice: z.boolean(),
  updatedAt: z.string(),
});

export const listBundlesResponseSchema = z.object({
  ...responseVersionField,
  bundles: z.array(bundleSummarySchema),
  total: z.number().int().nonnegative(),
});

// ── get (full admin detail) ──────────────────────────────────────────────────
export const getBundleRequestSchema = z
  .object({
    code: bundleCodeSchema,
    /** Price the components against this currency instead of the bundle's own list. */
    currency: bundleCurrencySchema.optional(),
    mode: bundlePriceModeSchema.optional(),
  })
  .strict();

export const bundleComponentDetailSchema = z.object({
  sku: skuSchema,
  title: z.string().nullable(),
  productSlug: z.string(),
  quantity: z.number().int().positive(),
  isAddon: z.boolean(),
  sortOrder: z.number().int().nonnegative(),
  referenceUnitPriceMinor: z.number().int().nonnegative().nullable(),
});

export const bundleTargetPriceSchema = z.object({
  mode: z.string(),
  targetPriceMinor: z.number().int().nonnegative(),
  currency: z.string(),
  amountKind: z.string(),
  active: z.boolean(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
});

/**
 * Derived stock, on the DETAIL response.
 *
 * Until now the only contract carrying availability was the public sellable feed, which is
 * live-only by construction — so an operator looking at a draft, or at an archived bundle they
 * were about to revive, was told nothing at all. This block is additive and NULLABLE, and the null
 * is load-bearing: it means "this deployment did not compute stock", which is a different fact
 * from every component being unknown, and neither may be rendered as zero.
 *
 * `components` is the per-unit breakdown the feed cannot carry. `sellableNow: null` on a component
 * is UNKNOWN; the kernel fails the whole bundle to unknown when any counted one is missing.
 */
export const bundleAvailabilityComponentSchema = z.object({
  sku: skuSchema,
  quantity: z.number().int().positive(),
  isAddon: z.boolean(),
  sellableNow: z.number().int().nonnegative().nullable(),
});

export const bundleAvailabilityViewSchema = z.object({
  sellableNow: z.number().int().nonnegative().nullable(),
  status: z.string(),
  reasonCode: z.string(),
  limitingSku: z.string().nullable(),
  components: z.array(bundleAvailabilityComponentSchema),
});

export const bundleDetailSchema = bundleSummarySchema.extend({
  compositionConstraint: z
    .object({
      kind: z.string(),
      version: z.number().int().nonnegative(),
      data: z.record(z.string(), z.unknown()),
    })
    .nullable(),
  metadata: z.record(z.string(), z.unknown()),
  components: z.array(bundleComponentDetailSchema),
  prices: z.array(bundleTargetPriceSchema),
  resolvedCurrency: z.string().nullable(),
  availability: bundleAvailabilityViewSchema.nullable(),
});

export const getBundleResponseSchema = z.object({
  ...responseVersionField,
  bundle: bundleDetailSchema,
});

// ── history (operator trail) ─────────────────────────────────────────────────
export const bundleHistoryRequestSchema = z
  .object({ code: bundleCodeSchema, ...paginationFields })
  .strict();

export const bundleHistoryEventSchema = z.object({
  id: z.string(),
  action: z.string(),
  actorKind: z.string().nullable(),
  actorEmail: z.string().nullable(),
  entityId: z.string().nullable(),
  oldValue: z.unknown().nullable(),
  newValue: z.unknown().nullable(),
  occurredAt: z.string(),
});

export const bundleHistoryResponseSchema = z.object({
  ...responseVersionField,
  events: z.array(bundleHistoryEventSchema),
  total: z.number().int().nonnegative(),
});

// ── preview price (pure allocation over live component prices) ───────────────
/**
 * A dry run of the money, without the write path. The operator may preview the
 * price already stored (omit `targetPriceMinor`) or one they are considering; the
 * answer is the pricing kernel's own allocation over TODAY's component prices, so
 * it moves when the catalogue moves rather than when the bundle was last saved.
 */
export const previewBundlePriceRequestSchema = z
  .object({
    code: bundleCodeSchema,
    currency: bundleCurrencySchema.optional(),
    mode: bundlePriceModeSchema.optional(),
    targetPriceMinor: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

export const bundleComponentTargetSchema = z.object({
  sku: skuSchema,
  quantity: z.number().int().positive(),
  referenceUnitPriceMinor: z.number().int().nonnegative(),
  referenceSubtotalMinor: z.number().int().nonnegative(),
  targetSubtotalMinor: z.number().int().nonnegative(),
  discountAllocatedMinor: z.number().int(),
  discountBps: z.number().int(),
  hasSplitPricing: z.boolean(),
});

export const bundleAllocatedLineSchema = z.object({
  sku: skuSchema,
  quantity: z.number().int().positive(),
  effectiveUnitPriceMinor: z.number().int().nonnegative(),
  lineSubtotalMinor: z.number().int().nonnegative(),
});

export const bundlePricePreviewSchema = z.object({
  bundleCode: bundleCodeSchema,
  priceListId: z.string().min(1),
  mode: z.string(),
  currency: bundleCurrencySchema,
  referenceTotalMinor: z.number().int().nonnegative(),
  targetPriceMinor: z.number().int().nonnegative(),
  discountTotalMinor: z.number().int(),
  discountBps: z.number().int(),
  floorApplied: z.boolean(),
  componentTargets: z.array(bundleComponentTargetSchema),
  allocatedLines: z.array(bundleAllocatedLineSchema),
});

export const previewBundlePriceResponseSchema = z.object({
  ...responseVersionField,
  preview: bundlePricePreviewSchema,
});

export type ListBundlesRequest = z.infer<typeof listBundlesRequestSchema>;
export type ListBundlesResponse = z.infer<typeof listBundlesResponseSchema>;
export type BundleSummaryView = z.infer<typeof bundleSummarySchema>;
export type GetBundleRequest = z.infer<typeof getBundleRequestSchema>;
export type GetBundleResponse = z.infer<typeof getBundleResponseSchema>;
export type BundleDetailView = z.infer<typeof bundleDetailSchema>;
export type BundleAvailabilityView = z.infer<typeof bundleAvailabilityViewSchema>;
export type BundleHistoryRequest = z.infer<typeof bundleHistoryRequestSchema>;
export type BundleHistoryResponse = z.infer<typeof bundleHistoryResponseSchema>;
export type PreviewBundlePriceRequest = z.infer<typeof previewBundlePriceRequestSchema>;
export type PreviewBundlePriceResponse = z.infer<typeof previewBundlePriceResponseSchema>;
export type BundlePricePreview = z.infer<typeof bundlePricePreviewSchema>;
