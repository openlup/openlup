import type {
  CustomerSubscriptionBlockReason,
  CustomerSubscriptionPreviewRequest,
  CustomerSubscriptionPreviewResponse,
} from "../../../src/domains/customers/subscriptionFacadeContracts.js";
import {
  subscriptionActionRequiresChargeTimingConfirmation,
  canUsePaymentMethodForRenewal,
  resolveSubscriptionPaymentMethodStatus,
  type SubscriptionPaymentMethodStatus,
  type SubscriptionRenewalBlockStatus,
} from "../../../src/domains/subscription/contracts.js";
import {
  computeEditState,
  type CustomerSubscriptionEligibilityInput,
  type EditBlockedReason,
} from "./customerAccountV2ReadModels.js";

export function actionEligibility(
  action: CustomerSubscriptionPreviewRequest["subscriptionAction"]["action"],
  input: CustomerSubscriptionEligibilityInput,
  blockers: ReadonlyMap<string, EditBlockedReason>,
) {
  const sharedBlocker = blockers.get(input.subscriptionId);
  if (action === "change_shipping_address") {
    if (input.status !== "active" && input.status !== "paused") {
      return { canEdit: false, reason: "not_active" as const };
    }
    return sharedBlocker === "cycle_locked"
      ? { canEdit: false, reason: "cycle_locked" as const }
      : { canEdit: true, reason: null };
  }
  if (sharedBlocker === "payment_blocked") return { canEdit: false, reason: sharedBlocker };
  if (action === "pause") {
    return input.status === "active"
      ? { canEdit: true, reason: null }
      : { canEdit: false, reason: "not_active" as const };
  }
  if (action === "cancel") {
    return input.status === "active" || input.status === "paused"
      ? { canEdit: true, reason: null }
      : { canEdit: false, reason: "not_active" as const };
  }
  if (action === "resume") {
    if (input.status !== "paused") return { canEdit: false, reason: "not_active" as const };
    const hasUsablePaymentMethod = input.paymentMethodStatus
      ? canUsePaymentMethodForRenewal(input.paymentMethodStatus)
      : Boolean(input.paymentMethodKind && input.paymentMethodRefPresent);
    if (!hasUsablePaymentMethod) {
      return { canEdit: false, reason: "missing_payment_method" as const };
    }
    return { canEdit: true, reason: null };
  }
  return computeEditState(input, blockers);
}

export function previewTelemetry(input: {
  action: CustomerSubscriptionPreviewRequest["subscriptionAction"];
  subscription: Record<string, unknown>;
  nextCycleAt: string | null;
  blocker: EditBlockedReason | undefined;
  previewReason: CustomerSubscriptionBlockReason;
  paymentMethodStatus?: SubscriptionPaymentMethodStatus;
}): Pick<
  CustomerSubscriptionPreviewResponse["preview"],
  "lockedCycle" | "futureTemplate" | "paymentMethodStatus" | "deliverability" | "catalogAvailability" | "chargeTiming"
> {
  return {
    lockedCycle: { locked: input.blocker === "cycle_locked", status: blockerStatus(input.blocker) },
    futureTemplate: {
      templateVersion: numberOrNull(input.subscription.template_version),
      effectiveCycleAt: input.nextCycleAt,
      priceAgreementPolicy: "lock_until_edit",
    },
    paymentMethodStatus: input.paymentMethodStatus ?? resolvePreviewPaymentMethodStatus(input.subscription),
    deliverability: {
      status: input.previewReason === "invalid_address"
        ? "blocked"
        : input.action.action === "change_shipping_address"
          ? "address_book_validated"
          : "unknown",
      blockedReason: input.previewReason === "invalid_address" ? "invalid_address" : null,
    },
    catalogAvailability: { status: "unknown", blockedReason: null },
    chargeTiming: {
      requiresConfirmation: subscriptionActionRequiresChargeTimingConfirmation(input.action.action),
      confirmed: "confirmedChargeTiming" in input.action && input.action.confirmedChargeTiming === true,
      earliestChargeAt: input.action.action === "order_now" || input.action.action === "reactivate" ? input.nextCycleAt : null,
    },
  };
}

export function quoteExpiresAt(): string {
  return new Date(Date.now() + 15 * 60 * 1000).toISOString();
}

export function resolvePreviewPaymentMethodStatus(
  subscription: Record<string, unknown>,
): SubscriptionPaymentMethodStatus {
  return resolveSubscriptionPaymentMethodStatus({
    clientId: nullableText(subscription.client_id),
    methodClientId: nullableText(subscription.payment_method_client_id),
    providerKind: nullableText(subscription.provider_kind),
    providerCustomerRef: nullableText(subscription.provider_customer_ref),
    providerMethodRef: nullableText(subscription.provider_method_ref) ?? nullableText(subscription.payment_method_ref),
    methodKind: nullableText(subscription.provider_method_kind) ?? nullableText(subscription.payment_method_kind),
    methodStatus: nullableText(subscription.payment_method_status),
    methodActive: booleanOrNull(subscription.payment_method_active),
    methodExpiresAt: nullableText(subscription.payment_method_expires_at),
    payerEmail: nullableText(subscription.payer_email),
  }).status;
}

function blockerStatus(reason: EditBlockedReason | undefined): SubscriptionRenewalBlockStatus | null {
  if (reason === "cycle_locked") return "blocked_preflight";
  if (reason === "payment_blocked") return "dunning";
  return null;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
