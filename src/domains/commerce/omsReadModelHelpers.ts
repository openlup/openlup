export { actionEligibility, baseOrder, buildOmsDeliveryContactProjection, deliveryContactAddress, evaluateOperationalState, findCustomer, inventorySummary, mapAddress, mapCustomer, paymentStatusForOrder } from "@openlup/platform/commerce";
export type { OmsActionAvailabilityFlags } from "@openlup/platform/commerce/contracts";
import type { OmsOrderDetail } from "./omsContracts.js";
import type { OmsOrderRow,OmsPetRow } from "./omsReadModelRows.js";
export type OmsOrderIdentity = Pick<OmsOrderDetail, "customer" | "pet">;
export function findPet(order: OmsOrderRow, pets: OmsPetRow[]): OmsOrderDetail["pet"] {
  return mapPet(pets.find((pet) => pet.id === order.pet_id) ?? null);
}
export function mapPet(row: OmsPetRow | null): OmsOrderDetail["pet"] {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    petType: row.pet_type,
    breed: row.breed,
    ageLabel: row.age_label,
    weightKg: row.weight_kg === null ? null : Number(row.weight_kg),
  };
}
