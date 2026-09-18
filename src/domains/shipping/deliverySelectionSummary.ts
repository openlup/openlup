export type DeliverySelectionSummaryKind = "courier" | "parcel-locker";

export interface DeliverySelectionSummary {
  deliveryKind: DeliverySelectionSummaryKind;
  providerKind: string | null;
  carrierKind: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  pickupPoint: {
    id: string;
    name: string;
    address: {
      line1: string;
      postalCode: string;
      city: string;
      country: string;
    } | null;
  } | null;
  source?: string | null;
}

export function summarizeDeliverySelection(
  selection: Record<string, unknown> | null | undefined,
  source: string | null = null,
): DeliverySelectionSummary | null {
  if (!selection) return null;
  const deliveryKind = readDeliveryKind(selection.deliveryKind ?? selection.kind);
  if (!deliveryKind) return null;
  return {
    deliveryKind,
    providerKind: text(selection.providerKind),
    carrierKind: text(selection.carrierKind),
    carrierCode: text(selection.carrierCode),
    serviceCode: text(selection.serviceCode ?? selection.service),
    pickupPoint: deliveryKind === "parcel-locker" ? readPickupPoint(selection.pickupPoint) : null,
    ...(source ? { source } : {}),
  };
}

function readDeliveryKind(value: unknown): DeliverySelectionSummaryKind | null {
  if (value === "courier" || value === "parcel-locker") return value;
  return null;
}

function readPickupPoint(value: unknown): DeliverySelectionSummary["pickupPoint"] {
  const point = record(value);
  if (!point) return null;
  const id = text(point.id ?? point.pointId);
  const name = text(point.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    address: readPickupPointAddress(point.address),
  };
}

function readPickupPointAddress(value: unknown): NonNullable<DeliverySelectionSummary["pickupPoint"]>["address"] {
  const address = record(value);
  if (!address) return null;
  const line1 = text(address.line1);
  const postalCode = text(address.postalCode);
  const city = text(address.city);
  const country = text(address.country);
  if (!line1 || !postalCode || !city || !country) return null;
  return { line1, postalCode, city, country };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
