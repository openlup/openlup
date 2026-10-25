import type { ConfiguratorIntent } from "./configuratorIntentContracts.js";
import type { CreateQuoteResponse } from "./contracts.js";
import { STARTER_MIN_CANS, starterTermsFromCoverage } from "./starterOfferPolicy.js";
import type { StarterTermsPort as CorePort, StarterTermsDecision } from "@openlup/platform/commerce/server";
export const STARTER_GRADUATION_CADENCE_DAYS = [14, 21, 28] as const;
export type StarterGraduationCadenceDays = (typeof STARTER_GRADUATION_CADENCE_DAYS)[number];
export type { StarterTermsDecision };
export type StarterTermsRefusal = "basket_too_small" | "basket_not_admitted" | "ration_unknown";
export type StarterTermsResolution = { kind: "terms"; terms: StarterTermsDecision } | { kind: "refused"; reason: StarterTermsRefusal };
export interface StarterTermsPort { resolve(input: { intent: ConfiguratorIntent; authoritativeQuote: CreateQuoteResponse; offerVersion?: string }): Promise<StarterTermsResolution> }
export function neutralStarterTermsPort(port: StarterTermsPort): CorePort<ConfiguratorIntent, CreateQuoteResponse> {
  return { async resolve(input) { const result = await port.resolve(input); if (result.kind === "terms") return result; return { kind: "refused", reason: result.reason === "ration_unknown" ? "demand_unknown" : result.reason }; } };
}
/**
 * The default arithmetic, in its original order: fewer units than
 * `STARTER_MIN_CANS` is `basket_too_small`, before any coverage is read; no
 * terms from the quote's feeding coverage is `ration_unknown`; otherwise the
 * policy's terms, with no size constraint of their own. The configurator asks
 * with the same function of the same two numbers, so a disagreement at checkout
 * means the ask drifted, never that two sides rounded differently.
 *
 * A thrown error is an infrastructure failure: it reaches the checkout
 * handler's failure path and the checkout fails closed.
 */
export const defaultStarterTermsPort: StarterTermsPort = {
  async resolve({ intent, authoritativeQuote }) {
    const units = intent.selectedVariants.reduce((total, variant) => total + variant.qty, 0);
    if (units < STARTER_MIN_CANS) return { kind: "refused", reason: "basket_too_small" };
    const terms = starterTermsFromCoverage(units, authoritativeQuote.quote.context?.feedingCoverageDays);
    if (terms === null) return { kind: "refused", reason: "ration_unknown" };
    return {
      kind: "terms",
      terms: {
        intervalDays: terms.intervalDays,
        steadyCadenceDays: terms.cadenceDays,
        steadyUnits: terms.steadyCans,
      },
    };
  },
};
