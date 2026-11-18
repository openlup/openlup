import { z } from "zod";
import type { CreateQuoteRequest } from "./contracts/quote.js";
import { CommerceQuoteError } from "./quotePorts.js";

const offerPricingSchema = z.object({
  priceReference: z.string().trim().min(1).max(120),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  lines: z.array(z.object({
    sku: z.string().min(1),
    quantity: z.number().int().positive(),
    unitGrossMinor: z.number().int().positive(),
  }).strict()).min(1).readonly(),
}).strict();

/** Exact, uniform per-unit allocations for an entire authorized one-time offer. */
export interface OneTimeOfferPricing {
  priceReference: string;
  currency: string;
  lines: ReadonlyArray<{ sku: string; quantity: number; unitGrossMinor: number }>;
}

export function resolveOneTimeOfferPricing(
  input: OneTimeOfferPricing | undefined, request: CreateQuoteRequest, currency: string, useStrictCatalog: boolean,
) {
  if (input === undefined) return undefined;
  const parsed = offerPricingSchema.safeParse(input);
  if (!parsed.success || !useStrictCatalog || parsed.data.currency !== currency || request.mode !== "one_time") {
    throw invalidOfferPricing();
  }
  const bySku = new Map(parsed.data.lines.map((line) => [line.sku, line]));
  if (bySku.size !== parsed.data.lines.length || bySku.size !== request.lines.length
    || new Set(request.lines.map((line) => line.sku)).size !== request.lines.length) {
    throw invalidOfferPricing();
  }

  for (const line of request.lines) {
    if (bySku.get(line.sku)?.quantity !== line.quantity || line.modeAtLine === "subscription") {
      throw invalidOfferPricing();
    }
  }
  const gross = parsed.data.lines.reduce((sum, line) => sum + line.quantity * line.unitGrossMinor, 0);
  if (!Number.isSafeInteger(gross)) throw invalidOfferPricing();
  return { priceReference: parsed.data.priceReference, bySku };
}

export function invalidOfferPricing() {
  return new CommerceQuoteError("PRICING_INVARIANT_VIOLATION", "Invalid one-time offer pricing");
}
