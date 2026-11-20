import { describe, expect, it, vi } from "vitest";
import {
  createFulfillmentProviderRegistry,
  FULFILLMENT_STATUS_EFFECTS,
} from "../../src/fulfillment/index.js";
import type { FulfillmentProviderAdapter } from "../../src/fulfillment/contracts/index.js";
import { observationStatusPolicy } from "../../src/fulfillment/observationProjection.js";

function syntheticFulfillmentAdapter(providerRef: string): FulfillmentProviderAdapter {
  return {
    capabilities: {
      providerRef,
      selected: true,
      readiness: { ready: true },
      intakeMode: "webhook",
      dispatch: "supported",
      labelCreation: "unsupported",
      labelRead: "unsupported",
      labelVoid: "unsupported",
      observationIngress: "supported",
      reconciliationReadback: "supported",
      stockSync: "supported",
      stockMovements: "unsupported",
      productSync: "unsupported",
      pickupPoints: "unsupported",
      carrierServices: "host_mapped",
    } as FulfillmentProviderAdapter["capabilities"],
    dispatch: {
      prepare: vi.fn(),
      dispatch: vi.fn(),
    },
  };
}

describe("FulfillmentProviderRegistry and neutral FULFILLMENT_STATUS_EFFECTS", () => {
  it("registers adapters by providerRef and rejects duplicates or blanks", () => {
    const a = syntheticFulfillmentAdapter("warehouse-a");
    const b = syntheticFulfillmentAdapter("warehouse-b");
    const registry = createFulfillmentProviderRegistry([a, b]);
    expect(registry.refs()).toEqual(["warehouse-a", "warehouse-b"]);
    expect(registry.get("warehouse-a")).toBe(a);
    expect(registry.get("missing")).toBeNull();
    expect(registry.requireAdapter("warehouse-b")).toBe(b);
    expect(() => registry.requireAdapter("missing")).toThrow("unknown_fulfillment_provider_ref:missing");
    expect(() => createFulfillmentProviderRegistry([a, syntheticFulfillmentAdapter("warehouse-a")]))
      .toThrow("duplicate_fulfillment_provider_ref:warehouse-a");
    expect(() => createFulfillmentProviderRegistry([syntheticFulfillmentAdapter(" ")]))
      .toThrow("fulfillment_provider_ref_required");
  });

  it("derives observationStatusPolicy directly from FULFILLMENT_STATUS_EFFECTS", () => {
    for (const [status, effect] of Object.entries(FULFILLMENT_STATUS_EFFECTS)) {
      const typed = status as keyof typeof FULFILLMENT_STATUS_EFFECTS;
      expect(observationStatusPolicy.consumesStock(typed)).toBe(effect.consumesStock);
      expect(observationStatusPolicy.handsOver(typed)).toBe(effect.handsOver);
      expect(observationStatusPolicy.suppressDispatched(typed)).toBe(effect.suppressDispatchedNotification);
    }
    expect(observationStatusPolicy.trackingStatus("in_transit")).toBe("in_transit");
    expect(observationStatusPolicy.trackingStatus("delivered")).toBe("delivered");
  });
});
