import type { BundleLineRef, CompositionConstraint, CompositionRulesPort } from "@openlup/core/bundle";
import { SIZED_PARCEL_LEVER_KIND } from "./sizedParcelLever.js";
import { type SizedAgreedLine, type SizedEditPolicy } from "./contracts/sizedEdit.js";
import type { SizedCatalogFact, SizedHostPorts } from "./sizedEditPorts.js";

export function assertSizedPolicy(policy: SizedEditPolicy): void {
  if ([policy.minimumCoreUnits, policy.maximumCoreLines, policy.maximumAddonLines, policy.maximumQuantity,
    policy.maximumExclusions, policy.maximumCatalogExclusions, policy.fixedThroughCycle, policy.graduationCycle, ...policy.allowedCadences]
    .some(value => !Number.isSafeInteger(value) || value <= 0) || !policy.allowedCadences.length ||
    policy.graduationCycle <= policy.fixedThroughCycle || policy.portionModes.full.mode === policy.portionModes.reduced.mode ||
    !policy.portionModes.full.mode || !policy.portionModes.reduced.mode ||
    !Number.isFinite(policy.portionModes.full.factor) || !Number.isFinite(policy.portionModes.reduced.factor) ||
    policy.portionModes.reduced.factor <= 0 || policy.portionModes.full.factor <= policy.portionModes.reduced.factor) {
    throw new Error("subscription_reprice_sized_configuration_unavailable");
  }
}
export function createSizedCompositionRules(input: { policy: SizedEditPolicy; catalog: readonly SizedCatalogFact[];
  baseline: SizedAgreedLine[]; exclusions: readonly string[]; dailyNeed: number; cadenceDays: number; useFrozenBaseline?: boolean;
  proposePortion: SizedHostPorts["proposePortion"] }): CompositionRulesPort {
  assertSizedPolicy(input.policy);
  const policy = input.policy, baseline = new Map(input.baseline.filter(line => !line.isAddon).map(line => [line.variantId, line]));
  const byVariant = new Map<string, SizedCatalogFact>(), skus = new Set<string>();
  for (const fact of input.catalog) {
    if (byVariant.has(fact.variantId) || skus.has(fact.sku)) throw new Error("subscription_reprice_sized_catalog_identity_invalid");
    byVariant.set(fact.variantId, fact); skus.add(fact.sku);
    const before = baseline.get(fact.variantId);
    if (!fact.verified || !fact.groupId || !fact.sku || !fact.documentRevisionId || !/^[a-f0-9]{64}$/iu.test(fact.documentDigest) ||
      !Number.isFinite(fact.physicalSize) || fact.physicalSize <= 0 || !Number.isSafeInteger(fact.demandPerUnit) || fact.demandPerUnit <= 0 ||
      (before && (before.sku !== fact.sku || before.groupId !== fact.groupId))) throw new Error("subscription_reprice_sized_catalog_facts_unreadable");
  }
  function resolve(lines: readonly BundleLineRef[]): string | null {
    if (!lines.length || lines.length > policy.maximumCoreLines || new Set(lines.map(line => line.variantId)).size !== lines.length) return "subscription_reprice_sized_line_not_sellable";
    const groups = new Set<string>();
    for (const line of lines) {
      const fact = byVariant.get(line.variantId), prior = baseline.get(line.variantId);
      if (!fact || fact.isAddon || line.isAddon || !Number.isSafeInteger(line.qty) || line.qty < 1 || line.qty > policy.maximumQuantity ||
        groups.has(fact.groupId) || (!fact.sellable && prior?.qty !== line.qty)) return "subscription_reprice_sized_line_not_sellable";
      groups.add(fact.groupId);
      if (!Array.isArray(fact.exclusions) || fact.exclusions.length > policy.maximumCatalogExclusions || fact.exclusions.some(key => typeof key !== "string" || !key)) return "subscription_reprice_sized_exclusion_facts_unreadable";
      if (line.qty > (prior?.qty ?? 0)) {
        if (fact.sellableNow === null || !Number.isSafeInteger(fact.sellableNow) || line.qty > fact.sellableNow) return "subscription_reprice_sized_stock_unavailable";
        if (fact.exclusions.some(key => input.exclusions.includes(key))) return "subscription_reprice_sized_exclusion_conflict";
      }
    }
    return lines.reduce((total, line) => total + line.qty, 0) < policy.minimumCoreUnits ? "subscription_reprice_sized_below_minimum" : null;
  }
  function check(lines: readonly BundleLineRef[], days: number): string | null {
    return !policy.allowedCadences.includes(days) ? "subscription_reprice_sized_cadence_invalid" : resolve(lines);
  }
  const modes = policy.portionModes;
  function portion(constraint: CompositionConstraint) {
    const { mode, portionFactor } = constraint.data;
    if ((mode === undefined || mode === modes.full.mode) && (portionFactor === undefined || portionFactor === modes.full.factor)) return modes.full;
    if (mode === modes.reduced.mode && portionFactor === modes.reduced.factor) return modes.reduced;
    return null;
  }
  function pinned(constraint: CompositionConstraint) {
    return constraint.data.kind === "unit_count" && constraint.data.dailyNeed === input.dailyNeed && portion(constraint) !== null;
  }
  function fail(reason: string | null) { if (reason) throw new Error(reason); }
  return {
    async validateComposition({ coreLines, constraint }) {
      const reason = !pinned(constraint) || constraint.data.value !== coreLines.reduce((total, line) => total + line.qty, 0)
        ? "subscription_reprice_sized_lever_mismatch" : check(coreLines, input.cadenceDays);
      return reason ? { ok: false, code: reason } : { ok: true };
    },
    async resizeComposition({ coreLines, constraint, lever }) {
      if (!pinned(constraint)) throw new Error("subscription_reprice_sized_lever_mismatch");
      if (lever.kind === "planLengthConstraint") return null;
      if (lever.kind === SIZED_PARCEL_LEVER_KIND) {
        const value = lever.value as { coreLines?: BundleLineRef[] };
        if (!Array.isArray(value?.coreLines)) throw new Error("subscription_reprice_sized_lever_mismatch");
        const desired = value.coreLines.map(line => ({ variantId: line.variantId, qty: line.qty, isAddon: false }));
        fail(check(desired, input.cadenceDays));
        const count = desired.reduce((total, line) => total + line.qty, 0);
        if (constraint.data.value !== count) throw new Error("subscription_reprice_sized_lever_mismatch");
        return { coreLines: desired, constraint: { ...constraint, data: { ...constraint.data, value: count } } };
      }
      if (lever.kind !== "planLength" && lever.kind !== "portionMode") return null;
      const starting = input.useFrozenBaseline ? input.baseline.filter(line => !line.isAddon).map(line => ({ variantId: line.variantId, qty: line.qty, isAddon: false })) : coreLines;
      fail(resolve(starting));
      const value = lever.value as { portionMode?: string; planDays?: number };
      const days = lever.kind === "planLength" ? Number(lever.value) : Number(value?.planDays ?? input.cadenceDays);
      if (!policy.allowedCadences.includes(days)) throw new Error("subscription_reprice_sized_cadence_invalid");
      if (lever.kind === "planLength") {
        if (starting.some(line => byVariant.get(line.variantId)?.exclusions?.some(key => input.exclusions.includes(key)))) throw new Error("subscription_reprice_sized_exclusion_conflict");
        fail(check(starting, days));
        return { coreLines: starting, constraint: { ...constraint, data: { ...constraint.data, value: starting.reduce((total, line) => total + line.qty, 0) } } };
      }
      const mode = value?.portionMode, selected = mode === modes.full.mode ? modes.full : mode === modes.reduced.mode ? modes.reduced : null;
      if (!selected) throw new Error("subscription_reprice_sized_lever_mismatch");
      const current = starting.map(line => input.baseline.find(prior => prior.variantId === line.variantId)!).filter(Boolean);
      const next = (await input.proposePortion({ dailyNeed: input.dailyNeed, cadenceDays: days, factor: selected.factor, current, catalog: input.catalog }))
        .map(line => ({ ...line, isAddon: false }));
      const total = next.reduce((count, line) => count + line.qty, 0);
      if (selected === modes.reduced && total >= starting.reduce((count, line) => count + line.qty, 0)) throw new Error("subscription_reprice_sized_portion_no_reduction");
      fail(check(next, days));
      return { coreLines: next, constraint: { ...constraint, data: { ...constraint.data, value: total, mode, portionFactor: selected.factor } } };
    },
  };
}
