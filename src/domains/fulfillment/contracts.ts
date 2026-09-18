import { z } from "../../lib/validation/zod.js";
import { FULFILLMENT_PROVIDER } from "./types.js";

// Public re-export of the provider notification-ownership policy (W6/W8) so
// consumers in other domains (e.g. the commerce delivered-email handler) read it
// through this public contract segment instead of importing provider internals.
export { providerOwnsDeliveredNotification } from "./providerCapabilities.js";
export * from "./omnipackOperationalProofContracts.js";

const dateTimeStringSchema = z.string().datetime({ offset: true });

export const fulfillmentDisplayStatusSchema = z.enum([
  "shipped",
  "in_transit",
  "delivered",
]);

export const shipmentStatusReadRequestSchema = z
  .object({
    shipmentId: z.string().trim().min(1).optional(),
    trackingNumber: z.string().trim().min(1).optional(),
  })
  .refine((value) => value.shipmentId || value.trackingNumber, {
    message: "shipmentId or trackingNumber is required",
  });

export const shipmentStatusReadResponseSchema = z.object({
  shipment: z.object({
    id: z.string().min(1),
    provider: z.literal(FULFILLMENT_PROVIDER),
    status: fulfillmentDisplayStatusSchema,
    trackingNumber: z.string().min(1).nullable(),
    trackingUrl: z.string().url().nullable(),
    statusUpdatedAt: dateTimeStringSchema.nullable(),
    deliveredAt: dateTimeStringSchema.nullable(),
  }),
});

export const cleanupDhlShipmentRequestSchema = z.object({
  trackingNumber: z.string().trim().min(1),
});

export const cleanupDhlShipmentResponseSchema = z.object({
  dhlDeleted: z.boolean(),
  dhlError: z.string().nullable(),
  labelDeleted: z.boolean(),
  canProceed: z.literal(true),
});

export const clearDhlShipmentStateRequestSchema = z.object({
  testerId: z.string().trim().min(1),
});

export const clearDhlShipmentStateResponseSchema = z.object({
  testerId: z.string().min(1),
  cleared: z.literal(true),
});

export const createDhlShipmentRequestSchema = z.object({
  testerId: z.string().trim().min(1),
  skipStatusChange: z.boolean().default(true),
});

export const createDhlShipmentResponseSchema = z.object({
  trackingNumber: z.string().min(1),
  trackingUrl: z.string().min(1).nullable(),
  labelUrl: z.string().min(1).nullable(),
  dhlShipmentId: z.string().min(1).nullable(),
  dhlShipmentDate: z.string().min(1).nullable(),
});

export const getDhlLabelRequestSchema = z.object({
  testerId: z.string().trim().min(1),
});

export const getDhlLabelResponseSchema = z.object({
  labelUrl: z.string().min(1),
});

export const mergeDhlLabelsRequestSchema = z.object({
  testerIds: z.array(z.string().trim().min(1)).min(1),
});

export const mergeDhlLabelsResponseSchema = z.object({
  pdfBase64: z.string().min(1),
  labelCount: z.number().int().nonnegative(),
});

export const bookDhlCourierRequestSchema = z.object({
  pickupDate: z.string().trim().min(1),
  pickupTimeFrom: z.string().trim().min(1),
  pickupTimeTo: z.string().trim().min(1),
  additionalInfo: z.string().trim().min(1).optional(),
  testerIds: z.array(z.string().trim().min(1)).min(1),
});

export const bookDhlCourierResponseSchema = z.object({
  pickupDate: z.string().min(1),
  pickupTime: z.string().min(1),
  shipmentsCount: z.number().int().nonnegative(),
  courierOrderId: z.string().min(1).nullable(),
});

export const repairDhlCourierPickupRequestSchema = z.object({
  pickupId: z.string().trim().uuid(),
  mode: z.enum(["dry_run", "commit"]),
  sendEmails: z.boolean().default(true),
  expectedCourierOrderId: z.string().trim().min(1),
  expectedShipmentCount: z.number().int().positive(),
});

export const repairDhlCourierPickupTesterStatusSchema = z.object({
  testerId: z.string().min(1),
  trackingNumber: z.string().min(1).nullable(),
  dhlShipmentId: z.string().min(1).nullable(),
  status: z.string().min(1).nullable(),
  emailStatus: z.string().min(1).nullable(),
  emailAlreadySent: z.boolean(),
  willRequestEmail: z.boolean(),
});

export const repairDhlCourierPickupResponseSchema = z.object({
  mode: z.enum(["dry_run", "commit"]),
  pickupId: z.guid(),
  pickupStatus: z.string().min(1),
  courierOrderId: z.string().min(1),
  recordedShipmentsCount: z.number().int().nonnegative(),
  linkedShipmentsCount: z.number().int().nonnegative(),
  expectedShipmentsCount: z.number().int().positive(),
  canCommit: z.boolean(),
  committed: z.boolean(),
  alreadyRepaired: z.boolean(),
  testerStatuses: z.array(repairDhlCourierPickupTesterStatusSchema),
  emailDedupPreview: z.object({
    sendEmails: z.boolean(),
    alreadySentCount: z.number().int().nonnegative(),
    requestCount: z.number().int().nonnegative(),
  }),
});

export const adminShipmentsFilterSchema = z.enum(["today", "7d", "30d", "all"]);

const nullableTrimmedStringSchema = z
  .string()
  .trim()
  .transform((value) => (value.length > 0 ? value : null))
  .nullable();

export const adminShipmentsOverviewRequestSchema = z.object({
  shippedFilter: adminShipmentsFilterSchema.default("7d"),
});

export const adminShipmentsApprovedTesterSchema = z.object({
  id: z.string().min(1),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  city: nullableTrimmedStringSchema,
  postal_code: nullableTrimmedStringSchema,
  dog_weight_kg: z.number().nullable(),
  cat_weight_kg: z.number().nullable(),
  pet_type: z.string().nullable(),
});

export const adminShipmentsPackingTesterSchema = z.object({
  id: z.string().min(1),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: nullableTrimmedStringSchema,
  phone: nullableTrimmedStringSchema,
  street: nullableTrimmedStringSchema,
  city: nullableTrimmedStringSchema,
  postal_code: nullableTrimmedStringSchema,
  tracking_number: nullableTrimmedStringSchema,
  label_url: nullableTrimmedStringSchema,
  dhl_shipment_id: nullableTrimmedStringSchema,
  dhl_shipment_date: nullableTrimmedStringSchema,
});

export const adminShipmentsShippedTesterSchema = z.object({
  id: z.string().min(1),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  city: nullableTrimmedStringSchema,
  status: z.string().min(1),
  status_updated_at: z.string().nullable(),
  delivered_at: z.string().nullable(),
  tracking_number: nullableTrimmedStringSchema,
  tracking_url: nullableTrimmedStringSchema,
});

export const adminShipmentsOverviewResponseSchema = z.object({
  approved: z.array(adminShipmentsApprovedTesterSchema),
  packing: z.array(adminShipmentsPackingTesterSchema),
  shippedToday: z.number().int().nonnegative(),
  shipped: z.array(adminShipmentsShippedTesterSchema),
});

// Admin shortage-UX read surface over omnipack_low_stock_evidence (W7b). Read-only,
// provider-neutral evidence: the OmniPack stock-sync worker (W7a) opens/resolves
// safety_stock / provider_mismatch / stale_sync rows; this endpoint lists them for an
// operator. Stock stays EVIDENCE/warn — this never blocks sales.
export const adminLowStockEvidenceStatusFilterSchema = z.enum([
  "open",
  "acknowledged",
  "resolved",
  "all",
]);

export const adminLowStockEvidenceThresholdKindSchema = z.enum([
  "safety_stock",
  "forecast",
  "provider_mismatch",
  "stale_sync",
  "manual",
]);

export const adminLowStockEvidenceSeveritySchema = z.enum(["info", "warning", "critical"]);
export const adminLowStockEvidenceStatusSchema = z.enum(["open", "acknowledged", "resolved"]);

export const adminLowStockEvidenceRequestSchema = z.object({
  statusFilter: adminLowStockEvidenceStatusFilterSchema.default("open"),
});

export const adminLowStockEvidenceItemSchema = z.object({
  id: z.string().min(1),
  sku: z.string().min(1),
  thresholdKind: adminLowStockEvidenceThresholdKindSchema,
  severity: adminLowStockEvidenceSeveritySchema,
  status: adminLowStockEvidenceStatusSchema,
  providerForSaleQuantity: z.number().int().nonnegative().nullable(),
  localAvailableQuantity: z.number().int().nonnegative().nullable(),
  forecastDays: z.number().int().nonnegative().nullable(),
  firstSeenAt: z.string().datetime({ offset: true }).nullable(),
  lastSeenAt: z.string().datetime({ offset: true }).nullable(),
  resolvedAt: z.string().datetime({ offset: true }).nullable(),
});

export const adminLowStockEvidenceResponseSchema = z.object({
  statusFilter: adminLowStockEvidenceStatusFilterSchema,
  openCount: z.number().int().nonnegative(),
  items: z.array(adminLowStockEvidenceItemSchema),
});

// Admin read over omnipack_product_reconciliation_evidence (Wave F). The open/acknowledged/
// resolved status lifecycle is shared with the low-stock evidence read.
export const adminProductReconciliationStatusFilterSchema = adminLowStockEvidenceStatusFilterSchema;
export const adminProductReconciliationStatusSchema = adminLowStockEvidenceStatusSchema;
export const adminProductReconciliationConflictKindSchema = z.enum(["unknown_sku", "ean_conflict", "kind_quantity_conflict"]);

export const adminProductReconciliationRequestSchema = z.object({
  statusFilter: adminProductReconciliationStatusFilterSchema.default("open"),
});

export const adminProductReconciliationItemSchema = z.object({
  id: z.string().min(1),
  sku: z.string().min(1),
  ean: z.string().min(1).nullable(),
  conflictKind: adminProductReconciliationConflictKindSchema,
  providerQuantity: z.number().int().nonnegative().nullable(),
  status: adminProductReconciliationStatusSchema,
  firstSeenAt: z.string().datetime({ offset: true }).nullable(),
  lastSeenAt: z.string().datetime({ offset: true }).nullable(),
  resolvedAt: z.string().datetime({ offset: true }).nullable(),
});

export const adminProductReconciliationResponseSchema = z.object({
  statusFilter: adminProductReconciliationStatusFilterSchema,
  openCount: z.number().int().nonnegative(),
  items: z.array(adminProductReconciliationItemSchema),
});

export type ShipmentStatusReadRequest = z.infer<typeof shipmentStatusReadRequestSchema>;
export type ShipmentStatusReadResponse = z.infer<typeof shipmentStatusReadResponseSchema>;
export type CleanupDhlShipmentRequest = z.infer<typeof cleanupDhlShipmentRequestSchema>;
export type CleanupDhlShipmentResponse = z.infer<typeof cleanupDhlShipmentResponseSchema>;
export type ClearDhlShipmentStateRequest = z.infer<typeof clearDhlShipmentStateRequestSchema>;
export type ClearDhlShipmentStateResponse = z.infer<typeof clearDhlShipmentStateResponseSchema>;
export type CreateDhlShipmentRequest = z.input<typeof createDhlShipmentRequestSchema>;
export type CreateDhlShipmentResponse = z.infer<typeof createDhlShipmentResponseSchema>;
export type GetDhlLabelRequest = z.infer<typeof getDhlLabelRequestSchema>;
export type GetDhlLabelResponse = z.infer<typeof getDhlLabelResponseSchema>;
export type MergeDhlLabelsRequest = z.infer<typeof mergeDhlLabelsRequestSchema>;
export type MergeDhlLabelsResponse = z.infer<typeof mergeDhlLabelsResponseSchema>;
export type BookDhlCourierRequest = z.infer<typeof bookDhlCourierRequestSchema>;
export type BookDhlCourierResponse = z.infer<typeof bookDhlCourierResponseSchema>;
export type RepairDhlCourierPickupRequest = z.infer<typeof repairDhlCourierPickupRequestSchema>;
export type RepairDhlCourierPickupResponse = z.infer<typeof repairDhlCourierPickupResponseSchema>;
export type AdminShipmentsFilter = z.infer<typeof adminShipmentsFilterSchema>;
export type AdminShipmentsOverviewRequest = z.infer<typeof adminShipmentsOverviewRequestSchema>;
export type AdminShipmentsOverviewResponse = z.infer<typeof adminShipmentsOverviewResponseSchema>;
export type AdminLowStockEvidenceStatusFilter = z.infer<typeof adminLowStockEvidenceStatusFilterSchema>;
export type AdminLowStockEvidenceRequest = z.infer<typeof adminLowStockEvidenceRequestSchema>;
export type AdminLowStockEvidenceItem = z.infer<typeof adminLowStockEvidenceItemSchema>;
export type AdminLowStockEvidenceResponse = z.infer<typeof adminLowStockEvidenceResponseSchema>;
export type AdminProductReconciliationStatusFilter = z.infer<typeof adminProductReconciliationStatusFilterSchema>;
export type AdminProductReconciliationRequest = z.infer<typeof adminProductReconciliationRequestSchema>;
export type AdminProductReconciliationItem = z.infer<typeof adminProductReconciliationItemSchema>;
export type AdminProductReconciliationResponse = z.infer<typeof adminProductReconciliationResponseSchema>;
