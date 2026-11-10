import type { FulfillmentDispatchRequest } from '../contracts/index.js';

/** This private payload never enters dispatch evidence or commerce read models. */
export function parcelContact(candidate: FulfillmentDispatchRequest) {
  const { recipient, selection, contactRevision } = candidate;
  const point = selection.pickupPoint;
  return {
    schemaVersion: contactRevision.schemaVersion, source: contactRevision.source, revision: contactRevision.revision,
    recipientName: recipient.name, contactEmail: recipient.email, contactPhone: recipient.phone,
    line1: recipient.line1, line2: recipient.line2, city: recipient.city,
    postalCode: recipient.postalCode, country: recipient.country,
    deliveryInstructions: recipient.deliveryInstructions, courierInstructions: recipient.courierInstructions,
    selectedDelivery: { providerKind: selection.providerRef, carrierKind: selection.carrierRef,
      service: selection.serviceRef, deliveryKind: selection.deliveryKind,
      pickupPoint: point ? { id: point.id, name: point.name, address: {
        line1: point.address.line1, postalCode: point.address.postalCode, city: point.address.city, country: point.address.country,
      } } : null },
  };
}
