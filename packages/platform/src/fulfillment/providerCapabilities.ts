import type { FulfillmentCapabilityDescriptor, FulfillmentRefusal, FulfillmentSelection } from "./contracts/index.js";

/** Injected profiles replace the private registry. Support never activates a provider. */
export function readFulfillmentCapabilities(
  profiles: readonly FulfillmentCapabilityDescriptor[],
  selection: FulfillmentSelection | null | undefined,
  /** Probe native execution limits independently of adapter selection support. */
  request?: { operation?: "dispatch" | "independentSplit" | "pickupPointDelivery" | "labelCreate" | "labelVoid" | "cancel" | "reservations" | "labelRead"; format?: string },
): { kind: "selected"; descriptor: FulfillmentCapabilityDescriptor } | { kind: "refused"; refusal: FulfillmentRefusal } {
  const refuse = (reason: FulfillmentRefusal["reason"]): { kind: "refused"; refusal: FulfillmentRefusal } =>
    ({ kind: "refused", refusal: { reason, phase: "selection", retryable: false } });
  const provider = selection?.providerRef?.trim().toLowerCase() || null;
  if (!provider) return refuse("selection_required");
  const descriptor = profiles.find(profile => profile.providerRef === provider);
  if (!descriptor) return refuse("provider_mismatch");
  if ((descriptor.transportSelection === "merchant" || (descriptor.transportSelection === undefined && descriptor.role === "warehouse")) && (!selection?.carrierRef || !selection.serviceRef)) return refuse("carrier_service_required");
  if (!descriptor.selected) return refuse("disabled");
  if (!descriptor.readiness.ready) return { kind: "refused", refusal: descriptor.readiness.refusal };
  if (descriptor.inventory?.reservationOwner === "provider") return refuse("provider_reservations_unsupported");
  if (descriptor.inventory && descriptor.inventory.consumption !== "finished_picking") return refuse("stock_consumption_policy_unsupported");
  if (descriptor.independentSplits || request?.operation === "independentSplit") return refuse("independent_split_unsupported");
  const formats = descriptor.labelFormats ?? ["application/pdf"];
  if (formats.some(format => format !== "application/pdf") || (request?.format !== undefined && (request.format !== "application/pdf" || !formats.includes(request.format)))) return refuse("label_format_unsupported");
  switch (request?.operation) {
    case "pickupPointDelivery": return refuse("pickup_point_delivery_unsupported");
    case "labelCreate": return refuse("label_create_unsupported");
    case "labelVoid": return refuse("label_void_unsupported");
    case "cancel": return refuse("provider_cancel_unsupported");
    case "reservations": return refuse("provider_reservations_unsupported");
  }
  return { kind: "selected", descriptor };
}
