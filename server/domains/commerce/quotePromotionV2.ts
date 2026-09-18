import { evaluatePromotionAdjustmentsV2, promoEligibilityFailure } from "../../../src/domains/promo/ports.js";
import type {
  PromoEvaluationCart,
  PromotionAdjustmentCandidate,
  PromotionRow,
} from "../../../src/domains/promo/types.js";
import type { CommerceCodeRejection, CommerceQuoteDiscount } from "../../../src/domains/commerce/types.js";
import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import type { CommercePromoDataPort } from "./promoDataPort.js";
import { resolvePromotionBenefitDefinition } from "./promotionBenefitDefinition.js";
import { evaluateOrderTotalDiscounts } from "./quotePromoDiscounts.js";
import { promotionCustomerSemantic } from "./promotionCustomerSemantic.js";
import { MINIMUM_PRODUCT_PAYABLE_MINOR } from "./promotionCodePreview.js";

type V2Row = PromotionRow & {
  promotion_engine_version?: unknown;
  benefit_lane?: unknown;
  benefit_kind?: unknown;
  benefit_value_bps?: unknown;
  benefit_value_minor?: unknown;
  v2_mirror_of?: unknown;
};

/** Automatic v2 acquisition benefits. Code claims intentionally remain PR4. */
export async function evaluateAutomaticPromotionV2(input: {
  promoDataPort: CommercePromoDataPort;
  clientId: string | null;
  visitorId?: string | null;
  mode: CreateQuoteRequest["mode"];
  /** Raw request spellings stay intact for legacy exact-literal evaluation. */
  promoCodes?: readonly string[];
  regionCode: string;
  referenceProductMinor: number;
  currentProductMinor: number;
  shippingMinor: number;
  atTime: string;
  emailEligibilityConfirmed?: boolean;
}): Promise<{ discounts: CommerceQuoteDiscount[]; codeRejections: CommerceCodeRejection[] }> {
  const byMode = input.clientId
    ? await input.promoDataPort.countPaidOrdersByMode(input.clientId)
    : { oneTime: 0, subscription: 0 };
  const [rows, counts, deviceRedeemed] = await Promise.all([
    input.promoDataPort.listActivePromotions(),
    input.promoDataPort.redemptionCounts(input.clientId),
    input.promoDataPort.deviceFirstOrderRedeemed(input.visitorId ?? null),
  ]);
  const cart: PromoEvaluationCart = {
    region_code: input.regionCode,
    cart_mode: input.mode === "subscription" ? "subscription" : "one_time",
    cart_subtotal_minor: input.currentProductMinor,
    shipping_amount_minor: input.shippingMinor,
    client_orders_count: byMode.oneTime + byMode.subscription,
    client_subscription_orders_count: byMode.subscription,
    client_onetime_orders_count: byMode.oneTime,
    device_first_order_redeemed: deviceRedeemed,
    email_eligibility_confirmed: input.emailEligibilityConfirmed === true,
    applied_codes: [],
  };

  const eligibleRows = (rows as V2Row[])
    .filter((row) => row.promotion_engine_version === "promotion-engine.v2")
    .filter((row) => row.trigger_type === "automatic")
    .filter((row) => promoEligibilityFailure(row, cart, input.atTime) === null)
    .filter((row) => {
      const familyId = typeof row.v2_mirror_of === "string" ? row.v2_mirror_of : row.id;
      const count = counts.get(familyId) ?? { global: 0, perCustomer: 0 };
      return (row.redemption_limit_global == null || count.global < row.redemption_limit_global) &&
        (!input.clientId || row.redemption_limit_per_customer == null || count.perCustomer < row.redemption_limit_per_customer);
    });
  const candidates = eligibleRows.map(toCandidate);

  const result = evaluatePromotionAdjustmentsV2({
    purchaseScope: input.mode === "subscription" ? "subscription_initial" : "one_time",
    referenceProductMinor: input.referenceProductMinor,
    currentProductMinor: input.currentProductMinor,
    shippingMinor: input.shippingMinor,
    minimumProductPayableMinor: MINIMUM_PRODUCT_PAYABLE_MINOR,
  }, candidates);
  const v2Discounts: CommerceQuoteDiscount[] = result.adjustments.map((adjustment) => {
    const source = eligibleRows.find((row) => row.id === adjustment.promotionId);
    const customerSemantic = source ? promotionCustomerSemantic(source) : undefined;
    return {
      promotionId: adjustment.promotionId,
      label: adjustment.name,
      appliesTo: adjustment.lane === "shipping" ? "shipping" : "order_total",
      amountOffMinor: adjustment.amountOffMinor,
      reasonCode: `promotion_v2:${adjustment.kind}`,
      ...(customerSemantic ? { customerSemantic } : {}),
    };
  });
  const legacyFloor = await evaluateOrderTotalDiscounts({
    promoDataPort: legacyPromotionDataPort(input.promoDataPort),
    clientId: input.clientId,
    visitorId: input.visitorId,
    mode: input.mode,
    promoCodes: [...(input.promoCodes ?? [])],
    regionCode: input.regionCode,
    subtotalGrossMinor: input.currentProductMinor,
    shippingGrossMinor: input.shippingMinor,
    atTime: input.atTime,
    emailEligibilityConfirmed: input.emailEligibilityConfirmed,
  });
  const discounts = withLegacyParityFloor(
    v2Discounts,
    reduceLegacyParityDiscounts(legacyFloor.discounts, input.promoCodes ?? []),
  );
  return {
    discounts,
    codeRejections: reconcileLegacyCodeOutcomes(input.promoCodes ?? [], discounts, legacyFloor),
  };
}

export function legacyPromotionDataPort(port: CommercePromoDataPort): CommercePromoDataPort {
  return {
    ...port,
    listActivePromotions: async () => (await port.listActivePromotions()).filter(
      (row) => (row as V2Row).promotion_engine_version !== "promotion-engine.v2",
    ),
  };
}

function toCandidate(row: V2Row): PromotionAdjustmentCandidate {
  const benefit = resolvePromotionBenefitDefinition(row);
  const base = {
    promotionId: row.id,
    name: row.name,
    source: "automatic" as const,
    scopes: ["one_time", "subscription_initial"] as const,
  };
  if (benefit.kind === "target_percentage") return { ...base, ...benefit };
  if (benefit.kind === "percentage") return { ...base, ...benefit };
  if (benefit.kind === "fixed_amount") return { ...base, ...benefit };
  if (benefit.kind === "free_shipping") return { ...base, ...benefit };
  throw new Error("promotion_v2_benefit_invalid");
}

function withLegacyParityFloor(
  v2: CommerceQuoteDiscount[],
  legacy: CommerceQuoteDiscount[],
): CommerceQuoteDiscount[] {
  return (["order_total", "shipping"] as const).flatMap((lane) => {
    const primary = v2.filter((item) => item.appliesTo === lane);
    const floor = legacy.filter((item) => item.appliesTo === lane);
    const primaryTotal = primary.reduce((sum, item) => sum + item.amountOffMinor, 0);
    const floorTotal = floor.reduce((sum, item) => sum + item.amountOffMinor, 0);
    if (floorTotal <= primaryTotal) return primary;
    return floor.map((item) => ({
      ...item,
      reasonCode: `promotion_v2:legacy_parity_floor:${item.reasonCode}`,
    }));
  });
}

/** Keep legacy's literal evaluation, then prevent one submitted identity from inflating its parity lane. */
function reduceLegacyParityDiscounts(
  discounts: readonly CommerceQuoteDiscount[],
  submittedCodes: readonly string[],
): CommerceQuoteDiscount[] {
  const firstSubmitted = new Map<string, string>();
  for (const code of submittedCodes) {
    const identity = normalizeCode(code);
    if (identity && !firstSubmitted.has(identity)) firstSubmitted.set(identity, code);
  }
  const chosen = new Map<string, { index: number; exact: boolean }>();
  for (const [index, discount] of discounts.entries()) {
    if (!discount.code) continue;
    const identity = normalizeCode(discount.code);
    const submitted = firstSubmitted.get(identity);
    if (!submitted) continue;
    const key = `${identity}:${discount.appliesTo}`;
    const exact = discount.code === submitted;
    const current = chosen.get(key);
    if (!current || (exact && !current.exact)) chosen.set(key, { index, exact });
  }
  return discounts.filter((discount, index) => !discount.code || !firstSubmitted.has(normalizeCode(discount.code)) ||
    chosen.get(`${normalizeCode(discount.code)}:${discount.appliesTo}`)?.index === index);
}

/**
 * The parity floor evaluates legacy codes before the automatic-v2 lane winner is
 * chosen. If that winner keeps equal-or-better money, turn a displaced applied
 * legacy code into the stable neutral outcome instead of letting it disappear.
 */
function reconcileLegacyCodeOutcomes(
  submittedCodes: readonly string[],
  discounts: readonly CommerceQuoteDiscount[],
  legacy: { discounts: readonly CommerceQuoteDiscount[]; codeRejections: readonly CommerceCodeRejection[] },
): CommerceCodeRejection[] {
  const applied = new Set(discounts.flatMap((discount) => discount.code ? [normalizeCode(discount.code)] : []));
  const legacyApplied = new Set(
    legacy.discounts.flatMap((discount) => discount.code ? [normalizeCode(discount.code)] : []),
  );
  const rejectionByCode = new Map<string, CommerceCodeRejection>();
  for (const rejection of legacy.codeRejections) {
    const identity = normalizeCode(rejection.code);
    if (!rejectionByCode.has(identity)) rejectionByCode.set(identity, rejection);
  }

  const outcomes: CommerceCodeRejection[] = [];
  const seen = new Set<string>();
  for (const code of submittedCodes) {
    const identity = normalizeCode(code);
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (applied.has(identity)) continue;
    const legacyRejection = rejectionByCode.get(identity);
    if (legacyRejection) {
      outcomes.push({ ...legacyRejection, code });
    } else if (legacyApplied.has(identity)) {
      outcomes.push({ code, reason: "better_price_exists" });
    }
  }
  return outcomes;
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}
