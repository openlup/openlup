import type { AccountSupportCapabilities } from "./capabilities.js";
/** Local transcriptions of owner contracts; portFit checks equality against the owners. */
export interface SubscriptionCommandContext {
  actor: { kind: "customer" | "operator"; actorId: string; clientId: string };
  subscriptionId: string; idempotencyKey: string; now: string;
}
export type SubscriptionCommand = SubscriptionCommandContext & (
  | { action: "pause"; pausePreset: string; reason: string | null; survey: string | null; saveOffer: string | null }
  | { action: "resume" | "skip" | "cancel"; reason: string | null; confirmedChargeTiming: boolean }
  | { action: "slide"; newNextCycleAt: string; confirmedChargeTiming: boolean }
  | { action: "edit_future_terms"; shippingAddressId: string; planDays: number; cadenceDays: number;
      expectedTemplateVersion: number;
      /** Empty string means no quote (semantic no-op). */
      acceptedQuoteHash: string; confirmedChargeTiming: boolean;
      coreLines: readonly SubscriptionBundleLine[]; addonLines: readonly SubscriptionBundleLine[];
      compositionConstraint: string }
);
export interface SubscriptionBundleLine { sku: string; quantity: number }
export interface SubscriptionCommandReceipt {
  actorId: string; idempotencyKey: string; commandFingerprint: string;
  outcome: "applied" | "replayed" | "noop"; subscriptionId: string;
  originalState: string; nextCycleAt: string | null; revision: string; eventId: string | null;
}
export interface SubscriptionCommandRefusal {
  outcome: "refused";
  /** Stable machine code; never provider, PostgreSQL diagnostic or customer text.
   * Unrecognized native or host diagnostics map to subscription_command_invalid_input. */
  reason:
    | "multi_cycle_prepaid_unsupported"
    | "subscription_command_addon_not_found"
    | "subscription_command_bundle_total_mismatch"
    | "subscription_command_charge_timing_not_confirmed"
    | "subscription_command_idempotency_conflict"
    | "subscription_command_invalid_composition_constraint"
    | "subscription_command_invalid_input"
    | "subscription_command_not_active"
    | "subscription_command_operation_busy"
    | "subscription_command_pause_forbidden"
    | "subscription_command_payment_blocked"
    | "subscription_command_preview_unsupported"
    | "subscription_command_renewal_terms_missing"
    | "subscription_command_unsupported_action"
    | "subscription_edit_catalog_unavailable"
    | "subscription_edit_invalid_lines"
    | "subscription_edit_invalid_request"
    | "subscription_edit_quote_expired"
    | "subscription_edit_quote_required"
    | "subscription_edit_stale_template"
    | "subscription_edit_window_closed"
    | "subscription_lifecycle_invalid_transition"
    | "subscription_lifecycle_invalid_skip"
    | "subscription_lifecycle_invalid_slide"
    | "subscription_lifecycle_payment_blocked";
}
export type SubscriptionUnsupportedCode = "multi_cycle_prepaid_unsupported" | "native_generic_bundle_commands_unsupported" | "native_command_bound_receipts_unsupported" | "native_prepared_attempt_store_unsupported";
export interface SubscriptionUnsupported { supported: false; refusalCode: SubscriptionUnsupportedCode }
/** Readiness must be selected explicitly; a port declaration does not install a store. */
export interface SubscriptionCapabilities {
  graph: "managed" | "native";
  multiCyclePrepaid: { supported: false; refusalCode: "multi_cycle_prepaid_unsupported" };
  genericBundleCommands: { supported: true } | { supported: false; refusalCode: "native_generic_bundle_commands_unsupported" };
  commandBoundReceipts: { supported: true } | { supported: false; refusalCode: "native_command_bound_receipts_unsupported" };
  preparedAttemptStore: { supported: true } | { supported: false; refusalCode: "native_prepared_attempt_store_unsupported" };
  retryRecovery: "unavailable" | "selected";
  stockRecovery: "unavailable" | "selected";
  deliveryAdmission: "required";
  executorCount: 1;
  defaultEnabled: false;
}
/** Exact raw native owner command; its result still requires a host codec. */
export interface NativeSubscriptionCommand {
  actorId: string; clientId: string; idempotencyKey: string; subscriptionId: string;
  action: string; payload: Record<string, unknown>; now: string;
}

/** Driver DTOs are explicit type arguments, never a claim that all graphs implement them. */
export interface SelfServiceCommandFacade<ManagedRequest, ManagedPreviewRequest, ManagedPreview, ManagedReceipt,
  ProfileRequest, ProfileResult, MethodRequest, MethodResult, CommerceRequest, CommerceResult, RecoveryRequest, RecoveryResult> {
  capabilities: AccountSupportCapabilities;
  managedSubscription: {
    previewAction(userId: string, request: ManagedPreviewRequest): Promise<ManagedPreview | null>;
    applyAction(userId: string, request: ManagedRequest): Promise<ManagedReceipt | null>;
  };
  nativeRawSubscription: {
    preview(command: NativeSubscriptionCommand): Promise<Record<string, unknown>>;
    apply(command: NativeSubscriptionCommand): Promise<Record<string, unknown>>;
  };
  nativeSubscription: {
    apply(command: SubscriptionCommand): Promise<SubscriptionCommandReceipt | SubscriptionCommandRefusal | SubscriptionUnsupported>;
    preview(command: Extract<SubscriptionCommand, { action: "edit_future_terms" }>): Promise<Record<string, unknown> | SubscriptionCommandRefusal>;
  };
  profile: { updateProfile(userId: string, request: ProfileRequest): Promise<ProfileResult | null> };
  paymentMethod: { execute(userId: string, request: MethodRequest): Promise<MethodResult> };
  commerce: { execute(userId: string, request: CommerceRequest): Promise<CommerceResult> };
  recovery: { startPaymentRecovery(userId: string, request: RecoveryRequest): Promise<RecoveryResult | null> };
}

export interface AccountSupportMoney { amountMinor: number; currency: string }
export type SubscriptionPaymentMethodStatus = "usable" | "expiring" | "missing" | "revoked" | "requires_action" | "invalid" | "provider_disabled";
export type SubscriptionRenewalBlockStatus = "blocked_preflight" | "payment_pending" | "dunning" | "paid_fulfillment_pending" | "fulfillment_blocked" | "catalog_blocked" | "customer_action_required";
export type EligibilityRefusal =
  | "not_active"
  | "edit_window_closed"
  | "cycle_locked"
  | "payment_blocked"
  | "missing_payment_method"
  | "invalid_address"
  | null;

export interface LegacySubscriptionPreviewResponse {
  preview: {
    subscriptionId: string;
    action: string;
    canApply: boolean;
    blockedReason: EligibilityRefusal;
    nextCycleAt: string | null;
    editCutoffAt: string | null;
    templateVersion: number | null;
    lockedCycle?: {
      locked: boolean;
      status: SubscriptionRenewalBlockStatus | null;
    };
    futureTemplate?: {
      templateVersion: number | null;
      effectiveCycleAt: string | null;
      priceAgreementPolicy: "lock_until_edit";
    };
    paymentMethodStatus?: SubscriptionPaymentMethodStatus;
    deliverability?: {
      status: "address_book_validated" | "blocked" | "unknown";
      blockedReason: EligibilityRefusal;
    };
    catalogAvailability?: {
      status: "available" | "blocked" | "unknown";
      blockedReason: EligibilityRefusal;
    };
    quoteHash?: string;
    quoteExpiresAt?: string;
    currentTotal?: AccountSupportMoney;
    newTotal?: AccountSupportMoney;
    delta?: AccountSupportMoney;
    chargeTiming?: {
      requiresConfirmation: boolean;
      confirmed: boolean;
      earliestChargeAt: string | null;
    };
    dateAvailability?: {
      earliestAllowedAt: string;
      latestAllowedAt: string;
      availableDates: string[];
      blockedReason: EligibilityRefusal;
    };
    packageEdit?: {
      currentRecurringPrice: AccountSupportMoney;
      newRecurringPrice: AccountSupportMoney;
      delta: AccountSupportMoney;
      quoteHash: string;
      effectiveCycleAt: string | null;
      priceAgreementPolicy: "lock_until_edit";
    };
  };
}

