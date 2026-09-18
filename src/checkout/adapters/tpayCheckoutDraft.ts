import type { CheckoutRequest } from "@/domains/commerce/checkoutContracts";
import type { TpayPaymentChannel } from "@/domains/commerce/tpayChannelsContracts";
import type { PaymentMethod } from "@/checkout/composer/configuratorFormStore";

export interface TpayCheckoutDraft {
  blikToken: string;
  /**
   * Buyer's self-declared bank, for subscriptions only. Empty until answered,
   * `__other__` when they say their bank is not on the supported list.
   *
   * Advisory only — it steers an unsupported buyer to a card before they type a
   * code, but the binding check is `refuseNoPayId` on the transaction, since the
   * declaration can simply be wrong.
   */
  blikBankId: string;
  pblChannelId: string;
  savedMethodId: string;
}

export type TpayCheckoutMode = "one_time" | "subscription";

export const emptyTpayCheckoutDraft: TpayCheckoutDraft = {
  blikToken: "",
  blikBankId: "",
  pblChannelId: "",
  savedMethodId: "",
};

const TPAY_BLIK_GROUP_ID = 150;

/** Sentinel the picker stores when the buyer says their bank is not listed. */
export const BLIK_BANK_UNSUPPORTED = "__other__";

export function isTpayPblCheckoutChannel(channel: TpayPaymentChannel): boolean {
  return channel.available &&
    channel.onlinePayment &&
    channel.instantRedirection &&
    !channel.groups.some((group) => group.id === TPAY_BLIK_GROUP_ID);
}

export function buildTpayCheckoutRequestPatch(input: {
  enabled: boolean;
  paymentMethod: PaymentMethod | null;
  draft: TpayCheckoutDraft;
  checkoutMode: TpayCheckoutMode;
}): Pick<CheckoutRequest, "paymentProvider" | "paymentExecution" | "declaredBankId"> | null {
  if (!input.enabled) return null;
  if (input.paymentMethod === "blik") {
    const blikToken = input.draft.blikToken.trim();
    if (!/^\d{6}$/.test(blikToken)) return null;
    // The sentinel means "my bank is not on the list", which is an answer about
    // the roster rather than an issuer, so it is not reported as one. Only
    // subscription checkout asks, because only a reusable mandate needs it.
    const declaredBank = input.checkoutMode === "subscription" && input.draft.blikBankId !== BLIK_BANK_UNSUPPORTED
      ? input.draft.blikBankId.trim()
      : "";
    return {
      paymentProvider: "tpay",
      // Reported beside the execution, not inside it: the issuer is a scheme
      // fact and the acquirer is replaceable. OMITTED rather than sent empty
      // when there is no answer — the contract requires a non-empty value, and
      // an absent field is the honest shape for "not asked".
      ...(declaredBank === "" ? {} : { declaredBankId: declaredBank }),
      paymentExecution: input.checkoutMode === "subscription"
        ? { provider: "tpay", flow: "blik_recurring_activation", blikToken, recurringModel: "O" }
        : { provider: "tpay", flow: "blik_one_time", blikToken },
    };
  }
  if (input.paymentMethod === "blik_one_click") {
    const savedMethodId = input.draft.savedMethodId.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(savedMethodId)) return null;
    return {
      paymentProvider: "tpay",
      paymentExecution: input.checkoutMode === "subscription"
        ? { provider: "tpay", flow: "blik_recurring_saved", savedMethodId }
        : { provider: "tpay", flow: "blik_one_click", savedMethodId },
    };
  }
  if (input.paymentMethod === "transfer") {
    if (input.checkoutMode === "subscription") return null;
    const channelId = input.draft.pblChannelId.trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(channelId)) return null;
    return {
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "pbl_one_time", channelId },
    };
  }
  return null;
}

export function validateTpayCheckoutDraft(input: {
  enabled: boolean;
  paymentMethod: PaymentMethod | null;
  draft: TpayCheckoutDraft;
  checkoutMode: TpayCheckoutMode;
  /** Off keeps the pre-picker behaviour: no bank is asked for, none is required. */
  bankPickerEnabled?: boolean;
}): Record<string, string> {
  if (!input.enabled) return {};
  // Bank first: for subscriptions the code field is hidden until a bank is named,
  // so reporting a missing CODE here would point at a field the buyer cannot see
  // and leave the submit button silently inert.
  if (input.paymentMethod === "blik" && input.checkoutMode === "subscription" && input.bankPickerEnabled) {
    if (!input.draft.blikBankId) {
      return { blikBankId: "checkout:step6.blikBankError" };
    }
    if (input.draft.blikBankId === BLIK_BANK_UNSUPPORTED) {
      return { blikBankId: "checkout:step6.blikBankUnsupportedTitle" };
    }
  }
  if (input.paymentMethod === "blik" && !/^\d{6}$/.test(input.draft.blikToken.trim())) {
    return { blikToken: "checkout:step6.blikCodeError" };
  }
  if (input.paymentMethod === "blik_one_click" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.draft.savedMethodId.trim())) {
    return { savedMethodId: "checkout:step6.savedBlikUnavailableError" };
  }
  if (input.paymentMethod === "transfer" && input.checkoutMode === "subscription") {
    return { pblChannelId: "checkout:step6.subscriptionPblUnsupportedError" };
  }
  if (input.paymentMethod === "transfer" && !/^[A-Za-z0-9_-]{1,40}$/.test(input.draft.pblChannelId.trim())) {
    return { pblChannelId: "checkout:step6.channelError" };
  }
  return {};
}
