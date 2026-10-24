import type { FulfillmentRefusal } from "./dispatch.js";
export interface FulfillmentCapabilityDescriptor {
  providerRef: string;
  role: "warehouse" | "direct_carrier" | "manual" | "simulator";
  operations: Readonly<Record<"dispatch" | "readback" | "exactAbsence" | "verifyObservation" | "syncStock" | "syncProducts" | "labelCreate" | "labelRead" | "labelVoid" | "cancel" | "pickupPoint" | "courierPickup", { supported: true } | { supported: false; reason: "not_exposed" | "host_only" | "not_implemented" }>>;
  authentication: "token" | "authenticated_timestamp" | "none";
  freshness: "authenticated_timestamp" | "not_available";
  defaultOff: true;
  selected: boolean;
  readiness: { ready: true } | { ready: false; refusal: FulfillmentRefusal };
  ownsDeliveredNotification: boolean;
  stockAuthority: "local_atp" | "external_stock_master_with_local_reservations";
  labelReadOwner: "host_storage" | "adapter" | "none";
  actionPolicy: { providerSpecificAdminActions: boolean; genericAdminActions: boolean; mutationSurface: "none" | "local_only" | "provider_adapter" };
}
