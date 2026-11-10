import type { PackageEditApplyResult, PackageEditLine, PackageEditMoney, PackageEditPreview, PackageEditQuoteLine } from "./packageEdit.js";

/** Full retained quote data crosses the host port; subscription validation owns no tax policy. */
export interface SizedQuoteLine extends PackageEditQuoteLine {
  productSlug: string;
  tax: { included: true; country: string; category: string; vatRateBps: number; legalBasis: string;
    netAmount: PackageEditMoney; vatAmount: PackageEditMoney; grossAmount: PackageEditMoney };
}
export interface SizedRecurringQuote {
  currency: string; taxIncluded: true; lines: SizedQuoteLine[]; discounts: unknown[]; pricingComponents?: unknown[];
  context?: { mode: "subscription" | "one_time"; cadenceDays?: number | null; promoCodes: string[] };
  subtotalGross: PackageEditMoney; discountTotalGross: PackageEditMoney; totalGross: PackageEditMoney;
  netTotal: PackageEditMoney; taxTotal: PackageEditMoney; shippingGross?: PackageEditMoney; shippingDiscountGross?: PackageEditMoney;
}
export interface SizedQuoteRequest {
  mode: "subscription"; cadenceDays?: number | null; promoCodes: string[];
  lines: { sku: string; quantity: number; modeAtLine?: "subscription"; isAddon?: boolean }[];
}

/** The sized parcel lever; the runtime value is exported by the server entry. */
export type SizedParcelLeverKind = "subscription.sized.parcel";
export type SizedEditAction = "resize_bundle" | "update_bundle" | "update_base_mix" | "update_plan_length" | "update_portion"
  | "add_addon" | "remove_addon" | "update_addon_quantity";
type Acceptance = { subscriptionId: string; expectedTemplateVersion?: number; acceptedQuoteHash?: string };
export type SizedEditRequest = Acceptance & (
  | { action: "resize_bundle"; cadenceDays: number; compositionConstraint: Record<string, unknown>;
      resizeLever: { kind: SizedParcelLeverKind; value: { coreLines: PackageEditLine[]; optInToSized?: true } }
        | { kind: "portionMode"; value: { portionMode: string; planDays: number } } }
  | { action: "update_bundle"; coreLines: PackageEditLine[]; addonLines?: PackageEditLine[]; cadenceDays?: number; compositionConstraint: Record<string, unknown> }
  | { action: "update_base_mix"; base: PackageEditLine[] }
  | { action: "update_plan_length"; planDays: number }
  | { action: "update_portion"; portionMode: string }
  | { action: "add_addon" | "update_addon_quantity"; variantId: string; qty: number }
  | { action: "remove_addon"; variantId: string }
);
export type SizedEditPhase = "none" | "fixed" | "graduation_pending";
export interface SizedAgreedLine {
  lineId: string | null; variantId: string; sku: string; groupId: string; qty: number; isAddon: boolean;
  quoteLine: SizedQuoteLine;
}
export interface SizedEditContext {
  subscriptionId: string; clientId: string; binding: "classic" | "sized.v1";
  templateVersion: number; cadenceDays: number; compositionConstraint: Record<string, unknown> | null;
  nextCycleAt: string | null; paidCycleCount: number;
  marker: { basisTemplateVersion: number; graduation: { cadenceDays: number; sizeConstraint?: Record<string, unknown>; lines: unknown[] } } | null;
  lines: SizedAgreedLine[]; graduationLines: SizedAgreedLine[];
}
export interface SizedEditPolicy {
  minimumCoreUnits: number; maximumCoreLines: number; maximumAddonLines: number; maximumQuantity: number;
  allowedCadences: readonly number[]; maximumExclusions: number; maximumCatalogExclusions: number;
  fixedThroughCycle: number; graduationCycle: number;
  portionModes: { full: { mode: string; factor: number }; reduced: { mode: string; factor: number } };
}
export type SizedPricedLine = SizedAgreedLine;
export interface SizedEditQuote {
  lines: SizedPricedLine[]; cadenceDays: number; compositionConstraint: Record<string, unknown>;
  expectedTemplateVersion: number; quoteHash: string; quote: SizedRecurringQuote;
  currentRecurringPrice: PackageEditMoney; newRecurringPrice: PackageEditMoney;
  delta: PackageEditMoney; changedLines: number; unchangedLines: number;
}
export type SizedEditPreview = PackageEditPreview<SizedEditAction>;
export type SizedEditApplyResult = PackageEditApplyResult<SizedEditAction>;
