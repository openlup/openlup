import type { OmsFulfillmentBlockReason } from "../commerce/types.js";

export type CommerceFulfillmentReadinessReason =
  | "oms_blocked"
  | "missing_client"
  | "missing_shipping_address"
  | "missing_order_items"
  | "missing_catalog_sku"
  | "missing_inventory_reservation";

export interface CommerceFulfillmentReadinessInput {
  omsEligibility: { allowed: true; reason: null } | { allowed: false; reason: OmsFulfillmentBlockReason };
  hasClient: boolean;
  hasShippingAddress: boolean;
  orderItemCount: number;
  allOrderItemsHaveSku: boolean;
  allOrderItemsReserved: boolean;
}

export type CommerceFulfillmentReadinessResult =
  | { allowed: true; reason: null; omsReason: null }
  | { allowed: false; reason: CommerceFulfillmentReadinessReason; omsReason: OmsFulfillmentBlockReason | null };

export function evaluateCommerceFulfillmentCreateReadiness(
  input: CommerceFulfillmentReadinessInput,
): CommerceFulfillmentReadinessResult {
  if (!input.omsEligibility.allowed) {
    return { allowed: false, reason: "oms_blocked", omsReason: input.omsEligibility.reason };
  }
  if (!input.hasClient) {
    return { allowed: false, reason: "missing_client", omsReason: null };
  }
  if (!input.hasShippingAddress) {
    return { allowed: false, reason: "missing_shipping_address", omsReason: null };
  }
  if (input.orderItemCount < 1) {
    return { allowed: false, reason: "missing_order_items", omsReason: null };
  }
  if (!input.allOrderItemsHaveSku) {
    return { allowed: false, reason: "missing_catalog_sku", omsReason: null };
  }
  if (!input.allOrderItemsReserved) {
    return { allowed: false, reason: "missing_inventory_reservation", omsReason: null };
  }

  return { allowed: true, reason: null, omsReason: null };
}
