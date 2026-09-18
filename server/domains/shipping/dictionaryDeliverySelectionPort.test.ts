import { describe, expect, it } from "vitest";
import {
  createDictionaryDeliverySelectionPort,
  type OmnipackDeliveryCatalog,
} from "./dictionaryDeliverySelectionPort.js";

// Inline catalog fixture (domain test must not import server/infra). Mirrors the
// structurally-compatible subset the port consumes.
const dictionary: OmnipackDeliveryCatalog = {
  carriers: [
    { kind: "inpost", code: "INPOST", services: [{ code: "INPOST_LOCKER_STANDARD", deliveryKind: "parcel-locker", requiresPickupPoint: true }] },
    { kind: "dpd", code: "DPD", services: [{ code: "DPD_COURIER_STANDARD", deliveryKind: "courier", requiresPickupPoint: false }] },
    { kind: "dhl", code: "DHL", services: [{ code: "DHL_COURIER_STANDARD", deliveryKind: "courier", requiresPickupPoint: false }] },
  ],
  pickupPoints: {
    inpost: { requiresPointId: true, requiredFields: ["pointId"], normalization: null },
  },
};

function port(enabled: string[]) {
  return createDictionaryDeliverySelectionPort({ dictionary, enabledCarriers: new Set(enabled) });
}

describe("dictionary delivery-selection port", () => {
  it("derives options only for allowlisted carriers", async () => {
    const options = await port(["inpost", "dpd"]).listOptions();
    expect(options.map((o) => o.carrierKind).sort()).toEqual(["dpd", "inpost"]);
    // dhl is in the dictionary but not allowlisted -> excluded
    expect(options.some((o) => o.carrierKind === "dhl")).toBe(false);
  });

  it("maps dictionary carrier/service onto a well-formed omnipack option", async () => {
    const [inpost] = await port(["inpost"]).listOptions();
    expect(inpost).toMatchObject({
      providerKind: "omnipack",
      carrierKind: "inpost",
      carrierCode: "INPOST_LOCKER_STANDARD",
      serviceCode: "INPOST_LOCKER_STANDARD",
      service: "INPOST_LOCKER_STANDARD",
      deliveryKind: "parcel-locker",
      pickupPointRequired: true,
      addressRequired: false,
    });
  });

  it("returns no options when the allowlist is empty (fail-closed)", async () => {
    expect(await port([]).listOptions()).toEqual([]);
  });

  it("validates a pickup point for an allowlisted pickup carrier", async () => {
    const point = await port(["inpost"]).validatePickupPoint({ pointId: "WAW04A", carrierKind: "inpost" });
    expect(point).toMatchObject({ id: "WAW04A", provider: "inpost" });
  });

  it("rejects pickup points for non-allowlisted or non-pickup carriers", async () => {
    expect(await port(["dpd"]).validatePickupPoint({ pointId: "X", carrierKind: "inpost" })).toBeNull();
    expect(await port(["dpd"]).validatePickupPoint({ pointId: "X", carrierKind: "dpd" })).toBeNull();
  });
});
