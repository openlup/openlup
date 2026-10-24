import type { FulfillmentCapabilityDescriptor } from "../contracts/index.js";

/** Offline protocol capabilities; selection and account readiness belong to the host. */
export const omnipackFulfillmentCapabilities: Readonly<FulfillmentCapabilityDescriptor> = Object.freeze<FulfillmentCapabilityDescriptor>({
  providerRef: "omnipack", role: "warehouse", defaultOff: true, selected: false,
  readiness: Object.freeze({ ready: false, refusal: Object.freeze({ reason: "not_ready", phase: "selection", retryable: false }) }),
  operations: Object.freeze({
    dispatch: Object.freeze({ supported: true }), readback: Object.freeze({ supported: true }),
    exactAbsence: Object.freeze({ supported: false, reason: "not_exposed" }), verifyObservation: Object.freeze({ supported: true }),
    syncStock: Object.freeze({ supported: true }), syncProducts: Object.freeze({ supported: true }),
    labelCreate: Object.freeze({ supported: false, reason: "not_exposed" }), labelRead: Object.freeze({ supported: false, reason: "host_only" }),
    labelVoid: Object.freeze({ supported: false, reason: "not_exposed" }), cancel: Object.freeze({ supported: false, reason: "not_exposed" }),
    pickupPoint: Object.freeze({ supported: true }), courierPickup: Object.freeze({ supported: false, reason: "not_exposed" }),
  }),
  authentication: "token", freshness: "not_available", ownsDeliveredNotification: false,
  stockAuthority: "external_stock_master_with_local_reservations", labelReadOwner: "host_storage",
  actionPolicy: Object.freeze({ providerSpecificAdminActions: false, genericAdminActions: true, mutationSurface: "provider_adapter" }),
});
