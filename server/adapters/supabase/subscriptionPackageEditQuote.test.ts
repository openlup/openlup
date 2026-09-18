import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CommercePackageSizingPort,
  CommercePackageSizingResult,
  CommerceQuotePort,
} from "../../../src/domains/commerce/ports.js";
import { createPetfoodCompositionRulesPort } from "../../domains/commerce/ports.js";
import { quotePackageEdit } from "./subscriptionPackageEditQuote.js";
import type { CommerceQuoteCatalogReadPort } from "../../domains/commerce/commerceQuoteCatalogReadPort.js";

const SUB = "5b000000-0000-0000-0000-0000000000c3";
const L1 = "51110000-0000-0000-0000-000000000001";
const V_LAMB = "55550000-0000-0000-0000-000000000001";
const V_BEEF = "55550000-0000-0000-0000-000000000002";
const V_ADDON = "55550000-0000-0000-0000-000000000099";
const V_RETIRED = "55550000-0000-0000-0000-000000000077";
/** One currency for every money assertion here, so the suite states the market once. */
const CURRENCY = "PLN";

describe("subscription package edit quote", () => {
  // The package editor is the only account surface that can rewrite the core
  // set, so it is the surface a customer holding a retired line must reach. The
  // comparison baseline falls back to the gross that line is actually billed at.
  it("prices the current package from the frozen snapshot when its only line has left the catalog", async () => {
    const quoteCatalogReadPort = quoteCatalog();
    vi.spyOn(quoteCatalogReadPort, "listQuoteCatalogItems").mockResolvedValue([
      quoteCatalogItem("BEEF", V_BEEF, false),
    ]);
    const quotePort = pricedQuotePort();

    const result = await quotePackageEdit({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: null, template_version: 5 },
        [frozen(base(L1, V_LAMB, 14), 12_345)],
      ),
      quoteCatalogReadPort,
      quotePort,
      compositionRulesPort: rulesPort(),
    }, {
      subscriptionId: SUB,
      planDays: 28,
      recipes: [{ variantId: V_BEEF, qty: 14 }],
      addons: [],
    });

    expect(result.currentRecurringPrice).toEqual({ amountMinor: 12_345, currency: CURRENCY });
    expect(result.newRecurringPrice).toEqual({ amountMinor: 14_000, currency: CURRENCY });
    expect(result.delta).toEqual({ amountMinor: 1_655, currency: CURRENCY });
    // Only the desired quote is priced live; the retired line has no live price.
    expect(quotePort.createQuote).toHaveBeenCalledOnce();
  });

  it("adds the frozen gross of a retired line to the live band price of the rest", async () => {
    const quoteCatalogReadPort = quoteCatalog();
    vi.spyOn(quoteCatalogReadPort, "listQuoteCatalogItems").mockResolvedValue([
      quoteCatalogItem("LAMB", V_LAMB, false),
      quoteCatalogItem("BEEF", V_BEEF, false),
    ]);
    const quotePort = pricedQuotePort();

    const result = await quotePackageEdit({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: null, template_version: 5 },
        [base(L1, V_LAMB, 10), frozen({ id: "retired", variant_id: V_RETIRED, qty: 4, is_addon: false, sort_order: 2 }, 3_000)],
      ),
      quoteCatalogReadPort,
      quotePort,
      compositionRulesPort: rulesPort(),
    }, {
      subscriptionId: SUB,
      planDays: 28,
      recipes: [{ variantId: V_BEEF, qty: 14 }],
      addons: [],
    });

    // LAMB x10 at today's band (10_000) + the retired line's frozen 3_000.
    expect(result.currentRecurringPrice).toEqual({ amountMinor: 13_000, currency: CURRENCY });
    expect(quotePort.createQuote).toHaveBeenNthCalledWith(1, expect.objectContaining({
      lines: [expect.objectContaining({ sku: "LAMB", quantity: 10 })],
    }));
  });

  it("refuses rather than guessing when a retired line carries no frozen gross", async () => {
    const quoteCatalogReadPort = quoteCatalog();
    vi.spyOn(quoteCatalogReadPort, "listQuoteCatalogItems").mockResolvedValue([
      quoteCatalogItem("BEEF", V_BEEF, false),
    ]);

    await expect(quotePackageEdit({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: null, template_version: 5 },
        [base(L1, V_LAMB, 14)],
      ),
      quoteCatalogReadPort,
      quotePort: pricedQuotePort(),
      compositionRulesPort: rulesPort(),
    }, {
      subscriptionId: SUB,
      planDays: 28,
      recipes: [{ variantId: V_BEEF, qty: 14 }],
      addons: [],
    })).rejects.toThrow("subscription_reprice_current_package_unpriceable");
  });

  it("still refuses a package edit that would KEEP a line whose SKU has left the catalog", async () => {
    const quoteCatalogReadPort = quoteCatalog();
    vi.spyOn(quoteCatalogReadPort, "listQuoteCatalogItems").mockResolvedValue([
      quoteCatalogItem("BEEF", V_BEEF, false),
    ]);

    await expect(quotePackageEdit({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: null, template_version: 5 },
        [frozen(base(L1, V_LAMB, 14), 12_345)],
      ),
      quoteCatalogReadPort,
      quotePort: pricedQuotePort(),
      compositionRulesPort: rulesPort(),
    }, {
      subscriptionId: SUB,
      planDays: 28,
      recipes: [{ variantId: V_LAMB, qty: 14 }],
      addons: [],
    })).rejects.toThrow(`subscription_reprice_unknown_variant:${V_LAMB}`);
  });

  it("starts current and desired quote reads together while preserving the result", async () => {
    const quotePort = pricedQuotePort();
    const quoteResponse = pricedQuoteResponse;
    let resolveCurrent!: (value: Awaited<ReturnType<typeof quotePort.createQuote>>) => void;
    const currentPending = new Promise<Awaited<ReturnType<typeof quotePort.createQuote>>>((resolve) => {
      resolveCurrent = resolve;
    });
    quotePort.createQuote.mockImplementation((request) =>
      quotePort.createQuote.mock.calls.length === 1
        ? currentPending
        : quoteResponse(request),
    );

    const pending = quotePackageEdit({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: null, template_version: 5 },
        [base(L1, V_LAMB, 14)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      compositionRulesPort: createPetfoodCompositionRulesPort({ packageSizingPort: sizingPort() }),
    }, {
      subscriptionId: SUB,
      planDays: 28,
      recipes: [{ variantId: V_BEEF, qty: 14 }],
      addons: [],
    });

    await vi.waitFor(() => expect(quotePort.createQuote).toHaveBeenCalledTimes(2));

    const currentRequest = quotePort.createQuote.mock.calls[0][0] as { lines: Array<{ sku: string; quantity: number }> };
    resolveCurrent(await quoteResponse(currentRequest));
    await expect(pending).resolves.toMatchObject({
      currentRecurringPrice: { amountMinor: 14000, currency: CURRENCY },
      newRecurringPrice: { amountMinor: 14000, currency: CURRENCY },
    });
  });

  it("keeps the requested quantities verbatim and only moves the cadence for a plan-length package edit", async () => {
    const quotePort = pricedQuotePort();
    const packageSizingPort = sizingPort({
      recipes: [{ variantId: V_BEEF, qty: 7 }],
      totalUnits: 7,
    });

    const result = await quotePackageEdit({
      serviceClient: serviceClient(
        {
          cadence_days: 28,
          size_constraint: {
            kind: "feeding_days",
            value: 28,
            dailyKcalOverride: 300,
            portionFactor: 0.5,
            mode: "topper",
            futureScalar: "preserve-me",
            futureNested: { flags: [true, false], note: null },
          },
          template_version: 5,
        },
        [
          base(L1, V_LAMB, 4),
          { id: "addon-1", variant_id: V_ADDON, qty: 1, is_addon: true, sort_order: 2 },
        ],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      compositionRulesPort: createPetfoodCompositionRulesPort({ packageSizingPort }),
    }, {
      subscriptionId: SUB,
      planDays: 14,
      recipes: [{ variantId: V_BEEF, qty: 14 }],
      addons: [{ variantId: V_ADDON, qty: 2 }],
    });

    // The sizing port performs the composition resize. A cadence change must not touch it.
    expect(packageSizingPort.recomputeRecipeQuantities).not.toHaveBeenCalled();
    expect(quotePort.createQuote).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cadenceDays: 28,
      sizeConstraint: {
        kind: "feeding_days",
        value: 28,
        dailyKcalOverride: 300,
        portionFactor: 0.5,
        mode: "topper",
        futureScalar: "preserve-me",
        futureNested: { flags: [true, false], note: null },
      },
    }));
    expect(quotePort.createQuote).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cadenceDays: 14,
      sizeConstraint: {
        kind: "feeding_days",
        value: 14,
        dailyKcalOverride: 300,
        portionFactor: 0.5,
        mode: "topper",
        futureScalar: "preserve-me",
        futureNested: { flags: [true, false], note: null },
      },
      lines: [
        expect.objectContaining({ sku: "BEEF", quantity: 14, isAddon: false }),
        expect.objectContaining({ sku: "ADDON", quantity: 2, isAddon: true }),
      ],
    }));
    expect(result).toEqual({
      currentRecurringPrice: { amountMinor: 5000, currency: CURRENCY },
      newRecurringPrice: { amountMinor: 16000, currency: CURRENCY },
      delta: { amountMinor: 11000, currency: CURRENCY },
      cadenceDays: 14,
      quoteHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      recipeLines: [{ variantId: V_BEEF, qty: 14, quoteLine: expect.objectContaining({ sku: "BEEF" }) }],
      addonLines: [{ variantId: V_ADDON, qty: 2, quoteLine: expect.objectContaining({ sku: "ADDON" }) }],
      expectedTemplateVersion: 5,
    });
  });

  it("quotes exactly the requested quantities when the plan length changes", async () => {
    const quotePort = pricedQuotePort();
    const requested = [
      { variantId: V_LAMB, qty: 9 },
      { variantId: V_BEEF, qty: 8 },
    ];

    const result = await quotePackageEdit({
      serviceClient: serviceClient(
        {
          cadence_days: 14,
          size_constraint: { kind: "feeding_days", value: 14, dailyKcalOverride: 300 },
          template_version: 5,
        },
        [base(L1, V_LAMB, 17)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      compositionRulesPort: createPetfoodCompositionRulesPort({ packageSizingPort: sizingPort() }),
    }, {
      subscriptionId: SUB,
      planDays: 21,
      recipes: requested,
      addons: [],
    });

    // The review screen renders the requested total client-side. The quote the
    // server locks must carry the very same quantities, or the customer accepts
    // a price for a package they never chose.
    expect(result.recipeLines.map(({ variantId, qty }) => ({ variantId, qty }))).toEqual(requested);
    expect(result.recipeLines.map((line) => (line.quoteLine as { quantity: number }).quantity))
      .toEqual(requested.map((line) => line.qty));
    expect(result.cadenceDays).toBe(21);
  });

  it("validates selection eligibility through the real composition adapter", async () => {
    const quotePort = pricedQuotePort();
    const packageSizingPort = sizingPort();

    await expect(quotePackageEdit({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: null, template_version: 5 },
        [base(L1, V_LAMB, 4)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      compositionRulesPort: createPetfoodCompositionRulesPort({ packageSizingPort }),
    }, {
      subscriptionId: SUB,
      planDays: 28,
      recipes: [{ variantId: V_ADDON, qty: 14 }],
      addons: [],
    })).rejects.toThrow("subscription_reprice_not_a_recipe_variant");

    expect(quotePort.createQuote).not.toHaveBeenCalled();
  });

  it("restamps the nominal plan-length constraint without resizing when the selected plan differs", async () => {
    const quotePort = pricedQuotePort();
    const packageSizingPort = sizingPort();

    await quotePackageEdit({
      serviceClient: serviceClient(
        {
          cadence_days: 28,
          size_constraint: { kind: "feeding_days", value: 99, dailyKcalOverride: 300 },
          template_version: 5,
        },
        [base(L1, V_LAMB, 4)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      compositionRulesPort: createPetfoodCompositionRulesPort({ packageSizingPort }),
    }, {
      subscriptionId: SUB,
      planDays: 28,
      recipes: [{ variantId: V_BEEF, qty: 14 }],
      addons: [],
    });

    expect(packageSizingPort.recomputeRecipeQuantities).not.toHaveBeenCalled();
    expect(quotePort.createQuote).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cadenceDays: 28,
      sizeConstraint: expect.objectContaining({ kind: "feeding_days", value: 28, dailyKcalOverride: 300 }),
      lines: [expect.objectContaining({ sku: "BEEF", quantity: 14, isAddon: false })],
    }));
  });

  it("preserves an extended cadence for a mix-only edit", async () => {
    const quotePort = pricedQuotePort();
    const packageSizingPort = sizingPort();

    const result = await quotePackageEdit({
      serviceClient: serviceClient(
        {
          cadence_days: 30,
          size_constraint: { kind: "feeding_days", value: 14, dailyKcalOverride: 300 },
          template_version: 5,
        },
        [base(L1, V_LAMB, 20), base("line-2", V_BEEF, 10)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      compositionRulesPort: createPetfoodCompositionRulesPort({ packageSizingPort }),
    }, {
      subscriptionId: SUB,
      planDays: 14,
      recipes: [
        { variantId: V_LAMB, qty: 15 },
        { variantId: V_BEEF, qty: 15 },
      ],
      addons: [],
    });

    expect(packageSizingPort.recomputeRecipeQuantities).not.toHaveBeenCalled();
    expect(result.recipeLines.map(({ variantId, qty }) => ({ variantId, qty }))).toEqual([
      { variantId: V_LAMB, qty: 15 },
      { variantId: V_BEEF, qty: 15 },
    ]);
    expect(result.cadenceDays).toBe(30);
    expect(quotePort.createQuote).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cadenceDays: 30,
      sizeConstraint: expect.objectContaining({
        kind: "feeding_days",
        value: 14,
        dailyKcalOverride: 300,
      }),
      lines: [
        expect.objectContaining({ sku: "LAMB", quantity: 15, isAddon: false }),
        expect.objectContaining({ sku: "BEEF", quantity: 15, isAddon: false }),
      ],
    }));
  });

  it("rejects a requested line set below the minimum order quantity", async () => {
    const quotePort = pricedQuotePort();
    await expect(quotePackageEdit({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: null, template_version: 5 },
        [base(L1, V_LAMB, 20)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      compositionRulesPort: createPetfoodCompositionRulesPort({ packageSizingPort: sizingPort() }),
    }, {
      subscriptionId: SUB,
      planDays: 28,
      recipes: [{ variantId: V_BEEF, qty: 13 }],
      addons: [],
    })).rejects.toThrow("subscription_reprice_below_minimum_order_units");
    expect(quotePort.createQuote).not.toHaveBeenCalled();
  });

  it("accepts a changed line total at or above the minimum with the cadence unchanged", async () => {
    const quotePort = pricedQuotePort();
    const result = await quotePackageEdit({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: null, template_version: 5 },
        [base(L1, V_LAMB, 20)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      compositionRulesPort: createPetfoodCompositionRulesPort({ packageSizingPort: sizingPort() }),
    }, {
      subscriptionId: SUB,
      planDays: 28,
      recipes: [{ variantId: V_BEEF, qty: 14 }],
      addons: [],
    });

    expect(result.recipeLines.map(({ variantId, qty }) => ({ variantId, qty }))).toEqual([
      { variantId: V_BEEF, qty: 14 },
    ]);
    expect(result.cadenceDays).toBe(28);
    expect(quotePort.createQuote).toHaveBeenNthCalledWith(2, expect.objectContaining({
      lines: [expect.objectContaining({ sku: "BEEF", quantity: 14, isAddon: false })],
    }));
  });
});

function base(id: string, variantId: string, qty: number) {
  return { id, variant_id: variantId, qty, is_addon: false, sort_order: 1 };
}

/** The activation-time gross the customer is billed for this line each cycle. */
function frozen<T extends object>(line: T, amountMinor: number) {
  return {
    ...line,
    line_metadata: {
      productSnapshot: { quoteLine: { lineSubtotalGross: { amountMinor, currency: CURRENCY } } },
    },
  };
}

/** Shared composition rules port for the retired-line cases. */
function rulesPort(port: CommercePackageSizingPort = sizingPort()) {
  return createPetfoodCompositionRulesPort({ packageSizingPort: port });
}

function sizingPort(result: Partial<CommercePackageSizingResult> = {}): CommercePackageSizingPort {
  return {
    recomputeRecipeQuantities: vi.fn(async ({ recipeVariantIds }) => ({
      recipes: recipeVariantIds.map((variantId: string) => ({ variantId, qty: 7 })),
      totalUnits: recipeVariantIds.length * 7,
      maxExceeded: false,
      ...result,
    })),
    recipeVariantIds: vi.fn(async () => new Set([V_LAMB, V_BEEF])),
  };
}

function quoteCatalog(): CommerceQuoteCatalogReadPort {
  return {
    listQuoteCatalogItems: async () => [
      quoteCatalogItem("LAMB", V_LAMB, false),
      quoteCatalogItem("BEEF", V_BEEF, false),
      quoteCatalogItem("ADDON", V_ADDON, true),
    ],
  };
}

function quoteCatalogItem(skuCode: string, variantId: string, isAddon: boolean) {
  return {
    skuId: variantId,
    skuCode,
    variantId,
    productSlug: skuCode.toLowerCase(),
    netWeightG: 400,
    energyPer100g: 123,
    allergenSlugs: [],
    isAddon,
    sellability: { oneTime: true, subscription: true },
    documentRevision: { id: "revision", digest: "a".repeat(64) },
  };
}

function pricedQuotePort(): CommerceQuotePort & { createQuote: ReturnType<typeof vi.fn> } {
  const createQuote = vi.fn(pricedQuoteResponse);
  return { createQuote } as unknown as CommerceQuotePort & { createQuote: ReturnType<typeof vi.fn> };
}

async function pricedQuoteResponse(request: { lines: Array<{ sku: string; quantity: number }> }) {
  const lines = request.lines.map((line) => ({
    sku: line.sku,
    quantity: line.quantity,
    unitPriceGross: { amountMinor: 1000, currency: "PLN" },
    lineSubtotalGross: { amountMinor: line.quantity * 1000, currency: "PLN" },
    pricingComponents: [],
  }));
  const total = lines.reduce((sum, line) => sum + line.lineSubtotalGross.amountMinor, 0);
  return {
    contractVersion: "commerce.v0",
    quote: {
      currency: "PLN",
      taxIncluded: true,
      lines,
      discounts: [],
      subtotalGross: { amountMinor: total, currency: "PLN" },
      discountTotalGross: { amountMinor: 0, currency: "PLN" },
      totalGross: { amountMinor: total, currency: "PLN" },
      netTotal: { amountMinor: total, currency: "PLN" },
      taxTotal: { amountMinor: 0, currency: "PLN" },
    },
  };
}

function serviceClient(subscription: unknown, lines: unknown[]): SupabaseClient {
  const builder = (data: unknown) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.order = () => b;
    b.maybeSingle = async () => ({ data, error: null });
    b.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
      Promise.resolve({ data, error: null }).then(resolve);
    return b;
  };
  return {
    from: (table: string) => builder(table === "subscriptions" ? subscription : lines),
  } as unknown as SupabaseClient;
}
