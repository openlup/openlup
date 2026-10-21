import type { FulfillmentCapabilityDescriptor } from "../contracts/index.js";

/** Offline protocol capabilities; selection and account readiness belong to the host. */
export const omnipackFulfillmentCapabilities: FulfillmentCapabilityDescriptor = {
  providerRef: "omnipack", role: "warehouse", defaultOff: true, selected: false,
  readiness: { ready: false, refusal: { reason: "not_ready", phase: "selection", retryable: false } },
  operations: {
    dispatch: { supported: true }, readback: { supported: true },
    exactAbsence: { supported: false, reason: "not_exposed" }, verifyObservation: { supported: true },
    syncStock: { supported: true }, syncProducts: { supported: true },
    labelCreate: { supported: false, reason: "not_exposed" }, labelRead: { supported: false, reason: "host_only" },
    labelVoid: { supported: false, reason: "not_exposed" }, cancel: { supported: false, reason: "not_exposed" },
    pickupPoint: { supported: true }, courierPickup: { supported: false, reason: "not_exposed" },
  },
  authentication: "token", freshness: "not_available", ownsDeliveredNotification: false,
  stockAuthority: "external_stock_master_with_local_reservations", labelReadOwner: "host_storage",
  actionPolicy: { providerSpecificAdminActions: false, genericAdminActions: true, mutationSurface: "provider_adapter" },
};
