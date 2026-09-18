import { describe, expect, it } from "vitest";
import {
  mapOmnipackProductPackCreatedResponse,
  mapOmnipackProductResponse,
} from "./productSyncMappers.js";

describe("mapOmnipackProductResponse", () => {
  it("maps a product's packs[] and drops EAN-less packs", () => {
    expect(
      mapOmnipackProductResponse(
        {
          sku: "OPENLUP-DOG-LAMB-CAN-400G",
          packs: [
            { ean: "5908121193005", quantity: 1 },
            { ean: "5908121193999", quantity: 12 },
            { quantity: 3 },
            "not-an-object",
          ],
        },
        "fallback",
      ),
    ).toEqual({
      provider: "omnipack",
      sku: "OPENLUP-DOG-LAMB-CAN-400G",
      packs: [
        { ean: "5908121193005", quantity: 1 },
        { ean: "5908121193999", quantity: 12 },
      ],
      raw: {
        sku: "OPENLUP-DOG-LAMB-CAN-400G",
        packs: [
          { ean: "5908121193005", quantity: 1 },
          { ean: "5908121193999", quantity: 12 },
          { quantity: 3 },
          "not-an-object",
        ],
      },
    });
  });

  it("falls back to the request sku and tolerates a sparse / non-object body", () => {
    expect(mapOmnipackProductResponse({}, "OPENLUP-X")).toEqual({
      provider: "omnipack",
      sku: "OPENLUP-X",
      packs: [],
      raw: {},
    });
    expect(mapOmnipackProductResponse(null, "OPENLUP-Y").sku).toBe("OPENLUP-Y");
    expect(mapOmnipackProductResponse({ packs: "nope" }, "OPENLUP-Z").packs).toEqual([]);
  });
});

describe("mapOmnipackProductPackCreatedResponse", () => {
  it("echoes the created pack, falling back to the request sku/ean", () => {
    expect(mapOmnipackProductPackCreatedResponse({ sku: "S", ean: "E" }, "req-sku", "req-ean")).toEqual({
      provider: "omnipack",
      sku: "S",
      ean: "E",
      raw: { sku: "S", ean: "E" },
    });
    expect(mapOmnipackProductPackCreatedResponse({}, "req-sku", "req-ean")).toMatchObject({
      sku: "req-sku",
      ean: "req-ean",
    });
  });
});
