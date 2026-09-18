import { outboxDispatchEnabled } from "../../_lib/config/featureFlags.js";

type Env = Record<string, string | undefined>;
type CustomerEmailFlowReadinessOptions = { accountingProviderEmailEnabled?: boolean };

// This is a compact projection of existing runtime gates, shared by cutover
// preflight and the watchdog so default-on/alias semantics cannot drift.
export const CUSTOMER_EMAIL_FLOW_FLAGS = [
  "COMMERCE_OUTBOX_DISPATCH_ENABLED",
  "COMMERCE_CHECKOUT_RECOVERY_ENABLED",
  "COMMERCE_DUNNING_EMAILS_ENABLED",
  "ACCOUNTING_EMAIL_ENABLED",
  "COMMERCE_ACCOUNTING_PROVIDER_EMAIL_ENABLED",
  "ACCOUNTING_B2C_EMAIL_ENABLED",
  "COMMERCE_ACCOUNTING_B2C_EMAIL_ENABLED",
  "COMMERCE_ABANDONED_CART_ENABLED",
  "COMMERCE_REORDER_REMINDER_ENABLED",
  "COMMERCE_REVIEW_REQUEST_ENABLED",
  "COMMERCE_BACK_IN_STOCK_ENABLED",
  "COMMERCE_SUBSCRIPTION_DELIVERY_REMINDERS_ENABLED",
  "SUBSCRIPTION_RENEWAL_REMINDER_ENABLED",
  "COMMERCE_SUBSCRIPTION_PAUSE_REMINDERS_ENABLED",
  "COMMERCE_SUBSCRIPTION_WINBACK_ENABLED",
  "SUBSCRIPTION_RENEWAL_OUTBOX_ENABLED",
] as const;

const ACCOUNTING_EMAIL_FLOW_FLAGS = [
  "ACCOUNTING_EMAIL_ENABLED",
  "COMMERCE_ACCOUNTING_PROVIDER_EMAIL_ENABLED",
  "ACCOUNTING_B2C_EMAIL_ENABLED",
  "COMMERCE_ACCOUNTING_B2C_EMAIL_ENABLED",
] as const;

/**
 * Producing and dispatching customer email is normally explicit, except for
 * the outbox dispatcher: omitted is active and only literal "false" disables
 * it. Accounting aliases are resolved by their existing runtime reader.
 */
export function activeCustomerEmailFlowFlags(
  env: Env,
  { accountingProviderEmailEnabled = false }: CustomerEmailFlowReadinessOptions = {},
): string[] {
  const active = new Set<string>();

  if (outboxDispatchEnabled(env)) {
    active.add("COMMERCE_OUTBOX_DISPATCH_ENABLED");
  }

  for (const flag of CUSTOMER_EMAIL_FLOW_FLAGS) {
    if (flag === "COMMERCE_OUTBOX_DISPATCH_ENABLED" || (ACCOUNTING_EMAIL_FLOW_FLAGS as readonly string[]).includes(flag)) {
      continue;
    }
    if (env[flag] === "true") active.add(flag);
  }

  if (accountingProviderEmailEnabled) {
    for (const flag of ACCOUNTING_EMAIL_FLOW_FLAGS) {
      if (env[flag] === "true") active.add(flag);
    }
  }

  return [...active];
}
