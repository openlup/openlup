import { describe, expect, it, vi } from "vitest";
import { readSubscriptionLines } from "./customerAccountSubscriptionLinesReadModel.js";

describe("readSubscriptionLines", () => {
  it("joins catalog product display fields onto subscription lines", async () => {
    const skuSelect = vi.fn(() => ({
      in: vi.fn(async () => ({
        data: [
          {
            id: "sku-1",
            sku: "OPENLUP-VENISON-400",
            title: "Venison + EntoPro™ Recipe",
            catalog_products: { slug: "venison" },
          },
        ],
        error: null,
      })),
    }));
    const client = {
      from: vi.fn((table: string) => {
        if (table === "subscription_lines") {
          return {
            select: vi.fn(() => ({
              in: vi.fn(() => ({
                order: vi.fn(async () => ({
                  data: [
                    {
                      id: "line-1",
                      subscription_id: "sub-1",
                      variant_id: "sku-1",
                      qty: 7,
                      sort_order: 0,
                      is_addon: false,
                      line_metadata: {},
                    },
                  ],
                  error: null,
                })),
              })),
            })),
          };
        }
        return {
          select: skuSelect,
          in: vi.fn(),
        };
      }),
    };

    const linesBySubscription = await readSubscriptionLines(client as never, ["sub-1"]);

    // The pair catalog_skus/catalog_products has two FK relationships since
    // migration 20260827220000; an unhinted embed fails live with PGRST201.
    expect(skuSelect).toHaveBeenCalledWith(
      "id, sku, title, catalog_products!catalog_skus_product_id_fkey(slug)",
    );

    expect(linesBySubscription.get("sub-1")).toEqual([
      {
        lineId: "line-1",
        variantId: "sku-1",
        qty: 7,
        sortOrder: 0,
        isAddon: false,
        title: "Venison + EntoPro™ Recipe",
        sku: "OPENLUP-VENISON-400",
        recipeName: null,
        productSlug: "venison",
        flavourSlug: "venison",
        displayLabel: "Dziczyzna + EntoPro™",
        accentColor: "#8B1A4A",
        unitPrice: null,
        lineSubtotal: null,
      },
    ]);
  });
});
