import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompositionRulesPort } from "../../../src/domains/bundle/ports.js";
import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import type { CommerceQuotePort } from "../../../src/domains/commerce/ports.js";
import type { CommerceQuoteCatalogReadPort } from "../../domains/commerce/commerceQuoteCatalogReadPort.js";
import { COMMERCE_MIN_ORDER_UNITS } from "../../../src/domains/commerce/recommendationPolicyDeps.js";
import { readLegacyPetfoodQuoteSizeConstraint, toCorePetfoodCompositionConstraint,
  toLegacyPetfoodQuoteSizeConstraint } from "../../domains/commerce/ports.js";
import {
  applyEdit,
  buildSkuMap,
  buildSubscriptionQuoteRequest,
  readSubscriptionAndLines,
  quoteRecipeSetPrices,
  type RecipeSetReprice,
  type SubscriptionRepricer,
} from "./subscriptionRepriceData.js";
import { hashQuote, quotePackageEdit } from "./subscriptionPackageEditQuote.js";
import { normalizeResizeLever, readPositiveInt, readResizeLever, resolveBundleCadence } from "../../domains/customers/subscriptionResizeLever.js";

export type { RecipeSetReprice, RepricedEditQuote, RepricedLine, SubscriptionRepricer } from "./subscriptionRepriceData.js";

interface SubscriptionRepricerDeps {
  serviceClient: SupabaseClient;
  quoteCatalogReadPort: CommerceQuoteCatalogReadPort;
  // MUST be built WITHOUT a promo data port: renewals re-price at the pure recurring
  // band, never the cycle-#1-only acquisition promo.
  quotePort: CommerceQuotePort;
  // Owns composition-specific validation and resize rules so subscription core
  // keeps size constraints opaque.
  compositionRulesPort: CompositionRulesPort;
}

export function createSubscriptionRepricer(deps: SubscriptionRepricerDeps): SubscriptionRepricer {
  return {
    async repriceForEdit({ subscriptionId, action, payload }) {
      if (
        action !== "swap_recipe" &&
        action !== "add_addon" &&
        action !== "remove_addon" &&
        action !== "update_addon_quantity"
      ) return null;

      const { subscription, currentLines } = await readSubscriptionAndLines(deps.serviceClient, subscriptionId);
      const skuByVariant = await buildSkuMap(deps.quoteCatalogReadPort);
      const postEdit = applyEdit(action, payload, currentLines);
      if (!postEdit) return null;

      const requestLines = postEdit.map((ref) => {
        const sku = skuByVariant.get(ref.variantId);
        if (!sku) throw new Error(`subscription_reprice_unknown_variant:${ref.variantId}`);
        return { sku, quantity: ref.quantity, modeAtLine: "subscription" as const, isAddon: ref.isAddon };
      });

      const request: CreateQuoteRequest = {
        mode: "subscription",
        cadenceDays: subscription.cadenceDays,
        sizeConstraint: subscription.sizeConstraint,
        promoCodes: [],
        lines: requestLines,
      };
      const { quote } = await deps.quotePort.createQuote(request);
      if (quote.lines.length !== postEdit.length) {
        throw new Error("subscription_reprice_line_count_mismatch");
      }
      return {
        repricedLines: quote.lines.map((quoteLine, index) => ({ lineId: postEdit[index].lineId, quoteLine })),
        quoteHash: hashQuote(quote),
        expectedTemplateVersion: subscription.templateVersion,
      };
    },

    async repriceRecipeSet({ subscriptionId, action, payload, sourceAction }) {
      if (!["update_plan_length", "update_recipe_mix", "set_portion_mode", "update_bundle", "resize_bundle"].includes(action)) return null;

      const { subscription, currentLines } = await readSubscriptionAndLines(deps.serviceClient, subscriptionId);
      const skuByVariant = await buildSkuMap(deps.quoteCatalogReadPort);
      const recipes = currentLines.filter((line) => !line.isAddon);
      const addons = currentLines.filter((line) => line.isAddon);
      if (recipes.length === 0) throw new Error("subscription_reprice_no_recipes");

      let desiredRecipes: Array<{ variantId: string; qty: number }>;
      let desiredAddons: Array<{ variantId: string; qty: number; lineId?: string }> =
        addons.map((addon) => ({ variantId: addon.variantId, qty: addon.quantity, lineId: addon.lineId as string }));
      let rewriteAddonLines = false;
      let cadenceDays = subscription.cadenceDays;
      let sizeConstraint = subscription.sizeConstraint;
      const coreLines = recipes.map((line) => ({
        variantId: line.variantId,
        qty: line.quantity,
        isAddon: false,
      }));

      if (action === "update_plan_length") {
        const planDays = Math.trunc(Number(payload.planDays));
        if (!Number.isInteger(planDays) || planDays <= 0) {
          throw new Error("subscription_reprice_invalid_plan_length");
        }
        const resized = await deps.compositionRulesPort.resizeComposition({
          coreLines,
          constraint: toCorePetfoodCompositionConstraint(sizeConstraint),
          lever: { kind: "planLength", value: planDays },
        });
        if (!resized) {
          throw new Error("subscription_reprice_plan_length_unservable");
        }
        desiredRecipes = resized.coreLines.map((line) => ({ variantId: line.variantId, qty: line.qty }));
        cadenceDays = planDays;
        sizeConstraint = toLegacyPetfoodQuoteSizeConstraint(resized.constraint);
      } else if (action === "set_portion_mode") {
        const resized = await deps.compositionRulesPort.resizeComposition({
          coreLines,
          constraint: toCorePetfoodCompositionConstraint(sizeConstraint),
          lever: {
            kind: "portionMode",
            value: { portionMode: payload.portionMode, planDays: subscription.cadenceDays },
          },
        });
        if (!resized) {
          throw new Error("subscription_reprice_portion_unservable");
        }
        desiredRecipes = resized.coreLines.map((line) => ({ variantId: line.variantId, qty: line.qty }));
        sizeConstraint = toLegacyPetfoodQuoteSizeConstraint(resized.constraint);
      } else if (action === "resize_bundle") {
        const resizeLever = readResizeLever(payload.resizeLever);
        const resized = await deps.compositionRulesPort.resizeComposition({
          coreLines,
          constraint: toCorePetfoodCompositionConstraint(payload.compositionConstraint ?? sizeConstraint),
          lever: normalizeResizeLever(resizeLever, payload.cadenceDays, subscription.cadenceDays),
        });
        if (!resized) {
          throw new Error("subscription_reprice_bundle_resize_unservable");
        }
        desiredRecipes = resized.coreLines.map((line) => ({ variantId: line.variantId, qty: line.qty }));
        cadenceDays = readPositiveInt(payload.cadenceDays) ?? subscription.cadenceDays;
        sizeConstraint = toLegacyPetfoodQuoteSizeConstraint(resized.constraint);
      } else if (action === "update_bundle") {
        const requestedCadenceDays = readPositiveInt(payload.cadenceDays);
        const bundleCadence = resolveBundleCadence(
          sourceAction, requestedCadenceDays, subscription.cadenceDays, sizeConstraint,
        );
        const requested = Array.isArray(payload.coreLines)
          ? (payload.coreLines as Array<Record<string, unknown>>)
          : [];
        desiredRecipes = requested.map((line) => ({
          variantId: String(line.variantId ?? ""),
          qty: Math.trunc(Number(line.qty)),
        }));
        // Captured pre-resize: the MOQ floor measures what the customer asked for.
        const requestedUnitTotal = desiredRecipes.reduce((sum, line) => sum + line.qty, 0);
        rewriteAddonLines = Array.isArray(payload.addonLines);
        desiredAddons = rewriteAddonLines
          ? (payload.addonLines as Array<Record<string, unknown>>).map((line) => ({
            variantId: String(line.variantId ?? ""),
            qty: Math.trunc(Number(line.qty)),
          }))
          : addons.map((addon) => ({ variantId: addon.variantId, qty: addon.quantity, lineId: addon.lineId as string }));
        sizeConstraint = readLegacyPetfoodQuoteSizeConstraint(payload.compositionConstraint) ?? sizeConstraint;
        cadenceDays = bundleCadence.cadenceDays;
        if (requestedCadenceDays !== null && payload.compositionConstraint === undefined) {
          const resized = await deps.compositionRulesPort.resizeComposition({
            coreLines: desiredRecipes.map((recipe) => ({
              variantId: recipe.variantId,
              qty: recipe.qty,
              isAddon: false,
            })),
            constraint: toCorePetfoodCompositionConstraint(sizeConstraint),
            lever: {
              kind: bundleCadence.resizeLeverKind,
              value: requestedCadenceDays,
            },
          });
          if (!resized && bundleCadence.requiresPlanResize) {
            throw new Error("subscription_reprice_plan_length_unservable");
          }
          if (resized) {
            desiredRecipes = resized.coreLines.map((line) => ({ variantId: line.variantId, qty: line.qty }));
            sizeConstraint = toLegacyPetfoodQuoteSizeConstraint(resized.constraint);
          }
        }
        const validation = await deps.compositionRulesPort.validateComposition({
          coreLines: desiredRecipes.map((recipe) => ({
            variantId: recipe.variantId,
            qty: recipe.qty,
            isAddon: false,
          })),
          addonLines: rewriteAddonLines
            ? desiredAddons.map((addon) => ({
              variantId: addon.variantId,
              qty: addon.qty,
              isAddon: true,
            }))
            : [],
          constraint: toCorePetfoodCompositionConstraint(sizeConstraint),
        });
        if (validation.ok === false) throw new Error(validation.code);
        // The package editor (rewritten here from `update_package_template`) edits
        // per-line quantities independently, so its only order-level rule is the
        // minimum order quantity. Genuine `update_bundle` callers keep fixed pool.
        if (sourceAction === "update_package_template") {
          if (requestedUnitTotal < COMMERCE_MIN_ORDER_UNITS) throw new Error("subscription_reprice_below_minimum_order_units");
        } else if (bundleCadence.preservesFixedTotal) {
          const currentTotal = recipes.reduce((sum, line) => sum + line.quantity, 0);
          const desiredTotal = desiredRecipes.reduce((sum, recipe) => sum + recipe.qty, 0);
          if (desiredTotal !== currentTotal) {
            throw new Error("subscription_reprice_recipe_total_mismatch");
          }
        }
      } else {
        const requested = Array.isArray(payload.recipes)
          ? (payload.recipes as Array<Record<string, unknown>>)
          : [];
        desiredRecipes = requested.map((recipe) => ({
          variantId: String(recipe.variantId ?? ""),
          qty: Math.trunc(Number(recipe.qty)),
        }));
        const validation = await deps.compositionRulesPort.validateComposition({
          coreLines: desiredRecipes.map((recipe) => ({
            variantId: recipe.variantId,
            qty: recipe.qty,
            isAddon: false,
          })),
          addonLines: [],
          constraint: toCorePetfoodCompositionConstraint(sizeConstraint),
        });
        if (validation.ok === false) throw new Error(validation.code);
        const currentTotal = recipes.reduce((sum, line) => sum + line.quantity, 0);
        const desiredTotal = desiredRecipes.reduce((sum, recipe) => sum + recipe.qty, 0);
        if (desiredTotal !== currentTotal) {
          throw new Error("subscription_reprice_recipe_total_mismatch");
        }
      }
      const orderedLines = [
        ...desiredRecipes.map((recipe) => ({ variantId: recipe.variantId, quantity: recipe.qty, isAddon: false })),
        ...desiredAddons.map((addon) => ({ variantId: addon.variantId, quantity: addon.qty, isAddon: true })),
      ];
      const request = buildSubscriptionQuoteRequest({
        skuByVariant,
        cadenceDays,
        sizeConstraint,
        lines: orderedLines,
      });
      const { quote, currentRecurringPrice } = await quoteRecipeSetPrices({
        quotePort: deps.quotePort,
        desiredRequest: request,
        skuByVariant,
        currentPackage: sourceAction === "update_package_template"
          ? { cadenceDays: subscription.cadenceDays, sizeConstraint: subscription.sizeConstraint, currentLines }
          : undefined,
      });
      if (quote.lines.length !== orderedLines.length) {
        throw new Error("subscription_reprice_line_count_mismatch");
      }
      // Recipes are the leading quote lines; addons trail them (re-locked too,
      // since a plan-length change can shift their tier price).
      const result: RecipeSetReprice = {
        recipeLines: desiredRecipes.map((recipe, index) => ({
          variantId: recipe.variantId,
          qty: recipe.qty,
          quoteLine: quote.lines[index],
        })),
        addonLines: desiredAddons.map((addon, index) => ({
          ...(rewriteAddonLines
            ? { variantId: addon.variantId, qty: addon.qty }
            : { lineId: addon.lineId as string }),
          quoteLine: quote.lines[desiredRecipes.length + index],
        })),
        expectedTemplateVersion: subscription.templateVersion,
        quoteHash: hashQuote(quote),
        cadenceDays,
      };
      if (rewriteAddonLines) result.rewriteAddonLines = true;
      if (action === "update_bundle" || action === "resize_bundle") {
        result.compositionConstraint = sizeConstraint;
      }
      // Package-edit price summary for the "Edytuj pakiet" preview (canonical quote hash).
      if (sourceAction === "update_package_template") {
        Object.assign(result, { currentRecurringPrice, newRecurringPrice: quote.totalGross });
      }
      return result;
    },
    async previewPackageEdit({ subscriptionId, payload }) {
      const recipes = Array.isArray(payload.recipes)
        ? (payload.recipes as Array<{ variantId: string; qty: number }>)
        : [];
      const addons = Array.isArray(payload.addons)
        ? (payload.addons as Array<{ variantId: string; qty: number }>)
        : [];
      return quotePackageEdit(deps, {
        subscriptionId,
        planDays: Math.trunc(Number(payload.planDays)),
        recipes,
        addons,
      });
    },
  };
}
