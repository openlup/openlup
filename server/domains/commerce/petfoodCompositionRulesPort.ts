import type {
  BundleLineRef,
  CompositionConstraint,
  CompositionRulesPort,
} from "../../../src/domains/bundle/ports.js";
import type { CommercePackageSizingPort } from "../../../src/domains/commerce/ports.js";

type ConstraintRecord = Record<string, unknown>;

export function createPetfoodCompositionRulesPort(deps: {
  packageSizingPort: CommercePackageSizingPort;
}): CompositionRulesPort {
  const { packageSizingPort } = deps;

  async function assertRecipeLines(coreLines: readonly BundleLineRef[]): Promise<void> {
    const recipeVariantIds = await packageSizingPort.recipeVariantIds();
    if (coreLines.some((line) => !recipeVariantIds.has(line.variantId))) {
      throw new Error("subscription_reprice_not_a_recipe_variant");
    }
  }

  async function validateComposition(input: Parameters<CompositionRulesPort["validateComposition"]>[0]) {
    if (input.coreLines.length === 0 || !validLines(input.coreLines) || !validLines(input.addonLines)) {
      return { ok: false as const, code: "subscription_reprice_invalid_recipe_mix" };
    }
    if (new Set(input.coreLines.map((line) => line.variantId)).size !== input.coreLines.length) {
      return { ok: false as const, code: "subscription_reprice_duplicate_recipe" };
    }

    const recipeVariantIds = await packageSizingPort.recipeVariantIds();
    const nonRecipe = input.coreLines.find((line) => !recipeVariantIds.has(line.variantId));
    if (nonRecipe) {
      return {
        ok: false as const,
        code: "subscription_reprice_not_a_recipe_variant",
        details: { variantId: nonRecipe.variantId },
      };
    }

    return { ok: true as const };
  }

  async function resizeComposition(
    input: Parameters<CompositionRulesPort["resizeComposition"]>[0],
  ): ReturnType<CompositionRulesPort["resizeComposition"]> {
    const data = readConstraintData(input.constraint);
    if (input.lever.kind === "planLengthConstraint") {
      const planDays = readPositiveInteger(input.lever.value, "subscription_reprice_invalid_plan_length");
      return {
        coreLines: input.coreLines,
        constraint: writeConstraint(input.constraint, { value: planDays }),
      };
    }

    if (input.lever.kind === "planLength") {
      const planDays = Math.trunc(Number(input.lever.value));
      if (!Number.isInteger(planDays) || planDays <= 0) {
        throw new Error("subscription_reprice_invalid_plan_length");
      }
      const fullDailyKcal = readDailyKcal(data);
      const dailyKcal = fullDailyKcal * readPortionFactor(data);
      await assertRecipeLines(input.coreLines);
      const sizing = await packageSizingPort.recomputeRecipeQuantities({
        recipeVariantIds: input.coreLines.map((line) => line.variantId),
        currentRecipes: input.coreLines.map((line) => ({
          variantId: line.variantId,
          qty: line.qty,
        })),
        dailyKcal,
        planDays,
      });
      if (sizing.maxExceeded || sizing.recipes.length === 0) {
        throw new Error("subscription_reprice_plan_length_unservable");
      }
      return {
        coreLines: sizing.recipes.map((line) => ({ ...line, isAddon: false })),
        constraint: writeConstraint(input.constraint, { value: planDays }),
      };
    }

    if (input.lever.kind === "portionMode") {
      const portionMode = readPortionMode(input.lever.value);
      if (portionMode !== "full" && portionMode !== "topper") {
        throw new Error("subscription_reprice_invalid_portion_mode");
      }
      const fullDailyKcal = readDailyKcal(data);
      const planDays = readPortionModePlanDays(input.lever.value, data);
      const portionFactor = portionMode === "topper" ? 0.5 : 1;
      const scaledDailyKcal = fullDailyKcal * portionFactor;
      await assertRecipeLines(input.coreLines);
      const sizing = await packageSizingPort.recomputeRecipeQuantities({
        recipeVariantIds: input.coreLines.map((line) => line.variantId),
        currentRecipes: input.coreLines.map((line) => ({
          variantId: line.variantId,
          qty: line.qty,
        })),
        dailyKcal: scaledDailyKcal,
        planDays,
      });
      if (sizing.maxExceeded || sizing.recipes.length === 0) {
        throw new Error("subscription_reprice_portion_unservable");
      }
      const currentRecipeTotal = input.coreLines.reduce((sum, line) => sum + line.qty, 0);
      const resizedTotalUnits = packageSizingTotalUnits(sizing);
      if (portionMode === "topper" && resizedTotalUnits >= currentRecipeTotal) {
        throw new Error("subscription_reprice_portion_no_reduction");
      }
      return {
        coreLines: sizing.recipes.map((line) => ({ ...line, isAddon: false })),
        constraint: writeConstraint(input.constraint, { mode: portionMode, portionFactor }),
      };
    }

    return null;
  }

  return { validateComposition, resizeComposition };
}

function validLines(lines: readonly BundleLineRef[]): boolean {
  return lines.every((line) => line.variantId.trim() !== "" && Number.isInteger(line.qty) && line.qty > 0);
}

function readConstraintData(constraint: CompositionConstraint): ConstraintRecord {
  return constraint.data;
}

function writeConstraint(
  constraint: CompositionConstraint,
  patch: ConstraintRecord,
): CompositionConstraint {
  const base = constraint.data;
  const safePatch = { ...patch };
  if ("value" in safePatch && base.kind !== "feeding_days") {
    delete safePatch.value;
  }
  return {
    ...constraint,
    data: { ...base, ...safePatch },
  };
}

function packageSizingTotalUnits(
  sizing: Awaited<ReturnType<CommercePackageSizingPort["recomputeRecipeQuantities"]>>,
): number {
  const totalUnits = sizing.totalUnits;
  if (!Number.isInteger(totalUnits) || totalUnits < 0) {
    throw new Error("subscription_reprice_invalid_package_sizing_total");
  }
  return totalUnits;
}

function readDailyKcal(data: ConstraintRecord): number {
  const value = Number(data.dailyKcalOverride);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("subscription_reprice_missing_daily_kcal");
  }
  return value;
}

function readPortionFactor(data: ConstraintRecord): number {
  const value = data.portionFactor;
  return typeof value === "number" && value > 0 && value <= 1 ? value : 1;
}

function readPositiveInteger(value: unknown, errorCode: string): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(errorCode);
  }
  return parsed;
}

function readPortionMode(value: unknown): string {
  if (isRecord(value)) {
    return String(value.portionMode ?? "");
  }
  return String(value ?? "");
}

function readPortionModePlanDays(value: unknown, data: ConstraintRecord): number {
  if (!isRecord(value)) {
    throw new Error("subscription_reprice_invalid_plan_length");
  }
  return readPositiveInteger(value.planDays ?? data.value, "subscription_reprice_invalid_plan_length");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
