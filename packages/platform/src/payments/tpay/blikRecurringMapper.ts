export interface TpayBlikAliasRegistrationInput {
  orderRef: string;
  amountMinor: number;
  currency: string;
  customerEmail: string;
  staticWebhookUrl: string;
  consentRef: string;
}

export interface TpayBlikAliasChargeInput {
  orderRef: string;
  payId: string;
  amountMinor: number;
  currency: string;
  staticWebhookUrl: string;
}

export function buildTpayBlikAliasRegistrationDraft(input: TpayBlikAliasRegistrationInput) {
  return {
    provider: "tpay",
    requestKind: "blik_alias_registration",
    orderRef: input.orderRef,
    amount: input.amountMinor,
    currency: input.currency,
    customer: { email: input.customerEmail },
    webhookUrl: input.staticWebhookUrl,
    consentRef: input.consentRef,
    fallbackRequiredWhenAliasUnavailable: true,
  };
}

export function buildTpayBlikAliasChargeDraft(input: TpayBlikAliasChargeInput) {
  return {
    provider: "tpay",
    requestKind: "blik_alias_charge",
    orderRef: input.orderRef,
    payId: input.payId,
    amount: input.amountMinor,
    currency: input.currency,
    webhookUrl: input.staticWebhookUrl,
  };
}
