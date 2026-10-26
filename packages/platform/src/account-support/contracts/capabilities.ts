import type { SubscriptionCapabilities } from "./commands.js";
export type AccountSupportCapability<Code extends string> = { supported: true } | { supported: false; refusalCode: Code };
export type AccountSupportLaneUnavailable<Code extends string> = Extract<AccountSupportCapability<Code>, { supported: false }>;
/** Explicit driver selections; importing the module installs no capability. */
export interface AccountSupportCapabilities {
  graph: "managed" | "native";
  accountRead: AccountSupportCapability<"host_binding_required">;
  customer360Read: AccountSupportCapability<"host_binding_required">;
  invoiceAccess: AccountSupportCapability<"host_binding_required">;
  paymentMethodSetup: AccountSupportCapability<"unsupported">;
  commerceRecovery: AccountSupportCapability<"host_binding_required">;
  configuredPurchase: AccountSupportCapability<"host_binding_required">;
  operatorSubscription: AccountSupportCapability<"operator_subscription_authority_unavailable">;
  operatorContact: AccountSupportCapability<"operator_subscription_authority_unavailable">;
  subscriptions: SubscriptionCapabilities;
  communicationGifts: AccountSupportCapability<"unsupported_preference">;
}

/** Per-action/subcase truth, independent of the host's unrelated read selections. */
export interface OperatorAuthorityCapabilities {
  graph: "managed" | "native";
  email: AccountSupportCapability<"operator_subscription_authority_unavailable">;
  phone: AccountSupportCapability<"operator_subscription_authority_unavailable">;
  link: AccountSupportCapability<"operator_subscription_authority_unavailable">;
  address: AccountSupportCapability<"operator_subscription_authority_unavailable">;
  shortBand: AccountSupportCapability<"operator_subscription_authority_unavailable">;
  unpaidResume: AccountSupportCapability<"operator_subscription_authority_unavailable">;
  preparedAttemptPause: AccountSupportCapability<"operator_subscription_authority_unavailable">;
  pause: { supported: true }; resume: { supported: true }; slide: { supported: true };
}
