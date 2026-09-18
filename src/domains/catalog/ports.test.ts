import { describe, expect, it } from "vitest";
import {
  CatalogProductNotFoundError,
  type CatalogSkuEnvelopeReadPort,
} from "./ports.js";

describe("catalog ports", () => {
  it("names missing product errors with the requested slug", () => {
    const error = new CatalogProductNotFoundError("lamb");

    expect(error.name).toBe("CatalogProductNotFoundError");
    expect(error.message).toBe("Catalog product not found: lamb");
  });

  it("keeps the dark envelope port payload-free and paginated", async () => {
    const port: CatalogSkuEnvelopeReadPort = {
      listSkuEnvelopes: async ({ cursor, limit }) => ({ items: [], nextCursor: cursor ?? (limit === 1 ? "next" : null) }),
      listActiveSkuEnvelopes: async ({ cursor, limit }) => ({ items: [], nextCursor: cursor ?? (limit === 1 ? "next" : null) }),
      getSkuEnvelope: async () => null,
      getSkuEnvelopeById: async () => null,
    };

    await expect(port.listSkuEnvelopes({ cursor: null, limit: 1 })).resolves.toEqual({ items: [], nextCursor: "next" });
    await expect(port.listActiveSkuEnvelopes({ cursor: null, limit: 1 })).resolves.toEqual({ items: [], nextCursor: "next" });
    await expect(port.getSkuEnvelope({ kind: "sku_code", skuCode: "FORMULA-A-400" })).resolves.toBeNull();
    await expect(port.getSkuEnvelope({ kind: "primary_product_slug", productSlug: "formula-a" })).resolves.toBeNull();
    await expect(port.getSkuEnvelopeById("22222222-2222-4222-8222-222222222222")).resolves.toBeNull();
  });
});
