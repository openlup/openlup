import type { PackageEditApplyResult, PackageEditLine, PackageEditPreview, PackageEditQuoteLine, PackageEditRequest } from "./packageEdit.js";

export type ExactSubscriptionEditAction = "swap_base_line" | "add_addon" | "remove_addon" | "update_addon_quantity"
  | "update_plan_length" | "update_base_mix" | "update_portion";
interface Acceptance {
  subscriptionId: string; expectedTemplateVersion?: number; acceptedQuoteHash?: string;
}
/** Exact levers retain their individual semantics; quantities are not a combined package edit. */
export type ExactSubscriptionEditRequest = Acceptance & (
  | { action: "swap_base_line"; fromVariantId: string; toVariantId: string }
  | { action: "add_addon"; variantId: string; qty: number }
  | { action: "update_addon_quantity"; variantId: string; qty: number }
  | { action: "remove_addon"; variantId: string }
  | { action: "update_plan_length"; planDays: number }
  | { action: "update_base_mix"; base: PackageEditLine[] }
  | { action: "update_portion"; portionMode: string }
);
export type SubscriptionEditRequest = PackageEditRequest | ExactSubscriptionEditRequest;
export type ExactSubscriptionEditPreview = PackageEditPreview<ExactSubscriptionEditAction>;
export type ExactSubscriptionEditApplyResult = PackageEditApplyResult<ExactSubscriptionEditAction>;
export interface ExactSubscriptionEditPricedLine extends PackageEditLine {
  lineId: string | null; isAddon: boolean; sortOrder: number; quoteLine: PackageEditQuoteLine;
}
/** Server evidence, never accepted from customer input. New base sets have null line IDs. */
export interface ExactSubscriptionEditQuote {
  quoteHash: string; expectedTemplateVersion: number; cadenceDays: number;
  compositionConstraint: Record<string, unknown> | null; lines: ExactSubscriptionEditPricedLine[];
  portionModes?: SubscriptionPortionModes;
}
/** Both factors and mode identifiers belong to the application configuration. */
export interface SubscriptionPortionModes {
  full: { mode: string; factor: number }; reduced: { mode: string; factor: number };
}
