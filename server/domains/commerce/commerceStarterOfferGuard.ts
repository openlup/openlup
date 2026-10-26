import { createStarterOfferGuard, withStarterPackContext } from "@openlup/platform/commerce/server";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { CreateQuoteResponse, CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import { starterPackPlanSchema, type StarterPackPlan } from "../../../src/domains/commerce/starterOfferContracts.js";
import { STARTER_DELIVERY2_DISCOUNT_BPS, starterAggregateBySku, starterDelivery2DiscountMinor, starterRescaleBasket } from "../../../src/domains/commerce/starterOfferPolicy.js";
import { defaultStarterTermsPort, neutralStarterTermsPort, type StarterTermsPort } from "../../../src/domains/commerce/starterTermsPort.js";
import { buildQuoteRequest } from "./commerceCheckoutOrchestrationHelpers.js";
const core = createStarterOfferGuard<ConfiguratorIntent, { clientId: string | null; petId: string | null }, CreateQuoteRequest, CreateQuoteResponse, StarterPackPlan>({
  declaration: (intent: ConfiguratorIntent) => intent.starterOffer ? { ...intent.starterOffer, steady: { cadenceDays: intent.starterOffer.steady.cadenceDays, units: intent.starterOffer.steady.cans } } : undefined,
  defaultTermsPort: neutralStarterTermsPort(defaultStarterTermsPort), defaultDiscountBps: STARTER_DELIVERY2_DISCOUNT_BPS,
  discountMinor: starterDelivery2DiscountMinor, planSchema: starterPackPlanSchema,
  aggregateBySku: starterAggregateBySku<ConfiguratorIntent["selectedVariants"][number]>,
  rescaleBasket: starterRescaleBasket<ConfiguratorIntent["selectedVariants"][number]>,
  steadyIntent: (intent, cadenceDays, units, variants) => ({ ...intent, cadenceDays, promoCodes: [], sizeConstraint: { ...intent.sizeConstraint, kind: "unit_count", value: units }, selectedVariants: variants }),
  buildQuoteRequest,
});
export type StarterOfferGuardInput = Omit<Parameters<typeof core.resolveStarterOfferGuard>[0], "termsPort"> & { termsPort?: StarterTermsPort };
export async function resolveStarterOfferGuard(input: StarterOfferGuardInput) {
  const result = await core.resolveStarterOfferGuard({ ...input, termsPort: input.termsPort ? neutralStarterTermsPort(input.termsPort) : undefined });
  return result.kind === "rejected" && result.reason === "starter_offer_demand_unknown" ? { ...result, reason: "starter_offer_ration_unknown" } : result;
}
export type StarterOfferGuardResult = Awaited<ReturnType<typeof resolveStarterOfferGuard>>;
export type StarterOfferRejectionReason = Extract<StarterOfferGuardResult, { kind: "rejected" }>["reason"];
export { withStarterPackContext };
