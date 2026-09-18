import type {
  PromotionCodeBenefit,
  PromotionCodePreviewRequest,
  PromotionCodeSummary,
} from "@/domains/commerce/adminPromotionCodesContracts";
import type { TFunction } from "i18next";

import {
  DEFAULT_MONEY_LANG,
  currencySymbol,
  formatCurrencyMinor,
} from "@/lib/currency/formatMinor";
import { ambientSettlementProfile } from "@/lib/currency/platformCurrency";

export type SupportedBenefit = Exclude<PromotionCodeBenefit, { validationState: string }>;

/**
 * Why the backend preview context could not be built. One sentence used to cover
 * "prices or shipping", which is two unrelated failures with two different
 * remedies: an active price list from which no subscription price is derivable
 * (the operator fixes the catalog) versus a read that did not answer (the
 * operator retries). `null` means the context is present.
 */
export type PreviewContextIssue = "band_empty" | "band_error" | "shipping_error" | null;

export const PROMOTION_CODE_PAGE_SIZE = 25;
export const REPRESENTATIVE_BUNDLE_QUANTITY = 14;

// Same bytes as before - `Intl` resolves a bare language subtag and its
// language-plus-region form identically for currency, and every caller passes
// `i18n.language` - but the currency and the divisor now come from the settlement
// profile instead of from a literal and a fixed hundred.
export function formatMoney(minor: number, locale = DEFAULT_MONEY_LANG): string {
  return formatCurrencyMinor(minor, {
    currency: ambientSettlementProfile.defaultCurrency,
    locale,
  });
}

/**
 * The smallest amount a product line may be sold for, written out.
 *
 * Two strings in this dialog used to restate it as "1,00 zł" / "PLN 1.00" in
 * their own prose - a second, hand-maintained copy of a number E2-F4 made a field
 * of the settlement profile, and one that would have been wrong for any
 * deployment whose floor was not a hundred minor units.
 */
export function minimumProductPayableLabel(locale: string): string {
  return formatMoney(ambientSettlementProfile.minimumProductPayableMinor, locale);
}

export function formatDateTime(value: string | null, locale: string, noExpiry: string): string {
  if (!value) return noExpiry;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function benefitLabel(benefit: PromotionCodeBenefit, t: TFunction, locale: string): string {
  if ("validationState" in benefit) return t("admin:adminPromotionCodes.labels.legacyUnsupported");
  if (benefit.kind === "free_shipping") return t("admin:adminPromotionCodes.labels.freeShipping");
  const lane = benefit.lane === "product" ? t("admin:adminPromotionCodes.labels.product") : t("admin:adminPromotionCodes.labels.shipping");
  if (benefit.kind === "fixed_amount") return `${lane}: −${formatMoney(benefit.valueMinor, locale)}`;
  const value = (benefit.valueBps / 100).toLocaleString(locale, { maximumFractionDigits: 2 });
  return `${lane}: −${value}%`;
}

export function scopeLabel(scopes: PromotionCodeSummary["scopes"], t: TFunction): string {
  if (scopes.length === 2) return t("admin:adminPromotionCodes.labels.both");
  return scopes[0] === "one_time" ? t("admin:adminPromotionCodes.labels.oneTime") : t("admin:adminPromotionCodes.labels.subscription");
}

export function statusLabel(status: PromotionCodeSummary["effectiveStatus"], t: TFunction): string {
  return t(`admin:adminPromotionCodes.labels.statuses.${status}`);
}

export function statusTone(status: PromotionCodeSummary["effectiveStatus"]): string {
  if (status === "active") return "bg-teal/15 text-teal-dark";
  if (status === "scheduled") return "bg-soft-lavender text-charcoal";
  if (status === "paused") return "bg-warm-amber/20 text-charcoal";
  return "bg-warm-sand text-text-muted";
}

export function representativeContext(input: {
  oneTimeMinor: number;
  subscriptionMinor: number;
  shippingMinor: number;
}): PromotionCodePreviewRequest["context"] {
  return {
    referenceProductMinor: input.oneTimeMinor * REPRESENTATIVE_BUNDLE_QUANTITY,
    oneTimeProductMinor: input.oneTimeMinor * REPRESENTATIVE_BUNDLE_QUANTITY,
    subscriptionProductMinor: input.subscriptionMinor * REPRESENTATIVE_BUNDLE_QUANTITY,
    shippingMinor: input.shippingMinor,
  };
}

export function parseOptionalPositiveInteger(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("positive_integer_required");
  return parsed;
}

export function parseMoneyMinor(value: string, options: { allowZero?: boolean } = {}): number {
  const parsed = Number(value.replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0 || (!options.allowZero && parsed === 0)) {
    throw new Error("money_value_invalid");
  }
  return Math.round(parsed * 100);
}

export function toDateTimeLocal(value: string): string {
  const date = new Date(value);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function fromDateTimeLocal(value: string): string {
  return new Date(value).toISOString();
}

export function createIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** The settlement currency's symbol for this reader; see {@link currencySymbol}. */
export function settlementCurrencySymbol(locale: string): string {
  return currencySymbol(ambientSettlementProfile.defaultCurrency, locale);
}
