import { describe, expect, it } from "vitest";
import {
  deriveAdminFulfillmentActionPolicy,
  FULFILLMENT_PROVIDER_CAPABILITY_KEYS,
  getFulfillmentProviderCapabilityProfile,
  listFulfillmentProviderCapabilityProfiles,
  normalizeFulfillmentProviderKind,
  providerOwnsDeliveredNotification,
} from "./providerCapabilities";

describe("fulfillment provider capability registry", () => {
  it("lists the OSS provider plugin capability contract in a stable order", () => {
    expect(FULFILLMENT_PROVIDER_CAPABILITY_KEYS).toEqual([
      "autoDispatch",
      "stockEvidence",
      "trackingEvidence",
      "cancel",
      "pickupPoint",
      "labelCreation",
      "courierPickup",
    ]);
    expect(listFulfillmentProviderCapabilityProfiles().map((profile) => profile.kind)).toEqual([
      "simulator",
      "manual",
      "dhl",
      "omnipack",
    ]);
  });

  it("keeps DHL as a direct-carrier compatibility plugin", () => {
    expect(getFulfillmentProviderCapabilityProfile("dhl")).toMatchObject({
      kind: "dhl",
      role: "direct_carrier",
      capabilities: {
        autoDispatch: true,
        stockEvidence: false,
        trackingEvidence: true,
        cancel: false,
        pickupPoint: false,
        labelCreation: true,
        courierPickup: true,
      },
      actionPolicy: {
        providerSpecificAdminActions: true,
        genericAdminActions: true,
        mutationSurface: "provider_adapter",
      },
      stockAuthority: "local_atp",
    });
  });

  it("keeps OmniPack as a 3PL plugin with stock and pickup-point evidence", () => {
    expect(getFulfillmentProviderCapabilityProfile("omnipack")).toMatchObject({
      kind: "omnipack",
      role: "third_party_logistics",
      capabilities: {
        autoDispatch: true,
        stockEvidence: true,
        trackingEvidence: true,
        cancel: false,
        pickupPoint: true,
        labelCreation: false,
        courierPickup: false,
      },
      actionPolicy: {
        providerSpecificAdminActions: false,
        genericAdminActions: true,
        mutationSurface: "provider_adapter",
      },
      stockAuthority: "external_stock_master_with_local_reservations",
    });
  });

  it("keeps stock authority explicit so OSS providers can choose local ATP or an external stock master", () => {
    expect(getFulfillmentProviderCapabilityProfile("simulator")?.stockAuthority).toBe("local_atp");
    expect(getFulfillmentProviderCapabilityProfile("manual")?.stockAuthority).toBe("local_atp");
    expect(getFulfillmentProviderCapabilityProfile("dhl")?.stockAuthority).toBe("local_atp");
    expect(getFulfillmentProviderCapabilityProfile("omnipack")?.stockAuthority).toBe(
      "external_stock_master_with_local_reservations",
    );
  });

  it("maps hidden-preview fulfillment to the simulator profile without inventing a provider", () => {
    expect(normalizeFulfillmentProviderKind("hidden_preview_fulfillment")).toBe("simulator");
    expect(getFulfillmentProviderCapabilityProfile("hidden_preview_fulfillment")?.kind).toBe("simulator");
    expect(getFulfillmentProviderCapabilityProfile("unknown-provider")).toBeNull();
  });

  it("encodes the delivered-notification ownership policy (W6) in the capability map", () => {
    // No registered provider owns the customer "delivered" notice (OmniPack flipped on
    // 2026-09-14); unknown providers keep ownership with us too.
    expect(getFulfillmentProviderCapabilityProfile("omnipack")?.ownsDeliveredNotification).toBe(false);
    expect(getFulfillmentProviderCapabilityProfile("dhl")?.ownsDeliveredNotification).toBe(false);
    expect(getFulfillmentProviderCapabilityProfile("simulator")?.ownsDeliveredNotification).toBe(false);

    // Owner decision 2026-09-14: the platform sends its own delivered mail for OmniPack too.
    expect(providerOwnsDeliveredNotification("omnipack")).toBe(false);
    expect(providerOwnsDeliveredNotification("hidden_preview_fulfillment")).toBe(false);
    expect(providerOwnsDeliveredNotification("dhl")).toBe(false);
    expect(providerOwnsDeliveredNotification(null)).toBe(false);
    expect(providerOwnsDeliveredNotification("unknown-provider")).toBe(false);
  });

  it("derives the admin action policy so ONLY a 3PL (auto-dispatch + no local label) hides the manual chain", () => {
    // autoLabelAndHandoff === autoDispatch && !labelCreation.
    // simulator: auto+label → false (hidden-preview manual chain + E2E must keep working)
    // manual:   !auto+!label → false
    // dhl:       auto+label → false
    // omnipack:  auto+!label → true (the only 3PL that auto-generates the label)
    expect(deriveAdminFulfillmentActionPolicy("simulator")?.autoLabelAndHandoff).toBe(false);
    expect(deriveAdminFulfillmentActionPolicy("hidden_preview_fulfillment")?.autoLabelAndHandoff).toBe(false);
    expect(deriveAdminFulfillmentActionPolicy("manual")?.autoLabelAndHandoff).toBe(false);
    expect(deriveAdminFulfillmentActionPolicy("dhl")?.autoLabelAndHandoff).toBe(false);
    expect(deriveAdminFulfillmentActionPolicy("omnipack")?.autoLabelAndHandoff).toBe(true);

    expect(deriveAdminFulfillmentActionPolicy("omnipack")).toMatchObject({
      role: "third_party_logistics",
      displayName: "OmniPack",
      autoLabelAndHandoff: true,
    });
    // Unknown/missing provider → null, so the panel falls back to the uniform manual chain.
    expect(deriveAdminFulfillmentActionPolicy("unknown-provider")).toBeNull();
    expect(deriveAdminFulfillmentActionPolicy(null)).toBeNull();
  });
});
