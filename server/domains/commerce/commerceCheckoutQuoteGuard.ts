import {
  CHECKOUT_CONTRACT_VERSION,
  checkoutResponseSchema,
  type CheckoutKind,
  type CheckoutResponse,
} from "../../../src/domains/commerce/checkoutContracts.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { ConfiguratorIntentPersistenceResponse } from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type { CommerceQuotePort } from "../../../src/domains/commerce/ports.js";
import { projectPublicQuoteSnapshot } from "./catalogFactsProvenance.js";
import { buildQuoteRequest } from "./commerceCheckoutOrchestrationHelpers.js";
import type { PricingPolicySnapshot } from "../../../src/domains/commerce/offerPolicyContracts.js";
import {
  resolveStarterOfferGuard,
  withStarterPackContext,
  type StarterOfferGuardResult,
} from "./commerceStarterOfferGuard.js";

type ExpectedQuoteTotal = {
  totalGross: { amountMinor: number; currency: string };
  pricingPolicy?: PricingPolicySnapshot;
};
export type PriceChangedResponse = Extract<CheckoutResponse, { status: "price_changed" }>;

export type CheckoutQuoteGuardResult =
  | { kind: "accepted"; quoteSnapshot: CreateQuoteResponse }
  | { kind: "price_changed"; response: PriceChangedResponse; starterOfferRejection?: string };

export async function resolveCheckoutQuoteGuard(input: {
  quotePort: CommerceQuotePort;
  intent: ConfiguratorIntent;
  provisioned: ConfiguratorIntentPersistenceResponse;
  checkoutKind: CheckoutKind;
  expectedQuote?: ExpectedQuoteTotal;
  recordQuoteStage: <T>(operation: () => Promise<T>) => Promise<T>;
  resolvePricingPolicy?: (
    request: ReturnType<typeof buildQuoteRequest>,
  ) => PricingPolicySnapshot | undefined | Promise<PricingPolicySnapshot | undefined>;
  /**
   * Customer selected from the submitted email before persistence. This may
   * differ from the exact-email client created for a new `+tag` alias and is
   * used only for promotion history while order identity stays provisioned.
   */
  pricingEligibilityClientId?: string | null;
  verifyPromotionAcceptance?: (input: {
    token: string;
    request: ReturnType<typeof buildQuoteRequest>;
    quote: CreateQuoteResponse["quote"];
    expectedTotal: ExpectedQuoteTotal["totalGross"];
  }) => boolean;
  promotionAcceptanceToken?: string;
  /**
   * Starter-pack acquisition lane. Omitted (or flag off with nothing declared)
   * leaves this guard's output byte-identical to the pre-starter contract.
   */
  starterPackEnabled?: () => boolean;
  isFirstOrderEligible?: () => Promise<boolean>;
}): Promise<CheckoutQuoteGuardResult> {
  const { quotePort, intent, provisioned, checkoutKind, expectedQuote, recordQuoteStage } = input;
  const quoteRequest = buildQuoteRequest(intent, provisioned, expectedQuote?.pricingPolicy);
  const pricingPolicy = await input.resolvePricingPolicy?.(quoteRequest);
  const pricingClientId = input.pricingEligibilityClientId ?? provisioned.clientId;
  const authoritativeQuote = await recordQuoteStage(() =>
    quotePort.createServerAuthoritativeQuote
      ? quotePort.createServerAuthoritativeQuote(quoteRequest, {
        clientId: pricingClientId,
        ...(pricingPolicy ? { pricingPolicy } : {}),
      })
      : quotePort.createQuote(quoteRequest, {
        clientId: pricingClientId,
        ...(pricingPolicy ? { pricingPolicy } : {}),
      }),
  );
  console.info(
    "checkout_promo_eligibility_context",
    JSON.stringify({ promoEligibilityContext: "resolved_client" }),
  );
  const hasCurrentV2Promotion = authoritativeQuote.quote.discounts.some((discount) =>
    discount.promotionEngineVersion === "promotion-engine.v2");
  const requiresPromotionAcceptance = Boolean(input.promotionAcceptanceToken) || hasCurrentV2Promotion;
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
  const starter: StarterOfferGuardResult = priceAccepted
    ? await resolveStarterOfferGuard({
      flagEnabled: input.starterPackEnabled?.() ?? false,
      intent,
      provisioned,
      authoritativeQuote,
      quotePort,
      isFirstOrderEligible: input.isFirstOrderEligible,
    })
    : { kind: "absent" };
  if (priceAccepted && starter.kind !== "rejected") {
    const persisted = withoutPricingPolicyToken(authoritativeQuote);
    return {
      kind: "accepted",
      quoteSnapshot: withStarterPackContext(
        persisted,
        starter.kind === "minted" ? starter.plan : null,
      ),
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

export function buildCheckoutPriceChangedResponse(input: {
  checkoutKind: CheckoutKind;
  expectedQuote: ExpectedQuoteTotal;
  authoritativeQuote: CreateQuoteResponse;
}): PriceChangedResponse {
  return checkoutResponseSchema.parse({
    contractVersion: CHECKOUT_CONTRACT_VERSION,
    checkoutKind: input.checkoutKind,
    status: "price_changed",
    priceChanged: true,
    expectedQuote: { totalGross: input.expectedQuote.totalGross },
    authoritativeQuote: projectPublicQuoteSnapshot(input.authoritativeQuote),
  }) as PriceChangedResponse;
}

function quoteTotalChanged(
  expectedQuote: ExpectedQuoteTotal | undefined,
  authoritativeQuote: {
    quote: {
      totalGross: { amountMinor: number; currency: string };
      context?: { pricingPolicy?: PricingPolicySnapshot };
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
    expectedQuote.totalGross.amountMinor !== authoritativeQuote.quote.totalGross.amountMinor ||
    expectedQuote.totalGross.currency !== authoritativeQuote.quote.totalGross.currency ||
    (expectedPolicy != null && !historicalUnboundV1 && (
      expectedPolicy.offerPolicyVersion !== actualPolicy?.offerPolicyVersion ||
      expectedPolicy.promotionEngineVersion !== actualPolicy?.promotionEngineVersion
    ))
  );
}
