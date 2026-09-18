import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BundleLineRef,
  CompositionRulesPort,
} from "../../../src/domains/bundle/ports.js";
import type { CreateQuoteRequest, CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type { CommerceQuotePort } from "../../../src/domains/commerce/ports.js";
import type { CommerceQuoteCatalogReadPort } from "../../domains/commerce/commerceQuoteCatalogReadPort.js";
import { COMMERCE_MIN_ORDER_UNITS } from "../../../src/domains/commerce/recommendationPolicyDeps.js";
import {
  toCorePetfoodCompositionConstraint,
  toLegacyPetfoodQuoteSizeConstraint,
} from "../../domains/commerce/ports.js";
import {
  buildSkuMap,
  readCurrentPackagePrice,
  readSubscription,
  readSubscriptionAndLines,
} from "./subscriptionRepriceData.js";
import { readNominalPlanDays } from "../../domains/customers/subscriptionResizeLever.js";
import type {
  PackageEditLine,
  PackageEditQuote,
} from "../../domains/customers/subscriptionRepricePort.js";

export type {
  PackageEditLine,
  PackageEditQuote,
} from "../../domains/customers/subscriptionRepricePort.js";

export interface PackageEditQuoteInput {
  subscriptionId: string;
  planDays: number;
  recipes: Array<{ variantId: string; qty: number }>;
  addons: Array<{ variantId: string; qty: number }>;
}

export interface PackageEditQuoteDeps {
  serviceClient: SupabaseClient;
  quoteCatalogReadPort: CommerceQuoteCatalogReadPort;
  quotePort: CommerceQuotePort;
  compositionRulesPort: CompositionRulesPort;
}

export async function quotePackageEdit(
  deps: PackageEditQuoteDeps,
  input: PackageEditQuoteInput,
): Promise<PackageEditQuote> {
  const { subscription, currentLines } = await readSubscriptionAndLines(deps.serviceClient, input.subscriptionId);
  const skuByVariant = await buildSkuMap(deps.quoteCatalogReadPort);
  const currentRecipes = currentLines.filter((line) => !line.isAddon);
  if (currentRecipes.length === 0) throw new Error("subscription_reprice_no_recipes");

  const requestedRecipes = sanitizeLines(input.recipes, "subscription_reprice_invalid_recipe_mix");
  const requestedAddons = sanitizeLines(input.addons, "subscription_reprice_invalid_addons");
  const validation = await deps.compositionRulesPort.validateComposition({
    coreLines: requestedRecipes.map((line) => toBundleLine(line, false)),
    addonLines: requestedAddons.map((line) => toBundleLine(line, true)),
    constraint: toCorePetfoodCompositionConstraint(subscription.sizeConstraint),
  });
  if (validation.ok === false) throw new Error(validation.code);
  // Line quantities are now independent, so the only order-level
  // floor is the minimum order quantity. It is checked on the REQUESTED set,
  // before any cadence-driven resize, so both composition branches are covered.
  const requestedUnitTotal = requestedRecipes.reduce((sum, line) => sum + line.qty, 0);
  if (requestedUnitTotal < COMMERCE_MIN_ORDER_UNITS) {
    throw new Error("subscription_reprice_below_minimum_order_units");
  }

  const desired = await desiredRecipeComposition(deps, {
    subscription,
    requestedRecipes,
    planDays: input.planDays,
  });
  // Comparison baseline only. It tolerates a line whose SKU has left the
  // sellable catalog by charging that line at its frozen per-cycle gross, so the
  // editor stays open to the owner who needs it to drop that very line.
  const currentQuotePromise = readCurrentPackagePrice(deps.quotePort, skuByVariant, {
    cadenceDays: subscription.cadenceDays,
    sizeConstraint: subscription.sizeConstraint,
    currentLines,
  });
  const desiredLines = [
    ...desired.recipes.map((line) => ({ ...line, isAddon: false })),
    ...requestedAddons.map((line) => ({ ...line, isAddon: true })),
  ];
  const desiredQuotePromise = quoteLines(deps.quotePort, skuByVariant, {
    cadenceDays: desired.cadenceDays,
    sizeConstraint: desired.sizeConstraint,
    lines: desiredLines,
  });
  const [currentQuoteResult, desiredQuoteResult] = await Promise.allSettled([
    currentQuotePromise,
    desiredQuotePromise,
  ]);
  // Current quote used to be awaited first. Preserve that failure precedence
  // while ensuring both concurrently-started quote calls are observed.
  const currentRecurringPrice = settledValue(currentQuoteResult);
  const desiredQuote = settledValue(desiredQuoteResult);
  if (desiredQuote.quote.lines.length !== desiredLines.length) {
    throw new Error("subscription_reprice_line_count_mismatch");
  }

  const newRecurringPrice = desiredQuote.quote.totalGross;
  return {
    currentRecurringPrice,
    newRecurringPrice,
    delta: {
      amountMinor: newRecurringPrice.amountMinor - currentRecurringPrice.amountMinor,
      currency: newRecurringPrice.currency,
    },
    quoteHash: hashQuote(desiredQuote.quote),
    recipeLines: desired.recipes.map((recipe, index) => ({
      variantId: recipe.variantId,
      qty: recipe.qty,
      quoteLine: desiredQuote.quote.lines[index],
    })),
    addonLines: requestedAddons.map((addon, index) => ({
      variantId: addon.variantId,
      qty: addon.qty,
      quoteLine: desiredQuote.quote.lines[desired.recipes.length + index],
    })),
    cadenceDays: desired.cadenceDays,
    expectedTemplateVersion: subscription.templateVersion,
  };
}

async function desiredRecipeComposition(
  deps: PackageEditQuoteDeps,
  input: {
    subscription: Awaited<ReturnType<typeof readSubscription>>;
    requestedRecipes: Array<{ variantId: string; qty: number }>;
    planDays: number;
  },
): Promise<{
  recipes: Array<{ variantId: string; qty: number }>;
  sizeConstraint: CreateQuoteRequest["sizeConstraint"];
  cadenceDays: number;
}> {
  const currentPlanDays = readNominalPlanDays(input.subscription.sizeConstraint)
    ?? input.subscription.cadenceDays;
  const planChanged = input.planDays !== currentPlanDays;

  // A cadence change no longer resizes the package. The customer picked the
  // per-line quantities explicitly in the editor, so they are authoritative and
  // are quoted verbatim; the plan change only moves the delivery cadence and
  // the nominal plan-length stamp. The `planLengthConstraint` lever is the
  // trivial stamp — no sizing, catalog or stock reads — so it cannot fail with
  // `subscription_reprice_missing_daily_kcal` /
  // `subscription_reprice_plan_length_unservable` on legacy rows, and it keeps
  // the quote deterministic for the preview/apply drift lock.
  //
  // No fixed-total check either: a mix edit may legitimately change the can
  // count now that per-line quantities are independent. The order minimum is
  // enforced once, on the requested set, in `quotePackageEdit`.
  const normalized = await deps.compositionRulesPort.resizeComposition({
    coreLines: input.requestedRecipes.map((line) => toBundleLine(line, false)),
    constraint: toCorePetfoodCompositionConstraint(input.subscription.sizeConstraint),
    lever: { kind: "planLengthConstraint", value: input.planDays },
  });
  return {
    recipes: input.requestedRecipes,
    sizeConstraint: normalized
      ? toLegacyPetfoodQuoteSizeConstraint(normalized.constraint)
      : input.subscription.sizeConstraint,
    // A nominal feeding-days plan may intentionally have a longer delivery
    // cadence (legacy rows with cadence 30 / nominal 14). An edit that leaves
    // the plan alone must preserve that cadence instead of silently dropping
    // it to the nominal value.
    cadenceDays: planChanged ? input.planDays : input.subscription.cadenceDays,
  };
}

async function quoteLines(
  quotePort: CommerceQuotePort,
  skuByVariant: ReadonlyMap<string, string>,
  input: {
    cadenceDays: number;
    sizeConstraint: CreateQuoteRequest["sizeConstraint"];
    lines: Array<{ variantId: string; qty: number; isAddon: boolean }>;
  },
): Promise<CreateQuoteResponse> {
  const lines = input.lines.map((line) => {
    const sku = skuByVariant.get(line.variantId);
    if (!sku) throw new Error(`subscription_reprice_unknown_variant:${line.variantId}`);
    return {
      sku,
      quantity: line.qty,
      modeAtLine: "subscription" as const,
      isAddon: line.isAddon,
    };
  });
  return quotePort.createQuote({
    mode: "subscription",
    cadenceDays: input.cadenceDays,
    sizeConstraint: input.sizeConstraint,
    promoCodes: [],
    lines,
  });
}

function sanitizeLines(
  lines: Array<{ variantId: string; qty: number }>,
  errorCode: string,
): Array<{ variantId: string; qty: number }> {
  const sanitized = lines.map((line) => ({
    variantId: String(line.variantId ?? ""),
    qty: Math.trunc(Number(line.qty)),
  }));
  if (sanitized.some((line) => !line.variantId || !Number.isInteger(line.qty) || line.qty <= 0)) {
    throw new Error(errorCode);
  }
  if (new Set(sanitized.map((line) => line.variantId)).size !== sanitized.length) {
    throw new Error("subscription_reprice_duplicate_variant");
  }
  return sanitized;
}

function toBundleLine(
  line: { variantId: string; qty: number },
  isAddon: boolean,
): BundleLineRef {
  return { variantId: line.variantId, qty: line.qty, isAddon };
}

export function hashQuote(quote: CreateQuoteResponse["quote"]): string {
  const snapshot = {
    totalGross: quote.totalGross,
    subtotalGross: quote.subtotalGross,
    discountTotalGross: quote.discountTotalGross,
    lines: quote.lines.map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
      unitPriceGross: line.unitPriceGross,
      lineSubtotalGross: line.lineSubtotalGross,
      pricingComponents: line.pricingComponents ?? [],
    })),
  };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}
