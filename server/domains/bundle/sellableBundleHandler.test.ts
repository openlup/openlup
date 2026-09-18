import { describe, expect, it } from "vitest";

import { createSellableBundleHandler, toSellableBundle } from "./sellableBundleHandler.js";
import type { BundleAvailabilityRow } from "./bundleAvailabilityService.js";
import type { ActiveBundleComposition, BundleComponentRow } from "./bundleCatalogReadPort.js";
import { sellableBundleListResponseSchema } from "../../../src/domains/bundle/sellableBundleContracts.js";
import type { BundleAvailability } from "../../../src/domains/bundle/availability.js";

type Handler = ReturnType<typeof createSellableBundleHandler>;
type Res = Parameters<Handler>[1];
type Req = Parameters<Handler>[0];

function capture() {
  const sent: { status?: number; body?: unknown; headers: Record<string, unknown> } = {
    headers: {},
  };
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      return res;
    },
    setHeader(name: string, value: unknown) {
      sent.headers[name] = value;
      return res;
    },
    end() {
      return res;
    },
  } as unknown as Res;
  return { res, sent };
}

function component(
  sku: string,
  unitPriceMinor: number | null,
  quantity = 1,
): BundleComponentRow {
  return {
    sku,
    title: `Unit ${sku}`,
    productSlug: `product-${sku}`,
    variantId: `variant-${sku}`,
    quantity,
    isAddon: false,
    sortOrder: 0,
    referenceUnitPriceMinor: unitPriceMinor,
  };
}

function composition(
  code: string,
  targetPriceMinor: number,
  components: BundleComponentRow[],
): ActiveBundleComposition {
  return {
    code,
    title: `Bundle ${code}`,
    fulfillmentMode: "virtual",
    currency: "XTS",
    targetPriceMinor,
    mode: "one_time",
    components,
  };
}

const AVAILABLE: BundleAvailability = {
  sellableNow: 12,
  status: "available",
  reasonCode: "stock_available",
  limitingSku: "unit-a",
};

/**
 * The cases below state a composition and a bundle-level availability, which is all this feed
 * reads. The service also carries the per-component rows the admin detail renders; they are
 * DERIVED from the composition here rather than restated, so a case cannot accidentally describe a
 * component set the composition does not have.
 */
type FeedRow = Omit<BundleAvailabilityRow, "components">;

function fill(rows: FeedRow[]): BundleAvailabilityRow[] {
  return rows.map((row) => ({
    ...row,
    components: row.composition.components.map((component) => ({
      sku: component.sku,
      quantity: component.quantity,
      isAddon: component.isAddon,
      sellableNow: row.availability.sellableNow,
    })),
  }));
}

function service(rows: FeedRow[]) {
  const filled = fill(rows);
  return {
    describeCompositions: () => Promise.resolve(filled),
    describeActiveBundles: () => Promise.resolve(filled),
  };
}

async function feed(rows: FeedRow[], enabled = true) {
  const { res, sent } = capture();
  await createSellableBundleHandler({ availabilityService: service(rows), enabled })(
    { method: "GET" } as Req,
    res,
  );
  return sent;
}

describe("sellable bundle feed", () => {
  it("keeps the sum of the derived lines exactly equal to the bundle price", async () => {
    // 3 x 1000 + 2 x 700 = 4400 reference; a 3333 target divides unevenly on
    // purpose, so the allocator must split at least one component across two lines.
    const sent = await feed([
      {
        composition: composition("set-one", 3333, [
          component("unit-a", 1000, 3),
          component("unit-b", 700, 2),
        ]),
        availability: AVAILABLE,
      },
    ]);

    const parsed = sellableBundleListResponseSchema.parse(
      (sent.body as { data: unknown }).data,
    );
    const bundle = parsed.bundles[0];
    const total = bundle.components.reduce((sum, line) => sum + line.lineSubtotalMinor, 0);

    expect(total).toBe(bundle.price.amountMinor);
    expect(total).toBe(3333);
    // Every emitted line reconciles on its own terms too — that is what makes an
    // order line derivable from the feed instead of merely consistent in total.
    for (const line of bundle.components) {
      expect(line.effectiveUnitPriceMinor * line.quantity).toBe(line.lineSubtotalMinor);
    }
    expect(bundle.availability).toEqual({
      status: "available",
      sellableNow: 12,
      limitingSku: "unit-a",
      reasonCode: "stock_available",
    });
  });

  it("holds the sum identity across a table of awkward targets", () => {
    // 5 is the exact floor for this set (five units at one minor unit each) and
    // 4400 the exact reference total; both ends are inclusive, and the values
    // between are chosen to force remainders in the largest-remainder split.
    const targets = [5, 6, 999, 1000, 2001, 3333, 4399, 4400];
    for (const targetPriceMinor of targets) {
      const bundle = toSellableBundle(
        composition("set-one", targetPriceMinor, [
          component("unit-a", 1000, 3),
          component("unit-b", 700, 2),
        ]),
        AVAILABLE,
      );
      expect(bundle, `target ${targetPriceMinor}`).not.toBeNull();
      const total = (bundle as NonNullable<typeof bundle>).components.reduce(
        (sum, line) => sum + line.lineSubtotalMinor,
        0,
      );
      expect(total, `target ${targetPriceMinor}`).toBe(targetPriceMinor);
    }
  });

  it("drops a bundle whose money cannot be derived rather than guessing it", async () => {
    const sent = await feed([
      // An unpriced component.
      {
        composition: composition("set-unpriced", 900, [
          component("unit-a", 1000),
          component("unit-b", null),
        ]),
        availability: AVAILABLE,
      },
      // A target above the sum of the parts: the kernel refuses it.
      {
        composition: composition("set-overpriced", 5000, [component("unit-a", 1000)]),
        availability: AVAILABLE,
      },
      // An empty composition.
      { composition: composition("set-empty", 100, []), availability: AVAILABLE },
      { composition: composition("set-ok", 900, [component("unit-a", 1000)]), availability: AVAILABLE },
    ]);

    const parsed = sellableBundleListResponseSchema.parse(
      (sent.body as { data: unknown }).data,
    );
    expect(parsed.bundles.map((bundle) => bundle.code)).toEqual(["set-ok"]);
  });

  it("carries the unknown stock verdict through instead of flattening it to zero", async () => {
    const sent = await feed([
      {
        composition: composition("set-one", 900, [component("unit-a", 1000)]),
        availability: {
          sellableNow: null,
          status: "unknown",
          reasonCode: "component_stock_unknown",
          limitingSku: "unit-a",
        },
      },
    ]);

    const parsed = sellableBundleListResponseSchema.parse(
      (sent.body as { data: unknown }).data,
    );
    expect(parsed.bundles[0].availability).toEqual({
      status: "unknown",
      sellableNow: null,
      limitingSku: "unit-a",
      reasonCode: "component_stock_unknown",
    });
  });

  it("refuses a non-GET method and answers the disabled envelope behind the flag", async () => {
    const { res: postRes, sent: postSent } = capture();
    await createSellableBundleHandler({ availabilityService: service([]), enabled: true })(
      { method: "POST" } as Req,
      postRes,
    );
    expect(postSent.status).toBe(405);

    const disabled = await feed([], false);
    expect(disabled.status).toBe(503);
    expect(disabled.body).toMatchObject({
      ok: false,
      error: { details: { featureFlag: "COMMERCE_BUNDLE_READ_ENABLED" } },
    });
  });

  it("answers UPSTREAM_UNAVAILABLE rather than an empty feed when the read throws", async () => {
    const { res, sent } = capture();
    await createSellableBundleHandler({
      availabilityService: {
        describeCompositions: () => Promise.reject(new Error("read failed")),
        describeActiveBundles: () => Promise.reject(new Error("read failed")),
      },
      enabled: true,
    })({ method: "GET" } as Req, res);

    expect(sent.status).toBe(503);
    expect(sent.body).toMatchObject({ ok: false });
  });
});
