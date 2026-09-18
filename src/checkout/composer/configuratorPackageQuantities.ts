import type { CommerceRecommendationSnapshot } from "@/domains/commerce/recommendationContracts";
import { COMMERCE_MIN_ORDER_UNITS } from "@/domains/commerce/recommendationPolicyDeps";

export const CONFIGURATOR_PACKAGE_LINE_MIN = 1;
export const CONFIGURATOR_PACKAGE_LINE_MAX = 99;

export type ConfiguratorPackageQuantityOverrides = Record<string, number>;

export interface ConfiguratorPackageQuantityOptions {
  stockBounded?: boolean;
}

export interface ResolvedConfiguratorPackageQuantities {
  /** Effective client-side package. The server-authored input snapshot is never mutated. */
  snapshot: CommerceRecommendationSnapshot;
  /** Sanitized sparse overrides; baseline quantities are deliberately absent. */
  overrides: ConfiguratorPackageQuantityOverrides;
  totalUnits: number;
  customized: boolean;
}

export type ConfiguratorPackageQuantityBlockReason =
  | "unknown_variant"
  | "line_minimum"
  | "line_maximum"
  | "minimum_order"
  | "stock_limit";

export interface ConfiguratorPackageQuantityChange
  extends ResolvedConfiguratorPackageQuantities {
  changeApplied: boolean;
  blockReason: ConfiguratorPackageQuantityBlockReason | null;
}

const CALCULATOR_QUANTITY_REASON_CODES = new Set<
  CommerceRecommendationSnapshot["reasonCodes"][number]
>([
  "quantity_rounded_to_full_cans",
  "minimum_order_quantity_applied",
  "max_order_quantity_exceeded",
  "large_package_warning",
  "package_rebalanced_to_target_kcal",
  "stock_bounded_quantities_applied",
  "stock_limited_below_target",
]);

/**
 * Resolve persisted/user-authored quantities against an immutable recommendation.
 * Invalid, ambiguous and stale entries are ignored. A candidate below the order
 * MOQ is rejected as a whole so hydration can never produce a partial package.
 */
export function resolveConfiguratorPackageQuantities(
  baseline: CommerceRecommendationSnapshot,
  overrides: unknown,
  options: ConfiguratorPackageQuantityOptions = {},
): ResolvedConfiguratorPackageQuantities {
  const uniqueLines = uniqueLineIds(baseline);
  const input = recordEntries(overrides);
  const accepted: Array<[string, number]> = [];

  for (const line of baseline.lines) {
    if (!uniqueLines.has(line.variantId)) continue;
    const candidate = input.get(line.variantId);
    if (!isEditableQuantity(candidate) || candidate === line.qty) continue;
    if (isStockBoundedIncrease(line, candidate, options.stockBounded === true)) continue;
    accepted.push([line.variantId, candidate]);
  }

  const sanitized = Object.fromEntries(accepted);
  const acceptedById = new Map(accepted);
  const lines = baseline.lines.map((line) => {
    const quantity = acceptedById.get(line.variantId);
    return quantity == null ? line : { ...line, qty: quantity };
  });
  const totalUnits = sumUnits(lines);

  if (accepted.length === 0 || totalUnits < COMMERCE_MIN_ORDER_UNITS) {
    return baselineResolution(baseline);
  }

  const snapshot = recomputeSnapshot(baseline, lines);

  return {
    snapshot,
    overrides: sanitized,
    totalUnits,
    customized: true,
  };
}

/**
 * Why a „+" was refused, reduced to the two answers a control can act on.
 *
 * ⚠️ The split is about SPEECH, not severity. A stock bound is the one refusal
 * the editor can explain in words („zapas skończony"), so the control must stay
 * clickable to say it; every other block has no message and stays disabled.
 */
export type ConfiguratorPackageIncreaseRefusal = "stock" | "blocked";

/**
 * Ask the same arithmetic the „+" runs whether it would be refused, without
 * applying it. A missing baseline is „blocked": nothing can be increased against
 * a package that has not been committed yet.
 */
export function configuratorPackageIncreaseRefusal(
  baseline: CommerceRecommendationSnapshot | null | undefined,
  overrides: unknown,
  variantId: string,
  options: ConfiguratorPackageQuantityOptions = {},
): ConfiguratorPackageIncreaseRefusal | null {
  if (!baseline) return "blocked";
  const next = changeConfiguratorPackageQuantity(baseline, overrides, variantId, 1, options);
  if (next.changeApplied) return null;
  return next.blockReason === "stock_limit" ? "stock" : "blocked";
}

/**
 * Apply one +/- action. A blocked action is a no-op over the currently sanitized
 * state, so crossing MOQ cannot unexpectedly reset the customer's other edits.
 */
export function changeConfiguratorPackageQuantity(
  baseline: CommerceRecommendationSnapshot,
  overrides: unknown,
  variantId: string,
  delta: 1 | -1,
  options: ConfiguratorPackageQuantityOptions = {},
): ConfiguratorPackageQuantityChange {
  const current = resolveConfiguratorPackageQuantities(baseline, overrides, options);
  const matchingLines = baseline.lines.filter((line) => line.variantId === variantId);
  if (matchingLines.length !== 1) {
    return blocked(current, "unknown_variant");
  }

  const baselineLine = matchingLines[0];
  const currentLine = current.snapshot.lines.find((line) => line.variantId === variantId);
  if (!currentLine) return blocked(current, "unknown_variant");

  const nextQuantity = currentLine.qty + delta;
  if (nextQuantity < CONFIGURATOR_PACKAGE_LINE_MIN) {
    return blocked(current, "line_minimum");
  }
  if (nextQuantity > CONFIGURATOR_PACKAGE_LINE_MAX) {
    return blocked(current, "line_maximum");
  }
  if (
    delta > 0 &&
    options.stockBounded === true &&
    nextQuantity > sellableCap(baselineLine.sellableNow)
  ) {
    return blocked(current, "stock_limit");
  }
  if (current.totalUnits + delta < COMMERCE_MIN_ORDER_UNITS) {
    return blocked(current, "minimum_order");
  }

  const candidate = { ...current.overrides, [variantId]: nextQuantity };
  if (nextQuantity === baselineLine.qty) delete candidate[variantId];
  const resolved = resolveConfiguratorPackageQuantities(baseline, candidate, options);
  return { ...resolved, changeApplied: true, blockReason: null };
}

function recomputeSnapshot(
  baseline: CommerceRecommendationSnapshot,
  lines: CommerceRecommendationSnapshot["lines"],
): CommerceRecommendationSnapshot {
  const totalWeightG = lines.reduce(
    (sum, line) => sum + line.qty * line.netWeightG,
    0,
  );
  const totalKcal = lines.reduce(
    (sum, line) => sum + line.qty * line.kcalPerUnit,
    0,
  );
  const rawFeedingDays =
    baseline.dailyKcal != null && totalKcal > 0 ? totalKcal / baseline.dailyKcal : null;
  const feedingDays = rawFeedingDays == null ? null : roundOneDecimal(rawFeedingDays);
  const dailyGrams =
    rawFeedingDays != null && rawFeedingDays > 0
      ? Math.round(totalWeightG / rawFeedingDays)
      : baseline.dailyGrams;

  return {
    ...baseline,
    reasonCodes: baseline.reasonCodes.filter(
      (code) => !CALCULATOR_QUANTITY_REASON_CODES.has(code),
    ),
    lines,
    totalWeightG,
    feedingDays,
    dailyGrams,
    energy: { ...baseline.energy, dailyGrams },
  };
}

function baselineResolution(
  baseline: CommerceRecommendationSnapshot,
): ResolvedConfiguratorPackageQuantities {
  return {
    snapshot: baseline,
    overrides: {},
    totalUnits: sumUnits(baseline.lines),
    customized: false,
  };
}

function blocked(
  current: ResolvedConfiguratorPackageQuantities,
  blockReason: ConfiguratorPackageQuantityBlockReason,
): ConfiguratorPackageQuantityChange {
  return { ...current, changeApplied: false, blockReason };
}

function recordEntries(value: unknown): Map<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return new Map();
  return new Map(Object.entries(value));
}

function uniqueLineIds(snapshot: CommerceRecommendationSnapshot): Set<string> {
  const counts = new Map<string, number>();
  for (const line of snapshot.lines) {
    counts.set(line.variantId, (counts.get(line.variantId) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()].filter(([, count]) => count === 1).map(([variantId]) => variantId),
  );
}

function isEditableQuantity(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= CONFIGURATOR_PACKAGE_LINE_MIN &&
    (value as number) <= CONFIGURATOR_PACKAGE_LINE_MAX
  );
}

function isStockBoundedIncrease(
  line: CommerceRecommendationSnapshot["lines"][number],
  candidate: number,
  stockBounded: boolean,
): boolean {
  return stockBounded && candidate > line.qty && candidate > sellableCap(line.sellableNow);
}

function sellableCap(value: number | null | undefined): number {
  return value == null ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(value));
}

function sumUnits(lines: readonly CommerceRecommendationSnapshot["lines"][number][]): number {
  return lines.reduce((sum, line) => sum + line.qty, 0);
}

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}
