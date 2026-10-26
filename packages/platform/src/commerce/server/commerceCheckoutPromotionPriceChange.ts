import type { HttpResponse } from "../../http/index.js";
import type { BffResponder } from "../../bff/index.js";
import { CHECKOUT_CONTRACT_VERSION } from "../checkoutSchemas.js";
import type { CheckoutKind, ConfiguratorIntent as NeutralIntent } from "../contracts/index.js";
import type { CommerceQuotePort } from "../ports.js";
import type { PricingPolicySnapshot } from "../../pricing/index.js";
import type { CheckoutQuoteSnapshot } from "./checkoutQuoteTypes.js";
import { safeCommerceDiagnosticValue } from "./commerceDiagnostics.js";
export function createPromotionPriceChange<Intent extends NeutralIntent, Provisioned extends { clientId: string }, Request, Snapshot extends CheckoutQuoteSnapshot, Response>(bindings: {
  responder: BffResponder;
  buildQuoteRequest(intent: Intent, provisioned: Provisioned, policy?: PricingPolicySnapshot): Request;
  buildCheckoutPriceChangedResponse(input: { checkoutKind: CheckoutKind; expectedQuote: { totalGross: { amountMinor: number; currency: string } }; authoritativeQuote: Snapshot }): Response;
  respondQuoteFailure(res: HttpResponse, error: unknown): boolean;
}) {
  const { sendBffError, sendBffSuccess } = bindings.responder;

type PromotionPriceChangeInput = {
  res: HttpResponse;
  quotePort: CommerceQuotePort<Request, Snapshot, import("../../pricing/index.js").CreateQuoteOptions>;
  intent: Intent;
  provisioned: Provisioned;
  checkoutKind: CheckoutKind;
  expectedQuote?: {
    totalGross: { amountMinor: number; currency: string };
    pricingPolicy?: PricingPolicySnapshot;
  };
  resolvePricingPolicy?: (
    request: Request,
  ) => PricingPolicySnapshot | undefined | Promise<PricingPolicySnapshot | undefined>;
  acceptedQuoteSnapshot: Snapshot | null;
  recordQuote: <T>(operation: () => Promise<T>) => Promise<T>;
}

function rejectMissingPromotionExpectedQuote(input: {
  res: HttpResponse;
  enforced: boolean;
  intent: Intent;
  expectedQuote?: unknown;
}): boolean {
  if (!input.enforced || input.intent.promoCodes.length === 0 || input.expectedQuote) return false;
  sendBffError(input.res, "BAD_REQUEST", "Promotion checkout requires an expected quote", {
    details: { feature: "checkout", reason: "promotion_expected_quote_missing" },
  });
  return true;
}

async function respondToPromotionCodePriceChange(input: PromotionPriceChangeInput): Promise<boolean> {
  let authoritativeQuote: Snapshot;
  try {
    const quoteRequest = bindings.buildQuoteRequest(
      input.intent,
      input.provisioned,
      input.expectedQuote?.pricingPolicy,
    );
    const pricingPolicy = await input.resolvePricingPolicy?.(quoteRequest);
    const offerVersion = input.acceptedQuoteSnapshot?.quote.context?.offerVersion;
    authoritativeQuote = await input.recordQuote(() =>
      input.quotePort.createQuote(quoteRequest, {
        clientId: input.provisioned.clientId,
        ...(pricingPolicy ? { pricingPolicy } : {}),
        ...(offerVersion ? { offerVersion } : {}),
      }),
    );
  } catch (error) {
    if (bindings.respondQuoteFailure(input.res, error)) return true;
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
  sendBffSuccess(input.res, bindings.buildCheckoutPriceChangedResponse({
    checkoutKind: input.checkoutKind, expectedQuote, authoritativeQuote,
  }), { contractVersion: CHECKOUT_CONTRACT_VERSION });
  return true;
}

return { rejectMissingPromotionExpectedQuote, respondToPromotionCodePriceChange };
}
