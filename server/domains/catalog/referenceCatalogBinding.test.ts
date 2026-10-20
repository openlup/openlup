import { expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import { installObservedRequestContext } from "../../_lib/observability/requestContext.js";
import { createReferenceCatalogItemsHandler } from "./referenceCatalogHandler.js";

it("retains the observed request reference through the package handler binding", async () => {
  const req = { method: "GET", headers: { "x-request-id": "bff-axiom-canary-catalog-binding" }, query: {} } as unknown as HttpRequest;
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  installObservedRequestContext(req, res);
  await createReferenceCatalogItemsHandler({ catalogPort: {
    getStorefrontProfile: async () => ({ id: "reference", brand: "Reference", country: "US", currency: "USD", locale: "en-US", timezone: "Etc/UTC" }),
    listSellableItems: async () => [{ sku: "ITEM-1", title: "Item", unitPrice: { amountMinor: 100, currency: "USD" }, permittedPurchaseModes: ["one_time"] }],
  } })(req, res);
  expect(res.setHeader).toHaveBeenCalledWith("x-request-id", "bff-axiom-canary-catalog-binding");
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
    ok: true, meta: { contractVersion: "catalog.sellable.v1", requestId: "bff-axiom-canary-catalog-binding" },
  }));
});
