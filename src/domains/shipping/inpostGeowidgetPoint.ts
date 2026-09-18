// Maps the point object delivered by the InPost Geowidget v5 `onpointselect`
// event (ShipX point shape) onto the strict domain PickupPoint. Kept pure and
// DOM-free so it is unit-testable in isolation; mirrors the server-side
// normalization in server/infra/inpost/pointsClient.ts (`toResult`).
import type { PickupPoint } from "./deliverySelectionContracts";

export function mapGeowidgetPointToPickupPoint(raw: unknown): PickupPoint | null {
  const item = asRecord(raw);
  const id = text(item.name);
  const details = asRecord(item.address_details);
  const address = asRecord(item.address);
  const line1 = text(address.line1) || joinStreet(details);
  const city = text(details.city);
  const postCode = text(details.post_code);
  if (!id || !line1 || !city || !postCode) return null;
  const displayName = text(item.display_name) || `Paczkomat ${id}`;
  return {
    id,
    provider: "inpost",
    name: displayName,
    address: { line1, postalCode: postCode, city, country: "PL" },
  };
}

function joinStreet(details: Record<string, unknown>): string {
  return [text(details.street), text(details.building_number)].filter(Boolean).join(" ").trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
