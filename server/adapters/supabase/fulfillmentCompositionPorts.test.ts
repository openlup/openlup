import { describe, expect, it } from "vitest";
import { createSupabaseOrderFulfillmentProviderKindReader } from "./fulfillmentCompositionPorts.js";

function metadataClient(metadata: Record<string, unknown> | null, error: unknown = null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: error ? null : { metadata }, error }),
        }),
      }),
    }),
  };
}

describe("createSupabaseOrderFulfillmentProviderKindReader", () => {
  it("reads providerKind from metadata.selectedDelivery (normalized)", async () => {
    const reader = createSupabaseOrderFulfillmentProviderKindReader(
      metadataClient({ selectedDelivery: { providerKind: "OmniPack" } }),
    );
    expect(await reader.readSelectedProviderKind("order-1")).toBe("omnipack");
  });

  it("falls back to metadata.runtimeFinalize.selectedDelivery", async () => {
    const reader = createSupabaseOrderFulfillmentProviderKindReader(
      metadataClient({ runtimeFinalize: { selectedDelivery: { providerKind: "omnipack" } } }),
    );
    expect(await reader.readSelectedProviderKind("order-1")).toBe("omnipack");
  });

  it("returns null when there is no selection", async () => {
    const reader = createSupabaseOrderFulfillmentProviderKindReader(metadataClient({ other: true }));
    expect(await reader.readSelectedProviderKind("order-1")).toBeNull();
  });

  it("throws on a query error so routing re-attempts", async () => {
    const reader = createSupabaseOrderFulfillmentProviderKindReader(metadataClient(null, { message: "boom" }));
    await expect(reader.readSelectedProviderKind("order-1")).rejects.toThrow();
  });
});
