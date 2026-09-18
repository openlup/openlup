import { describe, expect, it } from "vitest";
import { resolveDeliverySelectionEvidence } from "./readDeliverySelectionEvidence.js";

const omnipack = { providerKind: "omnipack", carrierCode: "DPD", serviceCode: "DPD_COURIER_STANDARD" };

describe("resolveDeliverySelectionEvidence", () => {
  it("returns null evidence when no source carries a selection", () => {
    expect(resolveDeliverySelectionEvidence({})).toEqual({
      selection: null,
      providerKind: null,
      source: null,
    });
    expect(
      resolveDeliverySelectionEvidence({ orderMetadata: { other: true }, addressMetadata: {} }),
    ).toMatchObject({ selection: null, providerKind: null });
  });

  it("reads order-level selectedDelivery (the Wave-1 canonical path)", () => {
    const result = resolveDeliverySelectionEvidence({ orderMetadata: { selectedDelivery: omnipack } });
    expect(result.source).toBe("orderMetadata");
    expect(result.selection).toEqual(omnipack);
    expect(result.providerKind).toBe("omnipack");
  });

  it("reads metadata.runtimeFinalize.selectedDelivery (where checkout finalize nests it)", () => {
    const result = resolveDeliverySelectionEvidence({
      orderMetadata: { runtimeFinalize: { selectedDelivery: omnipack } },
    });
    expect(result.source).toBe("orderRuntimeFinalize");
    expect(result.providerKind).toBe("omnipack");
  });

  it("normalizes providerKind (trim + lowercase)", () => {
    expect(
      resolveDeliverySelectionEvidence({ orderMetadata: { selectedDelivery: { providerKind: "  OmniPack " } } })
        .providerKind,
    ).toBe("omnipack");
    // blank/missing providerKind on a present selection → null providerKind, selection kept
    const blank = resolveDeliverySelectionEvidence({ orderMetadata: { selectedDelivery: { providerKind: "  " } } });
    expect(blank.selection).toEqual({ providerKind: "  " });
    expect(blank.providerKind).toBeNull();
  });

  it("honors priority: fulfillment > order > runtimeFinalize > shipping snapshot > address", () => {
    const result = resolveDeliverySelectionEvidence({
      fulfillmentMetadata: { selectedDelivery: { providerKind: "from-fulfillment" } },
      orderMetadata: { selectedDelivery: { providerKind: "from-order" } },
      shippingAddressSnapshot: { selectedDelivery: { providerKind: "from-snapshot" } },
      addressMetadata: { selectedDelivery: { providerKind: "from-address" } },
    });
    expect(result.source).toBe("fulfillmentMetadata");
    expect(result.providerKind).toBe("from-fulfillment");
  });

  it("falls through to shipping snapshot then address metadata", () => {
    expect(
      resolveDeliverySelectionEvidence({ shippingAddressSnapshot: { selectedDelivery: omnipack } }).source,
    ).toBe("shippingAddressSnapshot");
    expect(
      resolveDeliverySelectionEvidence({ addressMetadata: { selectedDelivery: omnipack } }).source,
    ).toBe("addressMetadata");
  });

  it("unwraps array-wrapped joined rows (Supabase embeds can be arrays)", () => {
    const result = resolveDeliverySelectionEvidence({
      orderMetadata: [{ selectedDelivery: omnipack }],
    });
    expect(result.providerKind).toBe("omnipack");
  });

  it("SPLIT-BRAIN PARITY: routing (order-only) and dispatch (wide) agree for a Wave-1 order", () => {
    // A real Wave-1 checkout writes the selection to order metadata (runtimeFinalize).
    // Routing has only the order row; dispatch has the wider join. Given the same
    // authoritative order metadata, both must resolve the identical providerKind.
    const orderMetadata = { runtimeFinalize: { selectedDelivery: omnipack } };
    const routing = resolveDeliverySelectionEvidence({ orderMetadata });
    const dispatch = resolveDeliverySelectionEvidence({
      fulfillmentMetadata: null,
      orderMetadata,
      shippingAddressSnapshot: null,
      addressMetadata: null,
    });
    expect(routing.providerKind).toBe(dispatch.providerKind);
    expect(routing.providerKind).toBe("omnipack");
  });

  it("prefers an order-scoped contact override to legacy selection sources", () => {
    const current = { providerKind: "current", serviceCode: "CURRENT" };
    const legacy = { providerKind: "legacy", serviceCode: "LEGACY" };
    const result = resolveDeliverySelectionEvidence({
      orderMetadata: {
        runtimeFinalize: { deliveryContact: { selectedDelivery: legacy } },
        deliveryContactOverride: { selectedDelivery: current },
      },
      addressMetadata: { selectedDelivery: legacy },
    });

    expect(result).toEqual({
      selection: current,
      providerKind: "current",
      source: "orderDeliveryContactOverride",
    });
  });

  it("uses the parcel contact before every mutable or legacy selection source", () => {
    const parcel = { providerKind: "parcel", serviceCode: "PARCEL" };
    const result = resolveDeliverySelectionEvidence({
      fulfillmentMetadata: { selectedDelivery: { providerKind: "fulfillment" } },
      orderMetadata: { deliveryContactOverride: { selectedDelivery: { providerKind: "order" } } },
      shippingAddressSnapshot: { deliveryContact: { selectedDelivery: parcel } },
      addressMetadata: { selectedDelivery: { providerKind: "address" } },
    });

    expect(result).toEqual({
      selection: parcel,
      providerKind: "parcel",
      source: "shippingDeliveryContact",
    });
  });

  it.each([null, "malformed"])(
    "does not fall through a present parcel contact with %j selectedDelivery",
    (selectedDelivery) => {
      const result = resolveDeliverySelectionEvidence({
        fulfillmentMetadata: { selectedDelivery: { providerKind: "fulfillment" } },
        orderMetadata: { selectedDelivery: { providerKind: "order" } },
        shippingAddressSnapshot: { deliveryContact: { selectedDelivery } },
        addressMetadata: { selectedDelivery: { providerKind: "address" } },
      });

      expect(result).toEqual({
        selection: null,
        providerKind: null,
        source: "shippingDeliveryContact",
      });
    },
  );
});
