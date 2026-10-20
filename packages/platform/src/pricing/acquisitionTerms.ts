import { ACQUISITION_TERMS_CAPABILITY, type AcquisitionTermsMetadata, type ResolvedAcquisitionTerms } from "./contracts/acquisitionTerms.js";
import type { AcquisitionFinancialPolicy } from "./acquisitionFinancialPolicy.js";
import { acquisitionTermsMetadataSchema, resolvedAcquisitionTermsSchema } from "./acquisitionTermsSchemas.js";
export type AcquisitionTermsRefusal = "acquisition_terms_policy_unconfigured" | "acquisition_terms_invalid" | "acquisition_terms_ambiguous"
  | "acquisition_terms_not_effective" | "acquisition_terms_capability_required" | "acquisition_terms_v2_required";
export class AcquisitionTermsError extends Error {
  constructor(readonly reason: AcquisitionTermsRefusal) { super(reason); this.name = "AcquisitionTermsError"; }
}
export interface AcquisitionTermsSelection {
  kind: "legacy_pair" | "v2_standalone" | "legacy_unconfigured";
  terms: ResolvedAcquisitionTerms;
  sourcePromotionId: string;
  legacyPromotionId?: string;
  nextBoundaryAt: string | null;
}

function requirePolicy<Row>(policy: AcquisitionFinancialPolicy<Row>): void {
  if (!policy) throw new AcquisitionTermsError("acquisition_terms_policy_unconfigured");
}
function effective<Row>(row: Row, at: number, policy: AcquisitionFinancialPolicy<Row>): boolean {
  const facts = policy.facts(row);
  return Date.parse(facts.validFrom) <= at && (facts.validTo === null || Date.parse(facts.validTo) > at);
}
function metadata<Row>(row: Row, policy: AcquisitionFinancialPolicy<Row>): AcquisitionTermsMetadata {
  const parsed = acquisitionTermsMetadataSchema.safeParse(policy.facts(row).metadata);
  if (!parsed.success) throw new AcquisitionTermsError("acquisition_terms_invalid");
  policy.validateMetadata(row, parsed.data);
  return parsed.data;
}
function resolved<Row>(row: Row, terms: AcquisitionTermsMetadata, policy: AcquisitionFinancialPolicy<Row>,
  purpose: "resolved_target" | "filter_validation" = "resolved_target"): ResolvedAcquisitionTerms {
  const facts = policy.facts(row);
  const parsed = resolvedAcquisitionTermsSchema.safeParse({ ...terms,
    initialDiscountBps: policy.initialDiscountBps(row, purpose), effectiveFrom: facts.validFrom,
    effectiveTo: facts.validTo, sourcePromotionId: facts.id });
  if (!parsed.success) throw new AcquisitionTermsError("acquisition_terms_invalid");
  return { ...parsed.data, effectiveFrom: new Date(parsed.data.effectiveFrom).toISOString(),
    effectiveTo: parsed.data.effectiveTo === null ? null : new Date(parsed.data.effectiveTo).toISOString() };
}
/** Selection never falls back from a configured but malformed or incomplete schedule. */
export function selectAcquisitionTerms<Row>(
  rows: readonly Row[], atTime: string, regionCode: string, policy: AcquisitionFinancialPolicy<Row>,
): AcquisitionTermsSelection | null {
  requirePolicy(policy);
  const at = Date.parse(atTime);
  if (!Number.isFinite(at)) throw new AcquisitionTermsError("acquisition_terms_invalid");
  const scoped = rows.filter((row) => policy.facts(row).active && policy.facts(row).regionCodes.includes(regionCode));
  const tagged = scoped.filter((row) => policy.facts(row).metadataPresent);
  if (tagged.length === 0) {
    const legacyRows = scoped.filter((row) => policy.classify(row).unconfiguredLegacyEligible);
    const knownPairs = legacyRows.flatMap((legacy) => scoped.filter((mirror) => policy.classify(mirror).target
      && policy.pairMatches(legacy, mirror)).map((mirror) => ({ legacy, mirror })));
    const pairs = knownPairs.filter(({ mirror }) => effective(mirror, at, policy));
    if (pairs.length > 1) throw new AcquisitionTermsError("acquisition_terms_ambiguous");
    if (pairs.length === 0) {
      if (knownPairs.length) throw new AcquisitionTermsError("acquisition_terms_not_effective");
      return null;
    }
    const { legacy, mirror } = pairs[0]!;
    const terms = resolved(mirror, policy.unconfiguredTerms(legacy, mirror), policy);
    return { kind: "legacy_unconfigured", terms, sourcePromotionId: policy.facts(mirror).id,
      legacyPromotionId: policy.facts(legacy).id, nextBoundaryAt: terms.effectiveTo };
  }
  const grouped = new Map<string, Row[]>();
  for (const row of tagged) {
    const parsed = metadata(row, policy);
    const group = grouped.get(parsed.revision) ?? [];
    group.push(row); grouped.set(parsed.revision, group);
  }
  const selections: AcquisitionTermsSelection[] = [];
  for (const group of grouped.values()) {
    const mirrors = group.filter((row) => policy.classify(row).target);
    const legacy = group.filter((row) => policy.classify(row).baselineLegacy);
    if (mirrors.length !== 1 || legacy.length > 1 || group.length !== mirrors.length + legacy.length) {
      throw new AcquisitionTermsError("acquisition_terms_ambiguous");
    }
    const mirror = mirrors[0]!;
    if (legacy.length === 1 ? !policy.pairMatches(legacy[0]!, mirror) : policy.facts(mirror).mirrorOf != null) {
      throw new AcquisitionTermsError("acquisition_terms_invalid");
    }
    const terms = resolved(mirror, metadata(mirror, policy), policy);
    selections.push({ kind: legacy.length ? "legacy_pair" : "v2_standalone", terms,
      sourcePromotionId: policy.facts(mirror).id, ...(legacy.length ? { legacyPromotionId: policy.facts(legacy[0]!).id } : {}), nextBoundaryAt: null });
  }
  selections.sort((a, b) => Date.parse(a.terms.effectiveFrom) - Date.parse(b.terms.effectiveFrom));
  for (let i = 1; i < selections.length; i++) {
    const previousEnd = selections[i - 1]!.terms.effectiveTo;
    const start = Date.parse(selections[i]!.terms.effectiveFrom);
    if (previousEnd === null || Date.parse(previousEnd) > start) throw new AcquisitionTermsError("acquisition_terms_ambiguous");
    if (Date.parse(previousEnd) < start) throw new AcquisitionTermsError("acquisition_terms_not_effective");
  }
  const current = selections.filter(({ terms }) => Date.parse(terms.effectiveFrom) <= at
    && (terms.effectiveTo === null || Date.parse(terms.effectiveTo) > at));
  if (current.length !== 1) throw new AcquisitionTermsError("acquisition_terms_not_effective");
  if (scoped.some((row) => !policy.facts(row).metadataPresent && policy.classify(row).canonicalRow && effective(row, at, policy))) {
    throw new AcquisitionTermsError("acquisition_terms_invalid");
  }
  const boundaries = selections.flatMap(({ terms }) => [terms.effectiveFrom, terms.effectiveTo])
    .filter((instant): instant is string => instant !== null && Date.parse(instant) > at).sort();
  return { ...current[0]!, nextBoundaryAt: boundaries[0] ?? null };
}

/** Ordinary coupon validity and inactive rows remain owned by their evaluator. */
export function filterAcquisitionPromotions<Row>(rows: readonly Row[], atTime: string, regionCode: string,
  policy: AcquisitionFinancialPolicy<Row>): Row[] {
  requirePolicy(policy);
  const at = Date.parse(atTime);
  if (!Number.isFinite(at)) throw new AcquisitionTermsError("acquisition_terms_invalid");
  return rows.filter((row) => {
    if (!policy.facts(row).regionCodes.includes(regionCode) || !policy.classify(row).canonicalRow) return true;
    if (policy.facts(row).metadataPresent) {
      const parsed = metadata(row, policy);
      resolved(row, parsed, policy, "filter_validation");
    }
    return effective(row, at, policy);
  });
}

export function assertAcquisitionTermsCapability(
  selection: AcquisitionTermsSelection | null, capability: unknown, promotionEngineVersion: unknown,
): void {
  if (!selection || selection.kind !== "v2_standalone") return;
  if (capability !== ACQUISITION_TERMS_CAPABILITY) throw new AcquisitionTermsError("acquisition_terms_capability_required");
  if (promotionEngineVersion !== "promotion-engine.v2") throw new AcquisitionTermsError("acquisition_terms_v2_required");
}
