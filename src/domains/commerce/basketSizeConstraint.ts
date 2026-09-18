/**
 * Polymorphic basket size constraint validator.
 *
 * Per the commerce v2 plan §4 / §8.5 — every cart / order / subscription that carries a
 * size guarantee ("Bundle 14", "14-day subscription", "feeding for 21 days") expresses
 * that guarantee through a single jsonb shape, never through hard-coded "size = number
 * of cans". The validator supports unit count, total weight, and feeding-days
 * semantics so mixed gramatura baskets can stay on the same cart-line primitive.
 *
 * Used by: cart create/update handlers, order finalize handler, subscription mirror
 * webhook ingest. Snapshot of the resolved kind + value lives on commerce_orders /
 * commerce_order_items so audit can reconstruct what "size 14" meant on any given
 * historical sale.
 */

export const BASKET_SIZE_CONSTRAINT_KINDS = ["unit_count", "total_weight_g", "feeding_days"] as const;
export type BasketSizeConstraintKind = (typeof BASKET_SIZE_CONSTRAINT_KINDS)[number];

export interface BasketSizeConstraint {
  kind: BasketSizeConstraintKind;
  value: number;
  pet_id?: string;
  daily_kcal_override?: number;
}

export interface BasketLineForValidator {
  variant_id: string;
  qty: number;
  is_addon: boolean;
  net_weight_g?: number;
  kcal_per_unit?: number;
  mode_at_line?: "one_time" | "subscription";
}

export type BasketValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason_code:
        | "unit_count_mismatch"
        | "total_weight_g_mismatch"
        | "feeding_days_mismatch"
        | "missing_line_metadata"
        | "missing_daily_kcal"
        | "unknown_kind";
      message: string;
    };

const UNIT_COUNT_EPSILON_BPS = 0;

export function validateBasketSizeConstraint(
  constraint: BasketSizeConstraint,
  lines: ReadonlyArray<BasketLineForValidator>,
): BasketValidationResult {
  switch (constraint.kind) {
    case "unit_count":
      return validateUnitCount(constraint, lines);
    case "total_weight_g":
      return validateTotalWeight(constraint, lines);
    case "feeding_days":
      return validateFeedingDays(constraint, lines);
    default:
      return {
        ok: false,
        reason_code: "unknown_kind",
        message: `Unknown size_constraint.kind: ${(constraint as { kind: string }).kind}`,
      };
  }
}

function validateUnitCount(
  constraint: BasketSizeConstraint,
  lines: ReadonlyArray<BasketLineForValidator>,
): BasketValidationResult {
  const eligibleQty = lines
    .filter((line) => !line.is_addon)
    .reduce((sum, line) => sum + line.qty, 0);

  if (UNIT_COUNT_EPSILON_BPS === 0 && eligibleQty === constraint.value) return { ok: true };

  return {
    ok: false,
    reason_code: "unit_count_mismatch",
    message: `Eligible cart qty ${eligibleQty} does not match size_constraint.value ${constraint.value}`,
  };
}

function validateTotalWeight(
  constraint: BasketSizeConstraint,
  lines: ReadonlyArray<BasketLineForValidator>,
): BasketValidationResult {
  const missing = lines.find((line) => !line.is_addon && !isPositiveNumber(line.net_weight_g));
  if (missing) {
    return {
      ok: false,
      reason_code: "missing_line_metadata",
      message: `Line ${missing.variant_id} is missing net_weight_g for total_weight_g validation`,
    };
  }

  const totalWeight = lines
    .filter((line) => !line.is_addon)
    .reduce((sum, line) => sum + line.qty * (line.net_weight_g ?? 0), 0);

  if (totalWeight === constraint.value) return { ok: true };

  return {
    ok: false,
    reason_code: "total_weight_g_mismatch",
    message: `Eligible cart weight ${totalWeight}g does not match size_constraint.value ${constraint.value}g`,
  };
}

function validateFeedingDays(
  constraint: BasketSizeConstraint,
  lines: ReadonlyArray<BasketLineForValidator>,
): BasketValidationResult {
  const dailyKcal = constraint.daily_kcal_override;
  if (!isPositiveNumber(dailyKcal)) {
    return {
      ok: false,
      reason_code: "missing_daily_kcal",
      message: "feeding_days validation requires a positive daily_kcal_override",
    };
  }

  const missing = lines.find((line) => !line.is_addon && !isPositiveNumber(line.kcal_per_unit));
  if (missing) {
    return {
      ok: false,
      reason_code: "missing_line_metadata",
      message: `Line ${missing.variant_id} is missing kcal_per_unit for feeding_days validation`,
    };
  }

  const totalKcal = lines
    .filter((line) => !line.is_addon)
    .reduce((sum, line) => sum + line.qty * (line.kcal_per_unit ?? 0), 0);
  const feedingDays = totalKcal / dailyKcal;

  if (Math.abs(feedingDays - constraint.value) <= 1) return { ok: true };

  return {
    ok: false,
    reason_code: "feeding_days_mismatch",
    message: `Eligible cart covers ${roundForMessage(feedingDays)} feeding days, expected ${constraint.value}`,
  };
}

/**
 * Cart-level mode consistency invariant: every priced line must match the cart mode.
 * Subscription add-ons become part of the recurring template; ad-hoc one-time add-ons
 * must be represented by a separate one-time cart/order.
 */
export function validateCartModeConsistency(
  cartMode: "one_time" | "subscription",
  lines: ReadonlyArray<BasketLineForValidator>,
): { ok: true } | { ok: false; offending_lines: string[] } {
  const offending = lines
    .filter((line) => line.mode_at_line !== undefined && line.mode_at_line !== cartMode)
    .map((line) => line.variant_id);

  return offending.length === 0 ? { ok: true } : { ok: false, offending_lines: offending };
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function roundForMessage(value: number): number {
  return Math.round(value * 100) / 100;
}
