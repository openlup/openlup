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
    selectedDelivery: { providerKind: selection.providerRef, providerRef: selection.providerRef, carrierKind: selection.carrierRef,
      service: selection.serviceRef, deliveryKind: selection.deliveryKind,
      pickupPoint: point ? { id: point.id, provider: point.provider, name: point.name, address: {
        line1: point.address.line1, postalCode: point.address.postalCode, city: point.address.city, country: point.address.country,
      } } : null },
  };
}

/** Only the private preparation path reconstructs the frozen delivery fields. */
export function applyParcelContact(candidate: FulfillmentDispatchRequest, value: unknown): FulfillmentDispatchRequest {
  const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const contact = record(value), selection = record(contact.selectedDelivery), point = record(selection.pickupPoint), address = record(point.address);
  const text = (v: unknown) => typeof v === 'string' ? v : null;
  return { ...candidate,
    contactRevision: { schemaVersion: Number(contact.schemaVersion), source: text(contact.source) ?? '', revision: Number(contact.revision) },
    recipient: { name: text(contact.recipientName), email: text(contact.contactEmail), phone: text(contact.contactPhone),
      line1: text(contact.line1) ?? '', line2: text(contact.line2), city: text(contact.city) ?? '', postalCode: text(contact.postalCode) ?? '', country: text(contact.country) ?? '',
      deliveryInstructions: text(contact.deliveryInstructions), courierInstructions: text(contact.courierInstructions) },
    selection: { providerRef: text(selection.providerKind) ?? text(selection.providerRef), carrierRef: text(selection.carrierKind) ?? text(selection.carrierCode),
      serviceRef: text(selection.service) ?? text(selection.serviceCode),
      deliveryKind: selection.deliveryKind === 'parcel-locker' || selection.kind === 'parcel-locker' ? 'parcel-locker' : 'courier',
      pickupPoint: Object.keys(point).length ? { id: text(point.id) ?? text(point.pointId) ?? '', provider: text(point.provider) ?? '', name: text(point.name) ?? '',
        address: { line1: text(address.line1) ?? '', postalCode: text(address.postalCode) ?? '', city: text(address.city) ?? '', country: text(address.country) ?? '' } } : null },
  };
}
