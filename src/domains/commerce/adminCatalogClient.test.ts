import { describe, expect, it, vi, beforeEach } from "vitest";

import { requestBff } from "@/lib/bff/client";

import {
  activateCatalogProduct,
  archiveCatalogSku,
  createCatalogDraft,
  setCatalogPrice,
} from "./adminCatalogClient";

vi.mock("@/lib/bff/client", () => ({
  requestBff: vi.fn().mockResolvedValue({ ok: true }),
}));

const mockedRequestBff = vi.mocked(requestBff);

beforeEach(() => {
  mockedRequestBff.mockClear();
});

const draft = {
  mode: "commit" as const,
  product: {
    slug: "duck",
    name: "Duck",
    species: "dog" as const,
    unit: "can" as const,
    sku: "OPENLUP-DOG-DUCK-CAN-400G",
    netWeightGrams: 400,
    kcalPerUnit: 480,
    allergens: ["duck"],
  },
};

describe("adminCatalogClient", () => {
  it("POSTs a draft to the create route with a bearer token", async () => {
    await createCatalogDraft("admin-token", draft);
    const [url, , options] = mockedRequestBff.mock.calls[0];
    expect(url).toBe("/api/bff/admin/commerce/catalog/create");
    expect(options?.method).toBe("POST");
    expect(options?.body).toEqual(draft);
    expect((options?.headers as Headers).get("Authorization")).toBe("Bearer admin-token");
  });

  it("POSTs a price to the set-price route", async () => {
    await setCatalogPrice("admin-token", {
      mode: "commit",
      sku: "OPENLUP-DOG-DUCK-CAN-400G",
      price: { mode: "one_time", unitPriceMinor: 2490, currency: "PLN" },
    });
    const [url, , options] = mockedRequestBff.mock.calls[0];
    expect(url).toBe("/api/bff/admin/commerce/catalog/set-price");
    expect(options?.method).toBe("POST");
  });

  it("POSTs an archive to the archive route", async () => {
    await archiveCatalogSku("admin-token", { mode: "commit", sku: "OPENLUP-DOG-DUCK-CAN-400G" });
    const [url] = mockedRequestBff.mock.calls[0];
    expect(url).toBe("/api/bff/admin/commerce/catalog/archive");
  });

  it("POSTs a publish to the activate route (human-only)", async () => {
    await activateCatalogProduct("admin-token", { mode: "commit", slug: "duck" });
    const [url, , options] = mockedRequestBff.mock.calls[0];
    expect(url).toBe("/api/bff/admin/commerce/catalog/activate");
    expect(options?.body).toEqual({ mode: "commit", slug: "duck" });
  });
});
