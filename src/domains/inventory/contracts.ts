import { z } from "../../lib/validation/zod.js";
import { INVENTORY_CONTRACT_VERSION, inventoryStockLineSchema } from "@openlup/core/inventory";
export {
  INVENTORY_CONTRACT_VERSION,
  inventoryLocationKindSchema,
  inventoryLocationStatusSchema,
  inventoryLotStatusSchema,
  inventoryAtpStatusSchema,
  inventoryStockLineSchema,
  inventoryAtpRequestLineSchema,
  inventoryAtpRequestSchema,
  inventoryAllocationSchema,
  inventoryAtpLineResultSchema,
  inventoryAtpResultSchema,
} from "@openlup/core/inventory";
export type { InventoryAtpRequest, InventoryAtpResult, InventoryStockLine } from "@openlup/core/inventory";

export const inventoryReservationStatusSchema = z.enum([
  "reserved",
  "released",
  "consumed",
  "expired",
]);
export const inventoryReservationKindSchema = z.enum([
  "checkout_payment_window",
  "subscription_retry_window",
  "manual_ops",
]);
export const inventoryMovementTypeSchema = z.enum([
  "receipt",
  "adjustment",
  "reservation_created",
  "reservation_released",
  "reservation_consumed",
  "quarantine",
  "release_quarantine",
  "return",
  "incoming_received",
]);

const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true });
const quantitySchema = z.number().int().nonnegative();
const positiveQuantitySchema = z.number().int().positive();

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

export const inventoryReservationSummarySchema = z.object({
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

export const inventoryStockAdjustmentResponseSchema = z.object({
  contractVersion: z.literal(INVENTORY_CONTRACT_VERSION),
  replayed: z.boolean(),
}).strict();

export const inventorySubscriptionForecastStockStatusSchema = z.enum(["fresh", "stale", "missing"]);

export const inventorySubscriptionForecastSkuSchema = z.object({
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

export const inventorySubscriptionForecastTotalsSchema = z.object({
  activeSubscriptionCount: quantitySchema,
  excludedSubscriptionCount: quantitySchema,
  missingProviderStockSkuCount: quantitySchema,
  staleProviderStockSkuCount: quantitySchema,
  horizonShortageSkuCount: quantitySchema,
  protectionShortageSkuCount: quantitySchema,
  shortageSkuCount: quantitySchema,
  recommendedProductionQty: quantitySchema,
}).strict();

export const inventorySubscriptionForecastResponseSchema = z.object({
  contractVersion: z.literal(INVENTORY_CONTRACT_VERSION),
  generatedAt: datetimeSchema,
  stockMasterProvider: z.literal("omnipack"),
  horizonDays: z.number().int().min(1),
  protectionDays: z.number().int().min(1),
  skus: z.array(inventorySubscriptionForecastSkuSchema),
  totals: inventorySubscriptionForecastTotalsSchema,
}).strict();

export const inventoryForecastDemandLineSchema = z.object({
  subscriptionId: uuidSchema,
  subscriptionCycleId: uuidSchema.nullable(),
  skuId: uuidSchema,
  sku: z.string().trim().min(1),
  quantity: positiveQuantitySchema,
  dueAt: datetimeSchema,
  status: z.enum(["planned", "payment_pending", "paid", "retry_scheduled", "skipped", "cancelled"]),
}).strict();

export const inventoryForecastSupplyLineSchema = z.object({
  skuId: uuidSchema,
  quantity: positiveQuantitySchema,
  expectedAt: datetimeSchema,
  status: z.enum(["planned", "received", "cancelled"]),
}).strict();

export const inventoryForecastShortageSchema = z.object({
  skuId: uuidSchema,
  sku: z.string().trim().min(1),
  dueAt: datetimeSchema,
  demandQuantity: positiveQuantitySchema,
  availableOrExpectedQuantity: quantitySchema,
  missingQuantity: positiveQuantitySchema,
}).strict();

export const inventoryForecastResponseSchema = z.object({
  contractVersion: z.literal(INVENTORY_CONTRACT_VERSION),
  shortages: z.array(inventoryForecastShortageSchema),
}).strict();

export type InventoryReservationStatus = z.infer<typeof inventoryReservationStatusSchema>;
export type AdminInventoryStockRequest = z.infer<typeof adminInventoryStockRequestSchema>;
export type AdminInventoryReservationsRequest = z.infer<typeof adminInventoryReservationsRequestSchema>;
export type AdminInventoryStockAdjustmentRequest = z.infer<typeof adminInventoryStockAdjustmentRequestSchema>;
export type AdminInventorySubscriptionForecastRequest = z.infer<
  typeof adminInventorySubscriptionForecastRequestSchema
>;
export type InventoryStockListResponse = z.infer<typeof inventoryStockListResponseSchema>;
export type InventoryReservationsListResponse = z.infer<typeof inventoryReservationsListResponseSchema>;
export type InventoryStockAdjustmentResponse = z.infer<typeof inventoryStockAdjustmentResponseSchema>;
export type InventorySubscriptionForecastResponse = z.infer<typeof inventorySubscriptionForecastResponseSchema>;
export type InventorySubscriptionForecastSku = z.infer<typeof inventorySubscriptionForecastSkuSchema>;
export type InventoryForecastDemandLine = z.infer<typeof inventoryForecastDemandLineSchema>;
export type InventoryForecastSupplyLine = z.infer<typeof inventoryForecastSupplyLineSchema>;
export type InventoryForecastResponse = z.infer<typeof inventoryForecastResponseSchema>;
