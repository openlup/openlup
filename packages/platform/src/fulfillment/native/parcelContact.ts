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

/** Dispatch-only reconstruction; no snapshot type or reader is exported publicly. */
export function applyFrozenParcel(candidate: FulfillmentDispatchRequest, value: unknown): FulfillmentDispatchRequest {
  const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const payload = record(value), contact = record(payload.contact), selection = record(contact.selectedDelivery);
  const text = (v: unknown) => typeof v === 'string' ? v : null;
  const required = (v: unknown) => { const result = text(v); if (!result?.trim()) throw new Error('commerce_oms_replacement_delivery_contact_invalid'); return result; };
  const point = record(selection.pickupPoint), address = record(point.address);
  const providerRef = text(selection.providerKind) ?? text(selection.providerRef);
  return { ...candidate,
    parcelSequenceNo: Number(payload.sequenceNo),
    contactRevision: { schemaVersion: Number(contact.schemaVersion), source: required(contact.source), revision: Number(contact.revision) },
    recipient: { name: required(contact.recipientName), email: text(contact.contactEmail), phone: required(contact.contactPhone),
      line1: required(contact.line1), line2: text(contact.line2), city: required(contact.city), postalCode: required(contact.postalCode), country: required(contact.country),
      deliveryInstructions: text(contact.deliveryInstructions), courierInstructions: text(contact.courierInstructions) },
    selection: { providerRef, carrierRef: text(selection.carrierKind) ?? text(selection.carrierCode), serviceRef: text(selection.service) ?? text(selection.serviceCode),
      deliveryKind: selection.deliveryKind === 'parcel-locker' || selection.kind === 'parcel-locker' ? 'parcel-locker' : 'courier',
      pickupPoint: Object.keys(point).length ? { id: required(point.id ?? point.pointId), provider: required(point.provider), name: required(point.name),
        address: { line1: required(address.line1), postalCode: required(address.postalCode), city: required(address.city), country: required(address.country) } } : null },
    lines: Array.isArray(payload.lines) ? payload.lines.map(raw => { const line = record(raw); return { skuRef: required(line.sku), title: text(line.title), quantity: Number(line.quantity), productRef: null, packRef: null, lotRef: text(line.lotRef), expirationDate: text(line.expirationDate) }; }) : candidate.lines,
  };
}
