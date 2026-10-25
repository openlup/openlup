import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { CheckoutInvoicePreference } from "../../../src/domains/commerce/checkoutContracts.js";
import type { CommerceCustomerDefaultsSnapshot } from "../../../src/domains/commerce/customerDefaultsSnapshotContracts.js";
import type { CheckoutJourney } from "./commerceCheckoutOrchestrationHelpers.js";
import { configuratorCheckoutJourney } from "./commerceCheckoutOrchestrationHelpers.js";
import {
  orchestrateCheckoutJourney,
  type OrchestrateBaseDeps,
  type OrchestratedCheckoutResult,
} from "./commercePaidOrderOrchestration.js";

export { CheckoutOrchestrationError } from "./commerceCheckoutOrchestrationError.js";
export { tryCompensate } from "./commerceCheckoutCompensation.js";
export type { CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";
export type {
  CheckoutPaymentStartedEvent,
  CheckoutStage,
  CheckoutStageRecorder,
  OrchestratedCheckoutResult,
} from "./commercePaidOrderOrchestration.js";

/**
 * One application service, two entry mappings. `journey` is the neutral entry
 * used by the checkout-command adapter; `intent` is the legacy configurator
 * mapping, which this module projects onto the same journey.
 */
export type OrchestrateDeps = OrchestrateBaseDeps &
  (
    | {
        journey: CheckoutJourney;
        intent?: undefined;
        invoicePreference?: undefined;
        customerDefaultsSnapshot?: undefined;
      }
    | {
        journey?: undefined;
        intent: ConfiguratorIntent;
        invoicePreference: CheckoutInvoicePreference;
        customerDefaultsSnapshot?: CommerceCustomerDefaultsSnapshot | null;
      }
  );
export async function orchestratePaidOrder(
  deps: OrchestrateDeps,
): Promise<OrchestratedCheckoutResult> {
  const journey: CheckoutJourney = deps.journey ?? configuratorCheckoutJourney(
    deps.intent,
    deps.provisioned,
    deps.checkoutKind,
    deps.invoicePreference,
    deps.customerDefaultsSnapshot,
  );
  return orchestrateCheckoutJourney(deps, journey);
}
