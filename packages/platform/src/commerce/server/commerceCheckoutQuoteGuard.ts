import type { z } from "zod";
import { acquisitionExpectationChanged, projectPublicQuoteSnapshot, type PricingPolicySnapshot, type ResolvedAcquisitionTerms } from "../../pricing/index.js";
import { hasShippingTerms } from "../../shipping/index.js";
import { CHECKOUT_CONTRACT_VERSION } from "../checkoutSchemas.js";
import type { CheckoutKind, ConfiguratorIntent as NeutralIntent } from "../contracts/index.js";
import type { CommerceQuotePort } from "../ports.js";
import { resolveCheckoutOffer, withCheckoutOfferContext, type CheckoutOfferPolicyPort } from "./checkoutOfferPolicyPort.js";
import type { CheckoutQuoteSnapshot, ExpectedCheckoutQuote } from "./checkoutQuoteTypes.js";
import type { StarterOfferGuardResult } from "./commerceStarterOfferGuard.js";
export type CheckoutQuoteGuardResult<Snapshot, Response> = { kind: "accepted"; quoteSnapshot: Snapshot } | { kind: "price_changed"; response: Response; starterOfferRejection?: string };
export function createCheckoutQuoteGuard<Intent extends NeutralIntent, Provisioned extends { clientId: string }, Request, Snapshot extends CheckoutQuoteSnapshot, Response, Terms, Plan>(bindings: {
  buildQuoteRequest(intent: Intent, provisioned: Provisioned, policy?: PricingPolicySnapshot): Request;
  responseSchema: z.ZodType<Response>;
  resolveStarterOfferGuard(input: { flagEnabled: boolean; intent: Intent; provisioned: Provisioned; authoritativeQuote: Snapshot; quotePort: CommerceQuotePort<Request, Snapshot, import("../../pricing/index.js").CreateQuoteOptions>; isFirstOrderEligible?: () => Promise<boolean>; termsPort?: Terms; offerVersion?: string }): Promise<StarterOfferGuardResult<Plan>>;
  withStarterPackContext(snapshot: Snapshot, plan: Plan | null): Snapshot;
}) {
  type ConfiguratorIntent = Intent;
  type ConfiguratorIntentPersistenceResponse = Provisioned;
  type CreateQuoteResponse = Snapshot;
  type ExpectedQuoteTotal = ExpectedCheckoutQuote;
async function resolveCheckoutQuoteGuard(input: {
  quotePort: CommerceQuotePort<Request, Snapshot, import("../../pricing/index.js").CreateQuoteOptions>;
  intent: ConfiguratorIntent;
  provisioned: ConfiguratorIntentPersistenceResponse;
  checkoutKind: CheckoutKind;
  expectedQuote?: ExpectedQuoteTotal;
  recordQuoteStage: <T>(operation: () => Promise<T>) => Promise<T>;
  resolvePricingPolicy?: (
    request: Request,
  ) => PricingPolicySnapshot | undefined | Promise<PricingPolicySnapshot | undefined>;
    pricingEligibilityClientId?: string | null;
  verifyPromotionAcceptance?: (input: {
    token: string;
    request: Request;
    quote: CreateQuoteResponse["quote"];
    expectedTotal: ExpectedQuoteTotal["totalGross"];
  }) => boolean;
  promotionAcceptanceToken?: string;
    offerPolicy?: CheckoutOfferPolicyPort<Intent, Snapshot["quote"]>;
    starterPackEnabled?: () => boolean;
  isFirstOrderEligible?: () => Promise<boolean>;
    starterTermsPort?: Terms;
}): Promise<CheckoutQuoteGuardResult<Snapshot, Response>> {
  const { quotePort, intent, provisioned, checkoutKind, expectedQuote, recordQuoteStage } = input;
  const offer = await resolveCheckoutOffer(input.offerPolicy, intent, checkoutKind);
  const quoteRequest = bindings.buildQuoteRequest(intent, provisioned, expectedQuote?.pricingPolicy);
  const pricingPolicy = await input.resolvePricingPolicy?.(quoteRequest);
  const pricingClientId = input.pricingEligibilityClientId ?? provisioned.clientId;
  const authoritativeQuote = await recordQuoteStage(() =>
    quotePort.createServerAuthoritativeQuote
      ? quotePort.createServerAuthoritativeQuote(quoteRequest, {
        clientId: pricingClientId,
        ...(pricingPolicy ? { pricingPolicy } : {}),
        ...(offer ? { offerVersion: offer.offerVersion } : {}),
      })
      : quotePort.createQuote(quoteRequest, {
        clientId: pricingClientId,
        ...(pricingPolicy ? { pricingPolicy } : {}),
        ...(offer ? { offerVersion: offer.offerVersion } : {}),
      }),
  );
  console.info(
    "checkout_promo_eligibility_context",
    JSON.stringify({ promoEligibilityContext: "resolved_client" }),
  );
  const hasCurrentV2Promotion = authoritativeQuote.quote.discounts.some((discount) =>
    discount.promotionEngineVersion === "promotion-engine.v2");
  const requiresPromotionAcceptance = Boolean(input.promotionAcceptanceToken) || hasCurrentV2Promotion
    || hasShippingTerms(authoritativeQuote.quote)
    || authoritativeQuote.quote.context?.acquisitionTerms !== undefined;
  const promotionAcceptanceValid = !requiresPromotionAcceptance || Boolean(
    expectedQuote && input.promotionAcceptanceToken && input.verifyPromotionAcceptance?.({
      token: input.promotionAcceptanceToken,
      request: quoteRequest,
      quote: authoritativeQuote.quote,
      expectedTotal: expectedQuote.totalGross,
    }),
  );
  const priceAccepted = promotionAcceptanceValid
    && (!expectedQuote || !quoteTotalChanged(expectedQuote, authoritativeQuote));
  // The starter guard runs only once the price itself is accepted: a moved total
  // is already a rejection, and re-quoting a steady package for a basket that is
  // about to be refused would be pure waste.
  const starter: StarterOfferGuardResult<Plan> = priceAccepted
    ? await bindings.resolveStarterOfferGuard({
      flagEnabled: input.starterPackEnabled?.() ?? false,
      intent,
      provisioned,
      authoritativeQuote,
      quotePort,
      isFirstOrderEligible: input.isFirstOrderEligible,
      termsPort: input.starterTermsPort,
      offerVersion: offer?.offerVersion,
    })
    : { kind: "absent" };
  if (priceAccepted && starter.kind !== "rejected") {
    const persisted = withoutPricingPolicyToken(authoritativeQuote);
    return {
      kind: "accepted",
      quoteSnapshot: await withCheckoutOfferContext(offer, intent, bindings.withStarterPackContext(
        persisted,
        starter.kind === "minted" ? starter.plan : null,
      )),
    };
  }
  return {
    kind: "price_changed",
    ...(starter.kind === "rejected" ? { starterOfferRejection: starter.reason } : {}),
    response: buildCheckoutPriceChangedResponse({
      checkoutKind,
      expectedQuote: expectedQuote ?? { totalGross: authoritativeQuote.quote.totalGross },
      authoritativeQuote,
    }),
  };
}

function withoutPricingPolicyToken(snapshot: CreateQuoteResponse): CreateQuoteResponse {
  const policy = snapshot.quote.context?.pricingPolicy;
  if (!policy?.pricingPolicyToken) return snapshot;
  const { pricingPolicyToken: _token, ...persistedPolicy } = policy;
  return {
    ...snapshot,
    quote: {
      ...snapshot.quote,
      context: { ...snapshot.quote.context!, pricingPolicy: persistedPolicy },
    },
  };
}

function buildCheckoutPriceChangedResponse(input: {
  checkoutKind: CheckoutKind;
  expectedQuote: ExpectedQuoteTotal;
  authoritativeQuote: CreateQuoteResponse;
}): Response {
  return bindings.responseSchema.parse({
    contractVersion: CHECKOUT_CONTRACT_VERSION,
    checkoutKind: input.checkoutKind,
    status: "price_changed",
    priceChanged: true,
    expectedQuote: { totalGross: input.expectedQuote.totalGross },
    authoritativeQuote: projectPublicQuoteSnapshot(input.authoritativeQuote),
  });
}

function quoteTotalChanged(
  expectedQuote: ExpectedQuoteTotal | undefined,
  authoritativeQuote: {
    quote: {
      totalGross: { amountMinor: number; currency: string };
      context?: { pricingPolicy?: PricingPolicySnapshot; acquisitionTerms?: ResolvedAcquisitionTerms };
    };
  },
): boolean {
  if (!expectedQuote) return false;
  const actualPolicy = authoritativeQuote.quote.context?.pricingPolicy;
  const expectedPolicy = expectedQuote.pricingPolicy;
  const historicalUnboundV1 = expectedPolicy?.offerPolicyVersion === "commerce.offer-policy.v1"
    && expectedPolicy.promotionEngineVersion === "promotion-engine.v1"
    && !expectedPolicy.pricingPolicyToken;
  return (
    acquisitionExpectationChanged(expectedQuote.acquisitionTerms, authoritativeQuote.quote.context?.acquisitionTerms) ||
    expectedQuote.totalGross.amountMinor !== authoritativeQuote.quote.totalGross.amountMinor ||
    expectedQuote.totalGross.currency !== authoritativeQuote.quote.totalGross.currency ||
    (expectedPolicy != null && !historicalUnboundV1 && (
      expectedPolicy.offerPolicyVersion !== actualPolicy?.offerPolicyVersion ||
      expectedPolicy.promotionEngineVersion !== actualPolicy?.promotionEngineVersion
    ))
  );
}

return { resolveCheckoutQuoteGuard, buildCheckoutPriceChangedResponse };
}
