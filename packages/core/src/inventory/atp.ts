import { z } from "zod";

/** @beta */
export const INVENTORY_CONTRACT_VERSION = "inventory.v0";

const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true });
const quantitySchema = z.number().int().nonnegative();
const positiveQuantitySchema = z.number().int().positive();

/** @beta */
export const inventoryLocationKindSchema = z.enum([
  "internal_warehouse",
  "third_party_logistics",
  "supplier",
  "quarantine",
  "virtual",
]);
/** @beta */
export const inventoryLocationStatusSchema = z.enum(["active", "inactive"]);
/** @beta */
export const inventoryLotStatusSchema = z.enum(["available", "quarantined", "expired", "recalled"]);
/** @beta */
export const inventoryAtpStatusSchema = z.enum(["fulfillable", "insufficient", "review_required", "unsupported"]);

/** @beta */
export const inventoryStockLineSchema = z.object({
  skuId: uuidSchema,
  sku: z.string().trim().min(1),
  locationId: uuidSchema,
  locationCode: z.string().trim().min(1),
  locationKind: inventoryLocationKindSchema,
  locationStatus: inventoryLocationStatusSchema,
  fulfillable: z.boolean(),
  lotId: uuidSchema.nullable(),
  lotCode: z.string().trim().min(1).nullable(),
  lotStatus: inventoryLotStatusSchema.nullable(),
  expiresAt: datetimeSchema.nullable(),
  onHand: quantitySchema,
  reserved: quantitySchema,
  unavailable: quantitySchema,
  incoming: quantitySchema,
  safetyStock: quantitySchema,
}).strict();

/** @beta */
export const inventoryAtpRequestLineSchema = z.object({
  skuId: uuidSchema,
  sku: z.string().trim().min(1),
  quantity: positiveQuantitySchema,
}).strict();

/** @beta */
export const inventoryAtpRequestSchema = z.object({
  contractVersion: z.literal(INVENTORY_CONTRACT_VERSION),
  lines: z.array(inventoryAtpRequestLineSchema).min(1),
  requestedAt: datetimeSchema,
  orderMode: z.enum(["one_time", "subscription_cycle"]),
  region: z.string().trim().min(2).max(32).optional(),
  noSplitShipment: z.boolean().default(true),
  minShelfLifeDays: z.number().int().min(0).max(730).default(0),
}).strict();

/** @beta */
export const inventoryAllocationSchema = z.object({
  skuId: uuidSchema,
  sku: z.string().trim().min(1),
  locationId: uuidSchema,
  locationCode: z.string().trim().min(1),
  lotId: uuidSchema.nullable(),
  lotCode: z.string().trim().min(1).nullable(),
  quantity: positiveQuantitySchema,
  expiresAt: datetimeSchema.nullable(),
}).strict();

/** @beta */
export const inventoryAtpLineResultSchema = z.object({
  skuId: uuidSchema,
  sku: z.string().trim().min(1),
  requestedQuantity: positiveQuantitySchema,
  availableQuantity: quantitySchema,
  missingQuantity: quantitySchema,
  status: inventoryAtpStatusSchema,
  allocations: z.array(inventoryAllocationSchema),
}).strict();

/** @beta */
export const inventoryAtpResultSchema = z.object({
  contractVersion: inventoryAtpRequestSchema.shape.contractVersion,
  status: inventoryAtpStatusSchema,
  reason: z.string().trim().min(1).nullable(),
  locationId: uuidSchema.nullable(),
  locationCode: z.string().trim().min(1).nullable(),
  lines: z.array(inventoryAtpLineResultSchema),
}).strict();

/** @beta */
export type InventoryAtpRequest = z.input<typeof inventoryAtpRequestSchema>;
/** @beta */
export type InventoryAtpResult = z.infer<typeof inventoryAtpResultSchema>;
/** @beta */
export type InventoryStockLine = z.infer<typeof inventoryStockLineSchema>;

/** @beta */
export interface CalculateInventoryAtpInput {
  request: InventoryAtpRequest;
  stock: InventoryStockLine[];
}

/** @beta */
export function availableNow(line: Pick<InventoryStockLine, "onHand" | "reserved" | "unavailable" | "safetyStock">): number {
  return Math.max(0, line.onHand - line.reserved - line.unavailable - line.safetyStock);
}

/** @beta */
export function calculateInventoryAtp(input: CalculateInventoryAtpInput): InventoryAtpResult {
  if (input.request.noSplitShipment === false) {
    return inventoryAtpResultSchema.parse({
      contractVersion: INVENTORY_CONTRACT_VERSION,
      status: "unsupported",
      reason: "split_shipment_unsupported",
      locationId: null,
      locationCode: null,
      lines: input.request.lines.map((line) => ({
        skuId: line.skuId,
        sku: line.sku,
        requestedQuantity: line.quantity,
        availableQuantity: 0,
        missingQuantity: line.quantity,
        status: "unsupported",
        allocations: [],
      })),
    });
  }

  const usableStock = input.stock.filter((line) => isUsable(
    line,
    input.request.requestedAt,
    input.request.minShelfLifeDays ?? 0,
  ));
  const locationIds = [...new Set(usableStock.map((line) => line.locationId))];
  const preferredLocation = locationIds
    .map((locationId) => allocationForLocation(input.request, usableStock, locationId))
    .find((candidate) => candidate.status === "fulfillable");

  if (preferredLocation) {
    return inventoryAtpResultSchema.parse({
      contractVersion: INVENTORY_CONTRACT_VERSION,
      status: "fulfillable",
      reason: null,
      locationId: preferredLocation.locationId,
      locationCode: preferredLocation.locationCode,
      lines: preferredLocation.lines,
    });
  }

  const lines = input.request.lines.map((requestLine) => {
    const matching = usableStock.filter((line) => line.skuId === requestLine.skuId);
    const availableQuantity = matching.reduce((sum, line) => sum + availableNow(line), 0);
    return {
      skuId: requestLine.skuId,
      sku: requestLine.sku,
      requestedQuantity: requestLine.quantity,
      availableQuantity,
      missingQuantity: Math.max(0, requestLine.quantity - availableQuantity),
      status: availableQuantity >= requestLine.quantity ? "review_required" : "insufficient",
      allocations: [],
    };
  });

  const hasEnoughInAggregate = lines.every((line) => line.missingQuantity === 0);
  return inventoryAtpResultSchema.parse({
    contractVersion: INVENTORY_CONTRACT_VERSION,
    status: hasEnoughInAggregate ? "review_required" : "insufficient",
    reason: hasEnoughInAggregate
      ? "stock_available_only_with_split_shipment"
      : "insufficient_available_stock",
    locationId: null,
    locationCode: null,
    lines,
  });
}

function allocationForLocation(
  request: InventoryAtpRequest,
  stock: InventoryStockLine[],
  locationId: string,
) {
  const locationStock = stock.filter((line) => line.locationId === locationId);
  const locationCode = locationStock[0]?.locationCode ?? null;
  const lines = request.lines.map((requestLine) => {
    let remaining = requestLine.quantity;
    const allocations = locationStock
      .filter((line) => line.skuId === requestLine.skuId && availableNow(line) > 0)
      .sort(fefoSort)
      .flatMap((line) => {
        if (remaining <= 0) return [];
        const quantity = Math.min(remaining, availableNow(line));
        remaining -= quantity;
        return [{
          skuId: requestLine.skuId,
          sku: requestLine.sku,
          locationId: line.locationId,
          locationCode: line.locationCode,
          lotId: line.lotId,
          lotCode: line.lotCode,
          quantity,
          expiresAt: line.expiresAt,
        }];
      });

    return {
      skuId: requestLine.skuId,
      sku: requestLine.sku,
      requestedQuantity: requestLine.quantity,
      availableQuantity: requestLine.quantity - remaining,
      missingQuantity: remaining,
      status: remaining === 0 ? "fulfillable" : "insufficient",
      allocations,
    };
  });

  return {
    status: lines.every((line) => line.status === "fulfillable") ? "fulfillable" : "insufficient",
    locationId,
    locationCode,
    lines,
  };
}

function isUsable(line: InventoryStockLine, requestedAt: string, minShelfLifeDays: number): boolean {
  if (!line.fulfillable || line.locationStatus !== "active") return false;
  if (line.lotStatus && line.lotStatus !== "available") return false;
  if (line.expiresAt && Date.parse(line.expiresAt) <= minAcceptableExpiry(requestedAt, minShelfLifeDays)) {
    return false;
  }
  return availableNow(line) > 0;
}

function minAcceptableExpiry(requestedAt: string, minShelfLifeDays: number): number {
  return Date.parse(requestedAt) + minShelfLifeDays * 24 * 60 * 60 * 1000;
}

function fefoSort(a: InventoryStockLine, b: InventoryStockLine): number {
  const aExpiry = a.expiresAt ? Date.parse(a.expiresAt) : Number.POSITIVE_INFINITY;
  const bExpiry = b.expiresAt ? Date.parse(b.expiresAt) : Number.POSITIVE_INFINITY;
  if (aExpiry !== bExpiry) return aExpiry - bExpiry;
  return a.locationCode.localeCompare(b.locationCode) || (a.lotCode ?? "").localeCompare(b.lotCode ?? "");
}
