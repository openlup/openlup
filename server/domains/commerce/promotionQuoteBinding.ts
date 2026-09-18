import type {
  CommerceMoney,
  CommerceQuote,
  CommerceQuoteDiscount,
} from "../../../src/domains/commerce/types.js";

/**
 * The canonical money projection an acceptance token binds.
 *
 * ⛔ The token protects **what the customer pays**, never how it was presented
 * or which server-only evidence produced it. Everything outside this projection
 * is deliberately unbound: `label`, `reasonCode`, `customerSemantic`, `code`,
 * `promotionCodeRevision`, `promotionCodeScopes`, `promotionMinimumReferenceMinor`,
 * `promotionCodeValidTo`, `floorApplied`, `context`, `codeRejections`,
 * `codeRejectionDetails`, `pricingComponents` and `catalogFacts`. Those differ
 * legitimately between the two surfaces that share one token — the public quote
 * route signs the contract-parsed public projection while the checkout guard
 * verifies the raw server-authoritative quote, which carries `catalogFacts`
 * (with a per-request `atTime`) that the public projection strips — so binding
 * them turned every strict-path v2 code checkout into a permanent rejection.
 *
 * What stays bound is every amount and every discount identity: change a price,
 * a quantity, a tax split, shipping, a discount amount, which promotion granted
 * it, or what it applies to, and the token stops verifying.
 */
export interface PromotionQuoteMoneyLine {
  sku: string;
  quantity: number;
  unitPriceGross: CommerceMoney;
  lineSubtotalGross: CommerceMoney;
  tax: {
    vatRateBps: number;
    netAmount: CommerceMoney;
    vatAmount: CommerceMoney;
    grossAmount: CommerceMoney;
  };
}

export interface PromotionQuoteMoneyDiscount {
  promotionId: string;
  appliesTo: CommerceQuoteDiscount["appliesTo"];
  amountOffMinor: number;
  promotionCodeId: string | null;
  promotionDefinitionFingerprint: string | null;
  promotionBenefitKind: NonNullable<CommerceQuoteDiscount["promotionBenefitKind"]> | null;
  promotionBenefitValueBps: number | null;
  promotionBenefitValueMinor: number | null;
}

export interface PromotionQuoteMoneyProjection {
  currency: string;
  totalGross: CommerceMoney;
  netTotal: CommerceMoney;
  taxTotal: CommerceMoney;
  subtotalGross: CommerceMoney;
  discountTotalGross: CommerceMoney;
  shippingGross: CommerceMoney | null;
  shippingDiscountGross: CommerceMoney | null;
  lines: PromotionQuoteMoneyLine[];
  discounts: PromotionQuoteMoneyDiscount[];
}

/** The five sections the token hashes separately so a mismatch can name itself. */
export const PROMOTION_QUOTE_MONEY_SECTIONS = [
  "lines",
  "discounts",
  "shipping",
  "totals",
  "currency",
] as const;

export type PromotionQuoteMoneySection = (typeof PROMOTION_QUOTE_MONEY_SECTIONS)[number];

/** `other` is the honest answer for a token minted before section bindings existed. */
export const PROMOTION_QUOTE_MISMATCH_FIELDS = [
  ...PROMOTION_QUOTE_MONEY_SECTIONS,
  "other",
] as const;

export type PromotionQuoteMismatchField = (typeof PROMOTION_QUOTE_MISMATCH_FIELDS)[number];

/**
 * Discount order is preserved: the promotion engine emits its lanes
 * deterministically, so a reordering is a real evaluation difference.
 */
export function projectPromotionQuoteMoney(quote: CommerceQuote): PromotionQuoteMoneyProjection {
  return {
    currency: quote.currency,
    totalGross: quote.totalGross,
    netTotal: quote.netTotal,
    taxTotal: quote.taxTotal,
    subtotalGross: quote.subtotalGross,
    discountTotalGross: quote.discountTotalGross,
    shippingGross: quote.shippingGross ?? null,
    shippingDiscountGross: quote.shippingDiscountGross ?? null,
    lines: quote.lines.map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
      unitPriceGross: line.unitPriceGross,
      lineSubtotalGross: line.lineSubtotalGross,
      tax: {
        vatRateBps: line.tax.vatRateBps,
        netAmount: line.tax.netAmount,
        vatAmount: line.tax.vatAmount,
        grossAmount: line.tax.grossAmount,
      },
    })),
    discounts: quote.discounts.map((discount) => ({
      promotionId: discount.promotionId,
      appliesTo: discount.appliesTo,
      amountOffMinor: discount.amountOffMinor,
      promotionCodeId: discount.promotionCodeId ?? null,
      promotionDefinitionFingerprint: discount.promotionDefinitionFingerprint ?? null,
      promotionBenefitKind: discount.promotionBenefitKind ?? null,
      promotionBenefitValueBps: discount.promotionBenefitValueBps ?? null,
      promotionBenefitValueMinor: discount.promotionBenefitValueMinor ?? null,
    })),
  };
}

/** Same projection, partitioned. The union of these five sections is the whole projection. */
export function promotionQuoteMoneySections(
  quote: CommerceQuote,
): Record<PromotionQuoteMoneySection, unknown> {
  const money = projectPromotionQuoteMoney(quote);
  return {
    lines: money.lines,
    discounts: money.discounts,
    shipping: {
      shippingGross: money.shippingGross,
      shippingDiscountGross: money.shippingDiscountGross,
    },
    totals: {
      totalGross: money.totalGross,
      netTotal: money.netTotal,
      taxTotal: money.taxTotal,
      subtotalGross: money.subtotalGross,
      discountTotalGross: money.discountTotalGross,
    },
    currency: money.currency,
  };
}

/** Key-sorted, `undefined`-dropping JSON. Every acceptance binding hashes this shape. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
