import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseCatalogSkuPacksPort,
  type CatalogSkuPacksSupabaseClient,
} from "./catalogSkuPacks.js";

describe("supabase catalog sku packs port", () => {
  it("reads, groups, and normalizes catalog SKU packs", async () => {
    const client = createClient({
      data: [
        row({ sku: "SKU-1", ean: "111", kind: "unit", quantity: 1, is_primary: true, source: "local" }),
        row({ sku: "SKU-1", ean: "222", kind: "collective", quantity: 12, is_primary: false, source: "omnipack" }),
        row({ sku: "", ean: "333" }),
        row({ sku: "SKU-2", ean: "" }),
        row({ sku: "SKU-2", ean: "444", kind: "weird", source: "manual" }),
      ],
      error: null,
    });

    await expect(
      createSupabaseCatalogSkuPacksPort(client).getCatalogSkuPacks(),
    ).resolves.toEqual({
      skus: [
        {
          sku: "SKU-1",
          packs: [
            { ean: "111", kind: "unit", quantity: 1, isPrimary: true, source: "local" },
            { ean: "222", kind: "collective", quantity: 12, isPrimary: false, source: "omnipack" },
          ],
        },
        {
          sku: "SKU-2",
          packs: [
            { ean: "444", kind: "unit", quantity: 1, isPrimary: false, source: "local" },
          ],
        },
      ],
      totalPacks: 3,
    });

    expect(client.from).toHaveBeenCalledWith("catalog_sku_eans");
    expect(client.select).toHaveBeenCalledWith("sku, ean, kind, quantity, is_primary, source");
    expect(client.order).toHaveBeenCalledWith("sku", { ascending: true });
    expect(client.order).toHaveBeenCalledWith("is_primary", { ascending: false });
  });

  it("throws on upstream query errors", async () => {
    const client = createClient({
      data: null,
      error: { message: "permission denied" },
    });

    await expect(
      createSupabaseCatalogSkuPacksPort(client).getCatalogSkuPacks(),
    ).rejects.toThrow("permission denied");
  });
});

function row(overrides: Partial<PackRow>): PackRow {
  return {
    sku: "SKU",
    ean: "111",
    kind: "unit",
    quantity: 1,
    is_primary: false,
    source: "local",
    ...overrides,
  };
}

interface PackRow {
  sku: string;
  ean: string;
  kind: string;
  quantity: number;
  is_primary: boolean;
  source: string;
}

function createClient(result: {
  data: PackRow[] | null;
  error: { message?: string } | null;
}) {
  const builder = {
    select: vi.fn(() => builder),
    order: vi.fn(() => builder),
    then: (resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return {
    from: vi.fn((table: "catalog_sku_eans") => {
      expect(table).toBe("catalog_sku_eans");
      return builder;
    }),
    select: builder.select,
    order: builder.order,
  } as unknown as CatalogSkuPacksSupabaseClient & {
    from: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
  };
}
