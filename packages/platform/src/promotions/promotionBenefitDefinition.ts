export type PromotionBenefitDefinition =
  | { kind: "legacy_percentage"; percentage: number }
  | { kind: "legacy_fixed_amount"; amount: number }
  | { kind: "legacy_free_shipping" }
  | { kind: "target_percentage"; lane: "product"; valueBps: number }
  | { kind: "percentage"; lane: "shipping"; valueBps: number }
  | { kind: "fixed_amount"; lane: "product" | "shipping"; valueMinor: number }
  | { kind: "free_shipping"; lane: "shipping" };

/**
 * Explicit dual-read boundary. Legacy rows only use legacy columns; v2 rows
 * only use explicit v2 benefit columns. There is intentionally no inference.
 */
export function resolvePromotionBenefitDefinition(row: {
  promotion_engine_version?: unknown;
  discount_type: unknown;
  discount_value: unknown;
  benefit_lane?: unknown;
  benefit_kind?: unknown;
  benefit_value_bps?: unknown;
  benefit_value_minor?: unknown;
}): PromotionBenefitDefinition {
  if (row.promotion_engine_version !== "promotion-engine.v2") {
    const value = finite(row.discount_value);
    if (row.discount_type === "percentage" && value > 0 && value < 100) return { kind: "legacy_percentage", percentage: value };
    if (row.discount_type === "fixed_amount" && value > 0) return { kind: "legacy_fixed_amount", amount: value };
    if (row.discount_type === "free_shipping") return { kind: "legacy_free_shipping" };
    throw new Error("promotion_v1_benefit_invalid");
  }

  const lane = row.benefit_lane;
  const kind = row.benefit_kind;
  if (lane === "product" && kind === "target_percentage" && safeBps(row.benefit_value_bps)) {
    return { kind, lane, valueBps: row.benefit_value_bps };
  }
  if (lane === "shipping" && kind === "percentage" && safeBps(row.benefit_value_bps)) {
    return { kind, lane, valueBps: row.benefit_value_bps };
  }
  if ((lane === "product" || lane === "shipping") && kind === "fixed_amount" && positiveInt(row.benefit_value_minor)) {
    return { kind, lane, valueMinor: row.benefit_value_minor };
  }
  if (lane === "shipping" && kind === "free_shipping") return { kind, lane };
  throw new Error("promotion_v2_benefit_invalid");
}

function finite(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN; }
function safeBps(value: unknown): value is number { return Number.isInteger(value) && Number(value) > 0 && Number(value) < 10_000; }
function positiveInt(value: unknown): value is number { return Number.isInteger(value) && Number(value) > 0; }
