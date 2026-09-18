import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerSubscriptionPreviewResponse } from "../../../src/domains/customers/subscriptionFacadeContracts.js";
import { subscriptionActionRequiresAcceptedQuote } from "../../../src/domains/subscription/contracts.js";
import { quoteExpiresAt } from "./customerSubscriptionPreviewTelemetry.js";
import { recordSubscriptionQuotePreview } from "./subscriptionQuotePreviewLedger.js";
import type { SubscriptionRepricer } from "./subscriptionEditReprice.js";
import { mapSubscriptionRepriceError } from "../../domains/customers/subscriptionActionErrorMapping.js";

type QuotePreviewAction = {
  action: string;
  subscriptionId: string;
} & Record<string, unknown>;

interface AttachQuotePreviewInput {
  userId: string;
  serviceClient: SupabaseClient;
  subscriptionRepricer?: SubscriptionRepricer;
  action: QuotePreviewAction;
  canApply: boolean;
  nextCycleAt: string | null;
  response: CustomerSubscriptionPreviewResponse;
}

export async function attachSubscriptionPreviewQuote({
  userId,
  serviceClient,
  subscriptionRepricer,
  action,
  canApply,
  nextCycleAt,
  response,
}: AttachQuotePreviewInput): Promise<void> {
  const actionName = action.action as Parameters<typeof subscriptionActionRequiresAcceptedQuote>[0];
  if (!canApply || !subscriptionActionRequiresAcceptedQuote(actionName)) return;
  if (!subscriptionRepricer) throw new Error("subscription_preview_reprice_unavailable");

  const requestPayload = publicRequestPayload(action);
  const expiresAt = quoteExpiresAt();

  if (isLineEditQuoteAction(action.action)) {
    const editQuote = await repriceOrMap(
      () => subscriptionRepricer.repriceForEdit({
        subscriptionId: action.subscriptionId,
        action: action.action,
        payload: requestPayload,
      }),
      action.action,
    );
    if (!editQuote) throw new Error("subscription_preview_reprice_unavailable");
    await recordSubscriptionQuotePreview(serviceClient, {
      userId,
      subscriptionId: action.subscriptionId,
      action: action.action,
      quoteHash: editQuote.quoteHash,
      templateVersion: editQuote.expectedTemplateVersion,
      quoteExpiresAt: expiresAt,
      requestPayload,
      quoteSnapshot: { repricedLines: editQuote.repricedLines },
      totals: {},
    });
    response.preview.quoteHash = editQuote.quoteHash;
    response.preview.quoteExpiresAt = expiresAt;
    return;
  }

  if (isRecipeSetQuoteAction(action.action)) {
    const recipeSet = await repriceOrMap(
      () => subscriptionRepricer.repriceRecipeSet({
        subscriptionId: action.subscriptionId,
        action: action.action,
        payload: requestPayload,
        sourceAction: typeof action.protocolSourceAction === "string" ? action.protocolSourceAction : undefined,
      }),
      action.action,
    );
    if (!recipeSet) throw new Error("subscription_preview_reprice_unavailable");
    const effectiveRequestPayload = action.action === "update_bundle"
      ? { ...requestPayload, cadenceDays: recipeSet.cadenceDays }
      : requestPayload;
    await recordSubscriptionQuotePreview(serviceClient, {
      userId,
      subscriptionId: action.subscriptionId,
      action: action.action,
      quoteHash: recipeSet.quoteHash,
      templateVersion: recipeSet.expectedTemplateVersion,
      quoteExpiresAt: expiresAt,
      requestPayload: effectiveRequestPayload,
      quoteSnapshot: {
        recipeLines: recipeSet.recipeLines,
        addonLines: recipeSet.addonLines,
        compositionConstraint: recipeSet.compositionConstraint,
      },
      totals: {},
    });
    response.preview.quoteHash = recipeSet.quoteHash;
    response.preview.quoteExpiresAt = expiresAt;
    // When the generic-bundle flag rewrote `update_package_template` → `update_bundle`,
    // the account "Edytuj pakiet" editor still needs `preview.packageEdit` to render
    // current/new/delta. Attach it from the SAME recipe-set quote (identical
    // `quoteHash` the apply path validates), so preview and confirm agree.
    if (
      typeof action.protocolSourceAction === "string" &&
      action.protocolSourceAction === "update_package_template" &&
      recipeSet.currentRecurringPrice &&
      recipeSet.newRecurringPrice
    ) {
      const delta = {
        amountMinor: recipeSet.newRecurringPrice.amountMinor - recipeSet.currentRecurringPrice.amountMinor,
        currency: recipeSet.newRecurringPrice.currency,
      };
      response.preview.packageEdit = {
        currentRecurringPrice: recipeSet.currentRecurringPrice,
        newRecurringPrice: recipeSet.newRecurringPrice,
        delta,
        quoteHash: recipeSet.quoteHash,
        effectiveCycleAt: nextCycleAt,
        priceAgreementPolicy: "lock_until_edit",
      };
      response.preview.currentTotal = recipeSet.currentRecurringPrice;
      response.preview.newTotal = recipeSet.newRecurringPrice;
      response.preview.delta = delta;
    }
    return;
  }

  if (action.action !== "update_package_template") return;

  const packageEdit = await repriceOrMap(
    () => subscriptionRepricer.previewPackageEdit({
      subscriptionId: action.subscriptionId,
      payload: requestPayload,
    }),
    action.action,
  );
  const effectiveRequestPayload = {
    ...requestPayload,
    planDays: packageEdit.cadenceDays,
    nominalPlanDays: requestPayload.planDays,
  };
  await recordSubscriptionQuotePreview(serviceClient, {
    userId,
    subscriptionId: action.subscriptionId,
    action: action.action,
    quoteHash: packageEdit.quoteHash,
    templateVersion: packageEdit.expectedTemplateVersion,
    quoteExpiresAt: expiresAt,
    requestPayload: effectiveRequestPayload,
    quoteSnapshot: {
      recipeLines: packageEdit.recipeLines,
      addonLines: packageEdit.addonLines,
    },
    totals: {
      currentRecurringPrice: packageEdit.currentRecurringPrice,
      newRecurringPrice: packageEdit.newRecurringPrice,
      delta: packageEdit.delta,
    },
  });
  response.preview.packageEdit = {
    currentRecurringPrice: packageEdit.currentRecurringPrice,
    newRecurringPrice: packageEdit.newRecurringPrice,
    delta: packageEdit.delta,
    quoteHash: packageEdit.quoteHash,
    effectiveCycleAt: nextCycleAt,
    priceAgreementPolicy: "lock_until_edit",
  };
  response.preview.quoteHash = packageEdit.quoteHash;
  response.preview.quoteExpiresAt = expiresAt;
  response.preview.currentTotal = packageEdit.currentRecurringPrice;
  response.preview.newTotal = packageEdit.newRecurringPrice;
  response.preview.delta = packageEdit.delta;
}

function isLineEditQuoteAction(action: string): action is "swap_recipe" | "add_addon" | "remove_addon" | "update_addon_quantity" {
  return action === "swap_recipe" ||
    action === "add_addon" ||
    action === "remove_addon" ||
    action === "update_addon_quantity";
}

function isRecipeSetQuoteAction(action: string): action is "update_plan_length" | "update_recipe_mix" | "set_portion_mode" | "update_bundle" | "resize_bundle" {
  return action === "update_plan_length" ||
    action === "update_recipe_mix" ||
    action === "set_portion_mode" ||
    action === "update_bundle" ||
    action === "resize_bundle";
}

// A repricer failure here is the customer's requested edit being unservable (e.g. a
// plan-length resize on a subscription whose size_constraint carries no
// dailyKcalOverride), not an infra outage. Route it through the same mapping the
// apply path already uses so preview returns a client-actionable 4xx instead of a
// generic UPSTREAM_UNAVAILABLE 503.
async function repriceOrMap<T>(run: () => Promise<T>, action: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw mapSubscriptionRepriceError(error, action);
  }
}

function publicRequestPayload(action: QuotePreviewAction): Record<string, unknown> {
  const { protocolSourceAction: _protocolSourceAction, ...payload } = action;
  return payload;
}
