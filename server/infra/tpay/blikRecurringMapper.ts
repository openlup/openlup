import { readProviderActivationConfig } from "../providerReadiness.js";

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

export function readTpayReadinessConfig(env: Record<string, string | undefined>) {
  return readProviderActivationConfig({
    providerKind: "tpay",
    enabled:
      env.COMMERCE_PAYMENT_PROVIDER_EXECUTION_ENABLED === "true" &&
      env.PAYMENTS_TPAY_ENABLED === "true",
    requiredEnv: ["TPAY_CLIENT_ID", "TPAY_CLIENT_SECRET", "TPAY_WEBHOOK_JWS_ROOT_CERT_URL"],
    env,
  });
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
