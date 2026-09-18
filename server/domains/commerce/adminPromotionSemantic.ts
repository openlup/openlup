import {
  PROMOTION_STATUSES,
  type AdminPromotion,
  type AdminPromotionSemanticBenefit,
  type AdminPromotionV2Mirror,
  type AdminSubscriptionBandEntry,
} from "../../../src/domains/commerce/adminPromotionsContracts.js";

type Row = Record<string, unknown>;

/**
 * Projects a promotion row for the legacy admin editor.
 *
 * `currency` is a parameter rather than a read of the settlement profile so this module
 * stays pure: the adapter that fetched the rows has already resolved the profile once,
 * and a second read here would be a second place for the answer to come from. It is the
 * *settlement* currency and not a stored one because the amounts below are not history -
 * a promotion preview says what this shop would charge if the rule ran now, and the
 * promotions table holds a bare `discount_value` with no denomination of its own.
 */
export function mapAdminPromotion(
  row: Row,
  mirror: Row | undefined,
  bandEntries: AdminSubscriptionBandEntry[],
  currency: string,
): AdminPromotion {
  const systemManaged = Boolean(mirror) || isTechnicalFirstSubscriptionLegacy(row);
  return {
    id: String(row.id),
    code: (row.code as string | null) ?? null,
    name: String(row.name ?? ""),
    triggerType: row.trigger_type as AdminPromotion["triggerType"],
    discountType: row.discount_type as AdminPromotion["discountType"],
    semanticBenefit: semanticBenefit(row, mirror, bandEntries, currency),
    systemManaged,
    readOnly: systemManaged,
    v2Mirror: mirrorHandle(mirror),
    appliesToKind: row.applies_to_kind as AdminPromotion["appliesToKind"],
    stackingRule: row.stacking_rule as AdminPromotion["stackingRule"],
    eligibility: (row.eligibility as Record<string, unknown> | null) ?? {},
    validFrom: String(row.valid_from ?? ""),
    validTo: (row.valid_to as string | null) ?? null,
    status: row.status as AdminPromotion["status"],
    regionAvailability: Array.isArray(row.region_availability)
      ? (row.region_availability as string[])
      : [],
    redemptionLimitGlobal: (row.redemption_limit_global as number | null) ?? null,
    redemptionLimitPerCustomer: (row.redemption_limit_per_customer as number | null) ?? null,
  };
}

/**
 * Handle for the deliberate human-operator mirror activate/pause control. Fails
 * closed to null (no control shown) when the mirror id or status is not a clean
 * known value, rather than exposing a mutable handle to a malformed row.
 */
function mirrorHandle(mirror: Row | undefined): AdminPromotionV2Mirror | null {
  if (!mirror) return null;
  const id = mirror.id;
  const status = mirror.status;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof status !== "string") return null;
  if (!(PROMOTION_STATUSES as readonly string[]).includes(status)) return null;
  return { id, status: status as AdminPromotionV2Mirror["status"] };
}

export function isTargetPercentageMirror(row: Row): boolean {
  const valueBps = Number(row.benefit_value_bps);
  return row.promotion_engine_version === "promotion-engine.v2" &&
    row.benefit_lane === "product" &&
    row.benefit_kind === "target_percentage" &&
    Number.isInteger(valueBps) && valueBps > 0 && valueBps < 10_000;
}

export function isTechnicalFirstSubscriptionLegacy(row: Row): boolean {
  const eligibility = row.eligibility as Record<string, unknown> | null | undefined;
  const technicalValue = Number(row.discount_value);
  return row.promotion_engine_version === "promotion-engine.v1" &&
    row.trigger_type === "automatic" &&
    row.discount_type === "percentage" &&
    eligibility?.first_subscription_purchase === true &&
    Number.isFinite(technicalValue) && Math.abs(technicalValue - 44.404) < 0.000_001;
}

function semanticBenefit(
  row: Row,
  mirror: Row | undefined,
  bandEntries: AdminSubscriptionBandEntry[],
  currency: string,
): AdminPromotionSemanticBenefit {
  if (mirror) {
    if (!isTargetPercentageMirror(mirror)) {
      return { kind: "unavailable", reason: "system_managed_metadata_incomplete" };
    }
    const valueBps = Number(mirror.benefit_value_bps);
    return {
      kind: "target_percentage",
      valueBps,
      reference: "catalog_list_price",
      unitTargets: bandEntries.map((entry) => ({
        variantId: entry.variantId,
        sku: entry.sku,
        referenceMinor: entry.oneTimeMinor,
        targetMinor: multiplyDivideCeil(entry.oneTimeMinor, 10_000 - valueBps),
        // The reference and target come from `price_entries` rows that the caller
        // already selected through the settlement market's active price list, so this
        // is the currency those minor units are in by construction.
        currency,
      })),
    };
  }
  if (isTechnicalFirstSubscriptionLegacy(row)) {
    return { kind: "unavailable", reason: "system_managed_metadata_incomplete" };
  }
  const value = Number(row.discount_value ?? 0);
  if (row.discount_type === "percentage") return { kind: "percentage", valuePercent: value };
  if (row.discount_type === "fixed_amount") {
    // `promotions.discount_value` is a bare number with no currency column beside it,
    // so there is no stored answer to prefer here: a fixed-amount rule is denominated
    // in whatever the shop settles in when it fires.
    return { kind: "fixed_amount", valueMinor: value, currency };
  }
  if (row.discount_type === "free_shipping") return { kind: "free_shipping" };
  return { kind: "unavailable", reason: "system_managed_metadata_incomplete" };
}

function multiplyDivideCeil(value: number, multiplier: number): number {
  const product = BigInt(value) * BigInt(multiplier);
  return Number((product + 9_999n) / 10_000n);
}
