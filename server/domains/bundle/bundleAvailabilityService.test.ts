import { describe, expect, it } from "vitest";

import { createBundleAvailabilityService } from "./bundleAvailabilityService.js";
import type {
  ActiveBundleComposition,
  BundleCatalogReadPort,
  BundleComponentRow,
} from "./bundleCatalogReadPort.js";
import type { CommerceOfferAvailabilityPort } from "../../../src/domains/commerce/ports.js";

function component(sku: string, quantity = 1, isAddon = false): BundleComponentRow {
  return {
    sku,
    title: `Unit ${sku}`,
    productSlug: `product-${sku}`,
    variantId: `variant-${sku}`,
    quantity,
    isAddon,
    sortOrder: 0,
    referenceUnitPriceMinor: 1000,
  };
}

function composition(code: string, components: BundleComponentRow[]): ActiveBundleComposition {
  return {
    code,
    title: `Bundle ${code}`,
    fulfillmentMode: "virtual",
    currency: "XTS",
    targetPriceMinor: 1500,
    mode: "one_time",
    components,
  };
}

function readPort(compositions: ActiveBundleComposition[]): BundleCatalogReadPort {
  return {
    listBundles: () => Promise.resolve({ bundles: [], total: 0 }),
    getBundle: () => Promise.resolve(null),
    listActiveBundleCompositions: () => Promise.resolve(compositions),
    listBundleHistory: () => Promise.resolve({ events: [], total: 0 }),
  };
}

function availabilityPort(
  stock: Record<string, number | null>,
  calls: Array<readonly { sku: string }[]> = [],
): CommerceOfferAvailabilityPort {
  return {
    getAvailability({ items }) {
      calls.push(items.map((item) => ({ sku: item.sku })));
      return Promise.resolve(
        items
          .filter((item) => item.sku in stock)
          .map((item) => ({
            sku: item.sku,
            productSlug: item.productSlug,
            variantId: item.variantId,
            status: "available" as const,
            visibleInConfigurator: true,
            sellableNow: stock[item.sku],
            reasonCode: "stock_available",
            source: "test",
          })),
      );
    },
  };
}

describe("createBundleAvailabilityService", () => {
  it("folds one batched stock answer into every composition", async () => {
    const calls: Array<readonly { sku: string }[]> = [];
    const service = createBundleAvailabilityService({
      bundleCatalogReadPort: readPort([
        composition("set-one", [component("unit-a"), component("unit-b", 2)]),
        composition("set-two", [component("unit-b", 5), component("unit-c")]),
      ]),
      offerAvailabilityPort: availabilityPort({ "unit-a": 40, "unit-b": 21, "unit-c": 9 }, calls),
    });

    const rows = await service.describeActiveBundles();

    expect(rows.map((row) => row.composition.code)).toEqual(["set-one", "set-two"]);
    expect(rows[0].availability).toEqual({
      sellableNow: 10,
      status: "available",
      reasonCode: "stock_available",
      limitingSku: "unit-b",
    });
    expect(rows[1].availability.sellableNow).toBe(4);
    expect(rows[1].availability.limitingSku).toBe("unit-b");
    // ONE call, and the shared unit is asked about exactly once.
    expect(calls).toHaveLength(1);
    expect(calls[0].map((item) => item.sku)).toEqual(["unit-a", "unit-b", "unit-c"]);
  });

  it("treats a sku the availability port never answers for as unknown, not zero", async () => {
    const service = createBundleAvailabilityService({
      bundleCatalogReadPort: readPort([
        composition("set-one", [component("unit-a"), component("unit-missing")]),
      ]),
      offerAvailabilityPort: availabilityPort({ "unit-a": 40 }),
    });

    const [row] = await service.describeActiveBundles();

    expect(row.availability.sellableNow).toBeNull();
    expect(row.availability.status).toBe("unknown");
    expect(row.availability.reasonCode).toBe("component_stock_unknown");
    expect(row.availability.limitingSku).toBe("unit-missing");
  });

  it("propagates an explicit null figure the same way", async () => {
    const service = createBundleAvailabilityService({
      bundleCatalogReadPort: readPort([]),
      offerAvailabilityPort: availabilityPort({ "unit-a": null }),
    });

    const [row] = await service.describeCompositions([
      composition("set-one", [component("unit-a")]),
    ]);

    expect(row.availability.status).toBe("unknown");
    expect(row.availability.limitingSku).toBe("unit-a");
  });

  it("passes the threshold and the add-on stance through to the kernel", async () => {
    const compositions = [
      composition("set-one", [component("unit-a"), component("unit-addon", 1, true)]),
    ];
    const stock = { "unit-a": 8, "unit-addon": 1 };

    const permissive = await createBundleAvailabilityService({
      bundleCatalogReadPort: readPort(compositions),
      offerAvailabilityPort: availabilityPort(stock),
    }).describeActiveBundles();
    const strict = await createBundleAvailabilityService({
      bundleCatalogReadPort: readPort(compositions),
      offerAvailabilityPort: availabilityPort(stock),
      lowStockThreshold: 10,
      includeAddonsInStock: true,
    }).describeActiveBundles();

    expect(permissive[0].availability).toMatchObject({ sellableNow: 8, status: "available" });
    expect(strict[0].availability).toMatchObject({
      sellableNow: 1,
      status: "low_stock",
      limitingSku: "unit-addon",
    });
  });

  it("never calls the availability port for an empty set", async () => {
    const calls: Array<readonly { sku: string }[]> = [];
    const service = createBundleAvailabilityService({
      bundleCatalogReadPort: readPort([]),
      offerAvailabilityPort: availabilityPort({}, calls),
    });

    expect(await service.describeActiveBundles()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("forwards the currency narrowing to the read port", async () => {
    const seen: Array<{ currency?: string } | undefined> = [];
    const service = createBundleAvailabilityService({
      bundleCatalogReadPort: {
        ...readPort([]),
        listActiveBundleCompositions: (input) => {
          seen.push(input);
          return Promise.resolve([]);
        },
      },
      offerAvailabilityPort: availabilityPort({}),
    });

    await service.describeActiveBundles({ currency: "XTS" });

    expect(seen).toEqual([{ currency: "XTS" }]);
  });
});
