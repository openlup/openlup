import type { DeliverySelectionEvidence, DeliverySelectionSourceKey, DeliverySelectionSources } from "./contracts/delivery.js";

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
