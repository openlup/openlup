import { createPaidOrderOrchestration } from "@openlup/platform/commerce/server";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { CheckoutInvoicePreference } from "../../../src/domains/commerce/checkoutContracts.js";
import type { CommerceCustomerDefaultsSnapshot } from "../../../src/domains/commerce/customerDefaultsSnapshotContracts.js";
import type { CreateQuoteRequest, CreateQuoteResponse, CreateOrderDraftResponse } from "../../../src/domains/commerce/contracts.js";
import type { StartHiddenCheckoutRuntimeResponse, ApplyHiddenCheckoutPaymentResultResponse } from "../../../src/domains/commerce/runtimeContracts.js";
import type { CheckoutPaymentExecution } from "../../../src/domains/commerce/paymentExecutionContracts.js";
import type { PaymentExecutionProvider, PaymentProviderFlow } from "../../../src/domains/payment/types.js";
import type { ResolvedSavedPaymentMethod, SavedPaymentMethodRecurringModel } from "./savedPaymentMethodResolverPort.js";
import type { CheckoutJourney } from "./commerceCheckoutOrchestrationHelpers.js";
import { configuratorCheckoutJourney } from "./commerceCheckoutOrchestrationHelpers.js";
import { providerFlowFor, checkoutConfirmationProvider } from "./commerceCheckoutProviderPayment.js";
import { mapStartRuntimeFailure } from "./commerceCheckoutStartRuntimeFailure.js";

export { CheckoutOrchestrationError } from "@openlup/platform/commerce/server";
export { tryCompensate } from "./commerceCheckoutCompensation.js";
export type { CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";
export type {
  CheckoutPaymentStartedEvent,
  CheckoutStage,
  CheckoutStageRecorder,
} from "@openlup/platform/commerce/server";

export const { orchestrateCheckoutJourney } = createPaidOrderOrchestration<
  { clientId: string; addressId: string; petId: string | null },
  CreateQuoteRequest,
  CreateQuoteResponse,
  CreateOrderDraftResponse,
  { petId: string | null },
  StartHiddenCheckoutRuntimeResponse,
  ApplyHiddenCheckoutPaymentResultResponse,
  CheckoutPaymentExecution,
  PaymentExecutionProvider,
  PaymentProviderFlow,
  ResolvedSavedPaymentMethod["providerAliasType"],
  SavedPaymentMethodRecurringModel
>({
  defaultPaymentProvider: "hidden_rehearsal",
  rehearsalPaymentProvider: "hidden_rehearsal",
  confirmationProvider: checkoutConfirmationProvider,
  missingConfirmationMessage: "stripe_processing_without_client_secret",
  providerFlowFor,
  runtimeRequestExtension: (provisioned) => ({ petId: provisioned.petId }),
  mapStartRuntimeFailure,
});

export type OrchestrateBaseDeps = Parameters<typeof orchestrateCheckoutJourney>[0];
export type OrchestratedCheckoutResult = Awaited<ReturnType<typeof orchestrateCheckoutJourney>>;

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
