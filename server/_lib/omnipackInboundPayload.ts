// Pure builder for the OmniPack inbound SHIPMENT request (POST /shipments) that receives stock
// into the warehouse. Mirrors the outbound-order payload convention. The request shape is
// confirmed against the OmniPack v1 docs: shipmentNumber + supplier + plannedDeliveryDate +
// trackingInfo{carrier,trackingNo} + items[]{sku,name,ean,quantity,(lotNumber,expirationDate)}.

// The OmniPack product group whose goods are tracked by batch number + expiry date on intake.
// Inbound for this group MUST carry lotNumber + expirationDate.
export const OMNIPACK_BATCH_EXPIRY_GROUP = "BATCH_NR+EXP_DATE";

// Inbound shipment request key names (confirmed against the OmniPack shipment API docs).
const KEY_SHIPMENT_NUMBER = "shipmentNumber";
const KEY_SUPPLIER = "supplier";
const KEY_PLANNED_DELIVERY_DATE = "plannedDeliveryDate";
const KEY_TRACKING_INFO = "trackingInfo";
const KEY_CARRIER = "carrier";
const KEY_TRACKING_NO = "trackingNo";
const KEY_ITEMS = "items";
const KEY_SKU = "sku";
const KEY_NAME = "name";
const KEY_EAN = "ean";
const KEY_QUANTITY = "quantity";
const KEY_LOT_NUMBER = "lotNumber";
const KEY_EXPIRATION_DATE = "expirationDate";

export interface OmnipackInboundBatch {
  lotNumber: string;
  expirationDate: string;
}

export interface OmnipackInboundTrackingInfo {
  carrier: string;
  trackingNo: string;
}

export interface OmnipackInboundInput {
  sku: string;
  // Product display name + EAN/barcode, required per item by POST /shipments.
  name: string;
  ean: string;
  quantity: number;
  productGroup: string;
  // The receiving-document reference; emitted as the shipment number (idempotency anchor).
  reference: string;
  batch?: OmnipackInboundBatch | null;
  // Required shipment metadata per the /shipments contract.
  supplier: string;
  plannedDeliveryDate: string;
  trackingInfo: OmnipackInboundTrackingInfo;
}

export class OmnipackInboundPayloadError extends Error {
  constructor(readonly code: string) {
    super(`omnipack_inbound_payload_invalid: ${code}`);
    this.name = "OmnipackInboundPayloadError";
  }
}

function requireNonEmpty(value: string | null | undefined, code: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new OmnipackInboundPayloadError(code);
  return trimmed;
}

// Builds the inbound shipment payload. quantity must be a positive integer (a zero-stock SKU is
// a no-op — the seed simply posts no shipment for it). A BATCH_NR+EXP_DATE product REQUIRES
// lotNumber + expirationDate; this invariant is enforced here (pure, unit-tested).
export function buildOmnipackInboundPayload(input: OmnipackInboundInput): Record<string, unknown> {
  const sku = requireNonEmpty(input.sku, "missing_sku");
  const name = requireNonEmpty(input.name, "missing_name");
  const ean = requireNonEmpty(input.ean, "missing_ean");
  const shipmentNumber = requireNonEmpty(input.reference, "missing_reference");
  const group = requireNonEmpty(input.productGroup, "missing_product_group");
  const supplier = requireNonEmpty(input.supplier, "missing_supplier");
  const plannedDeliveryDate = requireNonEmpty(input.plannedDeliveryDate, "missing_planned_delivery_date");
  const carrier = requireNonEmpty(input.trackingInfo?.carrier, "missing_tracking_carrier");
  const trackingNo = requireNonEmpty(input.trackingInfo?.trackingNo, "missing_tracking_no");
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new OmnipackInboundPayloadError("invalid_quantity");
  }

  const item: Record<string, unknown> = {
    [KEY_SKU]: sku,
    [KEY_NAME]: name,
    [KEY_EAN]: ean,
    [KEY_QUANTITY]: input.quantity,
  };

  if (group === OMNIPACK_BATCH_EXPIRY_GROUP) {
    if (!input.batch) throw new OmnipackInboundPayloadError("batch_required_for_batch_group");
    item[KEY_LOT_NUMBER] = requireNonEmpty(input.batch.lotNumber, "missing_lot_number");
    item[KEY_EXPIRATION_DATE] = requireNonEmpty(input.batch.expirationDate, "missing_expiration_date");
  }

  return {
    [KEY_SHIPMENT_NUMBER]: shipmentNumber,
    [KEY_SUPPLIER]: supplier,
    [KEY_PLANNED_DELIVERY_DATE]: plannedDeliveryDate,
    [KEY_TRACKING_INFO]: { [KEY_CARRIER]: carrier, [KEY_TRACKING_NO]: trackingNo },
    [KEY_ITEMS]: [item],
  };
}
