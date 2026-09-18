import { describe, expect, it } from "vitest";
import type { PickupPointSearchPort } from "./pickupPointSearchPort.js";

// Types-only port. Companion test pins the contract: an implementation resolves
// to a list of points (empty for unsupported carriers, never throws).
describe("PickupPointSearchPort contract", () => {
  it("accepts an implementation that returns points and empties unsupported carriers", async () => {
    const port: PickupPointSearchPort = {
      async searchPickupPoints(request) {
        return request.carrierKind === "inpost"
          ? [{
              id: "WAW01A",
              carrierKind: "inpost",
              name: "InPost WAW01A",
              address: { line1: "Prosta 20", postalCode: "00-850", city: "Warszawa", country: "PL" },
              location: { latitude: 52.23, longitude: 21.0 },
              locationDescription: null,
              openingHours: "24/7",
              distanceMeters: 120,
              pointKind: "locker",
              appAssisted: false,
            }]
          : [];
      },
    };
    expect(await port.searchPickupPoints({ carrierKind: "inpost", city: "Warszawa" })).toHaveLength(1);
    expect(await port.searchPickupPoints({ carrierKind: "orlen", city: "Warszawa" })).toEqual([]);
  });
});
