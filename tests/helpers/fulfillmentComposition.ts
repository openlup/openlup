import type { FulfillmentCapabilityDescriptor, FulfillmentDispatchRequest } from '@openlup/platform/fulfillment/contracts';

export function request(revision = 1): FulfillmentDispatchRequest {
  return { requestKey: "legacy-request-a", fulfillmentRef: "fulfillment-a", orderRef: "order-a", orderNumber: null, parcelRef: null,
    contactRevision: { schemaVersion: 1, source: "contact", revision },
    recipient: { name: null, email: null, phone: null, line1: "Synthetic 1", line2: null, city: "Example", postalCode: "00000", country: "XX", deliveryInstructions: null, courierInstructions: null },
    lines: [{ skuRef: "sku-a", title: null, quantity: 1, productRef: null, packRef: null }],
    selection: { providerRef: "warehouse-a", carrierRef: "carrier-a", serviceRef: "service-a", deliveryKind: "courier", pickupPoint: null } };
}
export function profile(full = true): FulfillmentCapabilityDescriptor {
  const support = { supported: true } as const, no = { supported: false, reason: "not_exposed" } as const;
  return { providerRef: "warehouse-a", role: "warehouse", defaultOff: true, selected: true, readiness: { ready: true },
    operations: { dispatch: support, readback: full ? support : no, exactAbsence: full ? support : no, verifyObservation: full ? support : no,
      syncStock: full ? support : no, syncProducts: full ? support : no, labelCreate: full ? support : no, labelRead: full ? support : no, labelVoid: full ? support : no,
      cancel: no, pickupPoint: no, courierPickup: no }, authentication: "token", freshness: "not_available", ownsDeliveredNotification: true,
    stockAuthority: "external_stock_master_with_local_reservations", labelReadOwner: full ? "adapter" : "none",
    actionPolicy: { providerSpecificAdminActions: false, genericAdminActions: false, mutationSurface: "provider_adapter" } };
}
