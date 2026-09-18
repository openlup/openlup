import { describe, expect, it } from "vitest";

import { buildCloneCreatePayload } from "./adminCatalogClone.js";
import { CatalogRpcError } from "../../domains/commerce/adminCatalogDataPort.js";
import type { CatalogProductDetail } from "../../../src/domains/commerce/adminCatalogReadContracts.js";
import type { CloneCatalogDraftRequest } from "../../../src/domains/commerce/adminCatalogLifecycleContracts.js";

function sourceDetail(overrides: Partial<CatalogProductDetail> = {}): CatalogProductDetail {
  return {
    slug: "duck",
    name: "Duck recipe",
    status: "active",
    species: "dog",
    allergens: ["duck"],
    marketingContent: null,
    skus: [
      {
        sku: "OPENLUP-DOG-DUCK-CAN-400G",
        status: "active",
        petType: "dog",
        title: "Duck recipe",
        netWeightGrams: 400,
        formatCode: "can",
        unitFormCode: "can",
        kcalPerUnit: 480,
        gtin: null,
        priceEntries: [],
      },
    ],
    readyToPublish: true,
    publishBlockers: [],
    ...overrides,
  };
}

const cloneRequest: CloneCatalogDraftRequest = {
  mode: "commit",
  sourceSlug: "duck",
  slug: "duck-copy",
  sku: "OPENLUP-DOG-DUCKCOPY-CAN-400G",
};

describe("buildCloneCreatePayload", () => {
  it("maps source structural fields onto the new slug + sku (copies the rest)", () => {
    const payload = buildCloneCreatePayload(sourceDetail(), cloneRequest);
    expect(payload).toEqual({
      slug: "duck-copy", // caller's NEW slug
      name: "Duck recipe", // copied
      species: "dog", // from product detail
      unit: "can", // from source SKU unitFormCode
      sku: "OPENLUP-DOG-DUCKCOPY-CAN-400G", // caller's NEW sku
      netWeightGrams: 400, // copied
      kcalPerUnit: 480, // copied
      allergens: ["duck"], // copied
    });
  });

  it("falls back to the SKU petType for species and formatCode for unit when absent", () => {
    const payload = buildCloneCreatePayload(
      sourceDetail({
        species: null,
        skus: [
          {
            sku: "OPENLUP-CAT-X-CAN-400G",
            status: "archived",
            petType: "cat",
            title: "x",
            netWeightGrams: 200,
            formatCode: "pouch",
            unitFormCode: null,
            kcalPerUnit: 150,
            gtin: null,
            priceEntries: [],
          },
        ],
      }),
      cloneRequest,
    );
    expect(payload.species).toBe("cat");
    expect(payload.unit).toBe("pouch");
    expect(payload.netWeightGrams).toBe(200);
  });

  it("throws when the source product has no SKU (clone is 1:1)", () => {
    expect(() => buildCloneCreatePayload(sourceDetail({ skus: [] }), cloneRequest)).toThrow(
      CatalogRpcError,
    );
  });
});
