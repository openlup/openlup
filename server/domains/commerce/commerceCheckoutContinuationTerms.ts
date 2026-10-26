import type { CheckoutInvoicePreference } from "../../../src/domains/commerce/checkoutContracts.js";
import { createSavedAcquisitionContinuation } from "@openlup/platform/commerce/server";
import { stableJson } from "@openlup/platform/promotions";
import { createQuoteResponseSchema } from "../../../src/domains/commerce/contracts.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import { buildQuoteRequest, runtimeMetadata } from "./commerceCheckoutOrchestrationHelpers.js";
import { buildSavedOrderResumeResponse } from "./commerceCheckoutResumeGuard.js";
import { resolveCheckoutQuoteGuard } from "./commerceCheckoutQuoteGuard.js";
const core = createSavedAcquisitionContinuation({
  quoteSchema: createQuoteResponseSchema, buildQuoteRequest,
  sameSubjectContext: (context, fresh, provisioned) => context.petId === provisioned.petId && stableJson(context.sizeConstraint) === stableJson(fresh.sizeConstraint) && stableJson(context.petProfileContext) === stableJson(fresh.petProfileContext),
  runtimeMetadata: (intent, kind, preference?: CheckoutInvoicePreference) => runtimeMetadata(intent, kind, preference ?? { kind: "b2c_named" }),
  starterDeclaration: (intent: ConfiguratorIntent) => intent.starterOffer ? { ...intent.starterOffer, steady: { cadenceDays: intent.starterOffer.steady.cadenceDays, units: intent.starterOffer.steady.cans } } : undefined,
  starterPlan: (snapshot) => snapshot.quote.context?.starterPack,
  buildSavedOrderResumeResponse,
});
export const resolveSavedAcquisitionContinuation = core.resolveSavedAcquisitionContinuation;
export async function resolveCheckoutQuoteOrContinuation(input: Parameters<typeof resolveCheckoutQuoteGuard>[0] & { deps: Parameters<typeof resolveSavedAcquisitionContinuation>[0]["deps"]; invoicePreference?: Parameters<typeof runtimeMetadata>[2]; now: () => Date }) {
  const saved = await resolveSavedAcquisitionContinuation({ ...input, clientId: input.provisioned.clientId, provisioned: input.provisioned });
  return saved ? { kind: "resumed" as const, response: saved } : resolveCheckoutQuoteGuard(input);
}
