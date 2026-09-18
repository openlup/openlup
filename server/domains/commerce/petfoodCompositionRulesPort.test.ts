import { describe, expect, it, vi } from "vitest";

import type { BundleLineRef, CompositionConstraint } from "../../../src/domains/bundle/ports.js";
import type {
  CommercePackageSizingPort,
  CommercePackageSizingResult,
} from "../../../src/domains/commerce/ports.js";
import { toCorePetfoodCompositionConstraint } from "./ports/legacyPetfoodCompositionConstraintMapper.js";
import { createPetfoodCompositionRulesPort } from "./petfoodCompositionRulesPort.js";

const V_LAMB = "55550000-0000-0000-0000-000000000001";
const V_BEEF = "55550000-0000-0000-0000-000000000002";
const V_ADDON = "55550000-0000-0000-0000-000000000099";

describe("petfood composition rules port", () => {
  it("resizes plan length with the effective daily kcal while preserving legacy constraint shape", async () => {
    const packageSizingPort = sizingPort({
      recipes: [{ variantId: V_LAMB, qty: 7 }],
      totalUnits: 7,
    });
    const port = createPetfoodCompositionRulesPort({
      packageSizingPort,
    });

    const resized = await port.resizeComposition({
      coreLines: [line(V_LAMB, 4)],
      constraint: legacyConstraint({
        kind: "feeding_days",
        value: 28,
        dailyKcalOverride: 300,
        portionFactor: 0.5,
        mode: "topper",
      }),
      lever: { kind: "planLength", value: 14 },
    });

    expect(packageSizingPort.recomputeRecipeQuantities).toHaveBeenCalledWith({
      recipeVariantIds: [V_LAMB],
      currentRecipes: [{ variantId: V_LAMB, qty: 4 }],
      dailyKcal: 150,
      planDays: 14,
    });
    expect(resized).toEqual({
      coreLines: [{ variantId: V_LAMB, qty: 7, isAddon: false }],
      constraint: expect.objectContaining({
        data: expect.objectContaining({
          kind: "feeding_days",
          value: 14,
          dailyKcalOverride: 300,
          portionFactor: 0.5,
          mode: "topper",
        }),
      }),
    });
  });

  it("uses the portion-mode lever planDays instead of the constraint value", async () => {
    const packageSizingPort = sizingPort({
      recipes: [{ variantId: V_LAMB, qty: 7 }],
      totalUnits: 7,
    });
    const port = createPetfoodCompositionRulesPort({
      packageSizingPort,
    });

    const resized = await port.resizeComposition({
      coreLines: [line(V_LAMB, 14)],
      constraint: legacyConstraint({ kind: "feeding_days", value: 99, dailyKcalOverride: 300 }),
      lever: { kind: "portionMode", value: { portionMode: "topper", planDays: 28 } },
    });

    expect(packageSizingPort.recomputeRecipeQuantities).toHaveBeenCalledWith({
      recipeVariantIds: [V_LAMB],
      currentRecipes: [{ variantId: V_LAMB, qty: 14 }],
      dailyKcal: 150,
      planDays: 28,
    });
    expect(resized?.constraint.data).toEqual(expect.objectContaining({
      kind: "feeding_days",
      value: 99,
      dailyKcalOverride: 300,
      mode: "topper",
      portionFactor: 0.5,
    }));
  });

  it("normalizes only feeding-days constraint value without recomputing recipe quantities", async () => {
    const packageSizingPort = sizingPort();
    const port = createPetfoodCompositionRulesPort({
      packageSizingPort,
    });

    const resized = await port.resizeComposition({
      coreLines: [line(V_LAMB, 4)],
      constraint: legacyConstraint({ kind: "feeding_days", value: 99, dailyKcalOverride: 300 }),
      lever: { kind: "planLengthConstraint", value: 28 },
    });

    expect(packageSizingPort.recomputeRecipeQuantities).not.toHaveBeenCalled();
    expect(resized).toEqual({
      coreLines: [line(V_LAMB, 4)],
      constraint: expect.objectContaining({
        data: expect.objectContaining({ kind: "feeding_days", value: 28, dailyKcalOverride: 300 }),
      }),
    });
  });

  it("does not write day counts into non-feeding-days constraint value fields", async () => {
    const packageSizingPort = sizingPort({
      recipes: [{ variantId: V_LAMB, qty: 7 }],
      totalUnits: 7,
    });
    const port = createPetfoodCompositionRulesPort({
      packageSizingPort,
    });

    await expect(port.resizeComposition({
      coreLines: [line(V_LAMB, 4)],
      constraint: legacyConstraint({ kind: "unit_count", value: 3, dailyKcalOverride: 300 }),
      lever: { kind: "planLengthConstraint", value: 28 },
    })).resolves.toEqual({
      coreLines: [line(V_LAMB, 4)],
      constraint: expect.objectContaining({
        data: expect.objectContaining({ kind: "unit_count", value: 3, dailyKcalOverride: 300 }),
      }),
    });

    await expect(port.resizeComposition({
      coreLines: [line(V_LAMB, 4)],
      constraint: legacyConstraint({ kind: "unit_count", value: 3, dailyKcalOverride: 300 }),
      lever: { kind: "planLength", value: 14 },
    })).resolves.toEqual({
      coreLines: [{ variantId: V_LAMB, qty: 7, isAddon: false }],
      constraint: expect.objectContaining({
        data: expect.objectContaining({ kind: "unit_count", value: 3, dailyKcalOverride: 300 }),
      }),
    });
  });

  it("accepts the flag-on mapped portion-mode lever shape without planDays", async () => {
    const packageSizingPort = sizingPort({
      recipes: [{ variantId: V_LAMB, qty: 2 }],
      totalUnits: 2,
    });
    const port = createPetfoodCompositionRulesPort({
      packageSizingPort,
    });

    const resized = await port.resizeComposition({
      coreLines: [line(V_LAMB, 4)],
      constraint: legacyConstraint({ kind: "feeding_days", value: 28, dailyKcalOverride: 300 }),
      lever: { kind: "portionMode", value: { portionMode: "topper" } },
    });

    expect(packageSizingPort.recomputeRecipeQuantities).toHaveBeenCalledWith({
      recipeVariantIds: [V_LAMB],
      currentRecipes: [{ variantId: V_LAMB, qty: 4 }],
      dailyKcal: 150,
      planDays: 28,
    });
    expect(resized).toEqual({
      coreLines: [{ variantId: V_LAMB, qty: 2, isAddon: false }],
      constraint: expect.objectContaining({
        data: expect.objectContaining({
          kind: "feeding_days",
          value: 28,
          dailyKcalOverride: 300,
          mode: "topper",
          portionFactor: 0.5,
        }),
      }),
    });
  });

  it("rejects invalid or no-op resize attempts with the legacy error codes", async () => {
    const noReductionPort = createPetfoodCompositionRulesPort({
      packageSizingPort: sizingPort({
        recipes: [{ variantId: V_LAMB, qty: 14 }],
        totalUnits: 14,
      }),
    });

    await expect(noReductionPort.resizeComposition({
      coreLines: [line(V_LAMB, 14)],
      constraint: legacyConstraint({ kind: "feeding_days", value: 28, dailyKcalOverride: 300 }),
      lever: { kind: "portionMode", value: { portionMode: "topper", planDays: 28 } },
    })).rejects.toThrow("subscription_reprice_portion_no_reduction");

    await expect(noReductionPort.resizeComposition({
      coreLines: [line(V_LAMB, 14)],
      constraint: legacyConstraint({ kind: "feeding_days", value: 28 }),
      lever: { kind: "portionMode", value: { portionMode: "topper", planDays: 28 } },
    })).rejects.toThrow("subscription_reprice_missing_daily_kcal");

    await expect(noReductionPort.resizeComposition({
      coreLines: [line(V_ADDON, 1)],
      constraint: legacyConstraint({ kind: "feeding_days", value: 28, dailyKcalOverride: 300 }),
      lever: { kind: "planLength", value: 14 },
    })).rejects.toThrow("subscription_reprice_not_a_recipe_variant");

    await expect(noReductionPort.resizeComposition({
      coreLines: [line(V_LAMB, 14)],
      constraint: legacyConstraint({
        kind: "feeding_days",
        version: 1,
        data: { value: 28, dailyKcalOverride: 300 },
      }),
      lever: { kind: "portionMode", value: { portionMode: "topper", planDays: 28 } },
    })).rejects.toThrow("subscription_reprice_missing_daily_kcal");

    await expect(noReductionPort.resizeComposition({
      coreLines: [line(V_LAMB, 14)],
      constraint: legacyConstraint({ kind: "feeding_days", value: 28, dailyKcalOverride: 300 }),
      lever: { kind: "portionMode", value: { portionMode: "double" } },
    })).rejects.toThrow("subscription_reprice_invalid_portion_mode");
  });

  it("rejects deprecated alias-only package sizing results", async () => {
    const aliasOnlySizingPort: CommercePackageSizingPort = {
      recomputeRecipeQuantities: vi.fn(async () => ({
        recipes: [{ variantId: V_LAMB, qty: 7 }],
        totalCans: 7,
        maxExceeded: false,
      } as unknown as CommercePackageSizingResult)),
      recipeVariantIds: vi.fn(async () => new Set([V_LAMB, V_BEEF])),
    };
    const port = createPetfoodCompositionRulesPort({
      packageSizingPort: aliasOnlySizingPort,
    });

    await expect(port.resizeComposition({
      coreLines: [line(V_LAMB, 14)],
      constraint: legacyConstraint({ kind: "feeding_days", value: 28, dailyKcalOverride: 300 }),
      lever: { kind: "portionMode", value: { portionMode: "topper", planDays: 28 } },
    })).rejects.toThrow("subscription_reprice_invalid_package_sizing_total");
  });

  it("validates recipe composition with catalog eligibility and keeps 12a allergen behavior unchanged", async () => {
    const port = createPetfoodCompositionRulesPort({
      packageSizingPort: sizingPort(),
    });

    await expect(port.validateComposition({
      coreLines: [line(V_LAMB, 1), line(V_LAMB, 1)],
      addonLines: [],
      constraint: legacyConstraint({}),
    })).resolves.toEqual({ ok: false, code: "subscription_reprice_duplicate_recipe" });

    await expect(port.validateComposition({
      coreLines: [line(V_ADDON, 1)],
      addonLines: [],
      constraint: legacyConstraint({}),
    })).resolves.toEqual({
      ok: false,
      code: "subscription_reprice_not_a_recipe_variant",
      details: { variantId: V_ADDON },
    });

    await expect(port.validateComposition({
      coreLines: [line(V_LAMB, 1)],
      addonLines: [],
      constraint: legacyConstraint({ allergenSlugs: ["chicken"] }),
    })).resolves.toEqual({ ok: true });
  });

  it("passes through unknown levers", async () => {
    const port = createPetfoodCompositionRulesPort({
      packageSizingPort: sizingPort(),
    });

    await expect(port.resizeComposition({
      coreLines: [line(V_LAMB, 1)],
      constraint: legacyConstraint({ kind: "feeding_days", value: 28, dailyKcalOverride: 300 }),
      lever: { kind: "unknown", value: null },
    })).resolves.toBeNull();
  });
});

function line(variantId: string, qty: number): BundleLineRef {
  return { variantId, qty, isAddon: false };
}

function legacyConstraint(value: Record<string, unknown>): CompositionConstraint {
  return toCorePetfoodCompositionConstraint(value);
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
