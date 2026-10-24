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
export interface SubscriptionCommandPort {
  readonly capabilities: SubscriptionCapabilities;
  /** Future term writes, actor/command receipt and events must commit atomically. */
  apply(command: SubscriptionCommand): Promise<SubscriptionCommandReceipt | SubscriptionCommandRefusal | SubscriptionUnsupported>;
}
export interface SubscriptionActivationPort {
  activate(input: { idempotencyKey: string; orderId: string; paymentIntentId: string;
    paidEvidenceRef: string; paidAt: string; paymentMethodRef: string; paymentMethodKind: string;
    checkoutKind: string }): Promise<
      | { outcome: "noop" | "blocked"; reason: string }
      | { outcome: "active"; subscriptionId: string; orderId: string; paymentIntentId: string; nextCycleAt: string; cadenceDays: number; replayed: boolean }>;
}
