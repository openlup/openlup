/** Data-only classic package quote and command envelopes. Identity and execution stay in the server entry. */
export interface PackageEditMoney { amountMinor: number; currency: string }
export interface PackageEditLine { variantId: string; qty: number }
export interface PackageEditQuoteLine {
  sku: string; quantity: number; unitPriceGross: PackageEditMoney; lineSubtotalGross: PackageEditMoney;
  pricingComponents?: unknown[];
}
export interface PackageEditPricedLine extends PackageEditLine { quoteLine: PackageEditQuoteLine }
export interface PackageEditRequest {
  subscriptionId: string; planDays: number; base: PackageEditLine[]; addons?: PackageEditLine[];
  expectedTemplateVersion?: number; acceptedQuoteHash?: string;
}
export interface PackageEditQuote {
  currentRecurringPrice: PackageEditMoney; newRecurringPrice: PackageEditMoney; delta: PackageEditMoney;
  quoteHash: string; baseLines: PackageEditPricedLine[]; addonLines: PackageEditPricedLine[];
  cadenceDays: number; expectedTemplateVersion: number; compositionConstraint: Record<string, unknown> | null;
}
export type PackageEditBlockedReason = "not_active" | "payment_blocked" | "cycle_locked" | "missing_payment_method" | "edit_window_closed";
export interface PackageEditPreview {
  preview: { subscriptionId: string; action: "update_package_template"; canApply: boolean; blockedReason: PackageEditBlockedReason | null;
    nextCycleAt: string | null; editCutoffAt: string | null; templateVersion: number };
  lockedCycle: { locked: boolean; status: "blocked_preflight" | "dunning" | null };
  futureTemplate: { templateVersion: number; effectiveCycleAt: string | null; priceAgreementPolicy: "lock_until_edit" };
  quoteHash?: string; quoteExpiresAt?: string; currentTotal?: PackageEditMoney; newTotal?: PackageEditMoney; delta?: PackageEditMoney;
  packageEdit?: Pick<PackageEditQuote, "currentRecurringPrice" | "newRecurringPrice" | "delta" | "quoteHash"> & {
    effectiveCycleAt: string | null; priceAgreementPolicy: "lock_until_edit" };
}
export interface PackageEditApplyResult {
  status: "applied" | "replayed" | "noop"; subscriptionId: string; action: "update_package_template";
  subscriptionStatus: string; nextCycleAt: string | null; templateVersion: number; eventId: string | null;
  originalStatus?: "applied" | "noop";
}
