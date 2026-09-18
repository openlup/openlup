import type { i18n as I18n } from "i18next";
import {
  availablePaymentRecoveryActions,
  type PaymentRecoveryAction,
  type PaymentRecoveryCandidate,
  type PaymentRecoveryGuidance,
} from "@openlup/core/payment";
import type { CheckoutClientAction } from "@/domains/commerce/checkoutContracts";
import type { CheckoutPaymentRecoveryGuidance } from "@/domains/commerce/paymentRecoveryGuidanceContracts";
import type { PaymentMethod, PaymentMethodOption } from "../adapters/paymentMethodOptions";

export function hasCheckoutRecoveryCopy(i18n: Pick<I18n, "getResource" | "language" | "resolvedLanguage">, key: string): boolean {
  const [namespace, path] = key.split(":");
  const language = i18n.language || i18n.resolvedLanguage;
  return Boolean(path) && typeof language === "string" && typeof i18n.getResource === "function" && typeof i18n.getResource(language, namespace, path) === "string";
}

export interface CheckoutRecoveryAction {
  kind: PaymentRecoveryAction;
  labelKey: string;
  /** A choice/focus target only. Selection never submits a payment. */
  method?: PaymentMethod;
}
export interface CheckoutRecoveryPresentation {
  messageKey: string;
  actions: CheckoutRecoveryAction[];
  emphasis: "normal" | "recommended";
}
export interface CheckoutRecoveryPresentationInput {
  guidance: CheckoutPaymentRecoveryGuidance | null | undefined;
  /** Already filtered by the host's checkout eligibility and device support. */
  methods: readonly PaymentMethodOption[];
  nextAction?: CheckoutClientAction | null;
  canCorrectData?: boolean;
}

const message = (id: string) => `checkout:recoveryGuidance.messages.${id}`;
const action = (kind: PaymentRecoveryAction, label: string, method?: PaymentMethod): CheckoutRecoveryAction => ({
  kind, labelKey: `checkout:recoveryGuidance.actions.${label}`, ...(method ? { method } : {}),
});

function hasAuthenticationAction(nextAction: CheckoutClientAction | null | undefined): boolean {
  if (nextAction?.kind === "provider_embedded") return Boolean(nextAction.clientSecret || nextAction.sessionRef);
  if (nextAction?.kind !== "redirect") return false;
  try {
    const url = new URL(nextAction.url);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

/** Intersect server permission with actual offers before choosing any sentence. */
export function presentCheckoutRecoveryGuidance({
  guidance, methods, nextAction, canCorrectData = false,
}: CheckoutRecoveryPresentationInput): CheckoutRecoveryPresentation | null {
  if (!guidance) return null;
  const present = (id: string, actions: CheckoutRecoveryAction[]): CheckoutRecoveryPresentation => ({
    messageKey: message(id), actions, emphasis: guidance.emphasis,
  });
  const help = () => present("c12", [action("contact_support", "support")]);
  if (!guidance.methodKey || !guidance.methodKind) return help();
  const operation = guidance.purchaseContext === "subscription_initial" ? "recurring_setup" : "one_time_payment";
  // The host owns availability; this final guard prevents a one-time-only choice
  // from being accidentally forwarded by a shared continuation screen.
  const eligible = methods.filter((method) => operation !== "recurring_setup" || method.value !== "transfer");
  const candidates: PaymentRecoveryCandidate[] = eligible.map(({ value }) => ({
    method: {
      kind: value === "card" ? "card" : value === "transfer" ? "bank_transfer" : "blik",
      recoveryMethodKey: value,
      interaction: value === "blik_one_click" ? "stored_instrument" : "new_instrument",
    },
    operation, capability: "supported", available: true,
    // A fresh BLIK code is a new instrument on the same method, exactly as another card is.
    actions: ["change_method", ...(value === "card" || value === "blik" ? ["change_instrument" as const] : []),
      ...(value === "card" && canCorrectData ? ["correct_data" as const] : [])],
  }));
  const coreGuidance: PaymentRecoveryGuidance = {
    ...guidance, consecutiveRefusals: guidance.consecutiveRefusals ?? null, operation: guidance.operation ?? null, refusalVerified: true, certainty: "verified", disclosure: "safe", advice: null,
    method: { kind: guidance.methodKind, recoveryMethodKey: guidance.methodKey, interaction: "new_instrument" },
  };
  const available = availablePaymentRecoveryActions(coreGuidance, candidates, operation);
  const alternative = eligible.find(({ value }) => value !== guidance.methodKey);
  const changeMethod = available.includes("change_method") && alternative
    ? action("change_method", "changeMethod", alternative.value) : null;
  const changeCard = available.includes("change_instrument") && guidance.methodKind === "card"
    ? action("change_instrument", "changeCard", "card") : null;
  const choices = [changeCard, changeMethod].filter((item): item is CheckoutRecoveryAction => item !== null);
  const cardAlternative = Boolean(changeMethod && guidance.methodKey !== "card" && eligible.some(({ value }) => value === "card"));

  // Only the server's persisted mandate decision produces this cause, always with
  // restriction "method"; its specific sentence outranks the generic restriction.
  if (guidance.cause === "recurring_setup_failed" && guidance.methodKind === "blik"
    && guidance.operation === "recurring_setup" && guidance.purchaseContext === "subscription_initial" && cardAlternative) {
    return present("c07", [action("change_method", "chooseCard", "card")]);
  }
  if (guidance.restriction === "method") return changeMethod ? present("c11a", [changeMethod]) : help();
  if (guidance.cause === "authentication_required" && guidance.actions.includes("authenticate") && hasAuthenticationAction(nextAction)) {
    return present("c08", [action("authenticate", "authenticate"), ...(changeMethod ? [changeMethod] : [])]);
  }
  // A refused code during BLIK activation proves nothing about the bank: a new
  // code comes first, card second. A second consecutive refusal falls to c02.
  if (guidance.cause === "generic_decline" && guidance.methodKey === "blik" && guidance.operation === "recurring_setup"
    && guidance.purchaseContext === "subscription_initial" && guidance.consecutiveRefusals !== 2
    && available.includes("change_instrument")) {
    return present("c18", [action("change_instrument", "enterNewCode", "blik"),
      ...(cardAlternative ? [action("change_method", "payByCard", "card")] : [])]);
  }
  if (guidance.cause === "expired_card" && guidance.methodKind === "card" && changeCard) return present("c04", choices);
  if (guidance.cause === "invalid_payment_data" && guidance.methodKind === "card" && available.includes("correct_data")) {
    return present("c05", [action("correct_data", "correctData", "card"), ...(changeMethod ? [changeMethod] : [])]);
  }
  if (guidance.cause === "insufficient_funds" && changeMethod) {
    return present(changeCard ? "c03" : "c03Alternative", choices);
  }
  if (guidance.restriction === "instrument" && changeCard) return present("c11", choices);
  if (guidance.cause === "operation_unsupported" && changeMethod) return present("c06", [changeMethod]);
  if (!changeMethod) return help();
  return present(guidance.cause === "generic_decline" && guidance.consecutiveRefusals === 2 ? "c02" : "c01", [changeMethod]);
}
