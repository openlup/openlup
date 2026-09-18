import { describe, expect, it, vi, beforeEach } from "vitest";

const { requestBff } = vi.hoisted(() => ({ requestBff: vi.fn() }));
vi.mock("@/lib/bff/client", () => ({ requestBff }));

import { getCatalogSkuPacks, getOpenProductReconciliationCount } from "./adminCatalogPacksClient";

describe("adminCatalogPacksClient", () => {
  beforeEach(() => {
    requestBff.mockReset();
  });

  it("GETs the SKU-EAN packs projection with the bearer token", async () => {
    const packs = { skus: [{ sku: "SKU-SAMPLE-0001", packs: [] }], totalPacks: 0 };
    requestBff.mockResolvedValue(packs);

    const result = await getCatalogSkuPacks("access-token-123");

    expect(result).toBe(packs);
    expect(requestBff).toHaveBeenCalledTimes(1);
    const [path, , options] = requestBff.mock.calls[0];
    expect(path).toBe("/api/bff/admin/commerce/catalog/sku-eans");
    expect(options.method).toBe("GET");
    expect((options.headers as Headers).get("Authorization")).toBe("Bearer access-token-123");
  });

  it("returns only the open count from the reconciliation-evidence read", async () => {
    requestBff.mockResolvedValue({ statusFilter: "open", openCount: 3, items: [] });

    const openCount = await getOpenProductReconciliationCount("tok");

    expect(openCount).toBe(3);
    const [path, , options] = requestBff.mock.calls[0];
    expect(path).toBe("/api/bff/admin/fulfillment/product-reconciliation-evidence?statusFilter=open");
    expect(options.method).toBe("GET");
    expect((options.headers as Headers).get("Authorization")).toBe("Bearer tok");
  });

  it("propagates a read failure for the caller to interpret", async () => {
    requestBff.mockRejectedValueOnce(new Error("unauthorized"));
    await expect(getCatalogSkuPacks("tok")).rejects.toThrow("unauthorized");
  });
});
