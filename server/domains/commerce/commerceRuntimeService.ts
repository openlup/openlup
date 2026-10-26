import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  applyHiddenCheckoutPaymentResultResponseSchema,
  type ApplyHiddenCheckoutPaymentResultRequest,
  type ApplyHiddenCheckoutPaymentResultResponse,
  type StartHiddenCheckoutRuntimeRequest,
  type StartHiddenCheckoutRuntimeResponse,
} from "../../../src/domains/commerce/runtimeContracts.js";
import {
  CommerceRuntimeConflictError,
  type CommerceCheckoutRuntimeOrderPort,
  type CommerceCheckoutRuntimePort,
  type CommerceRuntimeReadinessPort,
  type InventoryCheckoutReservationPort,
  type PaymentControlRuntimePort,
} from "../../../src/domains/commerce/runtimePorts.js";
import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";
import type { TpayTransientProviderInput } from "../../../src/domains/payment/types.js";
import { buildProviderAttemptIdentity } from "../../../src/lib/providerAttemptIdempotency.js";
import {
  executePreparedProviderAttempt,
  preserveProviderDispatchUncertainty,
  preparedProviderAttemptPort,
  ProviderAttemptPreDispatchError,
  requiresPreparedProviderAttempt,
} from "../../shared/preparedProviderAttempt.js";
import { recordPaymentAttempt } from "../../shared/recordPaymentAttempt.js";
import { tpayTransientInput } from "../../shared/tpayTransientInput.js";
import { buildStartedRuntimeResponse } from "./commerceRuntimeStartResponse.js";
import type {
  CommerceOrderDraftWritePort,
  CommerceQuotePort,
} from "../../../src/domains/commerce/ports.js";
import type {
  CheckoutCommandRuntimePort,
  CheckoutCommandPersistencePort,
} from "../../../src/domains/commerce/runtimePorts.js";
import { executeCheckoutCommand } from "./commerceCheckoutCommandExecution.js";
import type { CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";
import { reopenExhaustedPreDispatchAttempt } from "./commerceProviderAttemptFailure.js";

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

import { createCommerceRuntimeService as bindRuntime } from "@openlup/platform/commerce/server";
import type { FinalizedCheckoutOrder, PreparedProviderAttemptRuntimePort } from "../../../src/domains/commerce/runtimePorts.js";
import type { HiddenCheckoutRuntimeReservation, HiddenCheckoutRuntimeReadiness } from "../../../src/domains/commerce/runtimeContracts.js";
import type { PaymentExecutionResult } from "../../../src/domains/payment/types.js";
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
