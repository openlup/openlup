import { CATALOG_CANONICAL_UNITS, type CatalogQuantity } from "@openlup/core/catalog";
import type { CatalogSubscriptionCoverage, CatalogSubscriptionLineDemand, CatalogSubscriptionDemandScope, CatalogSubscriptionProfileIssue } from "@openlup/core/catalog";

type CoverageRule = "exact" | "allow_shortfall" | "allow_surplus";
type DemandLine = { id: string; quantity: number; demand: CatalogSubscriptionLineDemand; scope: CatalogSubscriptionDemandScope;
  policy: string; rule: CoverageRule; rounding: "floor" | "ceil" };
type CoverageGroup = Pick<DemandLine, "policy" | "rule" | "rounding"> & {
  ids: string[]; unit: string; content: bigint; daily: bigint;
};

const max = BigInt(Number.MAX_SAFE_INTEGER);
const scale = 12;
const scaleFactor = 10n ** BigInt(scale);
const maximum = max * scaleFactor;

function units(value: CatalogQuantity): bigint | undefined {
  if (!/^[1-9][0-9]{0,27}$/u.test(value.unscaled) || !Number.isInteger(value.scale) || value.scale < 0 || value.scale > scale) return;
  const amount = BigInt(value.unscaled) * 10n ** BigInt(scale - value.scale);
  if (amount <= maximum) return amount;
}

export function evaluateProfileDemand(lines: readonly DemandLine[], cadenceDays: number, allowedDays: readonly number[]): { coverage: CatalogSubscriptionCoverage[]; proposalDays?: number } | { issue: CatalogSubscriptionProfileIssue } {
  const groups = new Map<string, CoverageGroup>();
  for (const [index, line] of lines.entries()) {
    const { contentPerUnit, perDay } = line.demand;
    const path = `/lines/${index}/demand`;
    if (contentPerUnit.dimension !== perDay.dimension || contentPerUnit.unit !== CATALOG_CANONICAL_UNITS[contentPerUnit.dimension]
      || perDay.unit !== contentPerUnit.unit || !perDay.unit) return { issue: { code: "demand_unit_mismatch", path } };
    const key = line.scope.kind === "pooled" ? `pool/${line.scope.poolKey}` : `line/${line.id}`;
    const content = units(contentPerUnit);
    const daily = units(perDay);
    const group = groups.get(key);
    if (group && group.unit !== perDay.unit) return { issue: { code: "demand_unit_mismatch", path } };
    if (content === undefined || daily === undefined) return { issue: { code: "demand_arithmetic_unsafe", path } };
    const total = content * BigInt(line.quantity) + (group?.content ?? 0n);
    const required = daily * BigInt(cadenceDays);
    if (total > maximum || required > maximum) return { issue: { code: "demand_arithmetic_unsafe", path } };
    if (group && group.daily !== daily) return { issue: { code: "line_coverage_mismatch", path } };
    if (group && (group.policy !== line.policy || group.rule !== line.rule || group.rounding !== line.rounding)) {
      return { issue: { code: "policy_binding_missing", path } };
    }
    groups.set(key, { ids: [...(group?.ids ?? []), line.id], content: total, daily, unit: perDay.unit,
      policy: line.policy, rule: line.rule, rounding: line.rounding });

  }

  let offered: number | undefined;
  let sameOffer = true;
  const coverage: CatalogSubscriptionCoverage[] = [];
  for (const group of groups.values()) {
    const wholeDays = Number(group.content / group.daily);
    if (!Number.isSafeInteger(wholeDays)) return { issue: { code: "demand_arithmetic_unsafe", path: "/lines" } };
    const exact = group.content % group.daily === 0n;
    const { rule, rounding } = group;
    const delta = group.content - group.daily * BigInt(cadenceDays);
    if ((rule === "exact" && delta !== 0n) || (rule === "allow_shortfall" && delta > 0n) || (rule === "allow_surplus" && delta < 0n)) {
      return { issue: { code: "line_coverage_mismatch", path: "/lines" } };
    }
    const proposal = wholeDays + Number(rounding === "ceil" && !exact);
    if (offered !== undefined && offered !== proposal) sameOffer = false;
    offered = proposal;
    coverage.push({ lineIds: group.ids, wholeDays, exact });
  }

  return { coverage, ...(sameOffer && offered !== undefined && allowedDays.includes(offered) ? { proposalDays: offered } : {}) };
}
