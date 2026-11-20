import { describe, expect, it, vi } from "vitest";
import {
  createFulfillmentProviderRegistry,
  FULFILLMENT_STATUS_EFFECTS,
} from "../../src/fulfillment/index.js";
import type { FulfillmentCapabilityDescriptor, FulfillmentProviderAdapter } from "../../src/fulfillment/contracts/index.js";
import { observationStatusPolicy } from "../../src/fulfillment/observationProjection.js";

function syntheticFulfillmentAdapter(providerRef: string): FulfillmentProviderAdapter {
  const unsupported = { supported: false, reason: "not_exposed" } as const;
  const supported = { supported: true } as const;
  const capabilities: FulfillmentCapabilityDescriptor = {
    providerRef,
    role: "warehouse",
    operations: {
      dispatch: supported,
      readback: supported,
      exactAbsence: unsupported,
      verifyObservation: supported,
      syncStock: supported,
      syncProducts: unsupported,
      labelCreate: unsupported,
      labelRead: unsupported,
      labelVoid: unsupported,
      cancel: unsupported,
      pickupPoint: unsupported,
      courierPickup: unsupported,
    },
    authentication: "token",
    freshness: "authenticated_timestamp",
    defaultOff: true,
    selected: true,
    readiness: { ready: true },
    ownsDeliveredNotification: false,
    stockAuthority: "external_stock_master_with_local_reservations",
    intakeMode: "webhook",
    labelReadOwner: "none",
    actionPolicy: {
      providerSpecificAdminActions: false,
      genericAdminActions: true,
      mutationSurface: "provider_adapter",
    },
  };
  return {
    capabilities,
    dispatch: {
      prepare: vi.fn(),
      dispatch: vi.fn(),
    },
  };
}

describe("FulfillmentProviderRegistry and neutral FULFILLMENT_STATUS_EFFECTS", () => {
  it("registers adapters by providerRef and rejects duplicates, blanks, or untrimmed refs", () => {
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
    expect(() => createFulfillmentProviderRegistry([syntheticFulfillmentAdapter(" warehouse-a ")]))
      .toThrow("fulfillment_provider_ref_untrimmed:warehouse-a");
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
