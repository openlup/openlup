import type { FulfillmentProviderAdapter, FulfillmentProviderRegistry } from "./contracts/conformance.js";

export function createFulfillmentProviderRegistry(
  adapters: readonly FulfillmentProviderAdapter[],
): FulfillmentProviderRegistry {
  const byRef = new Map<string, FulfillmentProviderAdapter>();
  for (const adapter of adapters) {
    const rawRef = adapter.capabilities.providerRef;
    const ref = rawRef.trim();
    if (!ref) {
      throw new Error("fulfillment_provider_ref_required");
    }
    if (ref !== rawRef) {
      throw new Error(`fulfillment_provider_ref_untrimmed:${ref}`);
    }
    if (byRef.has(ref)) {
      throw new Error(`duplicate_fulfillment_provider_ref:${ref}`);
    }
    byRef.set(ref, adapter);
  }
  const refsList = Object.freeze([...byRef.keys()]);

  return {
    get(providerRef: string): FulfillmentProviderAdapter | null {
      return byRef.get(providerRef) ?? null;
    },
    requireAdapter(providerRef: string): FulfillmentProviderAdapter {
      const adapter = byRef.get(providerRef);
      if (!adapter) {
        throw new Error(`unknown_fulfillment_provider_ref:${providerRef}`);
      }
      return adapter;
    },
    refs(): readonly string[] {
      return refsList;
    },
  };
}
