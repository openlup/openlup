import type { VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess } from "../../_lib/bff/response.js";
import { CHECKOUT_CONTRACT_VERSION, type CheckoutKind } from "../../../src/domains/commerce/checkoutContracts.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type { CommerceQuotePort } from "../../../src/domains/commerce/ports.js";
import type { PricingPolicySnapshot } from "../../../src/domains/commerce/offerPolicyContracts.js";
import { safeCommerceDiagnosticValue } from "./commerceDiagnostics.js";
import { buildCheckoutPriceChangedResponse } from "./commerceCheckoutQuoteGuard.js";
import { buildQuoteRequest } from "./commerceCheckoutOrchestrationHelpers.js";

interface PromotionPriceChangeInput {
  res: VercelResponse;
  quotePort: CommerceQuotePort;
  intent: ConfiguratorIntent;
  provisioned: { clientId: string; petId: string; addressId: string };
  checkoutKind: CheckoutKind;
  expectedQuote?: {
    totalGross: { amountMinor: number; currency: string };
    pricingPolicy?: PricingPolicySnapshot;
  };
  resolvePricingPolicy?: (
    request: ReturnType<typeof buildQuoteRequest>,
  ) => PricingPolicySnapshot | undefined | Promise<PricingPolicySnapshot | undefined>;
  acceptedQuoteSnapshot: CreateQuoteResponse | null;
  recordQuote: <T>(operation: () => Promise<T>) => Promise<T>;
}

export function rejectMissingPromotionExpectedQuote(input: {
  res: VercelResponse;
  enforced: boolean;
  intent: ConfiguratorIntent;
  expectedQuote?: unknown;
}): boolean {
  if (!input.enforced || input.intent.promoCodes.length === 0 || input.expectedQuote) return false;
  sendBffError(input.res, "BAD_REQUEST", "Promotion checkout requires an expected quote", {
    details: { feature: "checkout", reason: "promotion_expected_quote_missing" },
  });
  return true;
}

export async function respondToPromotionCodePriceChange(input: PromotionPriceChangeInput): Promise<boolean> {
  let authoritativeQuote: CreateQuoteResponse;
  try {
    const quoteRequest = buildQuoteRequest(
      input.intent,
      input.provisioned,
      input.expectedQuote?.pricingPolicy,
    );
    const pricingPolicy = await input.resolvePricingPolicy?.(quoteRequest);
    authoritativeQuote = await input.recordQuote(() =>
      input.quotePort.createQuote(quoteRequest, {
        clientId: input.provisioned.clientId,
        ...(pricingPolicy ? { pricingPolicy } : {}),
      }),
    );
  } catch (error) {
    console.error("checkout_promotion_price_changed_requote_failed",
      safeCommerceDiagnosticValue(error instanceof Error ? error.message : String(error)));
    sendBffError(input.res, "UPSTREAM_UNAVAILABLE", "Checkout failed", {
      details: { feature: "checkout", stage: "quote" },
    });
    return false;
  }
  const expectedQuote = input.expectedQuote ?? {
    totalGross: input.acceptedQuoteSnapshot?.quote.totalGross ?? authoritativeQuote.quote.totalGross,
  };
  sendBffSuccess(input.res, buildCheckoutPriceChangedResponse({
    checkoutKind: input.checkoutKind, expectedQuote, authoritativeQuote,
  }), { contractVersion: CHECKOUT_CONTRACT_VERSION });
  return true;
}
