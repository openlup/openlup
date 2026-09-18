import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestBff } from "@/lib/bff/client";

import { fetchSellableBundles } from "./sellableBundleClient";
import {
  SELLABLE_BUNDLE_CONTRACT_VERSION,
  sellableBundleListResponseSchema,
} from "./sellableBundleContracts";

vi.mock("@/lib/bff/client", () => ({ requestBff: vi.fn().mockResolvedValue({}) }));

const mockedRequestBff = vi.mocked(requestBff);

beforeEach(() => mockedRequestBff.mockClear());

describe("sellableBundleClient", () => {
  it("reads the public feed route with GET and no credential", async () => {
    await fetchSellableBundles();

    expect(mockedRequestBff).toHaveBeenCalledTimes(1);
    const [path, schema, options] = mockedRequestBff.mock.calls[0];
    expect(path).toBe("/api/bff/catalog/bundles");
    expect(options?.method).toBe("GET");
    expect(options?.body).toBeUndefined();
    // The feed is public; an Authorization header here would be the first step
    // towards a storefront surface that answers differently when signed in.
    expect(new Headers(options?.headers).get("Authorization")).toBeNull();
    // The response contract is the same object the handler validates against, not
    // a second copy that could drift from it.
    expect(schema).toBe(sellableBundleListResponseSchema);
  });

  it("forwards caller options without letting them change the method", async () => {
    const signal = new AbortController().signal;
    await fetchSellableBundles({ signal, timeoutMs: 2_000 });

    const [, , options] = mockedRequestBff.mock.calls[0];
    expect(options).toMatchObject({ method: "GET", signal, timeoutMs: 2_000 });
  });

  it("parses a feed row through the strict contract it declares", () => {
    const parsed = sellableBundleListResponseSchema.parse({
      contractVersion: SELLABLE_BUNDLE_CONTRACT_VERSION,
      bundles: [
        {
          code: "starter-set",
          title: "Starter set",
          fulfillmentMode: "virtual",
          price: { amountMinor: 3333, currency: "XTS" },
          components: [
            { sku: "unit-a", quantity: 3, effectiveUnitPriceMinor: 758, lineSubtotalMinor: 2274, discountBps: 2420 },
            { sku: "unit-b", quantity: 2, effectiveUnitPriceMinor: 530, lineSubtotalMinor: 1060, discountBps: 2429 },
            { sku: "unit-b", quantity: 1, effectiveUnitPriceMinor: 0, lineSubtotalMinor: 0, discountBps: 2429 },
          ],
          availability: {
            status: "available",
            sellableNow: 12,
            limitingSku: "unit-a",
            reasonCode: "stock_available",
          },
        },
      ],
    });

    expect(parsed.bundles[0].price.currency).toBe("XTS");
    expect(() =>
      sellableBundleListResponseSchema.parse({
        contractVersion: SELLABLE_BUNDLE_CONTRACT_VERSION,
        bundles: [
          {
            code: "starter-set",
            title: "Starter set",
            fulfillmentMode: "virtual",
            // A lifecycle field cannot even be expressed in this feed: a draft must
            // not be able to reach a storefront by riding along in an extra key.
            status: "draft",
            price: { amountMinor: 100, currency: "XTS" },
            components: [
              { sku: "unit-a", quantity: 1, effectiveUnitPriceMinor: 100, lineSubtotalMinor: 100, discountBps: 0 },
            ],
            availability: {
              status: "available",
              sellableNow: 1,
              limitingSku: "unit-a",
              reasonCode: "stock_available",
            },
          },
        ],
      }),
    ).toThrow();
  });
});
