import { describe, expect, it, vi } from "vitest";

import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import { createReferenceCatalogItemsHandler } from "./referenceCatalogHandler.js";
import {
  SELLABLE_CATALOG_CONTRACT_VERSION,
  type SellableCatalogItem,
  type SellableCatalogProfile,
} from "../../../src/domains/catalog/contracts.js";
import type { SellableCatalogPort } from "../../../src/domains/catalog/ports.js";

const profile = {
  id: "reference-store-local",
  brand: "Reference Store",
  country: "US",
  currency: "USD",
  locale: "en-US",
  timezone: "Etc/UTC",
} satisfies SellableCatalogProfile;

const items = [{
  sku: "reference.standard",
  title: "Reference Standard",
  unitPrice: { amountMinor: 2_500, currency: "USD" },
  permittedPurchaseModes: ["one_time", "subscription"],
}] satisfies SellableCatalogItem[];

function response(): HttpResponse {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function catalogPort() {
  return {
    getStorefrontProfile: vi.fn(async () => profile),
    listSellableItems: vi.fn(async () => items),
  } satisfies SellableCatalogPort;
}

describe("reference catalog handler", () => {
  it("rejects non-GET methods without constructing catalog data", async () => {
    const port = catalogPort();
    const res = response();
    await createReferenceCatalogItemsHandler({ catalogPort: port })(
      { method: "POST", headers: {}, query: {} } as unknown as HttpRequest,
      res,
    );

    expect(port.getStorefrontProfile).not.toHaveBeenCalled();
    expect(port.listSellableItems).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
    });
  });

  it("returns the exact versioned reference catalog without caching", async () => {
    const port = catalogPort();
    const res = response();
    await createReferenceCatalogItemsHandler({ catalogPort: port })(
      { method: "GET", headers: {}, query: {} } as unknown as HttpRequest,
      res,
    );

    expect(port.getStorefrontProfile).toHaveBeenCalledOnce();
    expect(port.listSellableItems).toHaveBeenCalledOnce();
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: SELLABLE_CATALOG_CONTRACT_VERSION,
        profile,
        items,
      },
      meta: { contractVersion: SELLABLE_CATALOG_CONTRACT_VERSION },
    });
  });

  it("maps rejected catalog reads to a sanitized unavailable response", async () => {
    const port = catalogPort();
    port.listSellableItems.mockRejectedValue(new Error("sensitive upstream detail"));
    const res = response();
    await createReferenceCatalogItemsHandler({ catalogPort: port })(
      { method: "GET", headers: {}, query: {} } as unknown as HttpRequest,
      res,
    );

    expect(port.getStorefrontProfile).toHaveBeenCalledOnce();
    expect(port.listSellableItems).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "Reference catalog is unavailable",
      },
    });
    expect(JSON.stringify(vi.mocked(res.json).mock.calls)).not.toContain("sensitive upstream detail");
  });
});
