import { z } from "@/lib/validation/zod.js";

import type { PublicCreateQuoteRequest } from "@/domains/commerce/contracts";
import { OFFER_POLICY_V2_CAPABILITY } from "@/domains/commerce/offerPolicyContracts";
import type { CommerceRecommendationSnapshot } from "@/domains/commerce/recommendationContracts";
import { offerPolicyV2CapabilityEnabled } from "@/lib/flags";

import { isCheckoutableRecommendation } from "./recommendationGate";
import { getOrCreateVisitorId } from "./visitorId";

const quoteEligibilityEmailSchema = z.string().trim().toLowerCase().email().max(320);

export interface LiveQuoteInput {
  snapshot: CommerceRecommendationSnapshot | null;
  subscription: boolean;
  lengthDays: number;
  promoCodes: string[];
  customerEmail?: string | null;
  pricingPolicyToken?: string | null;
  promotionAcceptanceToken?: string | null;
  enabled?: boolean;
}

export function buildQuoteRequest(input: LiveQuoteInput): PublicCreateQuoteRequest | null {
  const {
    snapshot, subscription, lengthDays, promoCodes, customerEmail,
    pricingPolicyToken, promotionAcceptanceToken,
  } = input;
  if (!isCheckoutableRecommendation(snapshot) || !snapshot.dailyKcal) return null;

  const mode = subscription ? "subscription" : "one_time";
  // Coverage is informational; quote cadence is the explicit 14/21/28 choice.
  const cadenceDays = subscription ? lengthDays : null;
  const normalizedEmail = normalizeQuoteEligibilityEmail(customerEmail);
  return {
    mode,
    cadenceDays,
    sizeConstraint: {
      kind: "unit_count",
      value: snapshot.lines.reduce((sum, line) => sum + line.qty, 0),
    },
    petProfileContext: { dailyKcalOverride: snapshot.dailyKcal },
    promoCodes,
    lines: snapshot.lines.map((line) => ({
      sku: line.sku,
      quantity: line.qty,
      variantId: line.variantId,
      modeAtLine: mode,
    })),
    visitorId: getOrCreateVisitorId(),
    ...(pricingPolicyToken
      ? { pricingPolicy: { capability: OFFER_POLICY_V2_CAPABILITY, token: pricingPolicyToken } }
      : offerPolicyV2CapabilityEnabled()
        ? { pricingPolicy: { capability: OFFER_POLICY_V2_CAPABILITY } }
        : {}),
    ...(promotionAcceptanceToken ? { promotionAcceptanceToken } : {}),
    ...(normalizedEmail ? { customerEligibilityContext: { email: normalizedEmail } } : {}),
  };
}

export function normalizeQuoteEligibilityEmail(email: string | null | undefined): string | null {
  const parsed = quoteEligibilityEmailSchema.safeParse(email ?? "");
  return parsed.success ? parsed.data : null;
}
