import { expect, it, vi } from "vitest";
import { createOmnipackClient } from "../../../src/fulfillment/omnipack/client.js";
import { mapOmnipackProductResponse, mapOmnipackProductPackCreatedResponse } from "../../../src/fulfillment/omnipack/productSyncMappers.js";
import { buildOmnipackProductPackPayload, omnipackPackKindForQuantity } from "../../../src/fulfillment/omnipack/omnipackProductPackPayload.js";
import { config, jsonResponse } from "./fixtures.js";

it("reads product packs, filters EAN-less entries and tolerates sparse responses", () => {
  const body = { sku: "SKU-A", packs: [{ ean: "0000000000001", quantity: 1 }, { ean: "0000000000002", quantity: 12 }, { quantity: 3 }, "not-an-object"] };
  expect(mapOmnipackProductResponse(body, "fallback")).toEqual({ provider: "omnipack", sku: "SKU-A", packs: [{ ean: "0000000000001", quantity: 1 }, { ean: "0000000000002", quantity: 12 }], raw: body });
  expect(mapOmnipackProductResponse({}, "SKU-B")).toEqual({ provider: "omnipack", sku: "SKU-B", packs: [], raw: {} });
  expect(mapOmnipackProductResponse(null, "SKU-C").sku).toBe("SKU-C");
  expect(mapOmnipackProductResponse({ packs: "nope" }, "SKU-D").packs).toEqual([]);
  expect(mapOmnipackProductPackCreatedResponse({}, "SKU-A", "0000000000001")).toMatchObject({ sku: "SKU-A", ean: "0000000000001" });
});
it("uses explicit product and pack POST paths once, with encoded SKU and safe GET reads", async () => {
  const calls: Array<{ url: string; method?: string; body?: BodyInit | null }> = [];
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => { calls.push({ url: url.toString(), method: init?.method, body: init?.body }); return jsonResponse({}); });
  const client = createOmnipackClient({ ...config, productPath: "/products/" }, fetchImpl);
  await client.createProduct({ sku: "SKU/A" }, "SKU/A"); await client.getProduct("SKU/A"); await client.createProductPack("SKU/A", { ean: "0000000000001", quantity: 12 }, "0000000000001");
  expect(calls).toEqual([{ url: "https://warehouse.example.test/products/", method: "POST", body: '{"sku":"SKU/A"}' }, { url: "https://warehouse.example.test/products/SKU%2FA", method: "GET", body: undefined }, { url: "https://warehouse.example.test/products/SKU%2FA/packs", method: "POST", body: '{"ean":"0000000000001","quantity":12}' }]);
  for (const operation of ["product", "pack"]) {
    const failed = vi.fn(async () => jsonResponse({ code: "TEMPORARY" }, 503)); const c = createOmnipackClient(config, failed);
    await expect(operation === "product" ? c.createProduct({}, "SKU-A") : c.createProductPack("SKU-A", {}, "0000000000001")).rejects.toMatchObject({ retryable: false, mayHaveSucceeded: true }); expect(failed).toHaveBeenCalledOnce();
  }
});
it("refuses missing EAN or invalid pack quantity and preserves unit/collective classification", () => {
  expect(buildOmnipackProductPackPayload({ ean: " 0000000000001 ", quantity: 12 })).toEqual({ ean: "0000000000001", quantity: 12 });
  expect(() => buildOmnipackProductPackPayload({ ean: " ", quantity: 1 })).toThrow("missing_ean");
  for (const quantity of [0, -1, 1.5, NaN]) expect(() => buildOmnipackProductPackPayload({ ean: "0000000000001", quantity })).toThrow("invalid_quantity");
  expect(omnipackPackKindForQuantity(1)).toBe("unit"); expect(omnipackPackKindForQuantity(12)).toBe("collective");
});
