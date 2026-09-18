import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type {
  CommerceOfferAvailabilityPort,
  CommercePackageSizingPort,
  CommercePackageSizingResult,
} from "../../../src/domains/commerce/ports.js";
import type {
  CommercePackageQuantityPolicy,
  RecommendationVariant,
} from "../../../src/domains/commerce/recommendationPolicyDeps.js";
import { catalogProductsToRecommendationVariants } from "./catalogRecommendationVariants.js";
import type { CommerceQuoteCatalogReadPort } from "./commerceQuoteCatalogReadPort.js";

/**
 * Catalog-backed implementation of {@link CommercePackageSizingPort}.
 *
 * Resizes a bundle to a new plan length: the package-quantity policy computes
 * the demand-correct total units, then we apportion that total across the SAME
 * recipe variants using the customer's current proportions. The final mix is
 * corrected upward for kcal coverage without ever dropping a selected flavour.
 */
type CatalogVariantSource =
  | { catalogReadPort: CatalogReadPort; quoteCatalogReadPort?: never }
  | { catalogReadPort?: never; quoteCatalogReadPort: CommerceQuoteCatalogReadPort };

export function createCatalogBackedPackageSizingPort(deps: CatalogVariantSource & {
  packageQuantityPolicy: CommercePackageQuantityPolicy;
  offerAvailabilityPort?: CommerceOfferAvailabilityPort;
}): CommercePackageSizingPort {
  return {
    async recomputeRecipeQuantities({ recipeVariantIds, currentRecipes, dailyKcal, planDays }) {
      if (recipeVariantIds.length === 0) {
        throw new Error("commerce_package_sizing_no_recipes");
      }
      const byVariant = new Map((await listRecommendationVariants(deps))
        .map((variant) => [variant.variantId, variant]));
      const catalogVariants = recipeVariantIds.map((id) => byVariant.get(id));
      if (catalogVariants.some((variant) => !variant)) {
        throw new Error("commerce_package_sizing_unknown_variant");
      }
      const variants = await withLiveAvailability(
        catalogVariants as RecommendationVariant[],
        deps.offerAvailabilityPort,
      );

      const result = deps.packageQuantityPolicy(
        variants,
        dailyKcal,
        planDays,
        { stockBounded: Boolean(deps.offerAvailabilityPort) },
      );
      const totalUnits = result.totalUnits;
      if (!Number.isInteger(totalUnits) || totalUnits < 0) {
        throw new Error("commerce_package_sizing_invalid_total_units");
      }
      const currentMix = readCurrentMix(currentRecipes, recipeVariantIds);
      const recipes = result.maxExceeded || result.selectedCapacityConstrained
        ? []
        : resizeProportionally({
          totalUnits,
          targetTotalKcal: dailyKcal * planDays,
          variantIds: recipeVariantIds,
          currentMix,
          variants,
        });
      const maxExceeded = result.maxExceeded || Boolean(result.selectedCapacityConstrained) || recipes.length === 0;
      return {
        recipes,
        totalUnits: recipes.reduce((sum, line) => sum + line.qty, 0),
        maxExceeded,
      };
    },

    async recipeVariantIds() {
      return new Set((await listRecommendationVariants(deps))
        .filter((variant) => !variant.isAddon)
        .map((variant) => variant.variantId));
    },
  };
}

async function listRecommendationVariants(
  deps: CatalogVariantSource,
): Promise<Array<RecommendationVariant & { isAddon: boolean }>> {
  if (deps.quoteCatalogReadPort) {
    return (await deps.quoteCatalogReadPort.listQuoteCatalogItems())
      .filter((item) => item.sellability.subscription
        && item.energyPer100g != null
        && item.energyPer100g > 0
        && item.netWeightG > 0)
      .map((item) => ({
        variantId: item.variantId,
        sku: item.skuCode,
        slug: item.productSlug,
        kcalPer100g: item.energyPer100g as number,
        netWeightG: item.netWeightG,
        allergenSlugs: [...(item.allergenSlugs ?? [])],
        isAddon: item.isAddon,
      }));
  }
  const products = await deps.catalogReadPort.listProducts();
  const addonByVariantId = new Map(products.flatMap((product) => product.variants
    .map((variant) => [variant.variantId, variant.isAddon ?? false] as const)));
  return catalogProductsToRecommendationVariants(products)
    .map((variant) => ({
      ...variant,
      isAddon: addonByVariantId.get(variant.variantId) ?? false,
    }));
}

const MAX_UNITS_PER_VARIANT = 99;

function readCurrentMix(
  currentRecipes: readonly { variantId: string; qty: number }[] | undefined,
  variantIds: readonly string[],
): Array<{ variantId: string; qty: number }> {
  if (!currentRecipes) {
    return variantIds.map((variantId) => ({ variantId, qty: 1 }));
  }
  const byVariant = new Map(currentRecipes.map((line) => [line.variantId, line.qty]));
  if (
    byVariant.size !== variantIds.length ||
    variantIds.some((variantId) => {
      const qty = byVariant.get(variantId);
      return !Number.isInteger(qty) || (qty ?? 0) <= 0;
    })
  ) {
    throw new Error("commerce_package_sizing_invalid_current_mix");
  }
  return variantIds.map((variantId) => ({ variantId, qty: byVariant.get(variantId) as number }));
}

function resizeProportionally(input: {
  totalUnits: number;
  targetTotalKcal: number;
  variantIds: readonly string[];
  currentMix: readonly { variantId: string; qty: number }[];
  variants: readonly RecommendationVariant[];
}): CommercePackageSizingResult["recipes"] {
  const caps = input.variants.map(variantCap);
  if (
    input.totalUnits < input.variantIds.length ||
    input.totalUnits > sum(caps) ||
    caps.some((cap) => cap < 1)
  ) {
    return [];
  }

  const currentTotal = input.currentMix.reduce((sum, line) => sum + line.qty, 0);
  const quotas = input.currentMix.map((line, index) => ({
    variantId: line.variantId,
    index,
    quota: (input.totalUnits * line.qty) / currentTotal,
  }));
  const quantities = quotas.map(({ quota, index }) => Math.min(
    caps[index],
    Math.max(1, Math.floor(quota)),
  ));

  while (sum(quantities) > input.totalUnits) {
    const source = quotas
      .filter(({ index }) => quantities[index] > 1)
      .sort((a, b) =>
        (a.quota - Math.floor(a.quota)) - (b.quota - Math.floor(b.quota)) ||
        b.index - a.index,
      )[0];
    if (!source) return [];
    quantities[source.index] -= 1;
  }
  while (sum(quantities) < input.totalUnits) {
    const target = quotas
      .filter(({ index }) => quantities[index] < caps[index])
      .sort((a, b) =>
        (b.quota - quantities[b.index]) - (a.quota - quantities[a.index]) ||
        a.index - b.index,
      )[0];
    if (!target) return [];
    quantities[target.index] += 1;
  }

  const kcal = input.variants.map(kcalPerUnit);
  let packageKcal = quantities.reduce((total, qty, index) => total + qty * kcal[index], 0);
  while (packageKcal < input.targetTotalKcal) {
    const swap = bestKcalRaisingSwap({
      quantities,
      kcal,
      quotas: quotas.map(({ quota }) => quota),
      caps,
      targetTotalKcal: input.targetTotalKcal,
      packageKcal,
    });
    if (!swap) return [];
    quantities[swap.source] -= 1;
    quantities[swap.target] += 1;
    packageKcal += kcal[swap.target] - kcal[swap.source];
  }

  return input.variantIds.map((variantId, index) => ({ variantId, qty: quantities[index] }));
}

function bestKcalRaisingSwap(input: {
  quantities: readonly number[];
  kcal: readonly number[];
  quotas: readonly number[];
  caps: readonly number[];
  targetTotalKcal: number;
  packageKcal: number;
}): { source: number; target: number } | null {
  const candidates: Array<{
    source: number;
    target: number;
    reachesTarget: boolean;
    distanceToTarget: number;
    proportionalDistance: number;
  }> = [];
  for (let source = 0; source < input.quantities.length; source += 1) {
    if (input.quantities[source] <= 1) continue;
    for (let target = 0; target < input.quantities.length; target += 1) {
      if (
        source === target ||
        input.quantities[target] >= input.caps[target] ||
        input.kcal[target] <= input.kcal[source]
      ) continue;
      const nextKcal = input.packageKcal - input.kcal[source] + input.kcal[target];
      const nextQuantities = [...input.quantities];
      nextQuantities[source] -= 1;
      nextQuantities[target] += 1;
      candidates.push({
        source,
        target,
        reachesTarget: nextKcal >= input.targetTotalKcal,
        distanceToTarget: Math.abs(input.targetTotalKcal - nextKcal),
        proportionalDistance: nextQuantities.reduce(
          (distance, qty, index) => distance + Math.abs(qty - input.quotas[index]),
          0,
        ),
      });
    }
  }
  return candidates.sort((a, b) =>
    Number(b.reachesTarget) - Number(a.reachesTarget) ||
    a.proportionalDistance - b.proportionalDistance ||
    a.distanceToTarget - b.distanceToTarget ||
    a.source - b.source ||
    a.target - b.target,
  )[0] ?? null;
}

function kcalPerUnit(variant: RecommendationVariant): number {
  return Math.round((variant.kcalPer100g * variant.netWeightG) / 100);
}

function variantCap(variant: RecommendationVariant): number {
  return Math.min(
    MAX_UNITS_PER_VARIANT,
    variant.sellableNow == null
      ? MAX_UNITS_PER_VARIANT
      : Math.max(0, Math.floor(variant.sellableNow)),
  );
}

async function withLiveAvailability(
  variants: readonly RecommendationVariant[],
  offerAvailabilityPort: CommerceOfferAvailabilityPort | undefined,
): Promise<RecommendationVariant[]> {
  if (!offerAvailabilityPort) return [...variants];
  const availability = await offerAvailabilityPort.getAvailability({
    items: variants.map((variant) => ({
      sku: variant.sku,
      productSlug: variant.slug,
      variantId: variant.variantId,
      requestedQuantity: 1,
      checkoutMode: "subscription" as const,
    })),
  });
  const byVariant = new Map(availability.map((item) => [item.variantId, item]));
  return variants.map((variant) => {
    const live = byVariant.get(variant.variantId);
    // Account template edits are durable future-cycle mutations. Unlike the
    // browse/checkout availability surface, this adapter must not interpret an
    // incomplete or unknown ATP read as 99 units of capacity: doing so could
    // persist a subscription template that the next renewal cannot fulfil.
    if (!live || live.status === "unknown" || live.sellableNow == null) {
      return {
        ...variant,
        purchaseAvailability: "out_of_stock" as const,
        sellableNow: 0,
      };
    }
    return {
      ...variant,
      purchaseAvailability: live.status,
      sellableNow: live.sellableNow,
    };
  });
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
