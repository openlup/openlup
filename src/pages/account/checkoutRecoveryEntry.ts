import type { i18n as I18n } from "i18next";
import { hasCheckoutRecoveryCopy } from "@/checkout/machine/checkoutRecoveryGuidance";
import { recoveryCardPaymentCopy } from "./recoveryErrorCopy";
import { redeemCheckoutRecovery } from "@/domains/commerce/checkoutRecoveryClient";
import {
  CHECKOUT_RECOVERY_RESOLVE_ACTIVE_PAYMENT_CAPABILITY,
  CHECKOUT_RECOVERY_RECREATE_CAPABILITY,
  type CheckoutRecoveryTerminalStatus,
  type CheckoutRecoveryFallback,
  type CheckoutRecoveryOrderSummary,
} from "@/domains/commerce/checkoutRecoveryContracts";
import type { PaymentRecoveryStatusResponse } from "@/domains/commerce/paymentRecoveryGuidanceContracts";
import { getCommercePaymentStatus } from "@/domains/commerce/commerceClient";
import type { CheckoutClientAction } from "@/domains/commerce/checkoutContracts";
import {
  recoveryPaymentMethodVisibility,
  visiblePaymentMethods,
  type PaymentMethod,
} from "@/checkout/adapters/paymentMethodOptions";

const CHECKOUT_RECOVERY_STATUS_TIMEOUT_MS = 8_000;

export type CheckoutRecoveryEntry =
  | { kind: "paid"; order: Pick<CheckoutRecoveryOrderSummary, "orderRef" | "orderId" | "clientId"> }
  | { kind: "already_paid" }
  | { kind: "terminal"; status: Exclude<CheckoutRecoveryTerminalStatus, "paid"> }
  | { kind: "fallback"; fallback: CheckoutRecoveryFallback }
  | { kind: "awaiting_provider"; order: CheckoutRecoveryOrderSummary }
  | { kind: "manual_review"; order: CheckoutRecoveryOrderSummary }
  | {
      kind: "resume_existing";
      order: CheckoutRecoveryOrderSummary;
      clientAction: CheckoutClientAction;
      shouldPoll: boolean;
    }
  | { kind: "unsupported"; order: CheckoutRecoveryOrderSummary }
  | {
      kind: "ready";
      order: CheckoutRecoveryOrderSummary;
      paymentMethod: PaymentMethod | null;
      unsupportedBlik: boolean;
      shouldPoll: boolean;
    };

export async function resolveCheckoutRecoveryEntry(
  token: string,
  resumeStripe: boolean,
): Promise<CheckoutRecoveryEntry> {
  const response = await redeemCheckoutRecovery({
    token,
    capabilities: [
      CHECKOUT_RECOVERY_RECREATE_CAPABILITY,
      CHECKOUT_RECOVERY_RESOLVE_ACTIVE_PAYMENT_CAPABILITY,
    ],
  });
  if (response.recoverable === false) {
    if (response.paidOrder) return { kind: "paid", order: response.paidOrder };
    if (response.terminalStatus === "paid") return { kind: "already_paid" };
    if (response.terminalStatus === "cancelled" || response.terminalStatus === "order_changed") {
      return { kind: "terminal", status: response.terminalStatus };
    }
    return { kind: "fallback", fallback: response.fallback };
  }

  const resolution = response.paymentResolution;
  if (resolution?.kind === "awaiting_provider") {
    return { kind: "awaiting_provider", order: response.order };
  }
  if (resolution?.kind === "manual_review") {
    return { kind: "manual_review", order: response.order };
  }
  if (resolution?.kind === "resume_existing") {
    return {
      kind: "resume_existing",
      order: response.order,
      clientAction: resolution.clientAction,
      // A return from provider authentication is the one exception to the
      // no-poll-on-email-entry rule. It is evidence of a just-completed PSP
      // action, so continue the short existing verification loop.
      shouldPoll: resumeStripe,
    };
  }

  // Older BFF deployments legitimately omit the additive resolution. Keep the
  // old single snapshot read for that response shape only; capability-aware
  // email entry never starts browser polling on load.
  const methods = checkoutRecoveryPaymentMethods(response.order);
  const paymentIntentId = response.order.paymentIntentId;
  const snapshot = (resolution && resolution.kind !== "retry_new") || !paymentIntentId
    ? null
    : await readCheckoutRecoveryPaymentStatus({
        orderId: response.order.orderId,
        paymentIntentId,
        clientId: response.order.clientId,
      }, token).catch(() => null);
  if (snapshot?.status === "paid") return { kind: "paid", order: response.order };
  const unsupportedBlik = false; // Cause-specific recovery now requires the authorized guidance projection.
  const cardAvailable = methods.some((method) => method.value === "card");
  if (unsupportedBlik && !cardAvailable) return { kind: "unsupported", order: response.order };
  return {
    kind: "ready",
    order: response.order,
    // NOTHING is pre-selected on a fresh arrival. The page is reached from a
    // payment that did not go through, so the method used last is the one that
    // just failed them: offering it back, already ticked, is the worst default
    // available and invites a second decline on one careless click. The buyer
    // picks what suits them now, and `canPay` keeps the button inert until they
    // do (no error is shown for the empty state - nothing is wrong yet).
    //
    // The ONE exception is not a preference at all: `resume=stripe` is the
    // return leg of a 3DS challenge the buyer is already inside. They chose card
    // minutes ago and are mid-payment, so the card context has to survive the
    // redirect or the confirmation UI has nothing to render.
    paymentMethod: resumeStripe && methods.some((method) => method.value === "card")
      ? "card"
      : null,
    unsupportedBlik,
    // Compatibility for a provider return from an older server response. This
    // is intentionally not an email-entry poll: the `resume=stripe` marker is
    // set only by the post-3DS return URL.
    shouldPoll: Boolean(!resolution && resumeStripe && response.order.paymentIntentId),
  };
}

export function readCheckoutRecoveryPaymentStatus(
  target: Parameters<typeof getCommercePaymentStatus>[0],
  recoveryToken?: string,
): Promise<PaymentRecoveryStatusResponse> {
  return getCommercePaymentStatus(target, { timeoutMs: CHECKOUT_RECOVERY_STATUS_TIMEOUT_MS,
    ...(recoveryToken ? { headers: { Authorization: `Bearer ${recoveryToken}` } } : {}) });
}

export function checkoutRecoveryPaymentMethods(
  order: Pick<CheckoutRecoveryOrderSummary, "mode">,
) {
  return visiblePaymentMethods(
    order.mode === "subscription_cycle" ? "subscription" : "one_time",
    recoveryPaymentMethodVisibility(),
  );
}

/** The host translates the neutral form keys only after same-order eligibility proof. */
export function checkoutRecoveryCardCopy(t: (key: string) => string, i18n: I18n, covered: boolean, subscription: boolean) {
  const legacy = recoveryCardPaymentCopy(t, subscription);
  if (!covered || !hasCheckoutRecoveryCopy(i18n, "checkout:recoveryGuidance.messages.c09")) return legacy;
  return { ...legacy, loadFailed: t("checkout:recoveryGuidance.messages.c13NoAlternative"),
    loadRetry: t("checkout:recoveryGuidance.actions.retry"), loadAlternative: "",
    recoveryMessage: (key: string) => hasCheckoutRecoveryCopy(i18n, key) ? t(key) : t("checkout:recoveryGuidance.messages.c09") };
}
