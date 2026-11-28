import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  applyHiddenCheckoutPaymentResultResponseSchema,
  startHiddenCheckoutRuntimeResponseSchema,
  type ApplyHiddenCheckoutPaymentResultRequest,
  type ApplyHiddenCheckoutPaymentResultResponse,
  type HiddenCheckoutRuntimeReadiness,
  type HiddenCheckoutRuntimeReservation,
  type StartHiddenCheckoutRuntimeRequest,
  type StartHiddenCheckoutRuntimeResponse,
} from "../../../src/domains/commerce/runtimeContracts.js";
import { checkoutCommandV1Schema } from "../../../src/domains/commerce/checkoutCommandContracts.js";
import type { CreateOrderDraftResponse, CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type { CheckoutPaymentExecution } from "../../../src/domains/commerce/paymentExecutionContracts.js";
import {
  CommerceRuntimeConflictError,
  type CommerceCheckoutRuntimeOrderPort,
  type CommerceCheckoutRuntimePort,
  type CommerceRuntimeReadinessPort,
  type FinalizedCheckoutOrder,
  type InventoryCheckoutReservationPort,
  type PaymentControlRuntimePort,
  type PreparedProviderAttemptRuntimePort,
} from "../../../src/domains/commerce/runtimePorts.js";
import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";
import type {
  PaymentExecutionProvider,
  PaymentExecutionResult,
  PaymentProviderFlow,
  TpayTransientProviderInput,
} from "../../../src/domains/payment/types.js";
import { buildProviderAttemptIdentity } from "../../../src/lib/providerAttemptIdempotency.js";
import { finalizeDeclinedAttempt } from "../../shared/finalizeDeclinedAttempt.js";
import {
  executePreparedProviderAttempt,
  preserveProviderDispatchUncertainty,
  preparedProviderAttemptPort,
  ProviderAttemptPreDispatchError,
  requiresPreparedProviderAttempt,
} from "../../shared/preparedProviderAttempt.js";
import { recordPaymentAttempt } from "../../shared/recordPaymentAttempt.js";
import { tpayTransientInput } from "../../shared/tpayTransientInput.js";
import type {
  CommerceOrderDraftWritePort,
  CommerceQuotePort,
} from "../../../src/domains/commerce/ports.js";
import type {
  CheckoutCommandRuntimePort,
  CheckoutCommandPersistencePort,
} from "../../../src/domains/commerce/runtimePorts.js";
import type { CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";
import { orchestrateCheckoutJourney } from "./commerceCheckoutOrchestration.js";
import { reopenExhaustedPreDispatchAttempt } from "./commerceProviderAttemptFailure.js";
import type { ResolvedSavedPaymentMethod, SavedPaymentMethodRecurringModel } from "./savedPaymentMethodResolverPort.js";
import {
  createCheckoutCommandExecutor,
  createCommerceRuntimeService as bindRuntime,
  createRuntimeStartResponse,
} from "@openlup/platform/commerce/server";

export const { buildStartedRuntimeResponse } = createRuntimeStartResponse<
  FinalizedCheckoutOrder,
  HiddenCheckoutRuntimeReservation,
  PaymentControlRuntimePort,
  PaymentExecutionResult,
  HiddenCheckoutRuntimeReadiness,
  StartHiddenCheckoutRuntimeResponse
>({
  contractVersion: COMMERCE_CONTRACT_VERSION,
  responseSchema: startHiddenCheckoutRuntimeResponseSchema,
  runtimeResponseExtension: (order) => ({ petId: order.petId }),
  finalizeDeclinedAttempt,
});

const { executeCheckoutCommand } = createCheckoutCommandExecutor<
  { clientId: string; addressId: string; petId: string | null },
  CreateQuoteResponse,
  CreateOrderDraftResponse,
  { petId: string | null },
  StartHiddenCheckoutRuntimeResponse,
  ApplyHiddenCheckoutPaymentResultResponse,
  PaymentExecutionPort,
  CheckoutPaymentExecution,
  PaymentExecutionProvider,
  PaymentProviderFlow,
  ResolvedSavedPaymentMethod["providerAliasType"],
  SavedPaymentMethodRecurringModel
>({
  commandSchema: checkoutCommandV1Schema,
  commandProvisioned: (persistence) => ({
    clientId: persistence.clientId,
    petId: null,
    addressId: persistence.shippingAddressId,
  }),
  orchestrateCheckoutJourney,
});

/** No-provider fallback; composition injects a registry adapter for real PSPs. */
const defaultPaymentExecutionPort: PaymentExecutionPort = {
  async execute(input) {
    return {
      provider: "hidden_rehearsal",
      providerAttemptId: null,
      providerSessionId: null,
      attemptStatus: "processing",
      nextActionKind: null,
      requestPayload: {
        source: "commerce.runtime.hidden.v0",
        providerIdempotencyKey: input.providerIdempotencyKey,
        providerRequestFingerprint: input.providerRequestFingerprint,
      },
      responsePayload: { providerCall: false },
    };
  },
};

export interface CommerceRuntimeServiceDeps {
  orderPort: CommerceCheckoutRuntimeOrderPort;
  inventoryPort: InventoryCheckoutReservationPort;
  paymentPort: PaymentControlRuntimePort;
  readinessPort: CommerceRuntimeReadinessPort;
  /** Per-request resolver takes precedence over the fixed no-provider fallback. */
  executionPort?: PaymentExecutionPort;
  resolveExecutionPort?: (providerKind: string) => PaymentExecutionPort;
  /**
   * The command entry remains uncomposed until a caller explicitly supplies
   * these existing ports. This keeps a missing composition from writing a draft.
   */
  quotePort?: CommerceQuotePort;
  persistencePort?: CheckoutCommandPersistencePort;
  orderDraftPort?: CommerceOrderDraftWritePort;
  /** Compensation capability for a command failure after `startRuntime`. */
  compensationPort?: CheckoutCompensationPort;
  /** Clock for the command path's settle step; composition may freeze it. */
  now?: () => Date;
}

const createRuntime = bindRuntime<StartHiddenCheckoutRuntimeRequest, FinalizedCheckoutOrder, HiddenCheckoutRuntimeReservation, PaymentControlRuntimePort, PaymentExecutionResult, TpayTransientProviderInput, PaymentExecutionPort, PreparedProviderAttemptRuntimePort, ProviderAttemptPreDispatchError, HiddenCheckoutRuntimeReadiness, StartHiddenCheckoutRuntimeResponse, ApplyHiddenCheckoutPaymentResultRequest, ApplyHiddenCheckoutPaymentResultResponse, Parameters<typeof executePreparedProviderAttempt>[0]["provider"]>({
  defaultPaymentProvider: "hidden_rehearsal", defaultProviderFlow: "one_time_payment", preparedRecurringModel: (request) => request.providerFlow === "blik_recurring_activation" ? "O" : request.paymentMethodRecurringModel,
  contractVersion: COMMERCE_CONTRACT_VERSION, resultResponseSchema: applyHiddenCheckoutPaymentResultResponseSchema,
  defaultExecutionPort: defaultPaymentExecutionPort,
  executionSubject: (order: import("../../../src/domains/commerce/runtimePorts.js").FinalizedCheckoutOrder) => ({ petId: order.petId }),
  paymentMetadataExtension: (order: import("../../../src/domains/commerce/runtimePorts.js").FinalizedCheckoutOrder) => ({ petId: order.petId }),
  buildProviderAttemptIdentity, transientProviderInput: tpayTransientInput, requiresPreparedProviderAttempt, preparedProviderAttemptPort, executePreparedProviderAttempt,
  isPreDispatch: (error): error is ProviderAttemptPreDispatchError => error instanceof ProviderAttemptPreDispatchError,
  reopenExhaustedPreDispatchAttempt, preserveProviderDispatchUncertainty, recordPaymentAttempt, buildStartedRuntimeResponse,
});
export function createCommerceRuntimeService(deps: CommerceRuntimeServiceDeps): CommerceCheckoutRuntimePort & CheckoutCommandRuntimePort {
  const runtime = createRuntime(deps);
  return { ...runtime, startCheckoutCommand: (request) => executeCheckoutCommand(request, { ...deps, startRuntime: runtime.startRuntime, applyPaymentResult: runtime.applyPaymentResult }) };
}
