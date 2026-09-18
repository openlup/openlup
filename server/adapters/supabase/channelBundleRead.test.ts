import { describe, expect, it, vi } from "vitest";
import { createChannelBundleRead } from "./channelBundleRead.js";
import { createManagedBundleCatalogStore } from "./bundleCatalogStore.js";

type Store = ReturnType<typeof createManagedBundleCatalogStore>;

function store(compositions: unknown[], calls: unknown[] = []): Store {
  return {
    listActiveBundleCompositions: vi.fn(async (input: unknown) => {
      calls.push(input);
      return compositions;
    }),
  } as unknown as Store;
}

const composition = {
  code: "starter",
  title: "Starter",
  fulfillmentMode: "virtual",
  currency: "XTS",
  targetPriceMinor: 1800,
  mode: "one_time",
  components: [
    {
      sku: "SKU-A",
      title: "A",
      productSlug: "a",
      variantId: "variant-a",
      quantity: 2,
      isAddon: false,
      sortOrder: 0,
      referenceUnitPriceMinor: 1000,
    },
  ],
};

describe("channel bundle catalogue read", () => {
  it("narrows an active composition to the two facts the expansion weights by", async () => {
    const calls: unknown[] = [];
    const read = createChannelBundleRead(store([composition], calls));

    await expect(read.readActiveBundleCompositions({ currency: "XTS" })).resolves.toEqual([
      {
        bundleCode: "starter",
        components: [{ skuCode: "SKU-A", quantity: 2, referenceUnitPriceMinor: 1000 }],
      },
    ]);
    // The channel's currency reaches the catalogue: a bundle priced only in another currency must
    // not be sellable on this surface.
    expect(calls).toEqual([{ currency: "XTS" }]);
  });

  it("carries an absent reference price through rather than defaulting it", async () => {
    const read = createChannelBundleRead(
      store([
        {
          ...composition,
          components: [{ ...composition.components[0], referenceUnitPriceMinor: null }],
        },
      ]),
    );
    const [narrowed] = await read.readActiveBundleCompositions({ currency: "XTS" });
    // Null is what makes the expansion refuse rather than weight by a number nobody stated.
    expect(narrowed.components[0].referenceUnitPriceMinor).toBeNull();
  });

  it("answers an empty catalogue with an empty set, not a refusal", async () => {
    const read = createChannelBundleRead(store([]));
    await expect(read.readActiveBundleCompositions({ currency: "XTS" })).resolves.toEqual([]);
  });
});
