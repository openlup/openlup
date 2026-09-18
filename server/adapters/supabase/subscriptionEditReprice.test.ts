import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CommercePackageSizingPort,
  CommercePackageSizingResult,
  CommerceQuotePort,
} from "../../../src/domains/commerce/ports.js";
import { createPetfoodCompositionRulesPort } from "../../domains/commerce/ports.js";
import { createSubscriptionRepricer } from "./subscriptionEditReprice.js";
import { withSubscriptionRepricePayload } from "../../domains/customers/subscriptionActionRepricePayload.js";
import type { CommerceQuoteCatalogReadPort } from "../../domains/commerce/commerceQuoteCatalogReadPort.js";

const SUB = "5b000000-0000-0000-0000-0000000000c3";
const L1 = "51110000-0000-0000-0000-000000000001";
const V_LAMB = "55550000-0000-0000-0000-000000000001";
const V_BEEF = "55550000-0000-0000-0000-000000000002";
const V_SALMON = "55550000-0000-0000-0000-000000000003";

describe("subscription edit repricer (C3)", () => {
  it("re-quotes the post-edit template and maps swap to the existing lineId", async () => {
    const quotePort = quotePortSpy();
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient({ cadence_days: 30, size_constraint: null }, [base(L1, V_LAMB, 2)]),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      ...sizingDeps(),
    });

    const result = await repricer.repriceForEdit({
      subscriptionId: SUB,
      action: "swap_recipe",
      payload: { fromVariantId: V_LAMB, toVariantId: V_BEEF },
    });

    // re-quoted at the band, subscription mode, the swapped sku
    expect(quotePort.createQuote).toHaveBeenCalledWith(expect.objectContaining({
      mode: "subscription",
      cadenceDays: 30,
      promoCodes: [],
      lines: [expect.objectContaining({ sku: "BEEF", quantity: 2, modeAtLine: "subscription", isAddon: false })],
    }));
    expect(result).toEqual({
      repricedLines: [{ lineId: L1, quoteLine: expect.objectContaining({ sku: "BEEF" }) }],
      quoteHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedTemplateVersion: 1,
    });
  });

  it("appends a new addon line with a null lineId for add_addon", async () => {
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient({ cadence_days: 30, size_constraint: null }, [base(L1, V_LAMB, 2)]),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort: quotePortSpy(),
      ...sizingDeps(),
    });

    const result = await repricer.repriceForEdit({
      subscriptionId: SUB,
      action: "add_addon",
      payload: { variantId: V_SALMON, qty: 1 },
    });

    expect(result).toEqual({
      repricedLines: [
        { lineId: L1, quoteLine: expect.objectContaining({ sku: "LAMB" }) },
        { lineId: null, quoteLine: expect.objectContaining({ sku: "SALMON" }) },
      ],
      quoteHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedTemplateVersion: 1,
    });
  });

  it("returns null for non-pricing actions", async () => {
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient({ cadence_days: 30, size_constraint: null }, [base(L1, V_LAMB, 2)]),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort: quotePortSpy(),
      ...sizingDeps(),
    });
    expect(await repricer.repriceForEdit({ subscriptionId: SUB, action: "pause", payload: {} })).toBeNull();
  });

  it("returns null when the swap source line is absent (RPC will reject)", async () => {
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient({ cadence_days: 30, size_constraint: null }, [base(L1, V_LAMB, 2)]),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort: quotePortSpy(),
      ...sizingDeps(),
    });
    expect(await repricer.repriceForEdit({
      subscriptionId: SUB, action: "swap_recipe", payload: { fromVariantId: V_BEEF, toVariantId: V_SALMON },
    })).toBeNull();
  });

  it("fails closed (throws) when a variant has no catalog sku", async () => {
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient({ cadence_days: 30, size_constraint: null }, [base(L1, "unknown-variant", 2)]),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort: quotePortSpy(),
      ...sizingDeps(),
    });
    await expect(repricer.repriceForEdit({
      subscriptionId: SUB, action: "add_addon", payload: { variantId: V_SALMON, qty: 1 },
    })).rejects.toThrow(/subscription_reprice_unknown_variant/);
  });

  it("fails closed before quoting when the current D1 SKU is not subscription-sellable", async () => {
    const quoteCatalogReadPort = quoteCatalog();
    vi.spyOn(quoteCatalogReadPort, "listQuoteCatalogItems").mockResolvedValue([
      { ...quoteCatalogItem("LAMB", V_LAMB, false), sellability: { oneTime: true, subscription: false } },
      quoteCatalogItem("SALMON", V_SALMON, true),
    ]);
    const quotePort = quotePortSpy();
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient({ cadence_days: 30, size_constraint: null }, [base(L1, V_LAMB, 2)]),
      quoteCatalogReadPort,
      quotePort,
      ...sizingDeps(),
    });

    await expect(repricer.repriceForEdit({
      subscriptionId: SUB,
      action: "add_addon",
      payload: { variantId: V_SALMON, qty: 1 },
    })).rejects.toThrow(`subscription_reprice_unknown_variant:${V_LAMB}`);
    expect(quotePort.createQuote).not.toHaveBeenCalled();
  });

  // The guard is over the lines the edit KEEPS, not the ones it started from, so
  // the two edits that drop a retired line are exactly the two that must work.
  it.each([
    ["remove_addon", { variantId: V_SALMON }, ["LAMB"]],
    ["swap_recipe", { fromVariantId: V_SALMON, toVariantId: V_BEEF }, ["LAMB", "BEEF"]],
  ] as const)("lets %s drop a line whose SKU has left the sellable catalog", async (action, payload, expectedSkus) => {
    const quoteCatalogReadPort = quoteCatalog();
    vi.spyOn(quoteCatalogReadPort, "listQuoteCatalogItems").mockResolvedValue([
      quoteCatalogItem("LAMB", V_LAMB, false),
      quoteCatalogItem("BEEF", V_BEEF, false),
    ]);
    const quotePort = quotePortSpy();
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 30, size_constraint: null },
        [base(L1, V_LAMB, 2), { id: "retired", variant_id: V_SALMON, qty: 1, is_addon: action === "remove_addon", sort_order: 2 }],
      ),
      quoteCatalogReadPort,
      quotePort,
      ...sizingDeps(),
    });

    const result = await repricer.repriceForEdit({ subscriptionId: SUB, action, payload });

    expect(quotePort.createQuote).toHaveBeenCalledWith(expect.objectContaining({
      lines: expectedSkus.map((sku) => expect.objectContaining({ sku })),
    }));
    expect(result?.repricedLines.map((line) => line.lineId)).toEqual(
      action === "remove_addon" ? [L1] : [L1, "retired"],
    );
  });

  it("still refuses an edit that would KEEP a line whose SKU has left the catalog", async () => {
    const quoteCatalogReadPort = quoteCatalog();
    vi.spyOn(quoteCatalogReadPort, "listQuoteCatalogItems").mockResolvedValue([
      quoteCatalogItem("LAMB", V_LAMB, false),
      quoteCatalogItem("BEEF", V_BEEF, false),
    ]);
    const quotePort = quotePortSpy();
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 30, size_constraint: null },
        [base(L1, V_LAMB, 2), { id: "retired", variant_id: V_SALMON, qty: 1, is_addon: true, sort_order: 2 }],
      ),
      quoteCatalogReadPort,
      quotePort,
      ...sizingDeps(),
    });

    await expect(repricer.repriceForEdit({
      subscriptionId: SUB, action: "update_addon_quantity", payload: { variantId: V_SALMON, qty: 3 },
    })).rejects.toThrow(`subscription_reprice_unknown_variant:${V_SALMON}`);
    expect(quotePort.createQuote).not.toHaveBeenCalled();
  });

  it("fails closed when the subscription template version is corrupt", async () => {
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 30, size_constraint: null, template_version: "corrupt" },
        [base(L1, V_LAMB, 2)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort: quotePortSpy(),
      ...sizingDeps(),
    });

    await expect(repricer.repriceForEdit({
      subscriptionId: SUB,
      action: "add_addon",
      payload: { variantId: V_SALMON, qty: 1 },
    })).rejects.toThrow("subscription_reprice_invalid_template_version");
  });
});

describe("subscription edit repricer — plan length & selection mix (D1)", () => {
  it("lets a set replacement drop a core line whose SKU has left the sellable catalog", async () => {
    const quoteCatalogReadPort = quoteCatalog();
    vi.spyOn(quoteCatalogReadPort, "listQuoteCatalogItems").mockResolvedValue([
      quoteCatalogItem("BEEF", V_BEEF, false),
    ]);
    const quotePort = quotePortSpy();
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: null, template_version: 2 },
        [base(L1, V_LAMB, 4)],
      ),
      quoteCatalogReadPort,
      quotePort,
      ...sizingDeps(),
    });

    const result = await repricer.repriceRecipeSet({
      subscriptionId: SUB,
      action: "update_recipe_mix",
      payload: { recipes: [{ variantId: V_BEEF, qty: 4 }] },
    });

    expect(quotePort.createQuote).toHaveBeenCalledWith(expect.objectContaining({
      lines: [expect.objectContaining({ sku: "BEEF", quantity: 4 })],
    }));
    expect(result?.recipeLines.map(({ variantId, qty }) => ({ variantId, qty })))
      .toEqual([{ variantId: V_BEEF, qty: 4 }]);
  });

  it("still refuses a set replacement that would KEEP the retired core line", async () => {
    const quoteCatalogReadPort = quoteCatalog();
    vi.spyOn(quoteCatalogReadPort, "listQuoteCatalogItems").mockResolvedValue([
      quoteCatalogItem("BEEF", V_BEEF, false),
    ]);
    const quotePort = quotePortSpy();
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: null, template_version: 2 },
        [base(L1, V_LAMB, 4)],
      ),
      quoteCatalogReadPort,
      quotePort,
      ...sizingDeps(),
    });

    await expect(repricer.repriceRecipeSet({
      subscriptionId: SUB,
      action: "update_recipe_mix",
      payload: { recipes: [{ variantId: V_LAMB, qty: 4 }] },
    })).rejects.toThrow(`subscription_reprice_unknown_variant:${V_LAMB}`);
    expect(quotePort.createQuote).not.toHaveBeenCalled();
  });

  it("recomputes item quantities, re-locks addons, and carries the expected version", async () => {
    const quotePort = quotePortSpy();
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300 }, template_version: 5 },
        [base(L1, V_LAMB, 4), { id: "addon-1", variant_id: V_SALMON, qty: 1, is_addon: true, sort_order: 2 }],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      ...sizingDeps(),
    });

    const result = await repricer.repriceRecipeSet({
      subscriptionId: SUB,
      action: "update_plan_length",
      payload: { planDays: 14 },
    });

    expect(quotePort.createQuote).toHaveBeenCalledWith(expect.objectContaining({
      cadenceDays: 14,
      sizeConstraint: expect.objectContaining({ kind: "feeding_days", value: 14, dailyKcalOverride: 300 }),
      lines: [
        expect.objectContaining({ sku: "LAMB", quantity: 7, isAddon: false }),
        expect.objectContaining({ sku: "SALMON", quantity: 1, isAddon: true }),
      ],
    }));
    expect(result).toEqual({
      recipeLines: [{ variantId: V_LAMB, qty: 7, quoteLine: expect.objectContaining({ sku: "LAMB" }) }],
      addonLines: [{ lineId: "addon-1", quoteLine: expect.objectContaining({ sku: "SALMON" }) }],
      cadenceDays: 14,
      expectedTemplateVersion: 5,
      quoteHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("throws on a plan-length resize without dailyKcalOverride", async () => {
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: { kind: "feeding_days", value: 28 }, template_version: 1 },
        [base(L1, V_LAMB, 4)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort: quotePortSpy(),
      ...sizingDeps(),
    });
    await expect(repricer.repriceRecipeSet({
      subscriptionId: SUB, action: "update_plan_length", payload: { planDays: 14 },
    })).rejects.toThrow(/missing_daily_kcal/);
  });

  it("re-quotes a fixed-total recipe mix, rejects a changed total and a non-recipe variant", async () => {
    const deps = () => ({
      serviceClient: serviceClient({ cadence_days: 28, size_constraint: null, template_version: 2 }, [base(L1, V_LAMB, 4)]),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort: quotePortSpy(),
      ...sizingDeps(),
    });

    const ok = await createSubscriptionRepricer(deps()).repriceRecipeSet({
      subscriptionId: SUB,
      action: "update_recipe_mix",
      payload: { recipes: [{ variantId: V_LAMB, qty: 1 }, { variantId: V_BEEF, qty: 3 }] },
    });
    expect(ok).toEqual({
      recipeLines: [
        { variantId: V_LAMB, qty: 1, quoteLine: expect.objectContaining({ sku: "LAMB" }) },
        { variantId: V_BEEF, qty: 3, quoteLine: expect.objectContaining({ sku: "BEEF" }) },
      ],
      addonLines: [],
      cadenceDays: 28,
      expectedTemplateVersion: 2,
      quoteHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    await expect(createSubscriptionRepricer(deps()).repriceRecipeSet({
      subscriptionId: SUB, action: "update_recipe_mix", payload: { recipes: [{ variantId: V_LAMB, qty: 5 }] },
    })).rejects.toThrow(/recipe_total_mismatch/);

    // an addon / unknown variant smuggled into the recipe set is rejected
    await expect(createSubscriptionRepricer(deps()).repriceRecipeSet({
      subscriptionId: SUB, action: "update_recipe_mix",
      payload: { recipes: [{ variantId: "99990000-0000-0000-0000-000000000099", qty: 4 }] },
    })).rejects.toThrow(/not_a_recipe_variant/);
  });

  it("keeps legacy recipe-mix validation scope and error identity", async () => {
    const deps = () => ({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: null, template_version: 2 },
        [
          base(L1, V_LAMB, 4),
          { id: "addon-legacy-zero", variant_id: V_SALMON, qty: 0, is_addon: true, sort_order: 2 },
        ],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort: quotePortSpy(),
      ...sizingDeps(),
    });

    await expect(createSubscriptionRepricer(deps()).repriceRecipeSet({
      subscriptionId: SUB,
      action: "update_recipe_mix",
      payload: { recipes: [] },
    })).rejects.toThrow("subscription_reprice_invalid_recipe_mix");

    await expect(createSubscriptionRepricer(deps()).repriceRecipeSet({
      subscriptionId: SUB,
      action: "update_recipe_mix",
      payload: { recipes: [{ variantId: V_LAMB, qty: 4 }] },
    })).resolves.toMatchObject({
      recipeLines: [{ variantId: V_LAMB, qty: 4 }],
      addonLines: [{ lineId: "addon-legacy-zero" }],
    });
  });

  it("still reports no_recipes only for subscriptions without current recipe rows", async () => {
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: null, template_version: 2 },
        [{ id: "addon-1", variant_id: V_SALMON, qty: 1, is_addon: true, sort_order: 1 }],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort: quotePortSpy(),
      ...sizingDeps(),
    });

    await expect(repricer.repriceRecipeSet({
      subscriptionId: SUB,
      action: "update_recipe_mix",
      payload: { recipes: [{ variantId: V_LAMB, qty: 1 }] },
    })).rejects.toThrow("subscription_reprice_no_recipes");
  });

  it("returns null for actions that are not plan-length / recipe-mix", async () => {
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient({ cadence_days: 28, size_constraint: null }, [base(L1, V_LAMB, 4)]),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort: quotePortSpy(),
      ...sizingDeps(),
    });
    expect(await repricer.repriceRecipeSet({ subscriptionId: SUB, action: "swap_recipe", payload: {} })).toBeNull();
  });
});

describe("subscription edit repricer — topper / half-plan (set_portion_mode)", () => {
  it("recomputes the recipe set at half the daily kcal, keeping cadence, for a topper", async () => {
    const quotePort = quotePortSpy();
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300 }, template_version: 5 },
        [base(L1, V_LAMB, 14)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      ...sizingDeps(),
    });

    const result = await repricer.repriceRecipeSet({
      subscriptionId: SUB,
      action: "set_portion_mode",
      payload: { portionMode: "topper" },
    });

    // cadence unchanged; quantities are recomputed at the scaled daily kcal, while the
    // persisted constraint keeps the full kcal base plus portion factor.
    expect(quotePort.createQuote).toHaveBeenCalledWith(expect.objectContaining({
      cadenceDays: 28,
      sizeConstraint: expect.objectContaining({ kind: "feeding_days", value: 28, dailyKcalOverride: 300, mode: "topper", portionFactor: 0.5 }),
      lines: [expect.objectContaining({ sku: "LAMB", quantity: 7, isAddon: false })],
    }));
    expect(result).toEqual({
      recipeLines: [{ variantId: V_LAMB, qty: 7, quoteLine: expect.objectContaining({ sku: "LAMB" }) }],
      addonLines: [],
      cadenceDays: 28,
      expectedTemplateVersion: 5,
      quoteHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("recomputes at the full daily kcal when switching back to full", async () => {
    const quotePort = quotePortSpy();
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300, portionFactor: 0.5, mode: "topper" }, template_version: 6 },
        [base(L1, V_LAMB, 4)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      ...sizingDeps(),
    });

    await repricer.repriceRecipeSet({ subscriptionId: SUB, action: "set_portion_mode", payload: { portionMode: "full" } });

    expect(quotePort.createQuote).toHaveBeenCalledWith(expect.objectContaining({
      cadenceDays: 28,
      sizeConstraint: expect.objectContaining({ dailyKcalOverride: 300 }),
    }));
  });

  it("rejects a topper that would not reduce the can count (shipping minimum floor)", async () => {
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300 }, template_version: 1 },
        [base(L1, V_LAMB, 4)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort: quotePortSpy(),
      // floors at 7 cans (>= the current 4) → no price reduction.
      ...sizingDeps(),
    });
    await expect(repricer.repriceRecipeSet({
      subscriptionId: SUB, action: "set_portion_mode", payload: { portionMode: "topper" },
    })).rejects.toThrow(/portion_no_reduction/);
  });

  it("throws on a topper without dailyKcalOverride and on an invalid portion mode", async () => {
    const deps = (sizeConstraint: Record<string, unknown> | null) => ({
      serviceClient: serviceClient({ cadence_days: 28, size_constraint: sizeConstraint, template_version: 1 }, [base(L1, V_LAMB, 14)]),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort: quotePortSpy(),
      ...sizingDeps(),
    });
    await expect(createSubscriptionRepricer(deps({ kind: "feeding_days", value: 28 })).repriceRecipeSet({
      subscriptionId: SUB, action: "set_portion_mode", payload: { portionMode: "topper" },
    })).rejects.toThrow(/missing_daily_kcal/);
    await expect(createSubscriptionRepricer(deps({ kind: "feeding_days", value: 28, dailyKcalOverride: 300 })).repriceRecipeSet({
      subscriptionId: SUB, action: "set_portion_mode", payload: { portionMode: "double" },
    })).rejects.toThrow(/invalid_portion_mode/);
    await expect(createSubscriptionRepricer(deps({
      kind: "feeding_days",
      version: 1,
      data: { value: 28, dailyKcalOverride: 300 },
    })).repriceRecipeSet({
      subscriptionId: SUB, action: "set_portion_mode", payload: { portionMode: "topper" },
    })).rejects.toThrow(/missing_daily_kcal/);
  });

  it("preserves an active topper across a plan-length change (resizes at the effective portion)", async () => {
    const quotePort = quotePortSpy();
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300, portionFactor: 0.5, mode: "topper" }, template_version: 2 },
        [base(L1, V_LAMB, 7)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      ...sizingDeps(),
    });

    await repricer.repriceRecipeSet({ subscriptionId: SUB, action: "update_plan_length", payload: { planDays: 14 } });

    // dailyKcal applied to the recompute is the effective (300 * 0.5 = 150), not the full 300.
    expect(quotePort.createQuote).toHaveBeenCalledWith(expect.objectContaining({
      cadenceDays: 14,
      sizeConstraint: expect.objectContaining({ value: 14, dailyKcalOverride: 300, portionFactor: 0.5 }),
    }));
  });

  it("normalizes generic portion-mode resize levers with the current cadence", async () => {
    const quotePort = quotePortSpy();
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300 }, template_version: 5 },
        [base(L1, V_LAMB, 14)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      ...sizingDeps(),
    });

    await repricer.repriceRecipeSet({
      subscriptionId: SUB,
      action: "resize_bundle",
      payload: {
        resizeLever: { kind: "portionMode", value: "topper" },
        compositionConstraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300 },
      },
    });

    expect(quotePort.createQuote).toHaveBeenCalledWith(expect.objectContaining({
      cadenceDays: 28,
      sizeConstraint: expect.objectContaining({ dailyKcalOverride: 300, mode: "topper", portionFactor: 0.5 }),
    }));
  });

  it("keeps requested quantities on a generic update_bundle when a package-template alias changes cadence", async () => {
    const quotePort = quotePortSpy();
    const sizing = sizingDeps({ recipes: [{ variantId: V_BEEF, qty: 7 }], totalUnits: 7 });
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300 }, template_version: 5 },
        [base(L1, V_LAMB, 4)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      ...sizing,
    });

    const result = await repricer.repriceRecipeSet({
      subscriptionId: SUB,
      action: "update_bundle",
      sourceAction: "update_package_template",
      payload: {
        coreLines: [{ variantId: V_BEEF, qty: 14 }],
        addonLines: [],
        cadenceDays: 14,
      },
    });

    // Same semantics as the flag-OFF `quotePackageEdit` path: a cadence change
    // stamps the new nominal plan length and never resizes the composition.
    expect(sizing.packageSizingPort.recomputeRecipeQuantities).not.toHaveBeenCalled();
    expect(quotePort.createQuote).toHaveBeenCalledWith(expect.objectContaining({
      cadenceDays: 14,
      sizeConstraint: expect.objectContaining({ kind: "feeding_days", value: 14, dailyKcalOverride: 300 }),
      lines: [expect.objectContaining({ sku: "BEEF", quantity: 14, isAddon: false })],
    }));
    expect(result?.recipeLines).toEqual([expect.objectContaining({ variantId: V_BEEF, qty: 14 })]);
    expect(result?.cadenceDays).toBe(14);
  });

  it("restamps the nominal generic constraint without resizing when the selected plan differs", async () => {
    const quotePort = quotePortSpy();
    const sizing = sizingDeps();
    const expectedConstraint = {
      kind: "feeding_days",
      value: 28,
      dailyKcalOverride: 300,
      futureScalar: "preserve-me",
      futureNested: { flags: [true, false], note: null },
    };
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        {
          cadence_days: 28,
          size_constraint: { ...expectedConstraint, value: 99 },
          template_version: 5,
        },
        [base(L1, V_LAMB, 4)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      ...sizing,
    });

    const result = await repricer.repriceRecipeSet({
      subscriptionId: SUB,
      action: "update_bundle",
      sourceAction: "update_package_template",
      payload: {
        coreLines: [{ variantId: V_BEEF, qty: 14 }],
        addonLines: [],
        cadenceDays: 28,
      },
    });

    expect(sizing.packageSizingPort.recomputeRecipeQuantities).not.toHaveBeenCalled();
    expect(quotePort.createQuote).toHaveBeenCalledWith(expect.objectContaining({
      cadenceDays: 28,
      sizeConstraint: expectedConstraint,
      lines: [expect.objectContaining({ sku: "BEEF", quantity: 14, isAddon: false })],
    }));
    expect(result?.compositionConstraint).toEqual(expectedConstraint);
    expect(result?.compositionConstraint).not.toHaveProperty("data");
  });

  it("preserves extended cadence and fixed total for a package-template mix-only update_bundle", async () => {
    const quotePort = quotePortSpy();
    const sizing = sizingDeps();
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 30, size_constraint: { kind: "feeding_days", value: 14, dailyKcalOverride: 300 }, template_version: 5 },
        [base(L1, V_LAMB, 20), base("line-2", V_BEEF, 10)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      ...sizing,
    });

    const result = await repricer.repriceRecipeSet({
      subscriptionId: SUB,
      action: "update_bundle",
      sourceAction: "update_package_template",
      payload: {
        coreLines: [{ variantId: V_LAMB, qty: 15 }, { variantId: V_BEEF, qty: 15 }],
        addonLines: [],
        cadenceDays: 14,
      },
    });

    expect(sizing.packageSizingPort.recomputeRecipeQuantities).not.toHaveBeenCalled();
    expect(result?.cadenceDays).toBe(30);
    expect(result?.recipeLines.map(({ variantId, qty }) => ({ variantId, qty }))).toEqual([
      { variantId: V_LAMB, qty: 15 },
      { variantId: V_BEEF, qty: 15 },
    ]);
    expect(quotePort.createQuote).toHaveBeenCalledWith(expect.objectContaining({
      cadenceDays: 30,
      sizeConstraint: expect.objectContaining({ kind: "feeding_days", value: 14 }),
    }));
  });

  it("keeps generic update_bundle fixed-pool unless cadence changes", async () => {
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300 }, template_version: 5 },
        [base(L1, V_LAMB, 4)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort: quotePortSpy(),
      ...sizingDeps(),
    });

    await expect(repricer.repriceRecipeSet({
      subscriptionId: SUB,
      action: "update_bundle",
      payload: {
        coreLines: [{ variantId: V_BEEF, qty: 5 }],
        compositionConstraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300 },
      },
    })).rejects.toThrow("subscription_reprice_recipe_total_mismatch");
  });

  it("swaps the fixed-pool guard for a minimum-order floor on the package-template alias", async () => {
    const constraint = { kind: "feeding_days" as const, value: 28, dailyKcalOverride: 300 };
    const deps = () => ({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: constraint, template_version: 5 },
        [base(L1, V_LAMB, 20)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort: quotePortSpy(),
      ...sizingDeps(),
    });

    // A changed total is now allowed for the package editor…
    const ok = await createSubscriptionRepricer(deps()).repriceRecipeSet({
      subscriptionId: SUB,
      action: "update_bundle",
      sourceAction: "update_package_template",
      payload: {
        coreLines: [{ variantId: V_BEEF, qty: 14 }],
        addonLines: [],
        compositionConstraint: constraint,
      },
    });
    expect(ok?.recipeLines).toEqual([expect.objectContaining({ variantId: V_BEEF, qty: 14 })]);

    // …but only down to the minimum order quantity.
    await expect(createSubscriptionRepricer(deps()).repriceRecipeSet({
      subscriptionId: SUB,
      action: "update_bundle",
      sourceAction: "update_package_template",
      payload: {
        coreLines: [{ variantId: V_BEEF, qty: 13 }],
        addonLines: [],
        compositionConstraint: constraint,
      },
    })).rejects.toThrow("subscription_reprice_below_minimum_order_units");
  });
});

describe("subscription package template quote", () => {
  it("quotes current and desired recurring package price without promo codes", async () => {
    const quotePort = pricedQuotePort();
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300 }, template_version: 5 },
        [base(L1, V_LAMB, 14), { id: "addon-1", variant_id: V_SALMON, qty: 1, is_addon: true, sort_order: 2 }],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      ...sizingDeps(),
    });

    const result = await repricer.previewPackageEdit({
      subscriptionId: SUB,
      payload: {
        planDays: 28,
        recipes: [{ variantId: V_BEEF, qty: 14 }],
        addons: [{ variantId: V_SALMON, qty: 2 }],
      },
    });

    expect(quotePort.createQuote).toHaveBeenCalledWith(expect.objectContaining({ promoCodes: [] }));
    expect(result.currentRecurringPrice.amountMinor).toBe(15000);
    expect(result.newRecurringPrice.amountMinor).toBe(16000);
    expect(result.delta.amountMinor).toBe(1000);
    expect(result.recipeLines).toEqual([expect.objectContaining({ variantId: V_BEEF, qty: 14 })]);
    expect(result.addonLines).toEqual([expect.objectContaining({ variantId: V_SALMON, qty: 2 })]);
    expect(result.quoteHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("populates current/new recurring price on the recipe-set path for the update_package_template source (CJ57-A)", async () => {
    const quotePort = pricedQuotePort();
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300 }, template_version: 5 },
        [base(L1, V_LAMB, 14), { id: "addon-1", variant_id: V_SALMON, qty: 1, is_addon: true, sort_order: 2 }],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort,
      ...sizingDeps(),
    });

    const result = await repricer.repriceRecipeSet({
      subscriptionId: SUB,
      action: "update_bundle",
      sourceAction: "update_package_template",
      payload: { coreLines: [{ variantId: V_BEEF, qty: 14 }], addonLines: [], cadenceDays: 28 },
    });

    // current = active lines (LAMB×14 + SALMON×1 = 15000); new = desired recipes (BEEF×14 = 14000).
    expect(result?.currentRecurringPrice).toEqual({ amountMinor: 15000, currency: "PLN" });
    expect(result?.newRecurringPrice).toEqual({ amountMinor: 14000, currency: "PLN" });
    expect(result?.quoteHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("omits the package-edit price summary for non-package-template recipe-set actions", async () => {
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient(
        { cadence_days: 28, size_constraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300 }, template_version: 5 },
        [base(L1, V_LAMB, 4)],
      ),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort: pricedQuotePort(),
      ...sizingDeps(),
    });

    const result = await repricer.repriceRecipeSet({
      subscriptionId: SUB,
      action: "update_plan_length",
      payload: { planDays: 14 },
    });

    expect(result?.currentRecurringPrice).toBeUndefined();
    expect(result?.newRecurringPrice).toBeUndefined();
  });

  it("injects atomic package lines only when the accepted quote hash matches", async () => {
    const repricer = createSubscriptionRepricer({
      serviceClient: serviceClient({ cadence_days: 28, size_constraint: null, template_version: 5 }, [base(L1, V_LAMB, 4)]),
      quoteCatalogReadPort: quoteCatalog(),
      quotePort: pricedQuotePort(),
      ...sizingDeps(),
    });
    const payload = { planDays: 28, recipes: [{ variantId: V_BEEF, qty: 14 }], addons: [] };
    const preview = await repricer.previewPackageEdit({ subscriptionId: SUB, payload });

    await expect(withSubscriptionRepricePayload(repricer, {
      action: "update_package_template",
      idempotencyKey: "package-template-1",
      subscriptionId: SUB,
      planDays: 28,
      recipes: [{ variantId: V_BEEF, qty: 14 }],
      addons: [],
      acceptedQuoteHash: preview.quoteHash,
    }, payload)).resolves.toMatchObject({
      recipeLines: [expect.objectContaining({ variantId: V_BEEF })],
      acceptedQuoteHash: preview.quoteHash,
      expectedTemplateVersion: 5,
    });

    await expect(withSubscriptionRepricePayload(repricer, {
      action: "update_package_template",
      idempotencyKey: "package-template-2",
      subscriptionId: SUB,
      planDays: 28,
      recipes: [{ variantId: V_BEEF, qty: 14 }],
      addons: [],
      acceptedQuoteHash: "b".repeat(64),
    }, payload)).rejects.toThrow("subscription_reprice_quote_not_accepted");
  });
});

function base(id: string, variantId: string, qty: number) {
  return { id, variant_id: variantId, qty, is_addon: false, sort_order: 1 };
}

function sizingPort(result: Partial<CommercePackageSizingResult> = {}): CommercePackageSizingPort {
  return {
    recomputeRecipeQuantities: vi.fn(async ({ recipeVariantIds }) => ({
      recipes: recipeVariantIds.map((variantId: string) => ({ variantId, qty: 7 })),
      totalUnits: recipeVariantIds.length * 7,
      maxExceeded: false,
      ...result,
    })),
    recipeVariantIds: vi.fn(async () => new Set([V_LAMB, V_BEEF, V_SALMON])),
  };
}

function sizingDeps(result: Partial<CommercePackageSizingResult> = {}) {
  const packageSizingPort = sizingPort(result);
  return {
    packageSizingPort,
    compositionRulesPort: createPetfoodCompositionRulesPort({ packageSizingPort }),
  };
}

function quoteCatalog(): CommerceQuoteCatalogReadPort {
  return {
    listQuoteCatalogItems: async () => [
      quoteCatalogItem("LAMB", V_LAMB, false),
      quoteCatalogItem("BEEF", V_BEEF, false),
      quoteCatalogItem("SALMON", V_SALMON, true),
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

function quotePortSpy(): CommerceQuotePort & { createQuote: ReturnType<typeof vi.fn> } {
  const createQuote = vi.fn(async (request: { lines: Array<{ sku: string; quantity: number }> }) => ({
    contractVersion: "commerce.v0",
    quote: { lines: request.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })) },
  }));
  return { createQuote } as unknown as CommerceQuotePort & { createQuote: ReturnType<typeof vi.fn> };
}

function pricedQuotePort(): CommerceQuotePort & { createQuote: ReturnType<typeof vi.fn> } {
  const createQuote = vi.fn(async (request: { lines: Array<{ sku: string; quantity: number }> }) => {
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
  });
  return { createQuote } as unknown as CommerceQuotePort & { createQuote: ReturnType<typeof vi.fn> };
}

function serviceClient(subscription: unknown, lines: unknown[]): SupabaseClient {
  const subscriptionRow =
    subscription && typeof subscription === "object" && !Array.isArray(subscription) && !("template_version" in subscription)
      ? { ...subscription, template_version: 1 }
      : subscription;
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
    from: (table: string) => builder(table === "subscriptions" ? subscriptionRow : lines),
  } as unknown as SupabaseClient;
}
