export type OmnipackOutboundDeliveryKind = "courier" | "parcel-locker";

export interface OmnipackOutboundOrderInput {
  orderNumber: string;
  description?: string | null;
  additionalCustomerOrderNumber?: string | null;
  deliverySelection: OmnipackOutboundDeliverySelection | null;
  recipient: {
    name: string;
    email: string | null;
    phone: string | null;
  };
  address: {
    line1: string;
    city: string;
    postalCode: string;
    country: string;
  };
  items: Array<{
    sku: string;
    quantity: number;
    lotNumber?: string | null;
    expirationDate?: string | null;
  }>;
  orderValue?: { amount: number; currency: string } | null;
}

export interface OmnipackOutboundDeliverySelection {
  providerKind?: string | null;
  carrierKind?: string | null;
  carrierCode?: string | null;
  serviceCode?: string | null;
  service?: string | null;
  deliveryKind?: string | null;
  kind?: string | null;
  pickupPoint?: {
    id?: string | null;
    pointId?: string | null;
    name?: string | null;
    address?: {
      line1?: string | null;
      postalCode?: string | null;
      city?: string | null;
      country?: string | null;
    } | null;
  } | null;
}

export interface OmnipackOutboundOrderPayload {
  orderNumber: string;
  description?: string;
  additionalCustomerOrderNumber?: string;
  items: Array<{
    sku: string;
    quantity: number;
    lotNumber?: string;
    expirationDate?: string;
  }>;
  shippingDetails: {
    carrier: string;
    service: string;
    address: {
      name: string;
      street: string;
      city: string;
      postCode: string;
      phone: string;
      email?: string;
      country: string;
    };
    pickUpPoint?: string;
  };
  orderValue?: { amount: number; currency: string };
}

export class OmnipackOutboundOrderPayloadError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OmnipackOutboundOrderPayloadError";
  }
}

export function buildOmnipackOutboundOrderPayload(input: OmnipackOutboundOrderInput): OmnipackOutboundOrderPayload {
  const orderNumber = requiredText(input.orderNumber, "omnipack_order_payload_missing_order_number");
  const selection = input.deliverySelection;
  const providerKind = optionalText(selection?.providerKind);
  if (providerKind !== "omnipack") {
    throw new OmnipackOutboundOrderPayloadError("omnipack_order_payload_missing_omnipack_delivery_selection");
  }
  const service = requiredText(selection?.serviceCode ?? selection?.service, "omnipack_order_payload_missing_service");
  const carrier = service;
  const deliveryKind = readDeliveryKind(selection);
  const pickUpPoint = readPickUpPoint(deliveryKind, selection);
  const items = input.items.map((item) => {
    const lotNumber = optionalText(item.lotNumber);
    const expirationDate = optionalText(item.expirationDate);
    return {
      sku: requiredText(item.sku, "omnipack_order_payload_missing_sku"),
      quantity: requiredQuantity(item.quantity),
      ...(lotNumber ? { lotNumber } : {}),
      ...(expirationDate ? { expirationDate } : {}),
    };
  });
  if (items.length === 0) {
    throw new OmnipackOutboundOrderPayloadError("omnipack_order_payload_missing_items");
  }

  return compactRecord({
    orderNumber,
    description: optionalText(input.description),
    additionalCustomerOrderNumber: optionalText(input.additionalCustomerOrderNumber),
    items,
    shippingDetails: compactRecord({
      carrier,
      service,
      address: compactRecord({
        name: requiredText(input.recipient.name, "omnipack_order_payload_missing_recipient_name"),
        street: requiredText(input.address.line1, "omnipack_order_payload_missing_address_street"),
        city: requiredText(input.address.city, "omnipack_order_payload_missing_address_city"),
        postCode: requiredText(input.address.postalCode, "omnipack_order_payload_missing_address_post_code"),
        phone: requiredText(input.recipient.phone, "omnipack_order_payload_missing_recipient_phone"),
        email: optionalText(input.recipient.email),
        country: requiredText(input.address.country, "omnipack_order_payload_missing_address_country"),
      }),
      pickUpPoint,
    }),
    orderValue: validOrderValue(input.orderValue),
  }) as OmnipackOutboundOrderPayload;
}

export function buildOmnipackOutboundOrderEvidence(payload: OmnipackOutboundOrderPayload): Record<string, unknown> {
  return {
    provider: "omnipack",
    requestKind: "outbound_order",
    orderNumber: payload.orderNumber,
    carrier: payload.shippingDetails.carrier,
    service: payload.shippingDetails.service,
    pickUpPoint: payload.shippingDetails.pickUpPoint ?? null,
    itemCount: payload.items.length,
    items: payload.items.map((item) => ({
      sku: item.sku,
      quantity: item.quantity,
      lotNumber: item.lotNumber ?? null,
      expirationDate: item.expirationDate ?? null,
    })),
    stockTruth: "external_stock_master_with_local_reservations",
  };
}

function readDeliveryKind(selection: OmnipackOutboundDeliverySelection | null): OmnipackOutboundDeliveryKind {
  const value = optionalText(selection?.deliveryKind ?? selection?.kind);
  if (value === "courier" || value === "parcel-locker") return value;
  throw new OmnipackOutboundOrderPayloadError("omnipack_order_payload_missing_delivery_kind");
}

function readPickUpPoint(
  deliveryKind: OmnipackOutboundDeliveryKind,
  selection: OmnipackOutboundDeliverySelection | null,
): string | undefined {
  if (deliveryKind !== "parcel-locker") return undefined;
  const point = optionalText(selection?.pickupPoint?.id ?? selection?.pickupPoint?.pointId);
  if (!point) throw new OmnipackOutboundOrderPayloadError("omnipack_order_payload_missing_pickup_point");
  return point;
}

function requiredText(value: unknown, code: string): string {
  const text = optionalText(value);
  if (!text) throw new OmnipackOutboundOrderPayloadError(code);
  return text;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredQuantity(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new OmnipackOutboundOrderPayloadError("omnipack_order_payload_invalid_quantity");
  }
  return value;
}

function validOrderValue(value: OmnipackOutboundOrderInput["orderValue"]): OmnipackOutboundOrderPayload["orderValue"] | undefined {
  if (!value) return undefined;
  if (typeof value.amount !== "number" || value.amount <= 0 || !Number.isFinite(value.amount)) {
    throw new OmnipackOutboundOrderPayloadError("omnipack_order_payload_invalid_order_value");
  }
  const currency = requiredText(value.currency, "omnipack_order_payload_missing_order_value_currency");
  return { amount: value.amount, currency };
}

function compactRecord<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
