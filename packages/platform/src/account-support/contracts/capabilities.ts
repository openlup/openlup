import type { SubscriptionCapabilities } from "./commands.js";
export type AccountSupportCapability<Code extends string> = { supported: true } | { supported: false; refusalCode: Code };
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
