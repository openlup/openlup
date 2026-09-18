/**
 * Companion test for the bundle READ handlers.
 *
 * The handler layer owns exactly three things the read-port contract cannot see:
 * the read flag gate, the "absent is a 404, not an empty detail" decision, and the
 * price preview — the one read that computes, and whose refusals must land on the
 * same envelope a refused write produces. Those are what this file asserts. What
 * the adapters do with a query lives in the read-port contract table and is not
 * re-proved here.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createAdminBundleGetHandler,
  createAdminBundleHistoryHandler,
  createAdminBundleListHandler,
  createAdminBundlePreviewPriceHandler,
  type AdminBundleReadHandlerDeps,
} from "./adminBundleReadHandler.js";
import type {
  BundleCatalogReadPort,
  BundleComponentRow,
  BundleDetail,
} from "./bundleCatalogReadPort.js";

// Request/response types are DERIVED from the handler the factory returns rather
// than imported from the hosting SDK: the thing under test is the handler's own
// signature, so if that signature moves these follow it, and the file names no
// runtime it does not depend on.
type BundleRouteHandler = ReturnType<typeof createAdminBundleListHandler>;
type RouteRequest = Parameters<BundleRouteHandler>[0];
type RouteResponse = Parameters<BundleRouteHandler>[1];

function component(
  sku: string,
  referenceUnitPriceMinor: number | null,
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
    referenceUnitPriceMinor,
  };
}

function detail(overrides: Partial<BundleDetail> = {}): BundleDetail {
  return {
    code: "starter-set",
    title: "Starter set",
    status: "active",
    fulfillmentMode: "virtual",
    componentCount: 2,
    hasActiveTargetPrice: true,
    updatedAt: "2026-08-12T10:00:00.000Z",
    compositionConstraint: null,
    metadata: {},
    components: [component("unit-a", 1000, 3), component("unit-b", 700, 2)],
    prices: [
      {
        mode: "one_time",
        targetPriceMinor: 3333,
        currency: "XTS",
        amountKind: "gross",
        active: true,
        validFrom: "2026-08-01T00:00:00.000Z",
        validTo: null,
      },
    ],
    resolvedCurrency: "XTS",
    resolvedPriceListId: "list-1",
    ...overrides,
  };
}

function createPort(overrides: Partial<BundleCatalogReadPort> = {}): BundleCatalogReadPort {
  return {
    listBundles: vi.fn(async () => ({ bundles: [], total: 0 })),
    getBundle: vi.fn(async () => detail()),
    listActiveBundleCompositions: vi.fn(async () => []),
    listBundleHistory: vi.fn(async () => ({ events: [], total: 0 })),
    ...overrides,
  };
}

function deps(overrides: Partial<AdminBundleReadHandlerDeps> = {}): AdminBundleReadHandlerDeps {
  return {
    readPort: createPort(),
    authorizeAdmin: async () =>
      ({ ok: true, userId: "actor-id", role: "owner", isMachineActor: false }) as never,
    readsEnabled: true,
    ...overrides,
  };
}

function request(query: Record<string, unknown>, method = "GET"): RouteRequest {
  return { method, query, headers: {} } as unknown as RouteRequest;
}

function createResponse() {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as RouteResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function body(res: RouteResponse): Record<string, unknown> {
  return vi.mocked(res.json).mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

function payload(res: RouteResponse): Record<string, unknown> {
  return (body(res) as { data: Record<string, unknown> }).data;
}

describe("admin bundle read handlers", () => {
  it("answers the disabled envelope behind the read flag, on every read", async () => {
    const factories = [
      createAdminBundleListHandler,
      createAdminBundleGetHandler,
      createAdminBundleHistoryHandler,
      createAdminBundlePreviewPriceHandler,
    ];

    for (const factory of factories) {
      const res = createResponse();
      await factory(deps({ readsEnabled: false }))(request({ code: "starter-set" }), res);
      expect(body(res)).toMatchObject({
        ok: false,
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          details: { reason: "feature_flag_disabled", featureFlag: "COMMERCE_BUNDLE_READ_ENABLED" },
        },
      });
    }
  });

  it("admits a machine actor: reading is not the publish decision", async () => {
    const res = createResponse();
    await createAdminBundleListHandler(
      deps({
        authorizeAdmin: async () =>
          ({ ok: true, userId: "agent-id", role: "owner", isMachineActor: true }) as never,
      }),
    )(request({}), res);

    expect(payload(res)).toMatchObject({ bundles: [], total: 0 });
  });

  it("answers 404 for an absent bundle rather than an empty detail", async () => {
    const res = createResponse();
    await createAdminBundleGetHandler(
      deps({ readPort: createPort({ getBundle: vi.fn(async () => null) }) }),
    )(request({ code: "starter-set" }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(body(res)).toMatchObject({ error: { details: { reason: "bundle_not_found" } } });
  });

  it("keeps the internal variant id off the transport", async () => {
    const res = createResponse();
    await createAdminBundleGetHandler(deps())(request({ code: "starter-set" }), res);

    const bundle = payload(res).bundle as { components: Array<Record<string, unknown>> };
    expect(bundle.components[0]).not.toHaveProperty("variantId");
    expect(bundle.components[0]).toMatchObject({ sku: "unit-a", referenceUnitPriceMinor: 1000 });
    expect(payload(res)).not.toHaveProperty("resolvedPriceListId");
  });

  // Derived stock on the DETAIL response. The public feed is live-only, so before this an operator
  // looking at a draft was shown nothing; these cases pin that the detail now answers for any
  // status, that "not computed" is a null rather than a zero, and that the per-component figure the
  // feed cannot carry reaches the transport.
  it("folds derived stock into the detail, per component and with the limiting unit named", async () => {
    const res = createResponse();
    await createAdminBundleGetHandler(
      deps({
        availabilityService: {
          describeActiveBundles: vi.fn(async () => []),
          describeCompositions: vi.fn(async (compositions) => [
            {
              composition: compositions[0],
              availability: {
                sellableNow: 4,
                status: "low_stock" as const,
                reasonCode: "stock_low",
                limitingSku: "unit-b",
              },
              components: [
                { sku: "unit-a", quantity: 3, isAddon: false, sellableNow: 30 },
                { sku: "unit-b", quantity: 2, isAddon: false, sellableNow: 9 },
              ],
            },
          ]),
        },
      }),
    )(request({ code: "starter-set" }), res);

    const bundle = payload(res).bundle as { availability: Record<string, unknown> };
    expect(bundle.availability).toEqual({
      sellableNow: 4,
      status: "low_stock",
      reasonCode: "stock_low",
      limitingSku: "unit-b",
      components: [
        { sku: "unit-a", quantity: 3, isAddon: false, sellableNow: 30 },
        { sku: "unit-b", quantity: 2, isAddon: false, sellableNow: 9 },
      ],
    });
  });

  it("hands the service the bundle's own components, whatever its status", async () => {
    const describeCompositions = vi.fn(async () => []);
    const res = createResponse();
    await createAdminBundleGetHandler(
      deps({
        readPort: createPort({ getBundle: vi.fn(async () => detail({ status: "draft" })) }),
        availabilityService: {
          describeActiveBundles: vi.fn(async () => []),
          describeCompositions,
        },
      }),
    )(request({ code: "starter-set" }), res);

    const [asked] = describeCompositions.mock.calls[0] as unknown as [
      Array<{ code: string; components: unknown[] }>,
    ];
    expect(asked[0].code).toBe("starter-set");
    expect(asked[0].components).toHaveLength(2);
  });

  it("reports an unbound stock rail as null, never as zero", async () => {
    const res = createResponse();
    await createAdminBundleGetHandler(deps())(request({ code: "starter-set" }), res);
    expect((payload(res).bundle as { availability: unknown }).availability).toBeNull();
  });

  it("previews the stored price over today's component prices, summing exactly", async () => {
    const res = createResponse();
    await createAdminBundlePreviewPriceHandler(deps())(request({ code: "starter-set" }), res);

    const preview = payload(res).preview as {
      targetPriceMinor: number;
      referenceTotalMinor: number;
      priceListId: string;
      currency: string;
      allocatedLines: Array<{ lineSubtotalMinor: number }>;
    };
    expect(preview.targetPriceMinor).toBe(3333);
    expect(preview.referenceTotalMinor).toBe(4400);
    expect(preview.priceListId).toBe("list-1");
    expect(preview.currency).toBe("XTS");
    expect(
      preview.allocatedLines.reduce((sum, line) => sum + line.lineSubtotalMinor, 0),
    ).toBe(3333);
  });

  it("prices a target the operator is only considering, without writing", async () => {
    const getBundle = vi.fn(async () => detail());
    const res = createResponse();
    await createAdminBundlePreviewPriceHandler(deps({ readPort: createPort({ getBundle }) }))(
      request({ code: "starter-set", targetPriceMinor: "4000" }),
      res,
    );

    expect((payload(res).preview as { targetPriceMinor: number }).targetPriceMinor).toBe(4000);
    // The only port call a preview makes is a read.
    expect(getBundle).toHaveBeenCalledTimes(1);
  });

  it("maps every preview refusal onto the write path's own envelope", async () => {
    const cases: Array<[Partial<BundleDetail> | null, number, string]> = [
      [null, 404, "bundle_not_found"],
      [{ resolvedPriceListId: null, resolvedCurrency: null }, 404, "no_active_price_list"],
      [{ components: [] }, 409, "min_components"],
      [{ components: [component("unit-a", null)] }, 409, "component_unpriced:unit-a"],
      [{ prices: [] }, 404, "no_active_target_price"],
      // A target above the sum of the parts: the kernel's own refusal code.
      [
        {
          prices: [
            {
              mode: "one_time",
              targetPriceMinor: 99_000,
              currency: "XTS",
              amountKind: "gross",
              active: true,
              validFrom: "2026-08-01T00:00:00.000Z",
              validTo: null,
            },
          ],
        },
        409,
        "TARGET_ABOVE_COMPONENT_SUM",
      ],
    ];

    for (const [overrides, status, reason] of cases) {
      const res = createResponse();
      await createAdminBundlePreviewPriceHandler(
        deps({
          readPort: createPort({
            getBundle: vi.fn(async () => (overrides === null ? null : detail(overrides))),
          }),
        }),
      )(request({ code: "starter-set" }), res);

      expect(res.status, reason).toHaveBeenCalledWith(status);
      expect(body(res), reason).toMatchObject({ error: { details: { reason } } });
    }
  });

  it("refuses a request the read contract rejects before touching the port", async () => {
    const getBundle = vi.fn(async () => detail());
    const res = createResponse();
    await createAdminBundleGetHandler(deps({ readPort: createPort({ getBundle }) }))(
      request({ code: "starter-set", unexpected: "field" }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(getBundle).not.toHaveBeenCalled();
  });

  it("passes pagination through to the history read", async () => {
    const listBundleHistory = vi.fn(async () => ({ events: [], total: 0 }));
    const res = createResponse();
    await createAdminBundleHistoryHandler(deps({ readPort: createPort({ listBundleHistory }) }))(
      request({ code: "starter-set", limit: "10", offset: "20" }),
      res,
    );

    expect(listBundleHistory).toHaveBeenCalledWith({
      code: "starter-set",
      limit: 10,
      offset: 20,
    });
  });
});
