import { z } from "zod";
import type { SizedAgreedLine, SizedQuoteLine, SizedQuoteRequest, SizedRecurringQuote } from "./contracts/sizedEdit.js";

const money = z.object({ currency: z.string().regex(/^[A-Z]{3}$/u), amountMinor: z.number().int().nonnegative() });
const quoteLineSchema = z.object({ sku: z.string().min(1), productSlug: z.string().min(1), quantity: z.number().int().positive(),
  unitPriceGross: money, lineSubtotalGross: money, tax: z.object({ included: z.literal(true), country: z.string().regex(/^[A-Z]{2}$/u),
    category: z.string().min(1), vatRateBps: z.number().int().nonnegative(), legalBasis: z.string().min(1), netAmount: money, vatAmount: money, grossAmount: money }),
  pricingComponents: z.array(z.object({ scope: z.enum(["line", "order"]), componentType: z.enum(["base_unit", "mode_discount", "qty_tier", "promo", "loyalty", "shipping", "bundle"]), amountMinor: z.number().int(), reasonCode: z.string().min(1), reasonPayload: z.record(z.string(), z.unknown()) })).optional(),
}).refine(line => line.unitPriceGross.amountMinor * line.quantity === line.lineSubtotalGross.amountMinor &&
  line.lineSubtotalGross.amountMinor === line.tax.grossAmount.amountMinor && line.tax.netAmount.amountMinor + line.tax.vatAmount.amountMinor === line.tax.grossAmount.amountMinor &&
  [line.unitPriceGross, line.tax.netAmount, line.tax.vatAmount, line.tax.grossAmount].every(value => value.currency === line.lineSubtotalGross.currency));
/** Validation never replaces the retained object: every agreed byte survives. */
export function assertAgreedQuoteLine(value: unknown): asserts value is SizedQuoteLine & Record<string, unknown> {
  if (!quoteLineSchema.safeParse(value).success) throw new Error("subscription_reprice_sized_agreed_price_unreadable");
}
export function splitBySubscriptionAgreement(request: SizedQuoteRequest, agreed: readonly Pick<SizedAgreedLine, "sku" | "qty" | "isAddon" | "quoteLine">[]) {
  const used = new Set<number>();
  const unchanged: { index: number; quoteLine: SizedQuoteLine }[] = [];
  const changed: { index: number; line: SizedQuoteRequest["lines"][number] }[] = [];
  request.lines.forEach((line, index) => {
    const found = agreed.findIndex((prior, position) => !used.has(position) && prior.sku === line.sku &&
      prior.qty === line.quantity && prior.isAddon === (line.isAddon ?? false));
    if (found < 0) changed.push({ index, line });
    else { used.add(found); unchanged.push({ index, quoteLine: agreed[found].quoteLine }); }
  });
  return { unchanged, changed };
}
export function agreedSubscriptionTotal(lines: readonly Pick<SizedAgreedLine, "sku" | "qty" | "quoteLine">[]) {
  if (!lines.length) throw new Error("subscription_reprice_sized_agreed_price_unreadable");
  const currency = lines[0].quoteLine.lineSubtotalGross.currency;
  let amountMinor = 0;
  for (const line of lines) {
    assertAgreedQuoteLine(line.quoteLine);
    if (line.quoteLine.sku !== line.sku || line.quoteLine.quantity !== line.qty || line.quoteLine.lineSubtotalGross.currency !== currency) {
      throw new Error("subscription_reprice_sized_agreed_price_unreadable");
    }
    amountMinor += line.quoteLine.lineSubtotalGross.amountMinor;
  }
  if (!Number.isSafeInteger(amountMinor)) throw new Error("subscription_reprice_sized_agreed_price_unreadable");
  return { amountMinor, currency };
}
export function mergeSubscriptionAgreedQuote(input: { request: SizedQuoteRequest; currency: string;
  unchanged: ReturnType<typeof splitBySubscriptionAgreement>["unchanged"]; changedQuote: SizedRecurringQuote | null }): SizedRecurringQuote {
  const changed = input.changedQuote;
  if (changed && (changed.discounts.length || changed.discountTotalGross.amountMinor !== 0 ||
    (changed.shippingGross?.amountMinor ?? 0) !== 0 || (changed.shippingDiscountGross?.amountMinor ?? 0) !== 0)) {
    throw new Error("subscription_reprice_sized_quote_has_adjustments");
  }
  const saved = new Map(input.unchanged.map(line => [line.index, line.quoteLine]));
  if ((changed?.lines.length ?? 0) !== input.request.lines.length - saved.size) throw new Error("subscription_reprice_line_count_mismatch");
  let cursor = 0;
  const lines = input.request.lines.map((line, index) => {
    const next = saved.get(index) ?? changed?.lines[cursor++];
    if (!next || next.sku !== line.sku || next.quantity !== line.quantity) throw new Error("subscription_reprice_sized_quote_line_mismatch");
    assertAgreedQuoteLine(next); return next;
  });
  const money = (amountMinor: number) => ({ amountMinor, currency: input.currency });
  const sum = (field: "netAmount" | "vatAmount") => lines.reduce((total, line) => total + line.tax[field].amountMinor, 0);
  const total = money(lines.reduce((value, line) => value + line.lineSubtotalGross.amountMinor, 0));
  const quote: SizedRecurringQuote = { currency: input.currency, taxIncluded: true, lines, discounts: [],
    pricingComponents: lines.flatMap(line => line.pricingComponents ?? []),
    context: changed?.context ?? { mode: "subscription", cadenceDays: input.request.cadenceDays, promoCodes: [] },
    subtotalGross: total, discountTotalGross: money(0), totalGross: total, netTotal: money(sum("netAmount")), taxTotal: money(sum("vatAmount")) };
  if (!Number.isSafeInteger(total.amountMinor) || lines.some(line => line.unitPriceGross.currency !== input.currency || line.tax.vatRateBps !== lines[0].tax.vatRateBps)) throw new Error("subscription_reprice_sized_agreed_price_unreadable");
  return quote;
}
