import type { FulfillmentCapabilityDescriptor, FulfillmentRefusal, FulfillmentSelection } from "./contracts/index.js";

/** Injected profiles replace the private registry. Support never activates a provider. */
export function readFulfillmentCapabilities(
  profiles: readonly FulfillmentCapabilityDescriptor[],
  selection: FulfillmentSelection | null | undefined,
): { kind: "selected"; descriptor: FulfillmentCapabilityDescriptor } | { kind: "refused"; refusal: FulfillmentRefusal } {
  const refuse = (reason: FulfillmentRefusal["reason"]): { kind: "refused"; refusal: FulfillmentRefusal } =>
    ({ kind: "refused", refusal: { reason, phase: "selection", retryable: false } });
  const provider = selection?.providerRef?.trim().toLowerCase() || null;
  if (!provider) return refuse("selection_required");
  const descriptor = profiles.find(profile => profile.providerRef === provider);
  if (!descriptor) return refuse("provider_mismatch");
  if (descriptor.role === "warehouse" && (!selection?.carrierRef || !selection.serviceRef)) return refuse("carrier_service_required");
  if (!descriptor.selected) return refuse("disabled");
  if (!descriptor.readiness.ready) return { kind: "refused", refusal: descriptor.readiness.refusal };
  return { kind: "selected", descriptor };
}
