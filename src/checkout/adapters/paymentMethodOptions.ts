import type { PaymentMethod } from "@/checkout/composer/configuratorFormStore";
import {
  stripeCheckoutUiEnabled,
  tpayBlikModelOEnabled,
  tpayCheckoutScaffoldingEnabled,
} from "@/lib/flags";
import { tpaySimulatorUiEnabled } from "./tpayCheckoutFlags";
import {
  buildTpayCheckoutRequestPatch,
  type TpayCheckoutMode,
} from "./tpayCheckoutDraft";

export {
  applyTpaySimulatorPaymentResult as applyPaymentSimulatorResult,
  getTpayPaymentChannels as getChannels,
} from "@/domains/commerce/commerceClient";
export type { TpaySimulatorResultStatus as PaymentSimulatorResultStatus } from "@/domains/commerce/commerceClient";
export type { TpayPaymentChannel as PaymentChannel } from "@/domains/commerce/tpayChannelsContracts";
export {
  BLIK_BANK_UNSUPPORTED as PAYMENT_BANK_UNSUPPORTED,
  buildTpayCheckoutRequestPatch as buildPaymentCheckoutRequestPatch,
  emptyTpayCheckoutDraft as emptyPaymentCheckoutDraft,
  isTpayPblCheckoutChannel as isPayByLinkPaymentChannel,
  validateTpayCheckoutDraft as validatePaymentCheckoutDraft,
} from "./tpayCheckoutDraft";
export type {
  TpayCheckoutDraft as PaymentCheckoutDraft,
  TpayCheckoutMode as PaymentCheckoutMode,
} from "./tpayCheckoutDraft";
export type PaymentCheckoutRequestPatch = NonNullable<ReturnType<typeof buildTpayCheckoutRequestPatch>>;
export type { PaymentMethod };

/** Provider configuration consumed by recovery without leaking provider flags. */
export function recoveryPaymentMethodVisibility(): PaymentMethodVisibility {
  return {
    stripeEnabled: stripeCheckoutUiEnabled(),
    tpayEnabled: tpayCheckoutScaffoldingEnabled(),
    tpayOneClickAvailable: false,
    tpayModelOEnabled: tpayBlikModelOEnabled(),
  };
}

export const paymentBankPickerEnabled = tpayBlikModelOEnabled;

export const paymentSimulatorEnabled = tpaySimulatorUiEnabled;
export const RECOVERY_PAYMENT_PROVIDER = "tpay";

export type PaymentProviderKind = "stripe" | "tpay";

export interface PaymentMethodOption {
  value: PaymentMethod;
  provider: PaymentProviderKind;
}

/**
 * Catalog of payment methods offered on the configurator payment step, in display
 * order.
 *
 * `card` is fulfilled by Stripe and additionally surfaces Apple Pay / Google Pay
 * wallet buttons inside the Stripe Payment Element when the device supports them
 * (so the user picks the wallet without a separate up-front tile). `blik` and
 * `transfer` (pay-by-link) are fulfilled by Tpay.
 */
const PAYMENT_METHOD_CATALOG: readonly PaymentMethodOption[] = [
  { value: "card", provider: "stripe" },
  { value: "blik_one_click", provider: "tpay" },
  { value: "blik", provider: "tpay" },
  { value: "transfer", provider: "tpay" },
];

export interface PaymentMethodVisibility {
  /**
   * Whether Stripe-backed methods (card + Apple Pay / Google Pay wallets) are
   * offered. Gated by `VITE_COMMERCE_STRIPE_CHECKOUT_UI_ENABLED`.
   */
  stripeEnabled: boolean;
  /**
   * Whether Tpay-backed methods (BLIK, pay-by-link) are offered. Gated by
   * `VITE_PAYMENTS_TPAY_CHECKOUT_SCAFFOLDING`.
   */
  tpayEnabled: boolean;
  /**
   * Whether the authenticated customer has an active server-side Tpay BLIK
   * saved method usable for the current checkout mode and the one-click UI flag
   * is on.
   */
  tpayOneClickAvailable?: boolean;
  /** Whether new subscription BLIK Model O activations may be offered. */
  tpayModelOEnabled?: boolean;
}

/**
 * Methods visible for a given checkout mode + per-provider availability.
 *
 * Each provider's tiles are shown only when its flag is on, so a provider can be
 * switched on/off entirely from configuration — no code change. Tpay pay-by-link
 * (`transfer`) additionally has no recurring variant, so it is hidden for
 * subscriptions even when Tpay is enabled — mirroring the contract-level
 * rejection in {@link buildTpayCheckoutRequestPatch} and `checkoutRequestSchema`.
 * BLIK and card both support one-time and recurring.
 */
export function visiblePaymentMethods(
  mode: TpayCheckoutMode,
  {
    stripeEnabled,
    tpayEnabled,
    tpayOneClickAvailable = false,
    tpayModelOEnabled = false,
  }: PaymentMethodVisibility,
): PaymentMethodOption[] {
  return PAYMENT_METHOD_CATALOG.filter((option) => {
    if (option.provider === "stripe" && !stripeEnabled) return false;
    if (option.provider === "tpay" && !tpayEnabled) return false;
    if (option.value === "blik_one_click" && !tpayOneClickAvailable) return false;
    if (option.value === "blik" && mode === "subscription" && !tpayModelOEnabled) return false;
    if (option.value === "transfer" && mode !== "one_time") return false;
    return true;
  });
}

/** True when `method` is offered for the given checkout mode + provider availability. */
export function isPaymentMethodVisible(
  method: PaymentMethod,
  mode: TpayCheckoutMode,
  visibility: PaymentMethodVisibility,
): boolean {
  return visiblePaymentMethods(mode, visibility).some((option) => option.value === method);
}

/** Provider that fulfils a given payment method. */
export function providerForPaymentMethod(method: PaymentMethod): PaymentProviderKind {
  return (
    PAYMENT_METHOD_CATALOG.find((option) => option.value === method)?.provider ?? "stripe"
  );
}
