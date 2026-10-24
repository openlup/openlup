export interface SubscriptionCommandContext {
  actor: { kind: "customer" | "operator"; actorId: string; clientId: string };
  subscriptionId: string; idempotencyKey: string; now: string;
}
export type SubscriptionCommand = SubscriptionCommandContext & (
  | { action: "pause"; pausePreset: string; reason: string | null; survey: string | null; saveOffer: string | null }
  | { action: "resume" | "skip" | "cancel"; reason: string | null; confirmedChargeTiming: boolean }
  | { action: "slide"; newNextCycleAt: string; confirmedChargeTiming: boolean }
  | { action: "edit_future_terms"; shippingAddressId: string; planDays: number; cadenceDays: number;
      expectedTemplateVersion: number; acceptedQuoteHash: string; confirmedChargeTiming: boolean;
      coreLines: readonly SubscriptionBundleLine[]; addonLines: readonly SubscriptionBundleLine[];
      compositionConstraint: string }
);
export interface SubscriptionBundleLine { sku: string; quantity: number }
export interface SubscriptionCommandReceipt {
  actorId: string; idempotencyKey: string; commandFingerprint: string;
  outcome: "applied" | "replayed" | "noop"; subscriptionId: string;
  originalState: string; nextCycleAt: string | null; revision: string; eventId: string | null;
}
export interface SubscriptionCommandRefusal { outcome: "refused"; reason: string }
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
