import { describe, expect, it } from "vitest";
import type { DeliverySelectionPort } from "./deliverySelectionPort.js";

// deliverySelectionPort.ts is a types-only port interface. This companion test
// pins the contract: an implementation must accept an arbitrary (string) carrier
// kind for pickup validation — the relaxation that lets non-InPost OmniPack
// carriers (e.g. orlen) flow through the dictionary-driven port.
describe("DeliverySelectionPort contract", () => {
  it("accepts an implementation whose pickup validation takes any carrier kind", async () => {
    const port: DeliverySelectionPort = {
      async listOptions() {
        return [];
      },
      async validatePickupPoint({ pointId, carrierKind }) {
        return carrierKind === "orlen" && pointId
          ? { id: pointId, provider: carrierKind, name: pointId, address: { line1: pointId, postalCode: "00-000", city: "-", country: "PL" } }
          : null;
      },
    };
    expect(await port.listOptions()).toEqual([]);
    expect(await port.validatePickupPoint({ pointId: "ORL-1", carrierKind: "orlen" })).toMatchObject({ provider: "orlen" });
    expect(await port.validatePickupPoint({ pointId: "X", carrierKind: "dpd" })).toBeNull();
  });
});
