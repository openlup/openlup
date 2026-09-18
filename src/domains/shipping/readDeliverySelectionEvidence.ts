// Single source of truth for resolving the customer's canonical delivery selection
// from the various places it can be persisted. Before this module, the paid-order
// router (routingOrderPaidFulfillmentPort) read a NARROW set (order metadata only)
// while the OmniPack dispatch port (supabaseOmnipackDispatchPort) read a WIDER set
// (fulfillment metadata, order metadata + runtimeFinalize, shipping snapshot, address
// metadata). They could diverge — routing decides "simulator" while dispatch finds an
// omnipack selection, or vice versa — stranding a paid order. Both now resolve through
// this one function so the routing decision and the dispatch payload always agree.
//
// The selection object is the configurator intent's canonical `selectedDelivery`
// (see src/domains/commerce/configuratorIntentContracts.ts):
//   { kind, deliveryKind, providerKind, carrierKind, carrierCode, service, serviceCode,
//     pickupPoint, providerRef }
// Never infer the provider from the carrier — providerKind is read verbatim.

export type DeliverySelectionSourceKey =
  | "shippingDeliveryContact"
  | "orderDeliveryContactOverride"
  | "orderDeliveryContact"
  | "fulfillmentMetadata"
  | "orderMetadata"
  | "orderRuntimeFinalize"
  | "shippingAddressSnapshot"
  | "addressMetadata";

export interface DeliverySelectionSources {
  /** commerce_fulfillment_orders.metadata.selectedDelivery */
  fulfillmentMetadata?: unknown;
  /** commerce_orders.metadata.selectedDelivery (and .runtimeFinalize.selectedDelivery) */
  orderMetadata?: unknown;
  /** shipping_address_snapshot.selectedDelivery */
  shippingAddressSnapshot?: unknown;
  /** addresses.metadata.selectedDelivery */
  addressMetadata?: unknown;
}

export interface DeliverySelectionEvidence {
  /** The canonical selectedDelivery object, or null when no source carries one. */
  selection: Record<string, unknown> | null;
  /** Normalized (trimmed, lowercased) providerKind, or null when absent/blank. */
  providerKind: string | null;
  /** Which authoritative source was resolved (priority order), or null. A
   * canonical contact can be the source even when its selection is invalid. */
  source: DeliverySelectionSourceKey | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return asRecord(value[0]);
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function normalizeProviderKind(selection: Record<string, unknown> | null): string | null {
  const providerKind = selection?.providerKind;
  return typeof providerKind === "string" && providerKind.trim()
    ? providerKind.trim().toLowerCase()
    : null;
}

// New-format order/parcel contacts are authoritative. The wider historical
// ladder remains below them so old rows stay readable without letting a mutable
// address-book selection replace a frozen provider request.
export function resolveDeliverySelectionEvidence(
  sources: DeliverySelectionSources,
): DeliverySelectionEvidence {
  const orderMetadata = asRecord(sources.orderMetadata);
  const runtimeFinalize = asRecord(orderMetadata?.runtimeFinalize);
  const shippingSnapshot = asRecord(sources.shippingAddressSnapshot);
  const canonical: Array<[DeliverySelectionSourceKey, unknown]> = [
    ["shippingDeliveryContact", shippingSnapshot?.deliveryContact],
    ["orderDeliveryContactOverride", orderMetadata?.deliveryContactOverride],
    ["orderDeliveryContact", runtimeFinalize?.deliveryContact],
  ];
  for (const [source, contactValue] of canonical) {
    if (contactValue === undefined || contactValue === null) continue;
    const selection = asRecord(asRecord(contactValue)?.selectedDelivery);
    return { selection, providerKind: normalizeProviderKind(selection), source };
  }

  const legacy: Array<[DeliverySelectionSourceKey, unknown]> = [
    ["fulfillmentMetadata", asRecord(sources.fulfillmentMetadata)?.selectedDelivery],
    ["orderMetadata", orderMetadata?.selectedDelivery],
    ["orderRuntimeFinalize", runtimeFinalize?.selectedDelivery],
    ["shippingAddressSnapshot", shippingSnapshot?.selectedDelivery],
    ["addressMetadata", asRecord(sources.addressMetadata)?.selectedDelivery],
  ];

  for (const [source, candidate] of legacy) {
    const selection = asRecord(candidate);
    if (selection) {
      return { selection, providerKind: normalizeProviderKind(selection), source };
    }
  }

  return { selection: null, providerKind: null, source: null };
}
