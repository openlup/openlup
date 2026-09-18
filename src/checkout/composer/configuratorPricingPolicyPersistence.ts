import {
  pricingPolicySnapshotSchema,
  type PricingPolicySnapshot,
} from "@/domains/commerce/offerPolicyContracts";
import { platformCurrencySchema, type PlatformCurrency } from "@/lib/currency/platformCurrency";
import { z } from "@/lib/validation/zod.js";

export interface CheckoutQuoteExpectation {
  totalGross: { amountMinor: number; currency: PlatformCurrency };
  pricingPolicy?: PricingPolicySnapshot;
  promotionAcceptanceToken?: string;
}

const persistedPromotionQuoteExpectationSchema = z.object({
  totalGross: z.object({
    amountMinor: z.number().int().nonnegative(),
    currency: platformCurrencySchema,
  }).strict(),
  pricingPolicy: pricingPolicySnapshotSchema.optional(),
  promotionAcceptanceToken: z.string().min(1).max(8_300),
}).strict();

export function isPersistedPricingPolicyAssignment(value: unknown): boolean {
  if (value == null) return true;
  const parsed = pricingPolicySnapshotSchema.safeParse(value);
  return parsed.success && Boolean(parsed.data.pricingPolicyToken);
}

/** Only signed, server-verifiable promotion expectations survive a draft reload. */
export function isPersistedPromotionQuoteExpectation(
  value: unknown,
): value is CheckoutQuoteExpectation & { promotionAcceptanceToken: string } {
  return persistedPromotionQuoteExpectationSchema.safeParse(value).success;
}

export type { PricingPolicySnapshot };
