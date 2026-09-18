import {
  PROMOTION_ADJUSTMENT_KINDS,
  PROMOTION_ADJUSTMENT_LANES,
  PROMOTION_ENGINE_V2,
  PROMOTION_PURCHASE_SCOPES,
  type AppliedAdjustment,
  type PromotionAdjustmentCandidate,
  type PromotionAdjustmentContext,
  type PromotionAdjustmentLane,
  type PromotionAdjustmentResult,
  type PromotionCodeRejection,
} from "./adjustmentTypes.js";

interface ScoredCandidate {
  candidate: PromotionAdjustmentCandidate;
  amountOffMinor: number;
  beforeMinor: number;
  afterMinor: number;
  floorApplied: boolean;
}

/** Select at most one product and one shipping adjustment. */
/** @beta */
export function evaluatePromotionAdjustmentsV2(
  context: PromotionAdjustmentContext,
  candidates: readonly PromotionAdjustmentCandidate[],
): PromotionAdjustmentResult {
  const minimumProductPayableMinor = validateContext(context);
  candidates.forEach(validateCandidate);
  validateCodeIdentity(candidates);

  const applicable = candidates.filter((candidate) => candidate.scopes.includes(context.purchaseScope));
  const productWinner = pickWinner(
    applicable.filter((candidate) => candidate.lane === "product"),
    context,
    "product",
    minimumProductPayableMinor,
  );
  const shippingWinner = pickWinner(
    applicable.filter((candidate) => candidate.lane === "shipping"),
    context,
    "shipping",
    minimumProductPayableMinor,
  );
  const winners = [productWinner, shippingWinner].filter(
    (winner): winner is ScoredCandidate => winner !== null,
  );
  const productPayableMinor = productWinner?.afterMinor ?? context.currentProductMinor;
  const shippingPayableMinor = shippingWinner?.afterMinor ?? context.shippingMinor;

  return {
    engineVersion: PROMOTION_ENGINE_V2,
    adjustments: winners.map(toAppliedAdjustment),
    rejectedCodes: rejectedCodes(candidates, applicable, winners),
    productPayableMinor,
    shippingPayableMinor,
    effectiveProductDiscountBps: Number(
      (BigInt(context.referenceProductMinor - productPayableMinor) * 10_000n) /
      BigInt(context.referenceProductMinor),
    ),
  };
}

function validateContext(context: PromotionAdjustmentContext): number {
  const floor = context.minimumProductPayableMinor;
  if (!PROMOTION_PURCHASE_SCOPES.includes(context.purchaseScope)) {
    throw new RangeError("purchaseScope is invalid");
  }
  assertMinor("referenceProductMinor", context.referenceProductMinor, 1);
  assertMinor("minimumProductPayableMinor", floor, 1);
  assertMinor("currentProductMinor", context.currentProductMinor, floor);
  assertMinor("shippingMinor", context.shippingMinor, 0);
  if (context.currentProductMinor > context.referenceProductMinor) {
    throw new RangeError("currentProductMinor cannot exceed referenceProductMinor");
  }
  return floor;
}

function validateCandidate(candidate: PromotionAdjustmentCandidate): void {
  const runtimeLane = candidate.lane as string;
  const runtimeKind = candidate.kind as string;
  if (typeof candidate.promotionId !== "string" || typeof candidate.name !== "string" ||
      !candidate.promotionId.trim() || !candidate.name.trim()) {
    throw new RangeError("promotionId and name are required");
  }
  if (candidate.source !== "automatic" && candidate.source !== "code") {
    throw new RangeError("candidate source is invalid");
  }
  if (!PROMOTION_ADJUSTMENT_LANES.includes(runtimeLane as PromotionAdjustmentLane)) {
    throw new RangeError("candidate lane is invalid");
  }
  if (!PROMOTION_ADJUSTMENT_KINDS.includes(runtimeKind as (typeof PROMOTION_ADJUSTMENT_KINDS)[number])) {
    throw new RangeError("candidate kind is invalid");
  }
  if (!Array.isArray(candidate.scopes) || candidate.scopes.length === 0 ||
      candidate.scopes.some((scope) => !PROMOTION_PURCHASE_SCOPES.includes(scope)) ||
      new Set(candidate.scopes).size !== candidate.scopes.length) {
    throw new RangeError("candidate scopes are invalid");
  }
  if (candidate.source === "code" && (typeof candidate.codeId !== "string" || !candidate.codeId.trim())) {
    throw new RangeError("code candidates require codeId");
  }
  if (candidate.source === "automatic" && (candidate.codeId !== undefined || candidate.code !== undefined)) {
    throw new RangeError("automatic candidates cannot carry code identity");
  }
  if (candidate.kind === "target_percentage" || candidate.kind === "percentage") {
    assertMinor("valueBps", candidate.valueBps, 1);
    if ((candidate.valueBps ?? 0) >= 10_000) throw new RangeError("valueBps must be below 10000");
    if (candidate.valueMinor !== undefined) throw new RangeError("percentage candidates cannot set valueMinor");
  } else if (candidate.kind === "fixed_amount") {
    assertMinor("valueMinor", candidate.valueMinor, 1);
    if (candidate.valueBps !== undefined) throw new RangeError("fixed candidates cannot set valueBps");
  } else if (candidate.valueBps !== undefined || candidate.valueMinor !== undefined) {
    throw new RangeError("free_shipping cannot set a value");
  }
  if (runtimeLane === "product" && runtimeKind !== "target_percentage" && runtimeKind !== "fixed_amount") {
    throw new RangeError("product candidate kind is invalid");
  }
  if (runtimeLane === "shipping" && runtimeKind === "target_percentage") {
    throw new RangeError("shipping candidate kind is invalid");
  }
}

function validateCodeIdentity(candidates: readonly PromotionAdjustmentCandidate[]): void {
  const rawById = new Map<string, string | undefined>();
  for (const candidate of candidates) {
    if (candidate.source !== "code" || !candidate.codeId) continue;
    if (rawById.has(candidate.codeId) && rawById.get(candidate.codeId) !== candidate.code) {
      throw new RangeError("codeId candidates must use one code value");
    }
    rawById.set(candidate.codeId, candidate.code);
  }
}

function pickWinner(
  candidates: PromotionAdjustmentCandidate[],
  context: PromotionAdjustmentContext,
  lane: PromotionAdjustmentLane,
  floor: number,
): ScoredCandidate | null {
  const scored = candidates
    .map((candidate) => scoreCandidate(candidate, context, lane, floor))
    .filter((candidate) => candidate.amountOffMinor > 0)
    .sort(compareScored);
  return scored[0] ?? null;
}

function scoreCandidate(
  candidate: PromotionAdjustmentCandidate,
  context: PromotionAdjustmentContext,
  lane: PromotionAdjustmentLane,
  floor: number,
): ScoredCandidate {
  const beforeMinor = lane === "product" ? context.currentProductMinor : context.shippingMinor;
  let requestedOffMinor = 0;
  if (candidate.kind === "free_shipping") {
    requestedOffMinor = context.shippingMinor;
  } else if (candidate.kind === "fixed_amount") {
    requestedOffMinor = candidate.valueMinor ?? 0;
  } else if (lane === "shipping") {
    requestedOffMinor = multiplyDivideFloor(context.shippingMinor, candidate.valueBps ?? 0);
  } else {
    const targetPayableMinor = multiplyDivideCeil(
      context.referenceProductMinor,
      10_000 - (candidate.valueBps ?? 0),
    );
    requestedOffMinor = Math.max(0, context.currentProductMinor - targetPayableMinor);
  }
  const minimumPayable = lane === "product" ? floor : 0;
  const amountOffMinor = Math.min(requestedOffMinor, Math.max(0, beforeMinor - minimumPayable));
  return {
    candidate,
    amountOffMinor,
    beforeMinor,
    afterMinor: beforeMinor - amountOffMinor,
    floorApplied: lane === "product" && requestedOffMinor > amountOffMinor,
  };
}

function compareScored(left: ScoredCandidate, right: ScoredCandidate): number {
  if (left.amountOffMinor !== right.amountOffMinor) return right.amountOffMinor - left.amountOffMinor;
  if (left.candidate.source !== right.candidate.source) {
    return left.candidate.source === "automatic" ? -1 : 1;
  }
  return compareCodeUnits(left.candidate.promotionId, right.candidate.promotionId);
}

function toAppliedAdjustment(winner: ScoredCandidate): AppliedAdjustment {
  const candidate = winner.candidate;
  return {
    engineVersion: PROMOTION_ENGINE_V2,
    promotionId: candidate.promotionId,
    ...(candidate.codeId ? { codeId: candidate.codeId } : {}),
    ...(candidate.code ? { code: candidate.code } : {}),
    name: candidate.name,
    source: candidate.source,
    lane: candidate.lane,
    kind: candidate.kind,
    amountOffMinor: winner.amountOffMinor,
    beforeMinor: winner.beforeMinor,
    afterMinor: winner.afterMinor,
    floorApplied: winner.floorApplied,
    ...(candidate.kind === "target_percentage"
      ? { targetEffectiveDiscountBps: candidate.valueBps }
      : {}),
  };
}

function rejectedCodes(
  all: readonly PromotionAdjustmentCandidate[],
  applicable: readonly PromotionAdjustmentCandidate[],
  winners: readonly ScoredCandidate[],
): PromotionCodeRejection[] {
  const applicableIds = new Set(applicable.map((candidate) => candidate.codeId));
  const winnerIds = new Set(
    winners
      .filter((winner) => winner.candidate.source === "code")
      .map((winner) => winner.candidate.codeId),
  );
  const codes = new Map<string, PromotionCodeRejection>();
  for (const candidate of all) {
    if (candidate.source !== "code" || !candidate.codeId || winnerIds.has(candidate.codeId)) continue;
    const reason = applicableIds.has(candidate.codeId) ? "better_price_exists" : "scope_not_applicable";
    const previous = codes.get(candidate.codeId);
    if (!previous || previous.reason === "scope_not_applicable") {
      codes.set(candidate.codeId, {
        codeId: candidate.codeId,
        ...(candidate.code ? { code: candidate.code } : {}),
        reason,
      });
    }
  }
  return [...codes.values()].sort((left, right) => compareCodeUnits(left.codeId ?? "", right.codeId ?? ""));
}

function assertMinor(name: string, value: number | undefined, minimum: number): void {
  if (!Number.isSafeInteger(value) || (value ?? 0) < minimum) {
    throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
  }
}

function multiplyDivideFloor(value: number, multiplier: number): number {
  return Number((BigInt(value) * BigInt(multiplier)) / 10_000n);
}

function multiplyDivideCeil(value: number, multiplier: number): number {
  const product = BigInt(value) * BigInt(multiplier);
  return Number((product + 9_999n) / 10_000n);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
