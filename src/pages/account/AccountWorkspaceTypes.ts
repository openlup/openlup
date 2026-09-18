import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import {
  createCustomerDiagnosticActionKeyWhenEnabled,
  loadCustomerDiagnosticReporterWhenEnabled,
} from "@/lib/flags";

export type AccountTabId =
  | "start"
  | "subscriptions"
  | "orders"
  | "pets"
  | "addresses"
  | "payments"
  | "billing"
  | "history";

/**
 * Runs a mutation and refreshes the account aggregate. Resolves `true` when the
 * work succeeded and `false` when it failed — callers that must keep their own
 * UI open on failure (e.g. the package editor) read the flag; everyone else
 * ignores it and relies on the toast raised by the implementation.
 */
export type AccountMutationCategory =
  | "account_mutation"
  | "account_subscription_mutation"
  | "account_profile_mutation"
  | "account_companion_mutation"
  | "account_address_mutation"
  | "account_billing_mutation"
  | "account_delivery_mutation"
  | "account_payment_mutation"
  | "account_communication_mutation";

export type AccountMutate = (work: () => Promise<unknown>, category?: AccountMutationCategory) => Promise<boolean>;
export type AccountRefresh = () => Promise<boolean>;

/** Local form failures have the same closed category as their eventual write. */
export function reportAccountValidationBlocked(action: AccountMutationCategory, accessToken: string): void {
  try {
    const clientActionKey = createCustomerDiagnosticActionKeyWhenEnabled?.();
    const reporter = loadCustomerDiagnosticReporterWhenEnabled?.();
    if (!clientActionKey || !reporter) return;
    void reporter.then((loadedReporter) => {
      try {
        loadedReporter?.reportCustomerJourneyDiagnostic({
          action,
          phase: "attempted",
          code: "observed",
          clientActionKey,
        }, accessToken);
        loadedReporter?.reportCustomerJourneyDiagnostic({
          action,
          phase: "settled",
          code: "validation_blocked",
          clientActionKey,
        }, accessToken);
      } catch {
        // Diagnostics are never allowed to change a local form outcome.
      }
    }).catch(() => undefined);
  } catch {
    // The feature gate and lazy module are intentionally best effort.
  }
}
export type AccountOrderSummary = CustomerAccountV2Response["recentOrders"][number];
export type AccountPet = CustomerAccountV2Response["pets"][number];
export type AccountAddress = CustomerAccountV2Response["addresses"][number];
export type AccountBillingProfile = CustomerAccountV2Response["billingProfiles"][number];

export type AccountPanelProps = {
  account: CustomerAccountV2Response;
  accessToken: string;
  mutate: AccountMutate;
};
