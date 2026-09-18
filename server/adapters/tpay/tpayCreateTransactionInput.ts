import type { PaymentExecutionInput, TpayTransientProviderInput } from "../../../src/domains/payment/types.js";
import type {
  TpayAliasInput,
  TpayPayerInput,
  TpayTransactionCreateInput,
} from "../../infra/tpay/tpayHttpClient.js";

const TPAY_BLIK_GROUP_ID = 150;

/**
 * In-shell account return path (PL canonical, re-localized client-side). When the
 * checkout declares `returnContext: "account"`, the Tpay redirect/return targets
 * this in-account terminal instead of the public `/skomponuj-pakiet/platnosc`
 * page — the origin is preserved, only the path is swapped. Mirrors how the
 * public path is hard-coded PL server-side and re-localized on the client.
 */
const ACCOUNT_RETURN_PATH = "/konto/zamowienie/status";

/**
 * Swap the path of an origin-derived return URL to the in-account terminal while
 * preserving the env/origin-driven host. `returnContext` defaults to public, so a
 * caller that omits it gets the byte-identical public URL.
 */
function returnUrlForContext(baseUrl: string, returnContext: "public" | "account" | undefined): string {
  if (returnContext !== "account") return baseUrl;
  const url = new URL(baseUrl);
  url.pathname = ACCOUNT_RETURN_PATH;
  return url.toString();
}

export function buildCreateTransactionInput(input: {
  input: PaymentExecutionInput;
  transient: TpayTransientProviderInput;
  payer: TpayPayerInput;
  notificationUrl: string;
  successUrl: string;
  errorUrl: string;
  aliasRegistrationOnCodeEnabled: boolean;
  modelOActivationEnabled: boolean;
}): TpayTransactionCreateInput {
  const { transient } = input;
  const effectiveModel = resolveRecurringModel(transient.recurringModel, input.modelOActivationEnabled);
  const shouldRegisterOneTimeAlias =
    transient.flow === "blik_one_time" && input.aliasRegistrationOnCodeEnabled;
  const returnContext = input.input.returnContext;
  const successUrl = returnUrlForContext(input.successUrl, returnContext);
  const errorUrl = returnUrlForContext(input.errorUrl, returnContext);
  return {
    amount: input.input.amountMinor / 100,
    currency: "PLN",
    description: input.input.orderRef,
    hiddenDescription: input.input.paymentIntentId,
    payer: input.payer,
    notificationUrl: input.notificationUrl,
    successUrl: payerReturnUrl(successUrl, input.input),
    errorUrl: payerReturnUrl(errorUrl, input.input),
    groupId: transient.flow === "pbl_one_time" ? undefined : TPAY_BLIK_GROUP_ID,
    channelId: transient.flow === "pbl_one_time" ? transient.channelId : undefined,
    blikPaymentType: transient.flow === "recurring_charge" ||
      (transient.flow === "blik_one_click" && (input.input.paymentMethodAliasType ?? "PAYID") === "PAYID")
      ? 2
      : undefined,
    blikToken: transient.flow === "blik_one_time" || transient.flow === "blik_recurring_activation"
      ? transient.blikToken
      : undefined,
    // Only meaningful while registering a PAYID mandate: it makes BLIK refuse an
    // incapable bank outright instead of taking the money and silently never
    // showing the mandate invitation. Never set for a plain one-off BLIK.
    refuseNoPayId: transient.flow === "blik_recurring_activation" && effectiveModel === "O"
      ? true
      : undefined,
    alias: transient.flow === "blik_recurring_activation"
      ? {
          value: aliasValue(input.input.paymentIntentId),
          type: "PAYID",
          label: "openlup",
          ...(effectiveModel === "O" ? { recommendedAuthLevel: "NOCONFREQ" as const } : {}),
          autopayment: { model: effectiveModel },
        }
      : shouldRegisterOneTimeAlias
        ? { value: aliasValue(input.input.paymentIntentId), type: "UID", label: "openlup" }
      : (transient.flow === "recurring_charge" || transient.flow === "blik_one_click") && input.input.paymentMethodRef
        ? chargeAlias(
            input.input.paymentMethodRef,
            input.input.paymentMethodAliasType ?? "PAYID",
            input.input.paymentMethodRecurringModel,
          )
      : null,
    simulatorContext: {
      orderId: input.input.orderId,
      paymentIntentId: input.input.paymentIntentId,
      clientId: input.input.clientId,
      providerAttemptKey: input.input.providerIdempotencyKey,
      ...(returnContext === "account" ? { returnPath: ACCOUNT_RETURN_PATH } : {}),
    },
  };
}

/**
 * Alias sent when charging an already-registered mandate.
 *
 * `noDelay` and `recommendedAuthLevel` are autopayment fields: they belong to a
 * `PAYID` mandate under model O and are meaningless on a `UID` one-click alias,
 * which carries no autopayment agreement at all.
 *
 * Keyed on the model the MANDATE was registered under, never on the switch that
 * admits new Model O activations. Production may already hold model M mandates;
 * charging those as model O would both contradict the payer's consent and risk
 * rejection. Unknown or absent means not-model-O — fail closed, never guess.
 */
function chargeAlias(
  value: string,
  type: "UID" | "PAYID",
  registeredModel: "O" | "M" | undefined,
): TpayAliasInput {
  const autopaymentCharge = registeredModel === "O" && type === "PAYID";
  return {
    value,
    type,
    // Needed on every model O charge, not only at registration: without them
    // Tpay emails the payer an approval link instead of collecting, which is
    // model M behaviour. Verified against production 2026-07-20.
    ...(autopaymentCharge ? { noDelay: true, recommendedAuthLevel: "NOCONFREQ" as const } : {}),
  };
}

/**
 * The autopayment model actually sent to Tpay.
 *
 * Once the Model O activation switch is on, every recurring activation registers
 * as model O: it is the only model that permits a variable amount without the
 * payer confirming each charge, which is what a configurable subscription needs.
 * Model M would silently degrade every renewal into an approval prompt.
 *
 * Single source of truth on purpose — the new-activation switch and the alias
 * payload must never disagree about which model this activation attempt is.
 */
export function resolveRecurringModel(
  requested: "O" | "M" | undefined,
  modelOActivationEnabled: boolean,
): "O" | "M" {
  if (modelOActivationEnabled) return "O";
  return requested ?? "M";
}

function payerReturnUrl(baseUrl: string, input: PaymentExecutionInput): string {
  const url = new URL(baseUrl);
  if (input.orderId) url.searchParams.set("orderId", input.orderId);
  url.searchParams.set("paymentIntentId", input.paymentIntentId);
  if (input.clientId) url.searchParams.set("clientId", input.clientId);
  if (input.returnContext === "account" && input.petId) url.searchParams.set("pet", input.petId);
  url.searchParams.set("order", input.orderRef);
  return url.toString();
}

export function aliasValue(paymentIntentId: string): string {
  return `openlup_${paymentIntentId}`;
}
