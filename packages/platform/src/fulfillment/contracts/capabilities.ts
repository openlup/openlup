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
  /** Omitted intake preserves webhook/push acknowledgement evidence. */
  intakeMode?: "webhook" | "polling";
  /** Only local reservations with finished-picking consumption are admitted. */
  inventory?: { reservationOwner: "local" | "provider"; consumption: "finished_picking" | "provider_managed" };
  /** Omitted means movement reads are required; false selects snapshot-only sync. */
  stockMovements?: boolean;
  independentSplits?: boolean;
  /** Independent of warehouse role; omitted retains the existing role rule. */
  transportSelection?: "merchant" | "provider";
  /** MIME formats; only application/pdf is admitted by the native label contract. */
  labelFormats?: readonly string[];
  labelReadOwner: "host_storage" | "adapter" | "none";
  actionPolicy: { providerSpecificAdminActions: boolean; genericAdminActions: boolean; mutationSurface: "none" | "local_only" | "provider_adapter" };
}
