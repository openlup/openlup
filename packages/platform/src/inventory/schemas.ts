import { z } from "zod";
import { INVENTORY_CONTRACT_VERSION, inventoryStockLineSchema } from "@openlup/core/inventory";
z.config({ jitless: true });

const inventoryReservationStatusSchema = z.enum([
  "reserved",
  "released",
  "consumed",
  "expired",
]);

const inventoryReservationKindSchema = z.enum([
  "checkout_payment_window",
  "subscription_retry_window",
  "manual_ops",
]);

const uuidSchema = z.guid();

const datetimeSchema = z.string().datetime({ offset: true });

const quantitySchema = z.number().int().nonnegative();

export const adminInventoryStockRequestSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  skuId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  includeZero: z.coerce.boolean().default(false),
}).strict();

export const adminInventoryReservationsRequestSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: inventoryReservationStatusSchema.optional(),
  orderId: uuidSchema.optional(),
}).strict();

export const adminInventoryStockAdjustmentRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  skuId: uuidSchema,
  locationId: uuidSchema,
  lotId: uuidSchema.nullable().optional(),
  quantityDelta: z.number().int(),
  reason: z.string().trim().min(1).max(120),
  note: z.string().trim().max(1000).optional(),
}).strict();

export const adminInventorySubscriptionForecastRequestSchema = z.object({
  horizonDays: z.coerce.number().int().min(1).max(180).default(60),
  protectionDays: z.coerce.number().int().min(1).max(180).default(45),
}).strict().refine((request) => request.protectionDays <= request.horizonDays, {
  message: "protectionDays must be less than or equal to horizonDays",
  path: ["protectionDays"],
});

const inventoryReservationSummarySchema = z.object({
  id: uuidSchema,
  orderId: uuidSchema,
  subscriptionCycleId: uuidSchema.nullable(),
  status: inventoryReservationStatusSchema,
  kind: inventoryReservationKindSchema,
  expiresAt: datetimeSchema.nullable(),
  createdAt: datetimeSchema,
}).strict();

export const inventoryStockListResponseSchema = z.object({
  contractVersion: z.literal(INVENTORY_CONTRACT_VERSION),
  stock: z.array(inventoryStockLineSchema.extend({ availableNow: quantitySchema })),
  totalCount: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
}).strict();

export const inventoryReservationsListResponseSchema = z.object({
  contractVersion: z.literal(INVENTORY_CONTRACT_VERSION),
  reservations: z.array(inventoryReservationSummarySchema),
  totalCount: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
}).strict();

const inventorySubscriptionForecastStockStatusSchema = z.enum(["fresh", "stale", "missing"]);

const inventorySubscriptionForecastSkuSchema = z.object({
  skuId: uuidSchema,
  sku: z.string().trim().min(1),
  providerCurrentForSale: quantitySchema.nullable(),
  providerStockLastSyncedAt: datetimeSchema.nullable(),
  providerStockStaleAfter: datetimeSchema.nullable(),
  stockStatus: inventorySubscriptionForecastStockStatusSchema,
  openHardReservations: quantitySchema,
  safetyStock: quantitySchema,
  sellableNow: quantitySchema,
  activeSubscriptionDemand30: quantitySchema,
  activeSubscriptionDemand45: quantitySchema,
  activeSubscriptionDemand60: quantitySchema,
  plannedSupply: quantitySchema,
  coverageDays: z.number().int().nonnegative().nullable(),
  shortageDate: datetimeSchema.nullable(),
  horizonMissingQty: quantitySchema,
  protectionMissingQty: quantitySchema,
  missingQty: quantitySchema,
  recommendedProductionQty: quantitySchema,
}).strict();

const inventorySubscriptionForecastTotalsSchema = z.object({
  activeSubscriptionCount: quantitySchema,
  excludedSubscriptionCount: quantitySchema,
  missingProviderStockSkuCount: quantitySchema,
  staleProviderStockSkuCount: quantitySchema,
  horizonShortageSkuCount: quantitySchema,
  protectionShortageSkuCount: quantitySchema,
  shortageSkuCount: quantitySchema,
  recommendedProductionQty: quantitySchema,
}).strict();

export function createInventorySubscriptionForecastResponseSchema(providerSchema: z.ZodType<string>) {
return z.object({
  contractVersion: z.literal(INVENTORY_CONTRACT_VERSION),
  generatedAt: datetimeSchema,
  stockMasterProvider: providerSchema,
  horizonDays: z.number().int().min(1),
  protectionDays: z.number().int().min(1),
  skus: z.array(inventorySubscriptionForecastSkuSchema),
  totals: inventorySubscriptionForecastTotalsSchema,
}).strict();
}
