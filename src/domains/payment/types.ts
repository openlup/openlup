import type {
  PaymentExecutionBaseInput,
  PaymentExecutionBaseResult,
  PaymentExecutionMode,
} from "./executionBaseContracts.js";

export const PAYMENT_SESSION_STATES = [
  "requires_action",
  "pending",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type PaymentSessionState = (typeof PAYMENT_SESSION_STATES)[number];

export const PAYMENT_NEXT_ACTION_KINDS = [
  "redirect",
  "3ds_challenge",
  "qr_code",
  "blik_code_prompt",
  "sca_required",
] as const;
export type PaymentNextActionKind = (typeof PAYMENT_NEXT_ACTION_KINDS)[number];

export {
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_CONTROL_EVENT_TYPES,
  PAYMENT_INTENT_STATUSES,
  PAYMENT_TARGET_KINDS,
} from "./paymentControlTypes.js";
export type {
  PaymentAttemptStatus,
  PaymentControlEventType,
  PaymentIntentStatus,
  PaymentTargetKind,
} from "./paymentControlTypes.js";
export {
  PAYMENT_EXECUTION_ATTEMPT_STATUSES,
  PAYMENT_EXECUTION_MODES,
} from "./executionBaseContracts.js";
export type {
  PaymentExecutionAttemptStatus,
  PaymentExecutionBaseInput,
  PaymentExecutionBaseResult,
  PaymentExecutionMode,
} from "./executionBaseContracts.js";

export interface PaymentSession {
  state: PaymentSessionState;
  client_secret?: string;
  redirect_url?: string;
  next_action_kind?: PaymentNextActionKind;
  raw_provider_payload: Record<string, unknown>;
}

export interface InitiatePaymentInput {
  amount_minor: number;
  currency: string;
  customer_ref: string;
  intended_method?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentRefundResult {
  refund_provider_id: string;
  amount_minor: number;
  state: PaymentSessionState;
}

/** Deployment webhook vocabulary; the public payment-control contract is narrower. */
export const PAYMENT_WEBHOOK_EVENT_TYPES = [
  "payment.succeeded",
  "payment.failed",
  "payment.refunded",
  "payment.requires_action",
  "payment.disputed",
  "setup.succeeded",
  "setup.failed",
  "setup.requires_action",
] as const;
export type PaymentWebhookEventType = (typeof PAYMENT_WEBHOOK_EVENT_TYPES)[number];

export interface CanonicalPaymentEvent {
  provider_event_id: string;
  event_type: PaymentWebhookEventType;
  payment_provider_id: string;
  amount_minor?: number;
  next_action_kind?: PaymentNextActionKind;
  raw_payload: Record<string, unknown>;
}

export const PAYMENT_EXECUTION_PROVIDERS = ["hidden_rehearsal", "noop_payment", "stripe", "tpay"] as const;
export type PaymentExecutionProvider = (typeof PAYMENT_EXECUTION_PROVIDERS)[number];

export const PAYMENT_PROVIDER_FLOWS = [
  "one_time_payment",
  "setup_reusable_method",
  "off_session_payment",
  "blik_one_time",
  "blik_one_click",
  "pbl_one_time",
  "blik_recurring_activation",
  "recurring_charge",
] as const;
export type PaymentProviderFlow = (typeof PAYMENT_PROVIDER_FLOWS)[number];

export type TpayTransientProviderFlow = Extract<
  PaymentProviderFlow,
  "blik_one_time" | "blik_one_click" | "pbl_one_time" | "blik_recurring_activation" | "recurring_charge"
>;

export interface TpayTransientProviderInput {
  provider: "tpay";
  flow: TpayTransientProviderFlow;
  blikToken?: string;
  channelId?: string;
  recurringModel?: "O" | "M";
}

export type PaymentTransientProviderInput = TpayTransientProviderInput;

export interface PaymentExecutionInput extends PaymentExecutionBaseInput {
  mode: PaymentExecutionMode;
  orderRef: string;
  orderId?: string;
  providerFlow?: PaymentProviderFlow;
  transientProviderInput?: PaymentTransientProviderInput | null;
  customerRef?: string;
  paymentMethodRef?: string;
  paymentMethodAliasType?: "UID" | "PAYID";
  /**
   * Autopayment model the stored mandate was REGISTERED under, read back from the
   * mandate's consent snapshot.
   *
   * Charging a model M agreement with model O fields contradicts what the payer
   * consented to, so this travels with the charge instead of being inferred from
   * the switch admitting new Model O activations. Absent means "not established"
   * and must be treated as not-model-O.
   */
  paymentMethodRecurringModel?: "O" | "M";
  saveForFutureUse?: boolean;
  /**
   * Local client UUID for this checkout, propagated into Stripe provider
   * metadata so the webhook normalizer can populate `reusableMethod.clientId`
   * when a save-card flow lands. Optional — older callers omit it and the
   * normalizer leaves `reusableMethod` null.
   */
  clientId?: string;
  /** Account checkout pet scope carried through provider return URLs. */
  petId?: string | null;
  /**
   * Where a redirect-based provider (Tpay BLIK / PBL) returns the buyer after
   * payment. `"account"` makes the Tpay adapter build an in-shell
   * `/konto/zamowienie/status` return URL instead of the public
   * `/skomponuj-pakiet/platnosc` terminal. Defaults to `"public"` so existing
   * callers (and the whole Stripe path, which has no provider return_url) stay
   * byte-identical.
   */
  returnContext?: "public" | "account";
  payer?: {
    email: string;
    name: string;
    ip?: string | null;
    userAgent?: string | null;
  };
}

export interface PaymentExecutionResult extends PaymentExecutionBaseResult {
  provider: PaymentExecutionProvider;
  nextActionKind: PaymentNextActionKind | null;
  clientSecret?: string | null;
  redirectUrl?: string | null;
  reusablePaymentMethodRef?: string | null;
  customerProviderRef?: string | null;
  paymentMethodRef?: string | null;
  webhookExpected?: boolean;
  recoveryRequired?: boolean;
  rawProviderPayload?: Record<string, unknown>;
  normalizedError?: {
    code: string;
    message: string;
    retryable: boolean;
    supportCode?: string;
  } | null;
}
