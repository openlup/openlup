import type { CustomerSubscriptionActionRequest } from "../../../src/domains/customers/selfServiceContracts.js";
import { subscriptionActionRequiresAcceptedQuote } from "../../../src/domains/subscription/contracts.js";
import type { SubscriptionRepricer } from "./subscriptionRepricePort.js";
import type { SubscriptionProtocolAction } from "./subscriptionGenericBundleActions.js";

export async function withSubscriptionRepricePayload(
  subscriptionRepricer: SubscriptionRepricer | undefined,
  input: CustomerSubscriptionActionRequest | SubscriptionProtocolAction,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!subscriptionRepricer) {
    if (subscriptionActionRequiresAcceptedQuote(input.action)) {
      throw new Error("subscription_reprice_unavailable");
    }
    return payload;
  }

  if (
    input.action === "swap_recipe" ||
    input.action === "add_addon" ||
    input.action === "remove_addon" ||
    input.action === "update_addon_quantity"
  ) {
    const quote = await subscriptionRepricer.repriceForEdit({
      subscriptionId: input.subscriptionId,
      action: input.action,
      payload,
    });
    if (!quote) return payload;
    assertAcceptedQuote(input, quote.quoteHash);
    return {
      ...payload,
      repricedLines: quote.repricedLines,
      expectedTemplateVersion: quote.expectedTemplateVersion,
      acceptedQuoteHash: quote.quoteHash,
    };
  }

  if (
    input.action === "update_plan_length" ||
    input.action === "update_recipe_mix" ||
    input.action === "set_portion_mode" ||
    input.action === "update_bundle" ||
    input.action === "resize_bundle"
  ) {
    const recipeSet = await subscriptionRepricer.repriceRecipeSet({
      subscriptionId: input.subscriptionId,
      action: input.action,
      payload,
      sourceAction: "protocolSourceAction" in input ? input.protocolSourceAction : undefined,
    });
    if (!recipeSet) return payload;
    assertAcceptedQuote(input, recipeSet.quoteHash);
    if (input.action === "update_bundle" || input.action === "resize_bundle") {
      return {
        ...payload,
        ...(input.action === "update_bundle" ? { cadenceDays: recipeSet.cadenceDays } : {}),
        coreLines: recipeSet.recipeLines,
        ...(recipeSet.rewriteAddonLines ? { addonLines: recipeSet.addonLines } : { repricedLines: recipeSet.addonLines }),
        compositionConstraint: recipeSet.compositionConstraint,
        expectedTemplateVersion: recipeSet.expectedTemplateVersion,
        acceptedQuoteHash: recipeSet.quoteHash,
      };
    }
    return {
      ...payload,
      recipeLines: recipeSet.recipeLines,
      repricedLines: recipeSet.addonLines,
      expectedTemplateVersion: recipeSet.expectedTemplateVersion,
      acceptedQuoteHash: recipeSet.quoteHash,
    };
  }

  if (input.action !== "update_package_template") return payload;

  const packageEdit = await subscriptionRepricer.previewPackageEdit({
    subscriptionId: input.subscriptionId,
    payload,
  });
  if (!input.acceptedQuoteHash || input.acceptedQuoteHash !== packageEdit.quoteHash) {
    throw new Error("subscription_reprice_quote_not_accepted");
  }
  return {
    ...payload,
    planDays: packageEdit.cadenceDays,
    nominalPlanDays: payload.planDays,
    recipeLines: packageEdit.recipeLines,
    addonLines: packageEdit.addonLines,
    expectedTemplateVersion: packageEdit.expectedTemplateVersion,
    acceptedQuoteHash: packageEdit.quoteHash,
    currentRecurringPrice: packageEdit.currentRecurringPrice,
    newRecurringPrice: packageEdit.newRecurringPrice,
    delta: packageEdit.delta,
  };
}

function assertAcceptedQuote(
  input: CustomerSubscriptionActionRequest,
  quoteHash: string,
): void {
  const acceptedQuoteHash = "acceptedQuoteHash" in input ? input.acceptedQuoteHash : undefined;
  if (!acceptedQuoteHash || acceptedQuoteHash !== quoteHash) {
    throw new Error("subscription_reprice_quote_not_accepted");
  }
}
