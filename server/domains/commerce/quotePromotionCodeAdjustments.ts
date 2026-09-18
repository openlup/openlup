import { evaluatePromotionAdjustmentsV2 } from "../../../src/domains/promo/ports.js";
import type { PromotionCodeRejectionReason } from "../../../src/domains/promo/ports.js";
import type { CommerceCodeRejection, CommerceCodeRejectionDetail, CommerceCodeRejectionReason, CommerceQuoteDiscount } from "../../../src/domains/commerce/types.js";
import type { PromotionCodeQuotePort } from "./promotionCodeQuotePort.js";
import { MINIMUM_PRODUCT_PAYABLE_MINOR } from "./promotionCodePreview.js";

export interface ApplyPromotionCodesV2Input {
  port?: PromotionCodeQuotePort;
  preserveLegacyDiscountsWhenNoCandidates?: boolean;
  clientId: string | null;
  mode: "one_time" | "subscription";
  promoCodes: readonly string[];
  referenceProductMinor: number;
  subtotalGrossMinor: number;
  shippingGrossMinor: number;
  discounts: CommerceQuoteDiscount[];
  codeRejections: CommerceCodeRejection[];
  codeRejectionDetails?: CommerceCodeRejectionDetail[];
  atTime: string;
}

export async function applyPromotionCodesV2(input: ApplyPromotionCodesV2Input): Promise<{
  discounts: CommerceQuoteDiscount[]; codeRejections: CommerceCodeRejection[]; codeRejectionDetails: CommerceCodeRejectionDetail[];
}> {
  const submittedV2Codes = firstSubmittedCodes(input.promoCodes);
  if (!input.port || submittedV2Codes.length === 0) {
    return {
      discounts: input.discounts,
      codeRejections: input.codeRejections,
      codeRejectionDetails: input.codeRejectionDetails ?? [],
    };
  }
  const firstSubmittedByIdentity = new Map(submittedV2Codes.map((code) => [normalize(code), code]));
  const resolution = await input.port.resolve({
    codes: submittedV2Codes,
    clientId: input.clientId,
    purchaseScope: input.mode === "subscription" ? "subscription_initial" : "one_time",
    referenceProductMinor: input.referenceProductMinor,
    atTime: input.atTime,
  });
  if (resolution.candidates.length === 0) {
    const discounts = input.preserveLegacyDiscountsWhenNoCandidates
      ? input.discounts
      : reduceProvisionalLegacyDiscounts(input.discounts, firstSubmittedByIdentity);
    const appliedLegacyCodes = new Set(discounts.flatMap((discount) => discount.code ? [normalize(discount.code)] : []));
    const codeRejections = dedupeRejections([
      ...input.codeRejections,
      ...resolution.codeRejections,
    ], firstSubmittedByIdentity, input.codeRejections.length).filter((rejection) => !appliedLegacyCodes.has(normalize(rejection.code)));
    return {
      discounts: input.preserveLegacyDiscountsWhenNoCandidates
        ? discounts
        : orderSubmittedCodeSlots(projectSubmittedCodeSpelling(discounts, firstSubmittedByIdentity), firstSubmittedByIdentity),
      codeRejections,
      codeRejectionDetails: dedupeRejectionDetails([
        ...selectedRejectionDetails(input.codeRejectionDetails ?? [], input.codeRejections, codeRejections),
        ...selectedRejectionDetails(resolution.codeRejectionDetails, resolution.codeRejections, codeRejections),
      ], firstSubmittedByIdentity),
    };
  }
  const provisionalLegacyDiscounts = reduceProvisionalLegacyDiscounts(input.discounts, firstSubmittedByIdentity);
  const appliedLegacyCodes = new Set(provisionalLegacyDiscounts.flatMap((discount) => discount.code ? [normalize(discount.code)] : []));
  const result = evaluatePromotionAdjustmentsV2(
    adjustmentContext(input, provisionalLegacyDiscounts),
    resolution.candidates,
  );
  const byAdjustmentIdentity = new Map(
    resolution.candidates.map((candidate) => [
      `${candidate.promotionId}:${candidate.codeId}`,
      candidate,
    ]),
  );
  const replacedLegacyLanes = new Set<string>();
  const effectiveAdjustments = result.adjustments.flatMap((adjustment) => {
    const candidate = adjustment.codeId
      ? byAdjustmentIdentity.get(`${adjustment.promotionId}:${adjustment.codeId}`)
      : undefined;
    if (!candidate || candidate.source !== "code" || !candidate.code) {
      throw new Error("promotion_code_quote_candidate_identity_missing");
    }
    const appliesTo = adjustment.lane === "shipping" ? "shipping" : "order_total";
    const identity = normalize(candidate.code);
    const matchingLegacy = provisionalLegacyDiscounts.filter((discount) =>
      discount.appliesTo === appliesTo && discount.code && normalize(discount.code) === identity,
    );
    if (matchingLegacy.length === 0) return [{ adjustment, candidate }];

    // Re-score without the matching provisional legacy identity and retain the
    // single adjustment that gives the customer the lower lane payable.
    const withoutMatchingLegacy = provisionalLegacyDiscounts.filter((discount) =>
      !(discount.appliesTo === appliesTo && discount.code && normalize(discount.code) === identity),
    );
    const replacement = evaluatePromotionAdjustmentsV2(
      adjustmentContext(input, withoutMatchingLegacy),
      [candidate],
    ).adjustments[0];
    const legacyAmount = matchingLegacy.reduce((sum, discount) => sum + discount.amountOffMinor, 0);
    if (!replacement || replacement.amountOffMinor < legacyAmount) return [];
    replacedLegacyLanes.add(`${identity}:${appliesTo}`);
    return [{ adjustment: replacement, candidate }];
  });
  const retainedDiscounts = projectSubmittedCodeSpelling(
    provisionalLegacyDiscounts.filter((discount) =>
      !(discount.code && replacedLegacyLanes.has(`${normalize(discount.code)}:${discount.appliesTo}`)),
    ),
    firstSubmittedByIdentity,
  );
  const v2Discounts: CommerceQuoteDiscount[] = effectiveAdjustments.map(({ adjustment, candidate }) => ({
      promotionId: adjustment.promotionId,
      code: firstSubmittedByIdentity.get(normalize(candidate.code!)) ?? candidate.code!,
      label: adjustment.name,
      appliesTo: adjustment.lane === "shipping" ? "shipping" : "order_total",
      amountOffMinor: adjustment.amountOffMinor,
      reasonCode: "promotion_code_v2",
      promotionEngineVersion: "promotion-engine.v2",
      promotionCodeId: candidate.codeId,
      promotionCodeRevision: candidate.codeRevision,
      promotionDefinitionFingerprint: candidate.definitionFingerprint,
      promotionCodeScopes: [...candidate.scopes],
      promotionMinimumReferenceMinor: candidate.minimumReferenceMinor,
      promotionCodeValidTo: candidate.validTo,
      promotionBenefitKind: candidate.kind,
      promotionBenefitValueBps: candidate.valueBps,
      promotionBenefitValueMinor: candidate.valueMinor,
      floorApplied: adjustment.floorApplied,
    }));
  const appliedV2Codes = new Set(v2Discounts.flatMap((discount) => discount.code ? [normalize(discount.code)] : []));
  const engineRejections: CommerceCodeRejection[] = result.rejectedCodes.flatMap((rejection) =>
    rejection.code && !appliedLegacyCodes.has(normalize(rejection.code))
      ? [{
          code: firstSubmittedByIdentity.get(normalize(rejection.code)) ?? rejection.code,
          reason: mapEngineRejectionReason(rejection.reason),
        }]
      : [],
  );
  const appliedCodes = new Set([...retainedDiscounts.flatMap((discount) => discount.code ? [normalize(discount.code)] : []), ...appliedV2Codes]);
  const mergedRejections = dedupeRejections([
    ...input.codeRejections,
    ...resolution.codeRejections,
    ...engineRejections,
  ], firstSubmittedByIdentity, input.codeRejections.length).filter((rejection) => !appliedCodes.has(normalize(rejection.code)));
  const codeRejectionDetails = dedupeRejectionDetails([
    ...selectedRejectionDetails(input.codeRejectionDetails ?? [], input.codeRejections, mergedRejections),
    ...selectedRejectionDetails(resolution.codeRejectionDetails, resolution.codeRejections, mergedRejections),
  ], firstSubmittedByIdentity);
  return {
    discounts: orderSubmittedCodeSlots([...retainedDiscounts, ...v2Discounts], firstSubmittedByIdentity),
    codeRejections: mergedRejections,
    codeRejectionDetails,
  };
}

function adjustmentContext(input: ApplyPromotionCodesV2Input, discounts: readonly CommerceQuoteDiscount[]) {
  return {
    purchaseScope: input.mode === "subscription" ? "subscription_initial" : "one_time",
    referenceProductMinor: input.referenceProductMinor,
    currentProductMinor: input.subtotalGrossMinor - sumLane(discounts, false),
    shippingMinor: input.shippingGrossMinor - sumLane(discounts, true),
    minimumProductPayableMinor: MINIMUM_PRODUCT_PAYABLE_MINOR,
  } as const;
}

function sumLane(discounts: readonly CommerceQuoteDiscount[], shipping: boolean): number {
  return discounts
    .filter((discount) => (discount.appliesTo === "shipping") === shipping)
    .reduce((sum, discount) => sum + discount.amountOffMinor, 0);
}

function dedupeRejections(
  rejections: readonly CommerceCodeRejection[],
  firstSubmittedByIdentity: ReadonlyMap<string, string> = new Map(),
  authoritativeFrom = rejections.length,
): CommerceCodeRejection[] {
  const byCode = new Map<string, CommerceCodeRejection>();
  for (const [index, rejection] of rejections.entries()) {
    const identity = normalize(rejection.code);
    const current = byCode.get(identity);
    if (!current || (index >= authoritativeFrom && current.reason === "not_recognized")) {
      byCode.set(identity, { ...rejection, code: firstSubmittedByIdentity.get(identity) ?? rejection.code });
    }
  }
  return orderSubmittedCodeSlots([...byCode.values()], firstSubmittedByIdentity);
}

function dedupeRejectionDetails(
  details: readonly CommerceCodeRejectionDetail[],
  firstSubmittedByIdentity: ReadonlyMap<string, string> = new Map(),
): CommerceCodeRejectionDetail[] {
  const byCode = new Map<string, CommerceCodeRejectionDetail>();
  for (const detail of details) {
    const identity = normalize(detail.code);
    if (!byCode.has(identity)) {
      byCode.set(identity, { ...detail, code: firstSubmittedByIdentity.get(identity) ?? detail.code });
    }
  }
  return orderSubmittedCodeSlots([...byCode.values()], firstSubmittedByIdentity);
}

function selectedRejectionDetails(details: readonly CommerceCodeRejectionDetail[], sourceRejections: readonly CommerceCodeRejection[], selectedRejections: readonly CommerceCodeRejection[]): CommerceCodeRejectionDetail[] {
  const selected = new Map(selectedRejections.map((rejection) => [normalize(rejection.code), rejection.reason]));
  const matchingSources = new Set(sourceRejections.flatMap((rejection) =>
    selected.get(normalize(rejection.code)) === rejection.reason ? [normalize(rejection.code)] : [],
  ));
  return details.filter((detail) => matchingSources.has(normalize(detail.code)));
}

function firstSubmittedCodes(codes: readonly string[]): string[] {
  const seen = new Set<string>();
  const first: string[] = [];
  for (const code of codes) {
    const identity = normalize(code);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    first.push(code);
  }
  return first;
}

/** Collapse legacy exact-literal collisions to one submitted identity per lane. */
function reduceProvisionalLegacyDiscounts(discounts: readonly CommerceQuoteDiscount[], firstSubmittedByIdentity: ReadonlyMap<string, string>): CommerceQuoteDiscount[] {
  const chosen = new Map<string, { index: number; exactFirstSpelling: boolean }>();
  for (const [index, discount] of discounts.entries()) {
    if (!discount.code) continue;
    const identity = normalize(discount.code);
    const firstSubmitted = firstSubmittedByIdentity.get(identity);
    if (!firstSubmitted) continue;
    const key = `${identity}:${discount.appliesTo}`;
    const exactFirstSpelling = discount.code === firstSubmitted;
    const current = chosen.get(key);
    if (!current || (exactFirstSpelling && !current.exactFirstSpelling)) {
      chosen.set(key, { index, exactFirstSpelling });
    }
  }
  return discounts.filter((discount, index) => {
    if (!discount.code) return true;
    const identity = normalize(discount.code);
    if (!firstSubmittedByIdentity.has(identity)) return true;
    return chosen.get(`${identity}:${discount.appliesTo}`)?.index === index;
  });
}

function projectSubmittedCodeSpelling(discounts: readonly CommerceQuoteDiscount[], firstSubmittedByIdentity: ReadonlyMap<string, string>): CommerceQuoteDiscount[] {
  return discounts.map((discount) => {
    if (!discount.code) return discount;
    const code = firstSubmittedByIdentity.get(normalize(discount.code));
    return code ? { ...discount, code } : discount;
  });
}

function submittedRank(code: string, firstSubmittedByIdentity: ReadonlyMap<string, string>): number {
  const rank = [...firstSubmittedByIdentity.keys()].indexOf(normalize(code));
  return rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
}

function orderSubmittedCodeSlots<T extends { code?: string | null }>(values: T[], firstSubmittedByIdentity: ReadonlyMap<string, string>): T[] {
  const ordered = values.map((value, index) => ({ value, index })).filter(({ value }) => value.code && submittedRank(value.code, firstSubmittedByIdentity) < Number.MAX_SAFE_INTEGER)
    .sort((left, right) => submittedRank(left.value.code!, firstSubmittedByIdentity) - submittedRank(right.value.code!, firstSubmittedByIdentity) || left.index - right.index).map(({ value }) => value);
  let index = 0;
  return values.map((value) => value.code && submittedRank(value.code, firstSubmittedByIdentity) < Number.MAX_SAFE_INTEGER ? ordered[index++]! : value);
}

function normalize(code: string): string {
  return code.trim().toUpperCase();
}

export function mapEngineRejectionReason(reason: PromotionCodeRejectionReason): CommerceCodeRejectionReason {
  switch (reason) {
    case "better_price_exists":
      return "better_price_exists";
    case "scope_not_applicable":
      return "scope_not_applicable";
    default:
      return "not_eligible";
  }
}
