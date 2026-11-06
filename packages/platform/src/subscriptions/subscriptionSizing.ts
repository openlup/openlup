import type { BundleLineRef, CompositionConstraint, CompositionRulesPort } from "@openlup/core/bundle";
import type { SubscriptionPortionModes } from "./contracts/exactEdit.js";

/** Host facts already expressed in a common demand unit. Capacity includes host policy. */
export interface SubscriptionSizingUnit { variantId: string; demandPerUnit: number; maximumQuantity: number }
export interface SubscriptionSizingPolicy {
  portionModes: SubscriptionPortionModes;
  readDailyNeed(constraint: CompositionConstraint): number;
  isPlanLengthConstraint(constraint: CompositionConstraint): boolean;
  readUnitFacts(variantIds: string[]): Promise<SubscriptionSizingUnit[]>;
  quantityPolicy(input: { units: SubscriptionSizingUnit[]; dailyNeed: number; planDays: number }): Promise<{
    totalUnits: number; maxExceeded: boolean; selectedCapacityConstrained?: boolean;
  }>;
}
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
/** Preserve every selection, round proportions deterministically, then transfer units
 * toward demand coverage. A failed allocation is unservable, never a partial selection. */
export function apportionSubscriptionUnits(input: {
  totalUnits: number; targetDemand: number; current: readonly { variantId: string; qty: number }[];
  units: readonly SubscriptionSizingUnit[];
}): { variantId: string; qty: number }[] {
  const facts = new Map(input.units.map(unit => [unit.variantId, unit]));
  if (!input.current.length || new Set(input.current.map(line => line.variantId)).size !== input.current.length ||
    input.current.some(line => !Number.isInteger(line.qty) || line.qty <= 0 || !facts.has(line.variantId))) {
    throw new Error("subscription_reprice_invalid_current_mix");
  }
  if (!Number.isInteger(input.totalUnits) || input.totalUnits < 0) throw new Error("subscription_reprice_invalid_sizing_total");
  const units = input.current.map(line => facts.get(line.variantId)!);
  const caps = units.map(unit => Math.max(0, Math.floor(unit.maximumQuantity)));
  if (input.totalUnits < units.length || input.totalUnits > sum(caps) || caps.some(cap => cap < 1)) return [];
  const currentTotal = sum(input.current.map(line => line.qty));
  const quotas = input.current.map((line, index) => ({ index, quota: input.totalUnits * line.qty / currentTotal }));
  const quantities = quotas.map(({ quota, index }) => Math.min(caps[index], Math.max(1, Math.floor(quota))));
  while (sum(quantities) > input.totalUnits) {
    const source = quotas.filter(({ index }) => quantities[index] > 1)
      .sort((a, b) => (a.quota - Math.floor(a.quota)) - (b.quota - Math.floor(b.quota)) || b.index - a.index)[0];
    if (!source) return [];
    quantities[source.index] -= 1;
  }
  while (sum(quantities) < input.totalUnits) {
    const target = quotas.filter(({ index }) => quantities[index] < caps[index])
      .sort((a, b) => (b.quota - quantities[b.index]) - (a.quota - quantities[a.index]) || a.index - b.index)[0];
    if (!target) return [];
    quantities[target.index] += 1;
  }
  let demand = quantities.reduce((total, qty, index) => total + qty * units[index].demandPerUnit, 0);
  while (demand < input.targetDemand) {
    const candidates: { source: number; target: number; reaches: boolean; distance: number; proportional: number }[] = [];
    for (let source = 0; source < units.length; source += 1) {
      if (quantities[source] <= 1) continue;
      for (let target = 0; target < units.length; target += 1) {
        if (source === target || quantities[target] >= caps[target] || units[target].demandPerUnit <= units[source].demandPerUnit) continue;
        const next = demand - units[source].demandPerUnit + units[target].demandPerUnit;
        const shifted = [...quantities]; shifted[source] -= 1; shifted[target] += 1;
        candidates.push({ source, target, reaches: next >= input.targetDemand, distance: Math.abs(input.targetDemand - next),
          proportional: shifted.reduce((total, qty, index) => total + Math.abs(qty - quotas[index].quota), 0) });
      }
    }
    const transfer = candidates.sort((a, b) => Number(b.reaches) - Number(a.reaches) || a.proportional - b.proportional ||
      a.distance - b.distance || a.source - b.source || a.target - b.target)[0];
    if (!transfer) return [];
    quantities[transfer.source] -= 1; quantities[transfer.target] += 1;
    demand += units[transfer.target].demandPerUnit - units[transfer.source].demandPerUnit;
  }
  return input.current.map((line, index) => ({ variantId: line.variantId, qty: quantities[index] }));
}
/** Application demand and quantity policy stay behind the existing core composition seam. */
export function createSubscriptionSizingRules(policy: SubscriptionSizingPolicy): CompositionRulesPort {
  const modes = policy.portionModes;
  if (!modes.full.mode || !modes.reduced.mode || modes.full.mode === modes.reduced.mode ||
    !Number.isFinite(modes.full.factor) || !Number.isFinite(modes.reduced.factor) || modes.full.factor <= 0 ||
    modes.reduced.factor <= 0 || modes.reduced.factor >= modes.full.factor) throw new Error("subscription_reprice_portion_modes_unavailable");
  async function unitsFor(lines: BundleLineRef[]) {
    const units = await policy.readUnitFacts(lines.map(line => line.variantId));
    const byVariant = new Map(units.map(unit => [unit.variantId, unit]));
    if (lines.some(line => !byVariant.has(line.variantId))) throw new Error("subscription_reprice_non_base_variant");
    return lines.map(line => byVariant.get(line.variantId)!);
  }
  return {
    async validateComposition({ coreLines }) {
      if (!coreLines.length || coreLines.some(line => !line.variantId.trim() || !Number.isInteger(line.qty) || line.qty <= 0)) {
        return { ok: false, code: "subscription_reprice_invalid_base_mix" };
      }
      if (new Set(coreLines.map(line => line.variantId)).size !== coreLines.length) return { ok: false, code: "subscription_reprice_duplicate_variant" };
      try { await unitsFor(coreLines); } catch (error) {
        if (error instanceof Error && error.message === "subscription_reprice_non_base_variant") return { ok: false, code: error.message };
        throw error;
      }
      return { ok: true };
    },
    async resizeComposition({ coreLines, constraint, lever }) {
      if (lever.kind === "planLengthConstraint") {
        const planDays = Math.trunc(Number(lever.value));
        if (!Number.isInteger(planDays) || planDays <= 0) throw new Error("subscription_reprice_invalid_plan_length");
        return { coreLines, constraint: { ...constraint, data: { ...constraint.data,
          ...(policy.isPlanLengthConstraint(constraint) ? { value: planDays } : {}) } } };
      }
      if (lever.kind !== "planLength" && lever.kind !== "portionMode") return null;
      const data = constraint.data, value = lever.value && typeof lever.value === "object" ? lever.value as Record<string, unknown> : {};
      const planDays = Math.trunc(Number(lever.kind === "planLength" ? lever.value : value.planDays ?? data.value));
      if (!Number.isInteger(planDays) || planDays <= 0) throw new Error("subscription_reprice_invalid_plan_length");
      let factor = typeof data.portionFactor === "number" && data.portionFactor > 0 && data.portionFactor <= modes.full.factor
        ? data.portionFactor : modes.full.factor;
      let mode: string | undefined;
      if (lever.kind === "portionMode") {
        mode = String(value.portionMode ?? lever.value ?? "");
        if (![modes.full.mode, modes.reduced.mode].includes(mode)) throw new Error("subscription_reprice_invalid_portion_mode");
        factor = mode === modes.reduced.mode ? modes.reduced.factor : modes.full.factor;
      }
      const need = policy.readDailyNeed(constraint);
      if (!Number.isFinite(need) || need <= 0) throw new Error("subscription_reprice_missing_daily_need");
      const units = await unitsFor(coreLines), dailyNeed = need * factor;
      const sized = await policy.quantityPolicy({ units, dailyNeed, planDays });
      if (!Number.isInteger(sized.totalUnits) || sized.totalUnits < 0) throw new Error("subscription_reprice_invalid_sizing_total");
      const resized = sized.maxExceeded || sized.selectedCapacityConstrained ? [] : apportionSubscriptionUnits({
        current: coreLines, units, totalUnits: sized.totalUnits, targetDemand: dailyNeed * planDays });
      if (!resized.length) throw new Error(lever.kind === "planLength" ? "subscription_reprice_plan_length_unservable" : "subscription_reprice_portion_unservable");
      if (mode === modes.reduced.mode && sized.totalUnits >= sum(coreLines.map(line => line.qty))) throw new Error("subscription_reprice_portion_no_reduction");
      return { coreLines: resized.map(line => ({ ...line, isAddon: false })), constraint: { ...constraint, data: { ...data,
        ...(lever.kind === "planLength" && policy.isPlanLengthConstraint(constraint) ? { value: planDays } : {}),
        ...(mode ? { mode, portionFactor: factor } : {}) } } };
    },
  };
}
